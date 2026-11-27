// Runs the statistics in analyze.ts over every item on every tracked house and stores the results
// (stats_item, stats_opportunity, stats_anomaly) for the dashboard and the CLI.
import { HOUSES, sellsOn, type House } from "../config.ts";
import { transaction, type Db } from "../db/db.ts";
import { itemForecast, toDaily } from "./forecast.ts";
import { CONVERSIONS } from "./conversions.ts";
import { analyze, anomalies, DEFAULT_RULES, expectedDepositLoss, liquid, opportunities, SAFE, type Analysis, type Liquidity, type Pt } from "./analyze.ts";

/** A 7-day usual price follows Forever's young, fast-moving economy better than 14 days. */
/**
 * Opportunities are stored down to this margin; the user's minimum margin (default 10%, never below
 * this) filters them when shown, so changing the setting takes effect without recomputing.
 */
export const STORE_MARGIN_FLOOR = 0.05;

export const LOOKBACK_DAYS = Number(process.env.STATS_LOOKBACK_DAYS ?? 7);

/**
 * Price history for the statistics: Undermine Exchange's hourly snapshots (and full scans), evenly
 * spread through the day. Auctionator browse scans are left out: they are the cheapest listing at
 * moments you happened to look, which would drag the usual prices down. They are used as "now" prices.
 */
function loadSeries(db: Db, house: House, since: number): Map<number, Pt[]> {
  const out = new Map<number, Pt[]>();
  const rows = db.prepare(
    `SELECT s.item_id id, s.ts, coalesce(s.price_20, s.min_buyout) price, s.quantity qty
     FROM item_snapshot s JOIN snapshot sn ON sn.id = s.snapshot_id
     WHERE sn.house_id = ? AND s.ts >= ? AND coalesce(s.price_20, s.min_buyout) > 0 AND sn.source != 'auctionator-browse'`,
  ).iterate(house.houseId, since) as Iterable<{ id: number; ts: number; price: number; qty: number }>;
  for (const r of rows) {
    let pts = out.get(r.id);
    if (!pts) out.set(r.id, (pts = []));
    pts.push({ ts: r.ts, price: r.price, qty: r.qty });
  }
  return out;
}

/** Each item's price in your latest Auctionator scan of a house (browse or full), within `since`. */
function loadScanPrices(db: Db, house: House, since: number): Map<number, { price: number; ts: number }> {
  const out = new Map<number, { price: number; ts: number }>();
  const rows = db.prepare(
    `SELECT s.item_id id, s.ts, coalesce(s.min_buyout, s.price_20) price
     FROM item_snapshot s JOIN snapshot sn ON sn.id = s.snapshot_id
     WHERE sn.house_id = ? AND s.ts >= ? AND sn.source LIKE 'auctionator-%' AND coalesce(s.min_buyout, s.price_20) > 0
     ORDER BY s.ts`,
  ).iterate(house.houseId, since) as Iterable<{ id: number; ts: number; price: number }>;
  for (const r of rows) out.set(r.id, { price: r.price, ts: r.ts });
  return out;
}

/** How old a scan price can be and still count as "now". */
const SCAN_FRESH_SECONDS = 6 * 3600;

function loadLiquidity(db: Db): Map<number, Liquidity> {
  // Deposit per unit for a 2-hour listing: exact where the addon recorded it, otherwise vendor price
  // times the median deposit/vendor ratio seen on items where both are known.
  const ratios = (db.prepare(
    "SELECT 1.0 * deposit_unit / vendor_price r FROM item WHERE deposit_unit > 0 AND vendor_price > 0",
  ).all() as { r: number }[]).map((x) => x.r).sort((a, b) => a - b);
  const ratio = ratios.length ? (ratios[Math.floor(ratios.length / 2)] as number) : 0;
  const rows = db.prepare(
    `SELECT g.item_id id, g.sold_per_day soldPerDay, g.sale_rate saleRate, i.deposit_unit deposit, i.vendor_price vendor
     FROM tsm_region g LEFT JOIN item i ON i.item_id = g.item_id
     WHERE g.updated_at = (SELECT max(updated_at) FROM tsm_region)`,
  ).all() as { id: number; soldPerDay: number | null; saleRate: number | null; deposit: number | null; vendor: number | null }[];
  return new Map(rows.map((r) => [r.id, {
    soldPerDay: r.soldPerDay,
    saleRate: r.saleRate,
    deposit: r.deposit ?? (r.vendor && ratio ? Math.round(r.vendor * ratio) : null),
  }]));
}

const score = (profit: number, l: Liquidity | undefined, confidence: number) =>
  profit * Math.sqrt(Math.max(0, l?.soldPerDay ?? 0)) * confidence;

export interface RefreshResult { houses: Record<string, { analysed: number; opportunities: number; anomaliesOpen: number }>; crossHouse: number; ms: number }

export function refreshStats(db: Db, now = Math.floor(Date.now() / 1000)): RefreshResult {
  const started = Date.now();
  const liquidity = loadLiquidity(db);
  const analyses = new Map<number, Map<number, Analysis>>();
  const scans = new Map(HOUSES.map((h) => [h.houseId, loadScanPrices(db, h, now - SCAN_FRESH_SECONDS)]));
  const result: RefreshResult = { houses: {}, crossHouse: 0, ms: 0 };

  for (const house of HOUSES) {
    const series = loadSeries(db, house, now - LOOKBACK_DAYS * 86400);
    const byItem = new Map<number, Analysis>();
    const rules = { ...DEFAULT_RULES, minProfitPct: STORE_MARGIN_FLOOR, cut: house.cut };
    let nOpp = 0;
    transaction(db, () => {
      db.prepare("DELETE FROM stats_item WHERE house_id = ?").run(house.houseId);
      db.prepare("DELETE FROM stats_opportunity WHERE house_id = ? AND sell_house_id = ?").run(house.houseId, house.houseId);
      const insItem = db.prepare(
        `INSERT INTO stats_item (house_id, item_id, computed_at, days, points, current, median, median3d, buy_price, sell_price,
           buy_hours, sell_hours, hour_medians, consistency, pattern_days, z)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insOpp = db.prepare(
        `INSERT INTO stats_opportunity (house_id, item_id, kind, sell_house_id, buy_price, sell_price, profit, margin, confidence, score, why, computed_at,
           safe_buy, safe_sell, safe_profit, safe_margin, safe_evidence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const openAnom = db.prepare(
        `SELECT first_seen FROM stats_anomaly WHERE house_id = ? AND item_id = ? AND kind = ? AND closed_at IS NULL`,
      );
      const insAnom = db.prepare(
        `INSERT INTO stats_anomaly (house_id, item_id, kind, first_seen, last_seen, severity, detail) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      const touchAnom = db.prepare(
        `UPDATE stats_anomaly SET last_seen = ?, severity = ?, detail = ? WHERE house_id = ? AND item_id = ? AND kind = ? AND first_seen = ?`,
      );
      const scanned = scans.get(house.houseId)!;
      for (const [itemId, pts] of series) {
        const a = analyze(pts, now, LOOKBACK_DAYS);
        if (!a) continue;
        // Between houses buys at the newest price: your own scan when it is more recent than Undermine's.
        // (Same-house trades and anomalies stay on Undermine's prices, so the cheapest single listing
        // is not compared against usual prices measured differently.)
        const s = scanned.get(itemId);
        byItem.set(itemId, s && s.ts > a.currentTs ? { ...a, current: s.price, currentTs: s.ts } : a);
        insItem.run(house.houseId, itemId, now, a.days, a.points, a.current, a.median, a.median3d, a.buyPrice, a.sellPrice,
          a.buyHours.join(","), a.sellHours.join(","), JSON.stringify(a.hourMedian), a.patternConsistency, a.patternDays,
          Number.isFinite(a.z) ? a.z : null);
        const l = liquidity.get(itemId) ?? { soldPerDay: null, saleRate: null };
        // Same-house trades all end in a sale here.
        if (sellsOn(house, itemId)) for (const o of opportunities(a, l, rules)) {
          insOpp.run(house.houseId, itemId, o.kind, house.houseId, o.buyPrice, o.sellPrice, o.profit, o.margin, o.confidence,
            score(o.profit, l, o.confidence), o.why, now, o.safeBuy, o.safeSell, o.safeProfit, o.safeMargin, o.safeEvidence ? 1 : 0);
          nOpp++;
        }
        // Only flag anomalies on items people actually trade; a 1-a-week item spikes all the time.
        if (!liquid(l, DEFAULT_RULES)) continue;
        for (const x of anomalies(a)) {
          const open = openAnom.get(house.houseId, itemId, x.kind) as { first_seen: number } | undefined;
          if (open) touchAnom.run(now, x.severity, x.detail, house.houseId, itemId, x.kind, open.first_seen);
          else insAnom.run(house.houseId, itemId, x.kind, now, now, x.severity, x.detail);
        }
      }
      // Anomalies not seen in this run are over.
      db.prepare("UPDATE stats_anomaly SET closed_at = ? WHERE house_id = ? AND closed_at IS NULL AND last_seen < ?")
        .run(now, house.houseId, now);
    });
    analyses.set(house.houseId, byItem);
    const open = (db.prepare("SELECT count(*) n FROM stats_anomaly WHERE house_id = ? AND closed_at IS NULL").get(house.houseId) as { n: number }).n;
    result.houses[house.key] = { analysed: byItem.size, opportunities: nOpp, anomaliesOpen: open };
  }

  // Cross-house: buy at today's price on one house, sell at the usual price on the other (after its cut).
  transaction(db, () => {
    db.prepare("DELETE FROM stats_opportunity WHERE kind = 'cross-house'").run();
    const ins = db.prepare(
      `INSERT INTO stats_opportunity (house_id, item_id, kind, sell_house_id, buy_price, sell_price, profit, margin, confidence, score, why, computed_at,
         safe_buy, safe_sell, safe_profit, safe_margin, safe_evidence, sell_now, sell_now_ts, profit_now, margin_now)
       VALUES (?, ?, 'cross-house', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const buy of HOUSES)
      for (const sell of HOUSES) {
        if (buy === sell) continue;
        const A = analyses.get(buy.houseId);
        const B = analyses.get(sell.houseId);
        if (!A || !B) continue;
        for (const [itemId, a] of A) {
          const b = B.get(itemId);
          const l = liquidity.get(itemId);
          if (!b || !l || !liquid(l, DEFAULT_RULES) || !sellsOn(sell, itemId)) continue;
          // Deposits lost on 2-hour listings that expire before one sells, as for every other trade.
          const depositLoss = expectedDepositLoss(l);
          const profit = b.median * (1 - sell.cut) - a.current - depositLoss;
          const margin = profit / a.current;
          // Selling straight away at the price in your latest scan of the other house.
          const scan = scans.get(sell.houseId)!.get(itemId);
          const profitNow = scan ? scan.price * (1 - sell.cut) - a.current - depositLoss : null;
          const marginNow = profitNow === null ? null : profitNow / a.current;
          // Every item that sells on both houses is stored, profitable or not, so the dashboard can show
          // the full comparison; lists, alerts and the default views only use trades that make the margin.
          const confidence = Math.min(1, Math.min(a.days, b.days) / 10);
          // Pessimistic: sell at a low typical price on the other house, or today's price if lower.
          const safeSell = Math.min(b.p25, scan?.price ?? Infinity);
          const safeProfit = safeSell * (1 - sell.cut) - a.current - expectedDepositLoss(l, true);
          const falling = (b.median - b.median3d) / b.median > SAFE.maxRecentDrop;
          const evidence = (l.soldPerDay ?? 0) >= SAFE.minSoldPerDay && (l.saleRate ?? 0) >= SAFE.minSaleRate && Math.min(a.days, b.days) >= SAFE.minDays && !falling;
          ins.run(buy.houseId, itemId, sell.houseId, a.current, b.median, profit, margin, confidence, score(profit, l, confidence),
            `Buy on ${buy.label} now, sell on ${sell.label} at its ${b.days}-day usual price (after its ${Math.round(sell.cut * 100)}% cut). You carry the items there yourself.`,
            now, a.current, safeSell, safeProfit, safeProfit / a.current, evidence ? 1 : 0,
            scan?.price ?? null, scan?.ts ?? null, profitNow, marginNow);
          result.crossHouse++;
        }
      }

    // Conversions (3 Lesser essences <-> 1 Greater): buy the input on one house, convert, sell the
    // output on the same or the other house. Per conversion: cost = input units x buy price; you get
    // output units x price after the sell house's cut, less expected lost deposits on the output.
    db.prepare("DELETE FROM stats_opportunity WHERE kind = 'convert'").run();
    const insConv = db.prepare(
      `INSERT INTO stats_opportunity (house_id, item_id, kind, sell_house_id, buy_price, sell_price, profit, margin, confidence, score, why, computed_at,
         safe_buy, safe_sell, safe_profit, safe_margin, safe_evidence, sell_now, sell_now_ts, profit_now, margin_now, sell_item_id, convert_in, convert_out)
       VALUES (?, ?, 'convert', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const idOf = db.prepare("SELECT item_id id FROM item WHERE name = ?");
    for (const c of CONVERSIONS) {
      const fromId = (idOf.get(c.from) as { id: number } | undefined)?.id;
      const toId = (idOf.get(c.to) as { id: number } | undefined)?.id;
      if (!fromId || !toId) continue;
      for (const buy of HOUSES)
        for (const sell of HOUSES) {
          const a = analyses.get(buy.houseId)?.get(fromId);
          const b = analyses.get(sell.houseId)?.get(toId);
          const l = liquidity.get(toId);
          if (!a || !b || !l || !sellsOn(sell, toId)) continue;
          const cost = c.fromQty * a.current;
          const depositLoss = c.toQty * expectedDepositLoss(l);
          const profit = c.toQty * b.median * (1 - sell.cut) - cost - depositLoss;
          const scan = scans.get(sell.houseId)!.get(toId);
          const profitNow = scan ? c.toQty * scan.price * (1 - sell.cut) - cost - depositLoss : null;
          const safeSell = Math.min(b.p25, scan?.price ?? Infinity);
          const safeProfit = c.toQty * safeSell * (1 - sell.cut) - cost - c.toQty * expectedDepositLoss(l, true);
          const falling = (b.median - b.median3d) / b.median > SAFE.maxRecentDrop;
          const evidence = (l.soldPerDay ?? 0) >= SAFE.minSoldPerDay && (l.saleRate ?? 0) >= SAFE.minSaleRate && Math.min(a.days, b.days) >= SAFE.minDays && !falling;
          const confidence = Math.min(1, Math.min(a.days, b.days) / 10);
          insConv.run(buy.houseId, fromId, sell.houseId, a.current, b.median, profit, profit / cost, confidence, score(profit, l, confidence),
            `Buy ${c.fromQty} ${c.from} on ${buy.label}, ${c.verb} into ${c.toQty} ${c.to}, sell on ${sell.label} (after its ${Math.round(sell.cut * 100)}% cut).`,
            now, a.current, safeSell, safeProfit, safeProfit / cost, evidence ? 1 : 0,
            scan?.price ?? null, scan?.ts ?? null, profitNow, profitNow === null ? null : profitNow / cost, toId, c.fromQty, c.toQty);
        }
    }
  });
  result.ms = Date.now() - started;
  return result;
}

/** Items that sell at least this many a day (EU) count towards each method's pooled accuracy. */
const FORECAST_MIN_SOLD = 20;

/**
 * Trends and next-days estimates for every item on every house, from all of its Undermine hourly
 * history, plus each method's back-tested accuracy. See forecast.ts.
 */
export function refreshForecasts(db: Db, now = Math.floor(Date.now() / 1000)): { items: number; ms: number } {
  const started = Date.now();
  const liquidity = loadLiquidity(db);
  let items = 0;
  for (const house of HOUSES) {
    const rows = db.prepare(
      `SELECT s.item_id id, s.ts, coalesce(s.price_20, s.min_buyout) price, s.quantity
       FROM item_snapshot s JOIN snapshot sn ON sn.id = s.snapshot_id
       WHERE sn.house_id = ? AND sn.source != 'auctionator-browse' AND coalesce(s.price_20, s.min_buyout) > 0`,
    ).iterate(house.houseId) as Iterable<{ id: number; ts: number; price: number; quantity: number }>;
    const byItem = new Map<number, { ts: number; price: number; quantity: number }[]>();
    for (const r of rows) {
      let a = byItem.get(r.id);
      if (!a) byItem.set(r.id, (a = []));
      a.push(r);
    }
    const pooled = { snap: 0, trend: 0, naive: 0, items: 0, snapWins: 0, trendWins: 0 };
    transaction(db, () => {
      db.prepare("DELETE FROM stats_forecast WHERE house_id = ?").run(house.houseId);
      const ins = db.prepare(`INSERT INTO stats_forecast (house_id, item_id, computed_at, days, level, next, trend, consistency,
        supply_trend, peak, low, skill, backtests) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const [itemId, hourly] of byItem) {
        const f = itemForecast(toDaily(hourly));
        if (!f) continue;
        ins.run(house.houseId, itemId, now, f.days, f.level, f.next, f.trend, f.consistency, f.supplyTrend, f.peak, f.low, f.skill, f.backtests);
        items++;
        if ((liquidity.get(itemId)?.soldPerDay ?? 0) >= FORECAST_MIN_SOLD && f.errors.n >= 6) {
          pooled.snap += f.errors.snap; pooled.trend += f.errors.trend; pooled.naive += f.errors.naive; pooled.items++;
          if (f.errors.snap < f.errors.naive) pooled.snapWins++;
          if (f.errors.trend < f.errors.naive) pooled.trendWins++;
        }
      }
      const up = db.prepare(`INSERT OR REPLACE INTO stats_forecast_method (house_id, method, skill, wins, items, computed_at) VALUES (?, ?, ?, ?, ?, ?)`);
      const skill = (e: number) => (pooled.naive > 0 ? 1 - e / pooled.naive : null);
      const share = (w: number) => (pooled.items ? w / pooled.items : null);
      up.run(house.houseId, "snap-back", skill(pooled.snap), share(pooled.snapWins), pooled.items, now);
      up.run(house.houseId, "trend", skill(pooled.trend), share(pooled.trendWins), pooled.items, now);
    });
  }
  return { items, ms: Date.now() - started };
}
