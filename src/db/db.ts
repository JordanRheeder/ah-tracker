import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const SCHEMA_VERSION = 1;

export type Db = DatabaseSync;

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(readFileSync(resolve(import.meta.dirname, "schema.sql"), "utf8"));
  migrate(db);
  const row = db.prepare("SELECT version FROM schema_version").get() as { version: number } | undefined;
  if (!row) db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION);
  return db;
}

/** Adds a column, tolerating another process (collector or dashboard) having just added it. */
function addColumn(db: Db, sql: string) {
  try {
    db.exec(sql);
  } catch (err) {
    if (!/duplicate column name/i.test(String((err as Error).message))) throw err;
  }
}

/** Brings databases created by earlier versions up to the current schema. */
function migrate(db: Db) {
  const cols = (db.prepare("PRAGMA table_info(snapshot)").all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes("source")) addColumn(db, "ALTER TABLE snapshot ADD COLUMN source TEXT NOT NULL DEFAULT 'blizzard'");

  const itemCols = (db.prepare("PRAGMA table_info(item)").all() as { name: string }[]).map((c) => c.name);
  for (const [col, type] of [
    ["class_id", "INTEGER"], ["subclass_id", "INTEGER"], ["quality", "INTEGER"], ["icon_file_id", "INTEGER"],
    ["equip_loc", "TEXT"], ["icon_name", "TEXT"], ["wowhead_checked_at", "INTEGER"],
    ["vendor_price", "INTEGER"], ["deposit_unit", "INTEGER"],
  ] as const)
    if (!itemCols.includes(col)) addColumn(db, `ALTER TABLE item ADD COLUMN ${col} ${type}`);

  const oppCols = (db.prepare("PRAGMA table_info(stats_opportunity)").all() as { name: string }[]).map((c) => c.name);
  for (const [col, type] of [["safe_buy", "REAL"], ["safe_sell", "REAL"], ["safe_profit", "REAL"], ["safe_margin", "REAL"], ["safe_evidence", "INTEGER"],
    ["sell_now", "REAL"], ["sell_now_ts", "INTEGER"], ["profit_now", "REAL"], ["margin_now", "REAL"],
    ["sell_item_id", "INTEGER"], ["convert_in", "INTEGER"], ["convert_out", "INTEGER"]] as const)
    if (!oppCols.includes(col)) addColumn(db, `ALTER TABLE stats_opportunity ADD COLUMN ${col} ${type}`);

  // item_snapshot.listings became nullable (browse-scan summaries have no listing count).
  const listings = (db.prepare("PRAGMA table_info(item_snapshot)").all() as { name: string; notnull: number }[]).find(
    (c) => c.name === "listings",
  );
  if (listings?.notnull) {
    transaction(db, () => {
      db.exec(`ALTER TABLE item_snapshot RENAME TO item_snapshot_old;
        DROP INDEX IF EXISTS item_snapshot_item_time;`);
      db.exec(readFileSync(resolve(import.meta.dirname, "schema.sql"), "utf8").replace(/PRAGMA[^;]*;/g, ""));
      db.exec(`INSERT INTO item_snapshot SELECT * FROM item_snapshot_old; DROP TABLE item_snapshot_old;`);
    });
  }
}

export function transaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function logFetch(
  db: Db,
  entry: {
    source: string;
    startedAt: number;
    durationMs: number;
    status: "stored" | "unchanged" | "error";
    httpStatus?: number | undefined;
    bytes?: number | undefined;
    detail?: string | undefined;
  },
): void {
  db.prepare(
    `INSERT INTO fetch_log (source, started_at, duration_ms, status, http_status, bytes, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.source,
    entry.startedAt,
    entry.durationMs,
    entry.status,
    entry.httpStatus ?? null,
    entry.bytes ?? null,
    entry.detail ?? null,
  );
}

/** A user setting, or `fallback` when unset or unreadable. */
export function getSetting(db: Db, key: string, fallback: number): number {
  try {
    const row = db.prepare("SELECT value FROM setting WHERE key = ?").get(key) as { value: string } | undefined;
    const n = row ? Number(row.value) : Number.NaN;
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback; // table missing on a read-only connection to an old database
  }
}

export function setSetting(db: Db, key: string, value: number): void {
  db.prepare("INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, String(value));
}

/** Minimum profit margin for opportunities and shopping-list prices (0.1 = 10%). */
export const MIN_MARGIN_KEY = "min_margin";
export const DEFAULT_MIN_MARGIN = Number(process.env.LIST_TARGET_MARGIN ?? 0.1);
/** "Safer trades only": margins must hold in the pessimistic case and the evidence bar must be met. On by default. */
export const SAFE_ONLY_KEY = "safe_only";
export const safeOnly = (db: Db) => getSetting(db, SAFE_ONLY_KEY, 1) === 1;

/** No trade is ever suggested below this margin, whatever the setting says. */
export const MIN_MARGIN_FLOOR = 0.05;
export const minMargin = (db: Db) => Math.max(MIN_MARGIN_FLOOR, getSetting(db, MIN_MARGIN_KEY, DEFAULT_MIN_MARGIN));

/**
 * The item toggle selected on the dashboard's Opportunities page, which also decides the in-game
 * Between houses lists: null (all items), "tg" (trade goods), "quest" or "other".
 */
export const LIST_GOODS_KEY = "list_goods";
const GOODS_CODES = [null, "tg", "quest", "other"] as const;
export function listGoods(db: Db): "tg" | "quest" | "other" | null {
  return GOODS_CODES[getSetting(db, LIST_GOODS_KEY, 0)] ?? null;
}
export function goodsCode(goods: unknown): number {
  const i = GOODS_CODES.indexOf((goods || null) as (typeof GOODS_CODES)[number]);
  return i < 0 ? 0 : i;
}

/** Snipe price as a share of the usual price (0.5 = half price or less). */
export const SNIPE_FRACTION_KEY = "snipe_fraction";
export function snipeFraction(db: Db): number {
  return getSetting(db, SNIPE_FRACTION_KEY, Number(process.env.SNIPE_FRACTION ?? 0.5));
}

/**
 * Which way you carry Between houses trades and conversions: 0 both, 1 only buy on Neutral and sell on
 * Alliance, 2 only buy on Alliance and sell on Neutral. Applies to the dashboard and the in-game lists.
 */
export const CROSS_DIRECTION_KEY = "cross_direction";
export function crossDirection(db: Db): 0 | 1 | 2 {
  const v = getSetting(db, CROSS_DIRECTION_KEY, 0);
  return v === 1 || v === 2 ? v : 0;
}
/** Whether a trade bought on `buyKey` and sold on `sellKey` is in the direction you carry. */
export function directionAllows(dir: 0 | 1 | 2, buyKey: string, sellKey: string): boolean {
  if (dir === 1) return buyKey === "neutral" && sellKey === "alliance";
  if (dir === 2) return buyKey === "alliance" && sellKey === "neutral";
  return true;
}
