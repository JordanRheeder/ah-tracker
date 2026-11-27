// Other Forever PvP markets as supporting evidence for forecasting your own (EU PvP Alliance stays the
// source of truth): hourly history of every trade good from Undermine Exchange, about the last 14 days
// per call (3 points). Each item is refreshed once a day, within the hourly rate limit.
import { transaction, type Db } from "../db/db.ts";
import type { Config } from "../config.ts";
import { budgetRemaining, get } from "./undermine.ts";

export const REF_MARKETS = [
  { key: "eu-horde", region: "euf", realm: "pvp-horde", label: "EU PvP Horde" },
  { key: "us-alliance", region: "usf", realm: "pvp-alliance", label: "US PvP Alliance" },
  { key: "us-horde", region: "usf", realm: "pvp-horde", label: "US PvP Horde" },
] as const;
const COST = 3;
const REFRESH_SECONDS = 24 * 3600;
/**
 * Items the forecasting model covers (ml/forecast.py uses the same rule): every trade good, plus anything
 * on the watchlist. SQL over item alias i.
 */
export const MODEL_ITEMS = "(i.class_id = 7 OR i.item_id IN (SELECT item_id FROM watch_item))";

/** (market, item) pairs to fetch next: never fetched first, then the stalest older than a day. */
export function refQueue(db: Db, limit: number, now = Math.floor(Date.now() / 1000)): { market: (typeof REF_MARKETS)[number]; itemId: number }[] {
  const items = (db.prepare(`SELECT i.item_id id FROM item i
    LEFT JOIN tsm_region g ON g.item_id = i.item_id AND g.updated_at = (SELECT max(updated_at) FROM tsm_region)
    WHERE ${MODEL_ITEMS} ORDER BY coalesce(g.sold_per_day, 0) DESC`).all() as { id: number }[]).map((r) => r.id);
  const fetched = db.prepare("SELECT fetched_at t FROM ref_backfill WHERE market = ? AND item_id = ?");
  const due: { market: (typeof REF_MARKETS)[number]; itemId: number; age: number }[] = [];
  for (const itemId of items)
    for (const market of REF_MARKETS) {
      const t = (fetched.get(market.key, itemId) as { t: number } | undefined)?.t;
      if (t === undefined || now - t > REFRESH_SECONDS) due.push({ market, itemId, age: t === undefined ? Infinity : now - t });
    }
  // Never-fetched first (busiest items first, interleaving markets), then the stalest.
  return due.sort((a, b) => (a.age === Infinity) === (b.age === Infinity) ? (a.age === Infinity ? 0 : b.age - a.age) : a.age === Infinity ? -1 : 1).slice(0, limit);
}

/** Fetches as many queued histories as the rate limit allows (keeping `reservePoints` free). */
export async function refBackfillBatch(db: Db, config: Config, maxItems: number, fetchImpl = fetch) {
  let done = 0, errors = 0, points = 0;
  const ins = db.prepare("INSERT OR IGNORE INTO ref_price (market, item_id, ts, price, qty) VALUES (?, ?, ?, ?, ?)");
  const mark = db.prepare(`INSERT INTO ref_backfill (market, item_id, points, fetched_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (market, item_id) DO UPDATE SET points = excluded.points, fetched_at = excluded.fetched_at`);
  for (const { market, itemId } of refQueue(db, maxItems)) {
    if (budgetRemaining() < config.undermine.reservePoints + COST) return { done, errors, points, stoppedForBudget: true };
    try {
      const r = await get<{ hourly: { snapshot: string; price: number | null; quantity: number }[] }>(
        config, `/realm/${market.region}/${market.realm}/items/${itemId}/hourly.json`, fetchImpl);
      transaction(db, () => {
        for (const p of r.hourly ?? []) {
          if (!p.quantity) continue;
          ins.run(market.key, itemId, Math.floor(Date.parse(p.snapshot) / 1000), p.price && p.price > 0 ? p.price : null, p.quantity);
          points++;
        }
        mark.run(market.key, itemId, r.hourly?.length ?? 0, Math.floor(Date.now() / 1000));
      });
      done++;
    } catch (err) {
      errors++;
      if ((err as { httpStatus?: number }).httpStatus === 429) return { done, errors, points, stoppedForBudget: true };
      // Not listed on that market: remember it so it is not asked for again until tomorrow.
      if ((err as { httpStatus?: number }).httpStatus === 404) mark.run(market.key, itemId, 0, Math.floor(Date.now() / 1000));
    }
  }
  return { done, errors, points, stoppedForBudget: false };
}

export function refProgress(db: Db) {
  const items = (db.prepare(`SELECT count(*) n FROM item i WHERE ${MODEL_ITEMS}`).get() as { n: number }).n;
  return REF_MARKETS.map((m) => ({ market: m.key, done: (db.prepare("SELECT count(*) n FROM ref_backfill WHERE market = ?").get(m.key) as { n: number }).n, total: items }));
}
