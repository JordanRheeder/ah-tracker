// Read-only queries behind the dashboard API and the Claude query CLI.
import { sellsOn } from "../config.ts";
import { CONVERSIONS, ESSENCE_PAIRS } from "../stats/conversions.ts";
import { statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { Point } from "./candles.ts";

type Db = DatabaseSync;

/** price_20 when the scan had every listing, otherwise the cheapest unit buyout (browse scans). */
const PRICE = "coalesce(s.price_20, s.min_buyout)";

/** TSM realm prices are published for PvP Alliance only. */
const TSM_REALM_HOUSE = 110;

/**
 * The newest whole-house snapshot. Auctionator browse scans are left out: they cover only the
 * items you searched for (sometimes one), so they cannot stand for the whole auction house.
 */
function latestSnapshotId(db: Db, houseId: number): number | null {
  const row = db
    .prepare("SELECT id FROM snapshot WHERE house_id = ? AND item_count > 0 AND source != 'auctionator-browse' ORDER BY fetched_at DESC, id DESC LIMIT 1")
    .get(houseId) as { id: number } | undefined;
  return row?.id ?? null;
}

export interface ItemRow {
  itemId: number;
  name: string | null;
  price: number | null;
  minBuyout: number | null;
  quantity: number | null;
  marketValue: number | null;
  soldPerDay: number | null;
  saleRate: number | null;
}

const ITEM_SELECT = `
  SELECT s.item_id itemId, i.name, ${PRICE} price, s.min_buyout minBuyout, s.quantity,
         r.market_value marketValue, g.sold_per_day soldPerDay, g.sale_rate saleRate
  FROM item_snapshot s
  LEFT JOIN item i ON i.item_id = s.item_id
  LEFT JOIN tsm_realm r ON r.item_id = s.item_id AND r.updated_at = (SELECT max(updated_at) FROM tsm_realm) AND :house = ${TSM_REALM_HOUSE}
  LEFT JOIN tsm_region g ON g.item_id = s.item_id AND g.updated_at = (SELECT max(updated_at) FROM tsm_region)`;

/** Items in the latest scan, matched by name or id, busiest sellers first. */
export function searchItems(db: Db, q: string, houseId: number, limit = 25): ItemRow[] {
  const snap = latestSnapshotId(db, houseId);
  if (snap === null) return [];
  const term = q.trim();
  const byId = /^\d+$/.test(term);
  const where = term === "" ? "" : byId ? "AND s.item_id = :id" : "AND i.name LIKE :name";
  return db
    .prepare(`${ITEM_SELECT} WHERE s.snapshot_id = :snap ${where}
              ORDER BY g.sold_per_day IS NULL, g.sold_per_day DESC, i.name LIMIT :limit`)
    .all({ snap, limit, house: houseId, ...(byId ? { id: Number(term) } : term ? { name: `%${term}%` } : {}) }) as unknown as ItemRow[];
}

export interface ItemDetail extends ItemRow {
  /** AH Tracker's usual price on this house (7-day median). */
  usual: number | null;
  lastScan: number | null;
  firstScan: number | null;
  scans: number;
  low7d: number | null;
  high7d: number | null;
  tsmMinBuyout: number | null;
  tsmHistorical: number | null;
  avgSalePrice: number | null;
  /** Whether the latest scan had every listing (price is price_20) or only a summary (cheapest buyout). */
  latestScanKind: string | null;
  quality: number | null;
  icon: string | null;
  className: string | null;
  subclassName: string | null;
  depositUnit: number | null;
  depositIsEstimate: boolean;
  vendorPrice: number | null;
}

export function itemDetail(db: Db, itemId: number, houseId: number, now = Date.now() / 1000): ItemDetail | null {
  const latest = db
    .prepare(`${ITEM_SELECT} JOIN snapshot sn ON sn.id = s.snapshot_id
              WHERE s.item_id = :item AND sn.house_id = :house ORDER BY s.ts DESC LIMIT 1`)
    .get({ item: itemId, house: houseId }) as ItemRow | undefined;
  const name = (db.prepare("SELECT name FROM item WHERE item_id = ?").get(itemId) as { name: string } | undefined)?.name ?? null;
  const span = db
    .prepare(`SELECT min(s.ts) firstScan, max(s.ts) lastScan, count(*) scans FROM item_snapshot s
              JOIN snapshot sn ON sn.id = s.snapshot_id WHERE s.item_id = ? AND sn.house_id = ?`)
    .get(itemId, houseId) as { firstScan: number | null; lastScan: number | null; scans: number };
  const range = db
    .prepare(`SELECT min(${PRICE}) low, max(${PRICE}) high FROM item_snapshot s
              JOIN snapshot sn ON sn.id = s.snapshot_id WHERE s.item_id = ? AND sn.house_id = ? AND s.ts >= ?`)
    .get(itemId, houseId, now - 7 * 86400) as { low: number | null; high: number | null };
  const tsm = db
    .prepare(`SELECT r.min_buyout tsmMinBuyout, r.historical tsmHistorical, r.market_value marketValue,
                     g.avg_sale_price avgSalePrice, g.sold_per_day soldPerDay, g.sale_rate saleRate
              FROM (SELECT ? item_id) x
              LEFT JOIN tsm_realm r ON r.item_id = x.item_id AND r.updated_at = (SELECT max(updated_at) FROM tsm_realm) AND ? = ${TSM_REALM_HOUSE}
              LEFT JOIN tsm_region g ON g.item_id = x.item_id AND g.updated_at = (SELECT max(updated_at) FROM tsm_region)`)
    .get(itemId, houseId) as Record<string, number | null>;
  const meta = db.prepare(`SELECT i.quality, i.icon_name icon, c.name className, sc.name subclassName,
      i.deposit_unit depositUnit, i.vendor_price vendorPrice FROM item i
      LEFT JOIN item_class c ON c.class_id = i.class_id AND c.subclass_id = -1
      LEFT JOIN item_class sc ON sc.class_id = i.class_id AND sc.subclass_id = i.subclass_id
      WHERE i.item_id = ?`).get(itemId) as { quality: number | null; icon: string | null; className: string | null; subclassName: string | null;
        depositUnit: number | null; vendorPrice: number | null } | undefined;
  // Deposit estimate when the game has not reported it yet: vendor price x median deposit/vendor ratio.
  let depositEstimate: number | null = null;
  if (meta?.depositUnit == null && meta?.vendorPrice) {
    const ratios = (db.prepare("SELECT 1.0 * deposit_unit / vendor_price r FROM item WHERE deposit_unit > 0 AND vendor_price > 0").all() as { r: number }[])
      .map((x) => x.r).sort((a, b) => a - b);
    if (ratios.length) depositEstimate = Math.round(meta.vendorPrice * (ratios[Math.floor(ratios.length / 2)] as number));
  }
  const kind = db
    .prepare(`SELECT sn.source FROM item_snapshot s JOIN snapshot sn ON sn.id = s.snapshot_id
              WHERE s.item_id = ? AND sn.house_id = ? ORDER BY s.ts DESC LIMIT 1`)
    .get(itemId, houseId) as { source: string } | undefined;
  const usual = (db.prepare("SELECT median FROM stats_item WHERE house_id = ? AND item_id = ?").get(houseId, itemId) as { median: number } | undefined)?.median ?? null;
  if (!latest && !name && tsm.marketValue === null) return null;
  return {
    itemId,
    name,
    price: latest?.price ?? null,
    minBuyout: latest?.minBuyout ?? null,
    quantity: latest?.quantity ?? null,
    marketValue: tsm.marketValue ?? null,
    usual,
    soldPerDay: tsm.soldPerDay ?? null,
    saleRate: tsm.saleRate ?? null,
    tsmMinBuyout: tsm.tsmMinBuyout ?? null,
    tsmHistorical: tsm.tsmHistorical ?? null,
    avgSalePrice: tsm.avgSalePrice ?? null,
    firstScan: span.firstScan,
    lastScan: span.lastScan,
    scans: span.scans,
    low7d: range.low,
    high7d: range.high,
    latestScanKind: kind?.source ?? null,
    quality: meta?.quality ?? null,
    icon: meta?.icon ?? null,
    className: meta?.className ?? null,
    subclassName: meta?.subclassName ?? null,
    depositUnit: meta?.depositUnit ?? depositEstimate,
    depositIsEstimate: meta?.depositUnit == null && depositEstimate !== null,
    vendorPrice: meta?.vendorPrice ?? null,
  };
}

export function itemSeries(db: Db, itemId: number, houseId: number, since: number): Point[] {
  return (db
    .prepare(`SELECT s.ts, ${PRICE} price, s.quantity FROM item_snapshot s JOIN snapshot sn ON sn.id = s.snapshot_id
              WHERE s.item_id = ? AND sn.house_id = ? AND s.ts >= ? AND ${PRICE} IS NOT NULL ORDER BY s.ts`)
    .all(itemId, houseId, since) as unknown as Point[]).map((r) => ({ ts: r.ts, price: r.price, quantity: r.quantity }));
}

/** Biggest price change between each item's latest scan and its scan closest to 24 h earlier. */
export function topMovers(db: Db, houseId: number, limit = 15, now = Date.now() / 1000) {
  const snap = latestSnapshotId(db, houseId);
  if (snap === null) return [];
  return db
    .prepare(`
      WITH latest AS (
        SELECT s.item_id, ${PRICE} price, s.ts FROM item_snapshot s WHERE s.snapshot_id = :snap),
      before AS (
        SELECT s.item_id, ${PRICE} price, abs(s.ts - (:now - 86400)) dist,
               row_number() OVER (PARTITION BY s.item_id ORDER BY abs(s.ts - (:now - 86400))) rn
        FROM item_snapshot s JOIN snapshot sn ON sn.id = s.snapshot_id
        WHERE sn.house_id = :house AND sn.source != 'auctionator-browse' AND s.ts BETWEEN :now - 2 * 86400 AND :now - 12 * 3600)
      SELECT l.item_id itemId, i.name, i.quality, i.icon_name icon, b.price before, l.price now,
             round(100.0 * (l.price - b.price) / b.price, 1) changePct, g.sold_per_day soldPerDay
      FROM latest l JOIN before b ON b.item_id = l.item_id AND b.rn = 1
      LEFT JOIN item i ON i.item_id = l.item_id
      LEFT JOIN tsm_region g ON g.item_id = l.item_id AND g.updated_at = (SELECT max(updated_at) FROM tsm_region)
      WHERE b.price > 0 AND l.price IS NOT NULL
      ORDER BY abs(l.price - b.price) * 1.0 / b.price DESC LIMIT :limit`)
    .all({ now: Math.floor(now), limit, snap, house: houseId });
}

export function health(db: Db, dbPath: string, now = Date.now() / 1000) {
  const sources = ["auctionator", "undermine", "undermine-backfill", "tsm-realm", "tsm-region"].map((source) => {
    const last = db.prepare("SELECT started_at at, status, detail FROM fetch_log WHERE source = ? ORDER BY id DESC LIMIT 1").get(source) as
      | { at: number; status: string; detail: string | null } | undefined;
    const ok = db.prepare("SELECT max(started_at) t FROM fetch_log WHERE source = ? AND status != 'error'").get(source) as { t: number | null };
    const errors = db.prepare("SELECT count(*) n FROM fetch_log WHERE source = ? AND status = 'error' AND started_at > ?").get(source, now - 86400) as { n: number };
    return { source, lastAttempt: last?.at ?? null, lastStatus: last?.status ?? null, lastDetail: last?.detail ?? null, lastSuccess: ok.t, errors24h: errors.n };
  });
  const scans = db.prepare("SELECT id, source, house_id houseId, fetched_at ts, item_count items FROM snapshot ORDER BY fetched_at DESC LIMIT 50").all();
  const perHouse = db.prepare("SELECT house_id houseId, source, count(*) n, min(fetched_at) first, max(fetched_at) last FROM snapshot GROUP BY house_id, source").all();
  // Hours covered by your own Auctionator scans (Undermine covers every hour already).
  const hours = (db.prepare("SELECT DISTINCT CAST(strftime('%H', fetched_at, 'unixepoch') AS INTEGER) h FROM snapshot WHERE source LIKE 'auctionator-%'").all() as { h: number }[]).map((r) => r.h);
  const total = db.prepare("SELECT count(*) n, min(fetched_at) first, max(fetched_at) last FROM snapshot").get() as { n: number; first: number | null; last: number | null };
  let sizeBytes = 0;
  try { sizeBytes = statSync(dbPath).size + (statSync(`${dbPath}-wal`, { throwIfNoEntry: false })?.size ?? 0); } catch { /* missing file */ }
  return { sources, scans, perHouse, scanCount: total.n, firstScan: total.first, lastScan: total.last, hoursCoveredUtc: hours.sort((a, b) => a - b), sizeBytes };
}

export const BROWSE_SORTS = {
  name: "coalesce(i.name, '~')",
  price: `${PRICE}`,
  quantity: "s.quantity",
  usual: "st.median",
  sold: "g.sold_per_day",
  rate: "g.sale_rate",
  change: "change24h",
  pattern: "st.consistency",
} as const;
export type BrowseSort = keyof typeof BROWSE_SORTS;

/**
 * Every item in the house's latest snapshot, like an auction house list: filter by name, sort by any
 * column, paged. `change24h` compares with the snapshot closest to 24 h earlier (within 3 h).
 */
export function browseItems(
  db: Db,
  houseId: number,
  opts: { q?: string; sort?: string; dir?: string; page?: number; pageSize?: number; classId?: number | null; subclassId?: number | null; uncategorised?: boolean },
) {
  const snap = latestSnapshotId(db, houseId);
  if (snap === null) return { total: 0, page: 1, pageSize: 0, snapshotTs: null, rows: [] };
  const latestTs = (db.prepare("SELECT fetched_at t FROM snapshot WHERE id = ?").get(snap) as { t: number }).t;
  const prev = db
    .prepare(`SELECT id FROM snapshot WHERE house_id = ? AND source != 'auctionator-browse' AND abs(fetched_at - ?) <= 3 * 3600
              ORDER BY abs(fetched_at - ?) LIMIT 1`)
    .get(houseId, latestTs - 86400, latestTs - 86400) as { id: number } | undefined;

  const sortKey = (opts.sort ?? "sold") in BROWSE_SORTS ? (opts.sort as BrowseSort) : "sold";
  const dir = opts.dir === "asc" ? "ASC" : "DESC";
  const pageSize = Math.min(200, Math.max(10, opts.pageSize ?? 50));
  const page = Math.max(1, opts.page ?? 1);
  const term = (opts.q ?? "").trim();
  const byId = /^\d+$/.test(term);
  let where = term === "" ? "" : byId ? "AND s.item_id = :id" : "AND i.name LIKE :name";
  if (opts.uncategorised) where += " AND i.class_id IS NULL";
  else if (opts.classId !== null && opts.classId !== undefined) where += " AND i.class_id = :cls" + (opts.subclassId !== null && opts.subclassId !== undefined ? " AND i.subclass_id = :sub" : "");
  const params = {
    snap, prev: prev?.id ?? -1, house: houseId,
    ...(byId ? { id: Number(term) } : term ? { name: `%${term}%` } : {}),
    ...(opts.classId !== null && opts.classId !== undefined && !opts.uncategorised ? { cls: opts.classId } : {}),
    ...(opts.subclassId !== null && opts.subclassId !== undefined && !opts.uncategorised ? { sub: opts.subclassId } : {}),
  };

  const from = `
    FROM item_snapshot s
    LEFT JOIN item i ON i.item_id = s.item_id
    LEFT JOIN item_snapshot p ON p.snapshot_id = :prev AND p.item_id = s.item_id
    LEFT JOIN tsm_realm r ON r.item_id = s.item_id AND r.updated_at = (SELECT max(updated_at) FROM tsm_realm) AND :house = ${TSM_REALM_HOUSE}
    LEFT JOIN tsm_region g ON g.item_id = s.item_id AND g.updated_at = (SELECT max(updated_at) FROM tsm_region)
    LEFT JOIN stats_item st ON st.house_id = :house AND st.item_id = s.item_id
    WHERE s.snapshot_id = :snap ${where}`;
  const total = (db.prepare(`SELECT count(*) n ${from}`).get(params) as { n: number }).n;
  const rows = db
    .prepare(`
      SELECT s.item_id itemId, i.name, i.quality, i.icon_name icon, ${PRICE} price, s.quantity, st.median usual,
             g.sold_per_day soldPerDay, g.sale_rate saleRate, st.consistency patternHeld, st.pattern_days patternDays,
             CASE WHEN coalesce(p.price_20, p.min_buyout) > 0 AND ${PRICE} IS NOT NULL
                  THEN round(100.0 * (${PRICE} - coalesce(p.price_20, p.min_buyout)) / coalesce(p.price_20, p.min_buyout), 1) END change24h
      ${from}
      ORDER BY ${BROWSE_SORTS[sortKey]} IS NULL, ${BROWSE_SORTS[sortKey]} ${dir}, s.item_id
      LIMIT :limit OFFSET :offset`)
    .all({ ...params, limit: pageSize, offset: (page - 1) * pageSize });
  return { total, page, pageSize, snapshotTs: latestTs, sort: sortKey, dir: dir.toLowerCase(), rows };
}

/** TSM market value / EU average sale price over time, one point per stored TSM file version. */
export function tsmSeries(db: Db, itemId: number, houseId: number, since: number) {
  const market = houseId === TSM_REALM_HOUSE
    ? (db.prepare(`SELECT updated_at ts, market_value value FROM tsm_realm
                   WHERE item_id = ? AND updated_at >= ? AND market_value > 0 ORDER BY updated_at`)
        .all(itemId, since - 7 * 86400) as { ts: number; value: number }[])
    : [];
  const avgSale = db.prepare(`SELECT updated_at ts, avg_sale_price value FROM tsm_region
                              WHERE item_id = ? AND updated_at >= ? AND avg_sale_price > 0 ORDER BY updated_at`)
    .all(itemId, since - 7 * 86400) as { ts: number; value: number }[];
  return { market, avgSale };
}

/** Category tree for a house: classes and subclasses with how many items are listed in its latest snapshot. */
export function categories(db: Db, houseId: number) {
  const snap = latestSnapshotId(db, houseId);
  if (snap === null) return [];
  const rows = db.prepare(`
    SELECT i.class_id classId, i.subclass_id subclassId, count(*) items,
           coalesce(c.name, 'Class ' || i.class_id) className, coalesce(sc.name, 'Other') subclassName
    FROM item_snapshot s JOIN item i ON i.item_id = s.item_id
    LEFT JOIN item_class c ON c.class_id = i.class_id AND c.subclass_id = -1
    LEFT JOIN item_class sc ON sc.class_id = i.class_id AND sc.subclass_id = i.subclass_id
    WHERE s.snapshot_id = ? AND i.class_id IS NOT NULL
    GROUP BY i.class_id, i.subclass_id ORDER BY className, subclassName`).all(snap) as
    { classId: number; subclassId: number; items: number; className: string; subclassName: string }[];
  const tree = new Map<number, { classId: number; name: string; items: number; subclasses: { subclassId: number; name: string; items: number }[] }>();
  for (const r of rows) {
    let c = tree.get(r.classId);
    if (!c) tree.set(r.classId, (c = { classId: r.classId, name: r.className, items: 0, subclasses: [] }));
    c.items += r.items;
    c.subclasses.push({ subclassId: r.subclassId, name: r.subclassName, items: r.items });
  }
  const uncategorised = (db.prepare(`SELECT count(*) n FROM item_snapshot s LEFT JOIN item i ON i.item_id = s.item_id
    WHERE s.snapshot_id = ? AND i.class_id IS NULL`).get(snap) as { n: number }).n;
  return { classes: [...tree.values()], uncategorised };
}

/** Ranked opportunities for a buy house (or every house), optionally of one kind. */
export function listOpportunities(db: Db, opts: { houseId: number | null; kind: string | null; limit?: number; minMargin?: number; safeOnly?: boolean; includeUnprofitable?: boolean }) {
  return db.prepare(`
    SELECT o.kind, o.item_id itemId, o.house_id buyHouseId, o.sell_house_id sellHouseId, o.buy_price buyPrice,
           o.sell_price sellPrice, o.profit, o.margin, o.confidence, o.score, o.why, o.computed_at computedAt,
           i.name, i.quality, i.icon_name icon, i.class_id classId, g.sold_per_day soldPerDay, g.sale_rate saleRate,
           st.buy_hours buyHours, st.sell_hours sellHours, st.current, st.median,
           st.consistency patternHeld, st.pattern_days patternDays,
           o.safe_buy safeBuy, o.safe_sell safeSell, o.safe_profit safeProfit, o.safe_margin safeMargin, o.safe_evidence safeEvidence,
           o.sell_now sellNow, o.sell_now_ts sellNowTs, o.profit_now profitNow, o.margin_now marginNow,
           o.sell_item_id sellItemId, si.name sellName, si.quality sellQuality, o.convert_in convertIn, o.convert_out convertOut
    FROM stats_opportunity o
    LEFT JOIN item si ON si.item_id = o.sell_item_id
    LEFT JOIN item i ON i.item_id = o.item_id
    LEFT JOIN tsm_region g ON g.item_id = o.item_id AND g.updated_at = (SELECT max(updated_at) FROM tsm_region)
    LEFT JOIN stats_item st ON st.house_id = o.house_id AND st.item_id = o.item_id
    -- Between houses is judged on the now margin: selling straight away at the other house's price in
    -- your latest scan (Margin (N)). Without a recent scan of that house there is no now price, so no row.
    -- The Between houses tab also shows conversions (they are judged on the now margin too).
    WHERE (:house IS NULL OR o.house_id = :house) AND (:kind IS NULL OR o.kind = :kind OR (:kind = 'cross-house' AND o.kind = 'convert'))
      -- With includeUnprofitable, Between houses shows every item that sells on both houses.
      AND ((:all = 1 AND o.kind IN ('cross-house', 'convert'))
        OR (CASE WHEN o.kind IN ('cross-house', 'convert') THEN o.margin_now >= :minMargin ELSE o.margin >= :minMargin END
            AND (:safe = 0 OR (o.safe_evidence = 1 AND o.safe_margin >= :minMargin))))
    ORDER BY CASE WHEN :kind = 'cross-house' THEN coalesce(o.margin_now, -99) END DESC, o.score DESC LIMIT :limit`)
    .all({ house: opts.houseId, kind: opts.kind, limit: opts.limit ?? 100, minMargin: opts.minMargin ?? 0.1, safe: opts.safeOnly ? 1 : 0, all: opts.includeUnprofitable ? 1 : 0 });
}

export function listAnomalies(db: Db, houseId: number, limit = 100) {
  return db.prepare(`
    SELECT a.kind, a.item_id itemId, a.first_seen firstSeen, a.last_seen lastSeen, a.severity, a.detail,
           i.name, i.quality, i.icon_name icon, g.sold_per_day soldPerDay, st.current, st.median
    FROM stats_anomaly a
    LEFT JOIN item i ON i.item_id = a.item_id
    LEFT JOIN tsm_region g ON g.item_id = a.item_id AND g.updated_at = (SELECT max(updated_at) FROM tsm_region)
    LEFT JOIN stats_item st ON st.house_id = a.house_id AND st.item_id = a.item_id
    WHERE a.house_id = ? AND a.closed_at IS NULL
    -- Sharp events (spikes, crashes, buyouts) first; gradual price-level shifts after them.
    ORDER BY a.kind = 'new-normal', a.severity * sqrt(coalesce(g.sold_per_day, 0)) DESC LIMIT ?`).all(houseId, limit);
}

/** The statistics engine's view of one item on one house, plus its open opportunities and anomalies. */
export function itemStats(db: Db, itemId: number, houseId: number) {
  const s = db.prepare(`SELECT days, points, current, median, median3d, buy_price buyPrice, sell_price sellPrice,
      buy_hours buyHours, sell_hours sellHours, hour_medians hourMedians, consistency, pattern_days patternDays, z, computed_at computedAt
    FROM stats_item WHERE house_id = ? AND item_id = ?`).get(houseId, itemId) as Record<string, unknown> | undefined;
  const opportunities = db.prepare(`SELECT kind, house_id buyHouseId, sell_house_id sellHouseId, buy_price buyPrice, sell_price sellPrice,
      profit, margin, confidence, why FROM stats_opportunity WHERE item_id = ? AND (house_id = ? OR sell_house_id = ?)
      AND (kind NOT IN ('cross-house', 'convert') OR margin_now >= 0.05 OR margin >= 0.05) ORDER BY score DESC`)
    .all(itemId, houseId, houseId);
  const anomalies = db.prepare(`SELECT kind, severity, detail, first_seen firstSeen FROM stats_anomaly
      WHERE item_id = ? AND house_id = ? AND closed_at IS NULL ORDER BY severity DESC`).all(itemId, houseId);
  return { stats: s ? { ...s, hourMedians: JSON.parse(String(s.hourMedians)) } : null, opportunities, anomalies };
}

/**
 * What to buy and sell at the current hour on a house. Buy: time-flip items whose cheap hours include
 * this hour, and buy-now deals. Sell: time-flip items whose dear hours include this hour, and sell-now
 * items. Uses each item's latest price; `maxBuy` keeps `minMargin` after the house's cut.
 */
export function rightNow(db: Db, house: { houseId: number; cut: number }, utcHour: number, minMargin: number, safeOnly = false) {
  const rows = db.prepare(`
    SELECT o.kind, o.item_id itemId, o.buy_price modelBuy, o.sell_price modelSell, o.margin, o.confidence, o.score,
           o.safe_sell safeSell, o.safe_evidence safeEvidence, o.safe_margin safeMargin,
           st.current, st.median, st.buy_hours buyHours, st.sell_hours sellHours, st.consistency, st.pattern_days patternDays,
           i.name, i.quality, i.icon_name icon, i.class_id classId, g.sold_per_day soldPerDay
    FROM stats_opportunity o
    JOIN stats_item st ON st.house_id = o.house_id AND st.item_id = o.item_id
    LEFT JOIN item i ON i.item_id = o.item_id
    LEFT JOIN tsm_region g ON g.item_id = o.item_id AND g.updated_at = (SELECT max(updated_at) FROM tsm_region)
    WHERE o.house_id = :house AND o.sell_house_id = :house AND o.margin >= :minMargin
      AND (:safe = 0 OR (o.safe_evidence = 1 AND o.safe_margin >= :minMargin))
      AND (o.kind IN ('buy-now', 'sell-now')
           OR (o.kind = 'time-flip' AND (',' || st.buy_hours || ',' LIKE '%,' || :h || ',%'
                                      OR ',' || st.sell_hours || ',' LIKE '%,' || :h || ',%')))
    ORDER BY o.score DESC`).all({ house: house.houseId, minMargin, h: utcHour, safe: safeOnly ? 1 : 0 }) as {
      kind: string; itemId: number; modelBuy: number; modelSell: number; margin: number; confidence: number; score: number;
      safeSell: number | null; safeEvidence: number | null; safeMargin: number | null;
      current: number; median: number; buyHours: string; sellHours: string; consistency: number; patternDays: number;
      name: string | null; quality: number | null; icon: string | null; classId: number | null; soldPerDay: number | null;
    }[];

  const inHours = (csv: string) => csv.split(",").map(Number).includes(utcHour);
  const buy = [];
  const sell = [];
  const seenBuy = new Set<number>();
  const seenSell = new Set<number>();
  for (const r of rows) {
    const base = { itemId: r.itemId, name: r.name, quality: r.quality, icon: r.icon, classId: r.classId, soldPerDay: r.soldPerDay, current: r.current,
      usual: r.median, confidence: r.confidence, buyHours: r.buyHours, sellHours: r.sellHours,
      patternHeld: r.consistency, patternDays: r.patternDays };
    if ((r.kind === "time-flip" && inHours(r.buyHours)) || r.kind === "buy-now") {
      if (seenBuy.has(r.itemId)) continue;
      seenBuy.add(r.itemId);
      // What you expect to sell for: the dear-hour / usual price, or in safer mode its pessimistic (low typical) value.
      const target = safeOnly && r.safeSell ? r.safeSell : r.modelSell;
      const maxBuy = Math.floor((target * (1 - house.cut)) / (1 + minMargin));
      const profitAtCurrent = target * (1 - house.cut) - r.current;
      buy.push({ ...base, reason: r.kind, sellTarget: target, maxBuy, underMax: r.current <= maxBuy,
        profitAtCurrent, marginAtCurrent: profitAtCurrent / r.current });
    }
    if ((r.kind === "time-flip" && inHours(r.sellHours)) || r.kind === "sell-now") {
      if (seenSell.has(r.itemId)) continue;
      seenSell.add(r.itemId);
      // Posting below the current cheapest listing; worth it while that still beats the usual price.
      sell.push({ ...base, reason: r.kind, listAt: r.current, vsUsual: (r.current - r.median) / r.median,
        profitVsUsual: r.current * (1 - house.cut) - r.median });
    }
  }
  // Buys you can make at today's prices first, then by profit; sells by gold gained over the usual
  // price (a +600% on a 12c item is worth less than +30% on a 5g one).
  buy.sort((a, b) => Number(b.underMax) - Number(a.underMax) || b.profitAtCurrent - a.profitAtCurrent);
  sell.sort((a, b) => b.profitVsUsual - a.profitVsUsual);
  return { utcHour, minMargin, safeOnly, buy, sell };
}

export interface Lot { ts: number; qty: number; unit: number; house: string | null }

/** One sale from TSM's ledger, matched against your purchases (oldest first). */
export interface MatchedSale {
  itemId: number; ts: number; qty: number; unit: number; source: string | null; player: string;
  /** Units that came from your AH purchases, and what they cost; the rest were farmed, looted or crafted. */
  boughtQty: number; boughtCost: number;
}

/**
 * Units you bought on the AH and have not sold yet, per item, plus every sale matched to the purchases
 * it used up. Purchases: TSM's ledger (auction buys) plus any AH Tracker purchase records TSM missed.
 * Sales (auction or vendor) use up the oldest purchases first. AH Tracker's records also say which
 * house a purchase was on; TSM's do not.
 */
export function tradeBook(db: Db): { open: Map<number, Lot[]>; sales: MatchedSale[]; buys: (Lot & { itemId: number })[]; gone: Map<number, number> } {
  const ledger = db.prepare(`SELECT item_id itemId, ts, qty, price unit FROM tsm_ledger WHERE kind = 'buy' AND source = 'Auction'`)
    .all() as { itemId: number; ts: number; qty: number; unit: number }[];
  const own = db.prepare(`SELECT item_id itemId, ts, qty, unit, house FROM purchase`).all() as
    { itemId: number; ts: number; qty: number; unit: number; house: string | null }[];
  const buys: (Lot & { itemId: number; matched?: boolean })[] = ledger.map((b) => ({ ...b, house: null }));
  for (const p of own) {
    // TSM's ledger is the record of what you bought. AH Tracker's own purchase log adds which house it
    // was on: it tags TSM's buys of the item within 10 minutes. It only counts as a purchase itself when
    // TSM has no buy of the item that close (TSM missed it), never on top of TSM's rows (TSM may split
    // one purchase into several rows minutes apart, and the quantities need not match).
    const near = buys.filter((b) => b.itemId === p.itemId && b.matched !== true && Math.abs(b.ts - p.ts) <= 600);
    if (near.length) for (const b of near) { b.house ??= p.house; b.matched = true; }
    else if (!buys.some((b) => b.itemId === p.itemId && Math.abs(b.ts - p.ts) <= 600)) buys.push({ ...p, matched: true });
  }
  const sales = db.prepare(`SELECT item_id itemId, ts, qty, price unit, source, player FROM tsm_ledger WHERE kind = 'sale'`).all() as
    { itemId: number; ts: number; qty: number; unit: number; source: string | null; player: string }[];
  // TSM's count of what you owned when it last saved. At that moment, purchases beyond what you owned
  // were used, crafted, turned in or given away: they are written off (oldest first), not kept as stock.
  const holdingAt = Number((db.prepare("SELECT value FROM setting WHERE key = 'tsm_holding_at'").get() as { value: string } | undefined)?.value) || null;
  const owned = new Map((db.prepare("SELECT item_id id, sum(qty) q FROM tsm_holding GROUP BY item_id").all() as { id: number; q: number }[]).map((r) => [r.id, r.q]));
  type Ev = { ts: number; lot?: Lot; sale?: MatchedSale; check?: true };
  const events = new Map<number, Ev[]>();
  const push = (id: number, e: Ev) => { const list = events.get(id); if (list) list.push(e); else events.set(id, [e]); };
  for (const b of buys) push(b.itemId, { ts: b.ts, lot: { ts: b.ts, qty: b.qty, unit: b.unit, house: b.house } });
  for (const x of sales) push(x.itemId, { ts: x.ts, sale: { ...x, boughtQty: 0, boughtCost: 0 } });
  if (holdingAt) for (const evs of events.values()) evs.push({ ts: holdingAt, check: true });
  const open = new Map<number, Lot[]>();
  const gone = new Map<number, number>();
  const matched: MatchedSale[] = [];
  for (const [itemId, evs] of events) {
    // Same second: buys, then sales, then the holdings check.
    const order = (e: Ev) => (e.lot ? 0 : e.sale ? 1 : 2);
    evs.sort((a, b) => a.ts - b.ts || order(a) - order(b));
    const lots: Lot[] = [];
    for (const e of evs) {
      if (e.lot) { lots.push({ ...e.lot }); continue; }
      if (e.check) {
        let extra = lots.reduce((t, l) => t + l.qty, 0) - (owned.get(itemId) ?? 0);
        while (extra > 0 && lots.length) {
          const take = Math.min(extra, lots[0]!.qty);
          lots[0]!.qty -= take;
          extra -= take;
          gone.set(itemId, (gone.get(itemId) ?? 0) + take);
          if (lots[0]!.qty === 0) lots.shift();
        }
        continue;
      }
      const sale = e.sale!;
      let left = sale.qty; // what is left over when nothing was bought before it was farmed or looted
      while (left > 0 && lots.length) {
        const take = Math.min(left, lots[0]!.qty);
        sale.boughtQty += take;
        sale.boughtCost += take * lots[0]!.unit;
        lots[0]!.qty -= take;
        left -= take;
        if (lots[0]!.qty === 0) lots.shift();
      }
      matched.push(sale);
    }
    if (lots.length) open.set(itemId, lots);
  }
  return { open, gone, sales: matched.sort((a, b) => a.ts - b.ts), buys: buys.map(({ matched: _, ...b }) => b).sort((a, b) => a.ts - b.ts) };
}

export function openPurchases(db: Db): Map<number, Lot[]> {
  return tradeBook(db).open;
}

/** The newest `qty` units of the open lots: their count, average cost and the latest purchase. */
function heldCost(lots: Lot[] | undefined, qty: number) {
  let n = 0, cost = 0, lastTs: number | null = null, house: string | null = null;
  for (const l of [...(lots ?? [])].reverse()) {
    if (n >= qty) break;
    const take = Math.min(qty - n, l.qty);
    n += take;
    cost += take * l.unit;
    if (lastTs === null) { lastTs = l.ts; house = l.house; }
  }
  return { qty: n, unit: n ? cost / n : null, lastTs, house };
}

/**
 * Your sellable inventory across characters, priced on every tracked house. For each house:
 * target = dear-hour price if the daily pattern is reliable, else the usual price; "you get" per unit
 * = target x (1 - cut) - expected deposit loss on 2-hour listings. Best = the house that pays most.
 */
export function inventoryValuation(db: Db, houses: { houseId: number; key: string; label: string; cut: number }[]) {
  const items = db.prepare(`
    SELECT v.item_id itemId, sum(v.qty) qty, max(v.updated_at) scannedAt,
           group_concat(v.character || ' ' || v.location || ' ' || v.qty, ', ') heldBy,
           i.name, i.quality, i.icon_name icon, i.deposit_unit deposit, i.vendor_price vendor,
           g.sale_rate saleRate, g.sold_per_day soldPerDay, (x.item_id IS NOT NULL) ignored
    FROM inventory v
    LEFT JOIN inventory_ignore x ON x.item_id = v.item_id
    LEFT JOIN item i ON i.item_id = v.item_id
    LEFT JOIN tsm_region g ON g.item_id = v.item_id AND g.updated_at = (SELECT max(updated_at) FROM tsm_region)
    GROUP BY v.item_id`).all() as {
      itemId: number; qty: number; scannedAt: number; heldBy: string; name: string | null; quality: number | null; icon: string | null;
      deposit: number | null; vendor: number | null; saleRate: number | null; soldPerDay: number | null; ignored: number;
    }[];
  const ratios = (db.prepare("SELECT 1.0 * deposit_unit / vendor_price r FROM item WHERE deposit_unit > 0 AND vendor_price > 0").all() as { r: number }[])
    .map((x) => x.r).sort((a, b) => a - b);
  const ratio = ratios.length ? (ratios[Math.floor(ratios.length / 2)] as number) : 0;
  const stats = db.prepare(`SELECT current, median, sell_price sellPrice, consistency, pattern_days patternDays, sell_hours sellHours
    FROM stats_item WHERE house_id = ? AND item_id = ?`);
  const latest = db.prepare(`SELECT coalesce(s.price_20, s.min_buyout) price FROM item_snapshot s JOIN snapshot sn ON sn.id = s.snapshot_id
    WHERE sn.house_id = ? AND s.item_id = ? AND coalesce(s.price_20, s.min_buyout) > 0 ORDER BY s.ts DESC LIMIT 1`);
  const open = openPurchases(db);

  const rows = items.map((it) => {
    const deposit = it.deposit ?? (it.vendor && ratio ? Math.round(it.vendor * ratio) : 0);
    const s = Math.max(0.05, Math.min(1, it.saleRate ?? 0.2));
    const depositLoss = deposit * Math.min(5, (1 - s) / s);
    const perHouse = houses.map((h) => {
      const st = stats.get(h.houseId, it.itemId) as
        { current: number; median: number; sellPrice: number; consistency: number; patternDays: number; sellHours: string } | undefined;
      const now = st?.current ?? (latest.get(h.houseId, it.itemId) as { price: number } | undefined)?.price ?? null;
      const target = st ? (st.consistency >= 0.6 && st.patternDays >= 3 ? st.sellPrice : st.median) : now;
      const sells = sellsOn(h, it.itemId);
      const youGet = target && sells ? target * (1 - h.cut) - depositLoss : null;
      // Listing at the latest going price (low end of current listings) instead of waiting for the target.
      const youGetNow = now && sells ? now * (1 - h.cut) - depositLoss : null;
      return { key: h.key, label: h.label, now, usual: st?.median ?? null, target, youGet, youGetNow, sellHours: st?.sellHours ?? null, cut: h.cut };
    });
    const best = perHouse.filter((p) => p.youGet !== null && p.youGet > 0).sort((a, b) => (b.youGet as number) - (a.youGet as number))[0] ?? null;
    // Units held that you bought to resell (the rest were looted, farmed or crafted) and what they cost.
    const bought = heldCost(open.get(it.itemId), it.qty);
    const cost = bought.unit;
    return {
      ...it, ignored: it.ignored === 1, deposit, depositLoss, houses: perHouse,
      bestHouse: best?.key ?? null, bestLabel: best?.label ?? null,
      bestPerUnit: best?.youGet ?? null, value: best?.youGet ? best.youGet * it.qty : null,
      // How much more the best house pays than the other, per unit (a reason to carry it over).
      edgePerUnit: best && perHouse.length > 1
        ? (best.youGet as number) - Math.max(...perHouse.filter((p) => p !== best).map((p) => p.youGet ?? 0)) : null,
      purchasedQty: bought.qty, boughtAt: bought.lastTs, boughtOn: bought.house,
      paidPerUnit: cost, profit: cost && best?.youGet ? (best.youGet - cost) * bought.qty : null,
      // Profit or loss on the bought units if listed now at the latest going price on the house that pays most.
      ...(() => {
        const n = perHouse.filter((p) => p.youGetNow !== null).sort((a, b) => (b.youGetNow as number) - (a.youGetNow as number))[0];
        return {
          nowHouse: n?.key ?? null, nowPerUnit: n?.youGetNow ?? null,
          profitNow: cost && n?.youGetNow != null ? (n.youGetNow - cost) * bought.qty : null,
        };
      })(),
    };
  });
  rows.sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  const characters = db.prepare(`SELECT character, location, count(*) items, sum(qty) units, max(updated_at) scannedAt
    FROM inventory GROUP BY character, location ORDER BY character, location`).all();
  return { rows, characters, totalValue: rows.reduce((t, r) => t + (r.ignored ? 0 : r.value ?? 0), 0) };
}

/**
 * The Forecasts page: each item's trend, supply and next-days estimate on one house, plus how
 * accurate each forecasting method has been there. `view`: "rising" and "falling" are consistent
 * trends (|consistency| >= 0.5); "snap" are prices expected to move 5%+ back toward their recent level.
 */
export function listForecasts(db: Db, houseId: number, opts: { view: string; minPrice: number; minSold: number; classId?: number | null; limit?: number }) {
  const where = {
    rising: "f.trend > 0 AND f.consistency >= 0.5",
    falling: "f.trend < 0 AND f.consistency <= -0.5",
    snap: "abs(f.next / f.level - 1) >= 0.05",
  }[opts.view] ?? "1";
  const order = opts.view === "falling" ? "f.trend ASC" : opts.view === "snap" ? "abs(f.next / f.level - 1) DESC"
    : opts.view === "all" ? "g.sold_per_day IS NULL, g.sold_per_day DESC" : "f.trend DESC";
  const rows = db.prepare(`
    SELECT f.item_id itemId, i.name, i.quality, i.icon_name icon, f.days, f.level, f.next, f.trend, f.consistency,
           f.supply_trend supplyTrend, f.peak, f.low, f.skill, f.backtests, g.sold_per_day soldPerDay
    FROM stats_forecast f
    LEFT JOIN item i ON i.item_id = f.item_id
    LEFT JOIN tsm_region g ON g.item_id = f.item_id AND g.updated_at = (SELECT max(updated_at) FROM tsm_region)
    WHERE f.house_id = :house AND f.level >= :minPrice AND coalesce(g.sold_per_day, 0) >= :minSold AND ${where}
      AND (:cls IS NULL OR i.class_id = :cls)
    ORDER BY ${order} LIMIT :limit`).all({ house: houseId, minPrice: opts.minPrice, minSold: opts.minSold, cls: opts.classId ?? null, limit: opts.limit ?? 5000 });
  // Categories with forecasts on this house, for the filter (busiest first).
  const classes = db.prepare(`
    SELECT i.class_id classId, coalesce(c.name, 'Class ' || i.class_id) name, count(*) items, avg(g.sold_per_day) avgSold
    FROM stats_forecast f JOIN item i ON i.item_id = f.item_id
    LEFT JOIN item_class c ON c.class_id = i.class_id AND c.subclass_id = -1
    LEFT JOIN tsm_region g ON g.item_id = f.item_id AND g.updated_at = (SELECT max(updated_at) FROM tsm_region)
    WHERE f.house_id = ? AND i.class_id IS NOT NULL GROUP BY i.class_id ORDER BY avgSold DESC`).all(houseId);
  const methods = db.prepare("SELECT method, skill, wins, items, computed_at computedAt FROM stats_forecast_method WHERE house_id = ?").all(houseId);
  return { rows, methods, classes };
}

/**
 * How many of each item are listed on a house now: the latest whole-house snapshot, overridden by any
 * newer Auctionator browse scan of the item (last 6 hours). itemId -> quantity.
 */
export function listedQuantities(db: Db, houseId: number, now = Date.now() / 1000): Map<number, number> {
  const out = new Map<number, number>();
  const snap = latestSnapshotId(db, houseId);
  const snapTs = snap === null ? 0 : (db.prepare("SELECT fetched_at t FROM snapshot WHERE id = ?").get(snap) as { t: number }).t;
  if (snap !== null)
    for (const r of db.prepare("SELECT item_id id, quantity q FROM item_snapshot WHERE snapshot_id = ?").all(snap) as { id: number; q: number }[])
      out.set(r.id, r.q);
  const browse = db.prepare(`SELECT s.item_id id, s.quantity q FROM item_snapshot s JOIN snapshot sn ON sn.id = s.snapshot_id
    WHERE sn.house_id = ? AND sn.source = 'auctionator-browse' AND sn.fetched_at > ? AND sn.fetched_at > ? ORDER BY sn.fetched_at`)
    .all(houseId, snapTs, Math.floor(now) - 6 * 3600) as { id: number; q: number }[];
  for (const r of browse) out.set(r.id, r.q);
  return out;
}

/**
 * The Materials page: one profession's materials (a Trade Goods subcategory) on a house, each with its
 * cheapest listing right now (your latest scan or Undermine's latest snapshot, whichever is newer), its
 * usual price, and whether that cheapest listing is at snipe price (fraction of usual or less).
 */
export function materials(db: Db, houseId: number, subclass: string, fraction: number, extra: readonly string[] = []) {
  const rows = db.prepare(`
    SELECT i.item_id itemId, i.name, i.quality, i.icon_name icon, st.median usual, other.median usualOther, st.days,
           g.sold_per_day soldPerDay, f.trend, f.consistency, f.next
    FROM item i
    LEFT JOIN item_class sc ON sc.class_id = i.class_id AND sc.subclass_id = i.subclass_id
    LEFT JOIN stats_item st ON st.item_id = i.item_id AND st.house_id = :house
    LEFT JOIN stats_item other ON other.item_id = i.item_id AND other.house_id != :house
    LEFT JOIN stats_forecast f ON f.item_id = i.item_id AND f.house_id = :house
    LEFT JOIN tsm_region g ON g.item_id = i.item_id AND g.updated_at = (SELECT max(updated_at) FROM tsm_region)
    WHERE i.name IS NOT NULL AND ((i.class_id = 7 AND sc.name = :sub) OR i.name IN (SELECT value FROM json_each(:extra)))
    ORDER BY coalesce(g.sold_per_day, 0) DESC`).all({ sub: subclass, house: houseId, extra: JSON.stringify(extra) }) as {
      itemId: number; name: string; icon: string | null; usual: number | null; usualOther: number | null; soldPerDay: number | null; [k: string]: unknown }[];
  const latest = db.prepare(`SELECT s.min_buyout cheapest, s.quantity listed, s.ts, sn.source FROM item_snapshot s
    JOIN snapshot sn ON sn.id = s.snapshot_id WHERE s.item_id = ? AND sn.house_id = ? AND s.min_buyout > 0 ORDER BY s.ts DESC LIMIT 1`);
  return rows.map((r) => {
    const l = latest.get(r.itemId, houseId) as { cheapest: number; listed: number; ts: number; source: string } | undefined;
    // Judged against the lower of the two houses' usual prices (on Neutral, usually Alliance's).
    const reference = r.usual && r.usualOther ? Math.min(r.usual, r.usualOther) : r.usual ?? r.usualOther;
    const snipeAt = reference ? Math.floor(reference * fraction) : null;
    return {
      ...r, reference, cheapest: l?.cheapest ?? null, listed: l?.listed ?? null, seenAt: l?.ts ?? null,
      fromScan: l ? l.source.startsWith("auctionator") : null,
      vsUsual: l && reference ? l.cheapest / reference : null,
      vsOther: l && r.usualOther ? l.cheapest / r.usualOther : null,
      snipeAt, isSnipe: !!(l && snipeAt && l.cheapest <= snipeAt),
    };
  });
}


/**
 * Essence conversions at the cheapest listings right now (your latest scan or Undermine's latest
 * snapshot): buy 3 Lesser and sell the Greater they make ("combine"), or buy a Greater and sell the 3
 * Lesser it splits into ("split"), on one house or carried to the other. Profit is per Greater, after
 * the selling house's AH cut (deposits are left out: they come back when the listing sells).
 */
export function essenceConversions(db: Db, houses: { houseId: number; key: string; label: string; cut: number }[]) {
  const idOf = db.prepare("SELECT item_id id FROM item WHERE name = ?");
  const latest = db.prepare(`SELECT s.min_buyout p, s.quantity q, s.ts FROM item_snapshot s JOIN snapshot sn ON sn.id = s.snapshot_id
    WHERE s.item_id = ? AND sn.house_id = ? AND s.min_buyout > 0 ORDER BY s.ts DESC LIMIT 1`);
  const price = (id: number | undefined, h: { houseId: number }) =>
    id ? ((latest.get(id, h.houseId) as { p: number; q: number; ts: number } | undefined) ?? null) : null;
  return ESSENCE_PAIRS.map((pair) => {
    const L = (idOf.get(pair.lesser) as { id: number } | undefined)?.id;
    const G = (idOf.get(pair.greater) as { id: number } | undefined)?.id;
    const prices = Object.fromEntries(houses.map((h) => [h.key, { lesser: price(L, h), greater: price(G, h) }]));
    const routes: { kind: "combine" | "split"; buy: string; sell: string; cost: number; get: number; profit: number; margin: number }[] = [];
    for (const b of houses) for (const s of houses) {
      const pb = prices[b.key]!, ps = prices[s.key]!;
      if (pb.lesser && ps.greater) {
        const cost = 3 * pb.lesser.p, get = ps.greater.p * (1 - s.cut);
        routes.push({ kind: "combine", buy: b.key, sell: s.key, cost, get, profit: get - cost, margin: (get - cost) / cost });
      }
      if (pb.greater && ps.lesser) {
        const cost = pb.greater.p, get = 3 * ps.lesser.p * (1 - s.cut);
        routes.push({ kind: "split", buy: b.key, sell: s.key, cost, get, profit: get - cost, margin: (get - cost) / cost });
      }
    }
    routes.sort((a, b) => b.profit - a.profit);
    return { ...pair, lesserId: L ?? null, greaterId: G ?? null, prices, routes, best: routes[0] ?? null };
  });
}

/**
 * Cheapest listing, quantity and time for every item on a house right now: the latest whole-house
 * snapshot, overridden by your newer Auctionator scans (last 6 hours).
 */
export function latestPrices(db: Db, houseId: number, now = Date.now() / 1000): Map<number, { price: number; qty: number; ts: number; scan: boolean }> {
  const out = new Map<number, { price: number; qty: number; ts: number; scan: boolean }>();
  const snap = latestSnapshotId(db, houseId);
  const snapTs = snap === null ? 0 : (db.prepare("SELECT fetched_at t FROM snapshot WHERE id = ?").get(snap) as { t: number }).t;
  if (snap !== null)
    for (const r of db.prepare("SELECT item_id id, min_buyout p, quantity q, ts FROM item_snapshot WHERE snapshot_id = ? AND min_buyout > 0").all(snap) as { id: number; p: number; q: number; ts: number }[])
      out.set(r.id, { price: r.p, qty: r.q, ts: r.ts, scan: false });
  const browse = db.prepare(`SELECT s.item_id id, s.min_buyout p, s.quantity q, s.ts FROM item_snapshot s JOIN snapshot sn ON sn.id = s.snapshot_id
    WHERE sn.house_id = ? AND sn.source = 'auctionator-browse' AND sn.fetched_at > ? AND sn.fetched_at > ? AND s.min_buyout > 0 ORDER BY sn.fetched_at`)
    .all(houseId, snapTs, Math.floor(now) - 6 * 3600) as { id: number; p: number; q: number; ts: number }[];
  for (const r of browse) out.set(r.id, { price: r.p, qty: r.q, ts: r.ts, scan: true });
  return out;
}

/**
 * The Shuffles page: every item listed on both houses, with the profit of each route: buy at the
 * cheapest listing now, sell after that house's AH cut, minus expected lost deposits (from the item's
 * sale rate). Between houses the sell price is the other house's cheapest listing now; on the same
 * house it is that house's usual price (7-day median). Routes selling where nobody buys are left out.
 */
export function shuffles(db: Db, houses: { houseId: number; key: string; label: string; cut: number }[], only?: { subclass: string; extra: readonly string[] }) {
  const alliance = houses.find((h) => h.key === "alliance")!, neutral = houses.find((h) => h.key === "neutral")!;
  const A = latestPrices(db, alliance.houseId), N = latestPrices(db, neutral.houseId);
  const ratios = (db.prepare("SELECT 1.0 * deposit_unit / vendor_price r FROM item WHERE deposit_unit > 0 AND vendor_price > 0").all() as { r: number }[])
    .map((x) => x.r).sort((a, b) => a - b);
  const ratio = ratios.length ? (ratios[Math.floor(ratios.length / 2)] as number) : 0;
  const info = db.prepare(`SELECT i.name, i.quality, i.icon_name icon, i.class_id classId, i.deposit_unit deposit, i.vendor_price vendor,
      g.sold_per_day soldPerDay, g.sale_rate saleRate
    FROM item i LEFT JOIN tsm_region g ON g.item_id = i.item_id AND g.updated_at = (SELECT max(updated_at) FROM tsm_region) WHERE i.item_id = ?`);
  const usual = db.prepare("SELECT median FROM stats_item WHERE house_id = ? AND item_id = ?");
  // Optionally just one profession's materials (a Trade Goods subcategory plus named extras).
  const allowed = only ? new Set((db.prepare(`SELECT i.item_id id FROM item i
      LEFT JOIN item_class sc ON sc.class_id = i.class_id AND sc.subclass_id = i.subclass_id
      WHERE (i.class_id = 7 AND sc.name = ?) OR i.name IN (SELECT value FROM json_each(?))`).all(only.subclass, JSON.stringify(only.extra)) as { id: number }[]).map((r) => r.id)) : null;
  const rows = [];
  for (const [id, n] of N) {
    const a = A.get(id);
    if (!a || (allowed && !allowed.has(id))) continue;
    const it = info.get(id) as { name: string | null; quality: number | null; icon: string | null; classId: number | null; deposit: number | null;
      vendor: number | null; soldPerDay: number | null; saleRate: number | null } | undefined;
    if (!it?.name) continue;
    const deposit = it.deposit ?? (it.vendor && ratio ? Math.round(it.vendor * ratio) : 0);
    const s = Math.max(0.05, Math.min(1, it.saleRate ?? 0.2));
    const depositLoss = deposit * Math.min(5, (1 - s) / s);
    const usualA = (usual.get(alliance.houseId, id) as { median: number } | undefined)?.median ?? null;
    const usualN = (usual.get(neutral.houseId, id) as { median: number } | undefined)?.median ?? null;
    // route key "<buy>><sell>": [buy price, sell price, sell house]
    const legs: [string, number, number | null, typeof alliance][] = [
      ["neutral>alliance", n.price, a.price, alliance],
      ["alliance>neutral", a.price, n.price, neutral],
      ["alliance>alliance", a.price, usualA, alliance],
      ["neutral>neutral", n.price, usualN, neutral],
    ];
    const routes: Record<string, { buy: number; sell: number; profit: number; margin: number }> = {};
    for (const [key, buy, sell, house] of legs) {
      if (sell === null || !sellsOn(house, id)) continue;
      const profit = sell * (1 - house.cut) - buy - depositLoss;
      routes[key] = { buy, sell, profit: Math.round(profit), margin: profit / buy };
    }
    rows.push({
      itemId: id, name: it.name, quality: it.quality, icon: it.icon, classId: it.classId, soldPerDay: it.soldPerDay,
      neutral: n, alliance: a, usualA, usualN, routes,
    });
  }
  return rows;
}

/** Essence conversions as Shuffles rows: per conversion, on each route, at the cheapest listings now. */
export function conversionShuffles(db: Db, houses: { houseId: number; key: string; label: string; cut: number }[]) {
  const byKey = Object.fromEntries(houses.map((h) => [h.key, h]));
  const prices = Object.fromEntries(houses.map((h) => [h.key, latestPrices(db, h.houseId)]));
  const item = db.prepare("SELECT item_id id, name, quality, icon_name icon FROM item WHERE name = ?");
  const sold = db.prepare("SELECT sold_per_day s FROM tsm_region WHERE item_id = ? AND updated_at = (SELECT max(updated_at) FROM tsm_region)");
  const rows = [];
  for (const c of CONVERSIONS) {
    const from = item.get(c.from) as { id: number; name: string; quality: number | null; icon: string | null } | undefined;
    const to = item.get(c.to) as { id: number; name: string } | undefined;
    if (!from || !to) continue;
    const routes: Record<string, { buy: number; sell: number; profit: number; margin: number }> = {};
    for (const b of houses) for (const s of houses) {
      const pb = prices[b.key]!.get(from.id), ps = prices[s.key]!.get(to.id);
      if (!pb || !ps) continue;
      const cost = c.fromQty * pb.price, get = c.toQty * ps.price * (1 - byKey[s.key]!.cut);
      routes[`${b.key}>${s.key}`] = { buy: cost, sell: c.toQty * ps.price, profit: Math.round(get - cost), margin: (get - cost) / cost };
    }
    rows.push({
      itemId: from.id, name: `${c.fromQty} ${c.from} → ${c.toQty} ${c.to}`, quality: from.quality, icon: from.icon, classId: 7,
      conversion: { verb: c.verb, from: c.from, to: c.to, fromQty: c.fromQty, toQty: c.toQty },
      soldPerDay: (sold.get(to.id) as { s: number } | undefined)?.s ?? null,
      neutral: prices.neutral!.get(from.id) ?? null, alliance: prices.alliance!.get(from.id) ?? null, routes,
    });
  }
  return rows;
}

/**
 * The forecasting model's latest results: its test report and, for horizons that beat both baselines,
 * its forecasts for EU PvP Alliance trade goods (itemId -> horizon -> forecast).
 */
export function modelForecasts(db: Db) {
  const row = db.prepare("SELECT computed_at t, report FROM ml_eval ORDER BY computed_at DESC LIMIT 1").get() as { t: number; report: string } | undefined;
  if (!row) return { computedAt: null, report: null, forecasts: {} as Record<number, Record<string, unknown>> };
  const report = JSON.parse(row.report) as { evals: Record<string, { passed: boolean; groups?: Record<string, { passed: boolean }> } | null> };
  // A horizon is used for an item when the model passed overall and on the item's group (trade goods, or
  // the other watched items). Reports from before groups were scored covered trade goods only.
  const usable = (h: string, grp: string) => {
    const e = report.evals[h];
    if (!e?.passed) return false;
    return e.groups ? Boolean(e.groups[grp]?.passed) : grp === "trade";
  };
  const forecasts: Record<number, Record<string, { now: number; q10: number; q50: number; q90: number; pUp: number }>> = {};
  for (const f of db.prepare(`SELECT f.item_id id, f.horizon h, f.price_now p, f.q10, f.q50, f.q90, f.p_up u,
      CASE WHEN i.class_id = 7 THEN 'trade' ELSE 'other' END grp FROM ml_forecast f LEFT JOIN item i ON i.item_id = f.item_id`).all() as
    { id: number; h: string; p: number; q10: number; q50: number; q90: number; u: number; grp: string }[]) {
    if (!usable(f.h, f.grp)) continue;
    (forecasts[f.id] ??= {})[f.h] = { now: f.p, q10: f.q10, q50: f.q50, q90: f.q90, pUp: f.u };
  }
  return { computedAt: row.t, report, forecasts };
}

const HORIZON_SECONDS: Record<string, number> = { "1d": 86400, "3d": 3 * 86400, "7d": 7 * 86400 };

type ScoreStats = { n: number; maeModel: number; maeNaive: number; skill: number; bias: number; direction: number; cover: number };

/** Typical log errors of the model's median and of "no change", their ratio, mean signed error, direction hits, 80% range hits. */
function scoreStats(rows: { err: number; naive: number; hit: boolean; inside: boolean }[]): ScoreStats | null {
  if (!rows.length) return null;
  const mean = (f: (r: (typeof rows)[number]) => number) => rows.reduce((s, r) => s + f(r), 0) / rows.length;
  const maeModel = mean((r) => Math.abs(r.err)), maeNaive = mean((r) => Math.abs(r.naive));
  return {
    n: rows.length, maeModel, maeNaive, skill: maeNaive > 0 ? 1 - maeModel / maeNaive : 0,
    bias: mean((r) => r.err), direction: mean((r) => (r.hit ? 1 : 0)), cover: mean((r) => (r.inside ? 1 : 0)),
  };
}

/**
 * Live scoreboard for the forecasts the model actually published (ml_forecast_log): each forecast whose
 * target time (made_at + horizon) has passed is compared with what happened on EU PvP Alliance, the median
 * lowest buyout of the Undermine snapshots within 3 hours of the target (the price the model learns from).
 * Forecasts whose target fell in the last `days` days are scored per horizon and group (trade goods, other),
 * and per run so drift (like a run whose forecasts all lean one way) shows up.
 */
export function modelScoreboard(db: Db, now = Date.now() / 1000, days = 7) {
  const WINDOW = 3 * 3600;
  const since = now - days * 86400;
  const logged = db.prepare(`SELECT f.item_id id, f.horizon h, f.made_at t, f.price_now p, f.q10, f.q50, f.q90,
      CASE WHEN i.class_id = 7 THEN 'trade' ELSE 'other' END grp
    FROM ml_forecast_log f LEFT JOIN item i ON i.item_id = f.item_id
    WHERE f.made_at >= ? ORDER BY f.made_at`).all(since - 7 * 86400) as
    { id: number; h: string; t: number; p: number; q10: number; q50: number; q90: number; grp: string }[];
  const actualAt = db.prepare(`SELECT s.min_buyout v FROM item_snapshot s JOIN snapshot sn ON sn.id = s.snapshot_id
    WHERE s.item_id = ? AND s.ts BETWEEN ? AND ? AND sn.house_id = ${TSM_REALM_HOUSE} AND sn.source = 'undermine' AND s.min_buyout > 0`);
  const median = (v: number[]) => {
    const s = [...v].sort((a, b) => a - b), m = s.length >> 1;
    return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
  };

  type Scored = { h: string; grp: string; t: number; err: number; naive: number; hit: boolean; inside: boolean };
  const scored: Scored[] = [];
  let pending = 0, missing = 0;
  for (const f of logged) {
    const secs = HORIZON_SECONDS[f.h];
    if (!secs) continue;
    const target = f.t + secs;
    if (target + WINDOW > now) { pending++; continue; } // not over yet, or its window is still filling
    if (target < since) continue;
    const prices = (actualAt.all(f.id, target - WINDOW, target + WINDOW) as { v: number }[]).map((r) => r.v);
    if (!prices.length || !(f.p > 0) || !(f.q50 > 0)) { missing++; continue; }
    const actual = median(prices);
    const move = Math.log(actual / f.p), predicted = Math.log(f.q50 / f.p);
    scored.push({
      h: f.h, grp: f.grp, t: f.t, err: predicted - move, naive: -move,
      hit: Math.sign(predicted) === Math.sign(move), inside: actual >= f.q10 && actual <= f.q90,
    });
  }

  const horizons = Object.keys(HORIZON_SECONDS).filter((h) => scored.some((s) => s.h === h));
  const byHorizon: Record<string, { all: ScoreStats | null; trade: ScoreStats | null; other: ScoreStats | null }> = {};
  for (const h of horizons) {
    const rows = scored.filter((s) => s.h === h);
    byHorizon[h] = { all: scoreStats(rows), trade: scoreStats(rows.filter((s) => s.grp === "trade")), other: scoreStats(rows.filter((s) => s.grp === "other")) };
  }
  const runs = [...new Set(scored.map((s) => s.t))].sort((a, b) => b - a).map((t) => ({
    madeAt: t,
    horizons: Object.fromEntries(horizons.map((h) => [h, scoreStats(scored.filter((s) => s.t === t && s.h === h))])),
  }));
  const oldest = db.prepare("SELECT min(made_at) t FROM ml_forecast_log").get() as { t: number | null };
  return { days, horizons: byHorizon, runs, scored: scored.length, pending, missing, loggedSince: oldest.t };
}
