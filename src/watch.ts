// Watchlist: items you are thinking of buying, rechecked every few hours. Each check works out, for PvP
// Alliance (the house you trade on):
// - trend: Theil-Sen slope of the daily price over the last 4 days (and 7 days, for context), % per day;
// - supply: the same over the quantity listed, last 7 days;
// - forecast: the pooled model's 3-day forecast (1-day when 3-day is not usable), only horizons that
//   passed the model's own walk-forward test;
// - other realms: the average 7-day trend on EU Horde, US Alliance and US Horde.
// Each is turned into a label (rising/flat/falling, up/unclear/down, ...). A notification goes out when a
// label changes, or when the price has moved 15%+ since the last notification about the item. Labels
// change only past a clear threshold and change back only past a looser one, so an item sitting on a
// boundary does not flip-flop every check.
//
// buy_below is your own buy price: the item goes on the [WATCH] Auctionator list with that limit, and you
// are notified when the cheapest Alliance listing drops to it (once; re-armed 3% above).
import { HOUSES } from "./config.ts";
import { setSetting, transaction, type Db } from "./db/db.ts";
import { modelForecasts } from "./api/queries.ts";
import { theilSen } from "./stats/forecast.ts";
import { appNotify, type Notify } from "./alerts.ts";
import type { ShoppingList } from "./stats/lists.ts";
import { REF_MARKETS } from "./ingest/markets.ts";

export const WATCH_HOUSE = HOUSES.find((h) => h.key === "alliance")!;
/** Hours between checks (the scheduler's interval). */
export const WATCH_HOURS = 3;
/** Price move since the last notification that is worth one on its own. */
export const BIG_MOVE = 0.15;

export type Trend = "rising" | "flat" | "falling" | "unknown";
export type Outlook = "up" | "unclear" | "down" | "none";
export type Supply = "growing" | "steady" | "shrinking" | "unknown";
export interface ModelView { horizon: string; q10: number; q50: number; q90: number; pUp: number; change: number }
export interface WatchSignals {
  price: number | null; priceTs: number | null; qty: number | null;
  /** Fractions per day. */
  trend4: number | null; trend7: number | null; supply7: number | null; realms7: number | null;
  realmsCount: number;
  model: ModelView | null;
  labels: { trend: Trend; model: Outlook; realms: Trend; supply: Supply };
}

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[s.length >> 1]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2; };

/** Daily medians of price and quantity, days with 3+ points. */
function daily(pts: { ts: number; p: number; q: number }[]) {
  const by = new Map<number, { p: number[]; q: number[] }>();
  for (const x of pts) {
    const d = Math.floor(x.ts / 86400);
    let a = by.get(d);
    if (!a) by.set(d, (a = { p: [], q: [] }));
    a.p.push(x.p); a.q.push(x.q);
  }
  return [...by].filter(([, a]) => a.p.length >= 3).map(([d, a]) => ({ d, p: median(a.p), q: median(a.q) })).sort((a, b) => a.d - b.d);
}
/** Theil-Sen trend over the last `days` daily points, as a fraction per day; null with fewer than 4 points. */
function trendOf(ds: { d: number; p: number; q: number }[], days: number, key: "p" | "q" = "p"): number | null {
  const t = ds.slice(-days).filter((x) => x[key] > 0);
  if (t.length < 4) return null;
  return Math.exp(theilSen(t.map((x) => x.d), t.map((x) => Math.log(x[key]))).slope) - 1;
}

/** A three-way label with hysteresis: enter at ±enter, keep while beyond ±stay. */
function band<T extends string>(v: number | null, prev: T | undefined, enter: number, stay: number, [up, mid, down, unknown]: [T, T, T, T]): T {
  if (v === null) return unknown;
  if (v >= enter || (prev === up && v >= stay)) return up;
  if (v <= -enter || (prev === down && v <= -stay)) return down;
  return mid;
}

function outlook(m: ModelView | null, prev: Outlook | undefined): Outlook {
  if (!m) return "none";
  if ((m.pUp >= 0.6 && m.change >= 0.03) || (prev === "up" && m.pUp >= 0.55 && m.change >= 0.01)) return "up";
  if ((m.pUp <= 0.4 && m.change <= -0.03) || (prev === "down" && m.pUp <= 0.45 && m.change <= -0.01)) return "down";
  return "unclear";
}

/** Latest cheapest Alliance listing, any source (Auctionator scans included, so it is as fresh as possible). */
function latestPrice(db: Db, itemId: number) {
  return db.prepare(`SELECT s.min_buyout p, s.quantity q, s.ts FROM item_snapshot s JOIN snapshot sn ON sn.id = s.snapshot_id
    WHERE s.item_id = ? AND sn.house_id = ? AND s.min_buyout > 0 ORDER BY s.ts DESC LIMIT 1`).get(itemId, WATCH_HOUSE.houseId) as
    { p: number; q: number; ts: number } | undefined;
}

export function watchSignals(db: Db, itemId: number, prev: WatchSignals["labels"] | null, now: number,
  models = modelForecasts(db).forecasts): WatchSignals {
  // Browse scans hold only the cheapest unit of a few items: kept out of the daily series like everywhere else.
  const pts = db.prepare(`SELECT s.ts, s.min_buyout p, s.quantity q FROM item_snapshot s JOIN snapshot sn ON sn.id = s.snapshot_id
    WHERE s.item_id = ? AND sn.house_id = ? AND sn.source != 'auctionator-browse' AND s.min_buyout > 0 AND s.ts >= ?
    ORDER BY s.ts`).all(itemId, WATCH_HOUSE.houseId, now - 8 * 86400) as { ts: number; p: number; q: number }[];
  const ds = daily(pts);
  const refTrends = REF_MARKETS.map((m) => trendOf(daily(db.prepare(`SELECT ts, price p, qty q FROM ref_price
    WHERE market = ? AND item_id = ? AND price > 0 AND ts >= ? ORDER BY ts`).all(m.key, itemId, now - 8 * 86400) as { ts: number; p: number; q: number }[]), 7))
    .filter((t): t is number => t !== null);
  const f = models[itemId] as Record<string, { now: number; q10: number; q50: number; q90: number; pUp: number }> | undefined;
  const h = f?.["3d"] ? "3d" : f?.["1d"] ? "1d" : null;
  const model = h && f ? { horizon: h, q10: f[h]!.q10, q50: f[h]!.q50, q90: f[h]!.q90, pUp: f[h]!.pUp, change: f[h]!.q50 / f[h]!.now - 1 } : null;
  const last = latestPrice(db, itemId);
  const trend4 = trendOf(ds, 4), trend7 = trendOf(ds, 7), supply7 = trendOf(ds, 7, "q");
  const realms7 = refTrends.length ? refTrends.reduce((a, b) => a + b, 0) / refTrends.length : null;
  return {
    price: last?.p ?? null, priceTs: last?.ts ?? null, qty: last?.q ?? null,
    trend4, trend7, supply7, realms7, realmsCount: refTrends.length, model,
    labels: {
      trend: band(trend4, prev?.trend, 0.02, 0.01, ["rising", "flat", "falling", "unknown"]),
      model: outlook(model, prev?.model),
      realms: band(realms7, prev?.realms, 0.01, 0.005, ["rising", "flat", "falling", "unknown"]),
      supply: band(supply7, prev?.supply, 0.05, 0.03, ["growing", "steady", "shrinking", "unknown"]),
    },
  };
}

const gold = (c: number) => {
  const g = Math.floor(c / 10000), s = Math.floor((c % 10000) / 100), cu = Math.round(c % 100);
  return [g ? `${g}g` : "", s ? `${s}s` : "", !g && cu ? `${cu}c` : ""].filter(Boolean).join(" ") || "0c";
};
const pct = (v: number | null) => (v === null ? "?" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`);
const modelText = (m: ModelView | null) => (m ? `${m.horizon} forecast ${gold(m.q50)} (${pct(m.change)}, ${Math.round(m.pUp * 100)}% chance up)` : "no forecast");

export interface WatchRow { itemId: number; name: string; buyBelow: number | null; note: string | null; signals: WatchSignals | null; checkedAt: number | null }

export function watchItems(db: Db): WatchRow[] {
  return (db.prepare(`SELECT w.item_id itemId, coalesce(i.name, 'Item ' || w.item_id) name, w.buy_below buyBelow, w.note, w.signals, w.checked_at checkedAt
    FROM watch_item w LEFT JOIN item i ON i.item_id = w.item_id ORDER BY i.name`).all() as (Omit<WatchRow, "signals"> & { signals: string | null })[])
    .map((r) => ({ ...r, signals: r.signals ? (JSON.parse(r.signals) as WatchSignals) : null }));
}

export interface WatchChange { itemId: number; name: string; lines: string[]; isNew: boolean }

/** Rechecks every watched item and notifies about changes since the last check. Returns what changed. */
export function checkWatchlist(db: Db, now = Math.floor(Date.now() / 1000), notify: Notify = appNotify(db, now)): WatchChange[] {
  const models = modelForecasts(db).forecasts;
  const refs = new Map((db.prepare("SELECT item_id id, notified_price p FROM watch_item").all() as { id: number; p: number | null }[]).map((r) => [r.id, r.p]));
  const changes: WatchChange[] = [];
  const up = db.prepare("UPDATE watch_item SET signals = ?, checked_at = ?, notified_price = ? WHERE item_id = ?");
  transaction(db, () => {
    for (const w of watchItems(db)) {
      const prev = w.signals?.labels ?? null;
      const s = watchSignals(db, w.itemId, prev, now, models);
      const lines: string[] = [];
      if (prev) {
        // Changes between known states only: an item gaining or losing data (unknown/none) is not news.
        const known = (a: string, b: string) => a !== b && !["unknown", "none"].includes(a) && !["unknown", "none"].includes(b);
        if (known(prev.trend, s.labels.trend)) lines.push(`trend ${prev.trend} → ${s.labels.trend} (${pct(s.trend4)}/day over 4 days)`);
        if (known(prev.model, s.labels.model)) lines.push(`forecast ${prev.model} → ${s.labels.model}: ${modelText(s.model)}`);
        if (known(prev.realms, s.labels.realms)) lines.push(`other realms ${prev.realms} → ${s.labels.realms} (${pct(s.realms7)}/day)`);
        if (known(prev.supply, s.labels.supply)) lines.push(`supply ${prev.supply} → ${s.labels.supply} (${pct(s.supply7)}/day)`);
      }
      const ref = refs.get(w.itemId) ?? null;
      const moved = ref && s.price ? s.price / ref - 1 : 0;
      if (Math.abs(moved) >= BIG_MOVE) lines.push(`price ${moved > 0 ? "up" : "down"} ${Math.abs(Math.round(moved * 100))}% since the last alert (${gold(ref!)} → ${gold(s.price!)})`);
      const isNew = !prev;
      if (isNew) lines.push(`trend ${s.labels.trend} (${pct(s.trend4)}/day), ${modelText(s.model)}, other realms ${s.labels.realms}, supply ${s.labels.supply}`);
      // The big-move reference moves only when we tell you something, so a slow drift still adds up to an alert.
      const newRef = lines.length || ref === null ? s.price : ref;
      up.run(JSON.stringify(s), now, newRef, w.itemId);
      if (lines.length) changes.push({ itemId: w.itemId, name: w.name, lines: [...lines, `now ${s.price ? gold(s.price) : "?"}${w.buyBelow ? `, your buy price ${gold(w.buyBelow)}` : ""}`], isNew });
    }
  });
  const news = changes.filter((c) => !c.isNew), added = changes.filter((c) => c.isNew);
  if (news.length) {
    const title = news.length === 1 ? `Watchlist: ${news[0]!.name} changed` : `Watchlist: ${news.length} items changed`;
    notify(title, news.map((c) => `${c.name}: ${c.lines.join("; ")}`).join("\n"), { kind: "watch", itemId: news.length === 1 ? news[0]!.itemId : undefined });
  }
  if (added.length)
    notify(`Watching ${added.length} new item${added.length > 1 ? "s" : ""}`, added.map((c) => `${c.name}: ${c.lines.join("; ")}`).join("\n"), { kind: "watch" });
  return changes;
}

/** Notifies when a watched item's cheapest Alliance listing is at or below your buy price. Cheap: runs after every scan. */
export function checkWatchBuys(db: Db, now = Math.floor(Date.now() / 1000), notify: Notify = appNotify(db, now)): { itemId: number; name: string }[] {
  const fired: { itemId: number; name: string; price: number; qty: number; buyBelow: number }[] = [];
  const rows = db.prepare(`SELECT w.item_id id, coalesce(i.name, 'Item ' || w.item_id) name, w.buy_below b, w.buy_triggered t
    FROM watch_item w LEFT JOIN item i ON i.item_id = w.item_id WHERE w.buy_below IS NOT NULL`).all() as { id: number; name: string; b: number; t: number }[];
  const set = db.prepare("UPDATE watch_item SET buy_triggered = ? WHERE item_id = ?");
  transaction(db, () => {
    for (const r of rows) {
      const p = latestPrice(db, r.id);
      if (!p) continue;
      if (p.p <= r.b && !r.t) { fired.push({ itemId: r.id, name: r.name, price: p.p, qty: p.q, buyBelow: r.b }); set.run(1, r.id); }
      else if (r.t && p.p > r.b * 1.03) set.run(0, r.id);
    }
  });
  for (const f of fired)
    notify(`Buy price reached: ${f.name}`, `Cheapest on ${WATCH_HOUSE.label} is ${gold(f.price)} (your buy price ${gold(f.buyBelow)}), ${f.qty} listed. It is on the [WATCH] shopping list.`,
      { kind: "watch-buy", itemId: f.itemId });
  return fired;
}

/** The [WATCH] Auctionator list: watched items with a buy price, that price as the limit. */
export function buildWatchList(db: Db): ShoppingList {
  const items = (db.prepare(`SELECT w.item_id itemId, i.name, w.buy_below maxPrice FROM watch_item w JOIN item i ON i.item_id = w.item_id
    WHERE w.buy_below IS NOT NULL AND i.name IS NOT NULL ORDER BY i.name`).all() as { itemId: number; name: string; maxPrice: number }[])
    .map((r) => ({ ...r, maxPrice: Math.floor(r.maxPrice) }));
  return { name: `[WATCH] AHT ${WATCH_HOUSE.label} · Buy on dips`, items };
}

/**
 * Set when buy prices change: the poller then rewrites the TSM groups (watched items' Sniper subgroups)
 * once WoW is closed. A setting, because the dashboard and the poller are separate processes.
 */
export const TSM_GROUPS_DIRTY_KEY = "tsm_groups_dirty";

/** Adds, updates or removes a watched item. buyBelow in copper; undefined keeps the current one. */
export function setWatch(db: Db, itemId: number, opts: { buyBelow?: number | null; note?: string | null; remove?: boolean }, now = Math.floor(Date.now() / 1000)) {
  setSetting(db, TSM_GROUPS_DIRTY_KEY, 1);
  if (opts.remove) return void db.prepare("DELETE FROM watch_item WHERE item_id = ?").run(itemId);
  db.prepare(`INSERT INTO watch_item (item_id, buy_below, note, created_at) VALUES (:id, :b, :n, :now)
    ON CONFLICT (item_id) DO UPDATE SET
      buy_below = CASE WHEN :setB = 1 THEN :b ELSE watch_item.buy_below END,
      buy_triggered = CASE WHEN :setB = 1 THEN 0 ELSE watch_item.buy_triggered END,
      note = CASE WHEN :setN = 1 THEN :n ELSE watch_item.note END`)
    .run({ id: itemId, b: opts.buyBelow ?? null, n: opts.note ?? null, now, setB: opts.buyBelow !== undefined ? 1 : 0, setN: opts.note !== undefined ? 1 : 0 });
}
