// Undermine Exchange (https://undermine.exchange/api.html): hourly Forever snapshots for every item,
// around the clock. House summaries keep the database current; per-item hourly history backfills the
// past. Both land in snapshot/item_snapshot as source "undermine" with summary semantics (cheapest
// unit price + total quantity; price_20 and percentiles stay NULL).
import type { Config, House } from "../config.ts";
import { transaction, type Db } from "../db/db.ts";

const API = "https://api.undermine.exchange/v1";

/** Rate-limit state from the last response's headers (3000 points per sliding hour). */
const budget = { remaining: Number.POSITIVE_INFINITY, resetAt: 0, seenAt: 0 };

/**
 * Points left, as of the last response. The window slides, so a reading older than 5 minutes is
 * treated as unknown: the next request goes ahead and refreshes it (a 429 still pauses the backfill).
 */
export function budgetRemaining(now = Date.now()): number {
  if (now >= budget.resetAt || now - budget.seenAt > 5 * 60_000) return Number.POSITIVE_INFINITY;
  return budget.remaining;
}

export async function get<T>(config: Config, path: string, fetchImpl = fetch): Promise<T> {
  const res = await fetchImpl(`${API}${path}`, {
    headers: { Authorization: `ApiKey ${config.undermine.apiKey}`, "Accept-Encoding": "gzip" },
  });
  const remaining = Number(res.headers.get("ratelimit-remaining"));
  const reset = Number(res.headers.get("ratelimit-reset"));
  if (Number.isFinite(remaining)) {
    budget.remaining = remaining;
    budget.seenAt = Date.now();
  }
  if (Number.isFinite(reset)) budget.resetAt = Date.now() + reset * 1000;
  if (!res.ok) throw Object.assign(new Error(`Undermine ${path}: HTTP ${res.status}`), { httpStatus: res.status });
  return ((await res.json()) as { result: T }).result;
}

const toSec = (iso: string) => Math.floor(Date.parse(iso) / 1000);

/** One snapshot row per house and Undermine snapshot time, shared by summaries and backfill. */
function ensureSnapshot(db: Db, house: House, ts: number): number {
  const hash = `undermine:${house.ueRealm}:${ts}`;
  db.prepare(
    `INSERT OR IGNORE INTO snapshot (source, house_id, fetched_at, content_hash, auction_count, item_count)
     VALUES ('undermine', ?, ?, ?, 0, 0)`,
  ).run(house.houseId, ts, hash);
  return (db.prepare("SELECT id FROM snapshot WHERE house_id = ? AND content_hash = ?").get(house.houseId, hash) as { id: number }).id;
}

function insertPoint(db: Db) {
  return db.prepare(
    `INSERT OR IGNORE INTO item_snapshot (snapshot_id, item_id, ts, min_buyout, price_20, p10, p25, p50, quantity, listings)
     VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, NULL)`,
  );
}

interface ItemsResult {
  snapshot: string;
  items: Record<string, { item: number; price: number | null; quantity: number }>;
}

/** Stores the latest whole-house summary (every item's cheapest price and quantity). */
export async function pollHouseSummary(db: Db, config: Config, house: House, fetchImpl = fetch) {
  const r = await get<ItemsResult>(config, `/realm/${config.undermine.region}/${house.ueRealm}/items.json`, fetchImpl);
  const ts = toSec(r.snapshot);
  const items = Object.values(r.items).filter((i) => i.quantity > 0);
  const existing = db.prepare("SELECT item_count FROM snapshot WHERE house_id = ? AND content_hash = ?")
    .get(house.houseId, `undermine:${house.ueRealm}:${ts}`) as { item_count: number } | undefined;
  if (existing && existing.item_count > 0) return { stored: false, ts, items: items.length };
  transaction(db, () => {
    const id = ensureSnapshot(db, house, ts);
    const ins = insertPoint(db);
    for (const i of items) ins.run(id, i.item, ts, i.price && i.price > 0 ? i.price : null, i.quantity);
    db.prepare("UPDATE snapshot SET item_count = ? WHERE id = ?").run(items.length, id);
  });
  return { stored: true, ts, items: items.length };
}

interface HourlyResult {
  hourly: { snapshot: string; price: number | null; quantity: number }[];
}

/** Stores an item's hourly history (about the last 14 days) for one house. */
export async function backfillItem(db: Db, config: Config, house: House, itemId: number, fetchImpl = fetch) {
  const r = await get<HourlyResult>(config, `/realm/${config.undermine.region}/${house.ueRealm}/items/${itemId}/hourly.json`, fetchImpl);
  let added = 0;
  transaction(db, () => {
    const ins = insertPoint(db);
    for (const p of r.hourly ?? []) {
      if (!p.quantity) continue;
      const ts = toSec(p.snapshot);
      const res = ins.run(ensureSnapshot(db, house, ts), itemId, ts, p.price && p.price > 0 ? p.price : null, p.quantity);
      added += Number(res.changes);
    }
    db.prepare(
      `INSERT INTO ue_backfill (house_id, item_id, points, done_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (house_id, item_id) DO UPDATE SET points = excluded.points, done_at = excluded.done_at`,
    ).run(house.houseId, itemId, r.hourly?.length ?? 0, Math.floor(Date.now() / 1000));
  });
  return { points: r.hourly?.length ?? 0, added };
}

/**
 * Items still to backfill for a house: every item in the house's latest Undermine summary, busiest
 * EU sellers first (TSM region sold_per_day), then the rest. `backfillMinSoldPerDay` > 0 limits it.
 */
export function backfillQueue(db: Db, config: Config, house: House, limit: number): number[] {
  return (db
    .prepare(
      `WITH latest AS (
         SELECT id FROM snapshot WHERE house_id = :house AND source = 'undermine' AND item_count > 0
         ORDER BY fetched_at DESC LIMIT 1)
       SELECT s.item_id FROM item_snapshot s
       LEFT JOIN tsm_region g ON g.item_id = s.item_id AND g.updated_at = (SELECT max(updated_at) FROM tsm_region)
       WHERE s.snapshot_id = (SELECT id FROM latest)
         AND coalesce(g.sold_per_day, 0) >= :min
         AND NOT EXISTS (SELECT 1 FROM ue_backfill b WHERE b.house_id = :house AND b.item_id = s.item_id)
       ORDER BY g.sold_per_day IS NULL, g.sold_per_day DESC, s.item_id LIMIT :limit`,
    )
    .all({ house: house.houseId, min: config.undermine.backfillMinSoldPerDay, limit }) as { item_id: number }[]).map((r) => r.item_id);
}

export function backfillProgress(db: Db, config: Config, house: House) {
  const total = (db.prepare(
    `SELECT count(*) n FROM item_snapshot s
     LEFT JOIN tsm_region g ON g.item_id = s.item_id AND g.updated_at = (SELECT max(updated_at) FROM tsm_region)
     WHERE s.snapshot_id = (SELECT id FROM snapshot WHERE house_id = ? AND source = 'undermine' AND item_count > 0
                            ORDER BY fetched_at DESC LIMIT 1)
       AND coalesce(g.sold_per_day, 0) >= ?`,
  ).get(house.houseId, config.undermine.backfillMinSoldPerDay) as { n: number }).n;
  const done = (db.prepare("SELECT count(*) n FROM ue_backfill WHERE house_id = ?").get(house.houseId) as { n: number }).n;
  return { done, total: Math.max(total, done) };
}

/**
 * Backfills as many queued items as the rate limit allows, keeping `reservePoints` free for the
 * hourly summaries. Each per-item history costs 3 points.
 */
export async function backfillBatch(db: Db, config: Config, houses: House[], maxItems = 200, fetchImpl = fetch) {
  const COST = 3;
  let done = 0;
  let errors = 0;
  // Alternate between houses so every house gets its busiest items early.
  const queues = houses.map((house) => ({ house, items: backfillQueue(db, config, house, maxItems) }));
  for (let round = 0; done < maxItems && queues.some((q) => round < q.items.length); round++) {
    for (const q of queues) {
      const itemId = q.items[round];
      if (itemId === undefined) continue;
      if (done >= maxItems) return { done, errors, stoppedForBudget: false };
      if (budgetRemaining() < config.undermine.reservePoints + COST) return { done, errors, stoppedForBudget: true };
      try {
        await backfillItem(db, config, q.house, itemId, fetchImpl);
        done++;
      } catch (err) {
        errors++;
        if ((err as { httpStatus?: number }).httpStatus === 429) return { done, errors, stoppedForBudget: true };
        if (errors >= 5) throw err;
      }
    }
  }
  return { done, errors, stoppedForBudget: false };
}
