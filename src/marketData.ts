// Shareable market data: auction house scans and public price data, without anything personal.
// `export-market-data` writes a gzipped SQLite file; `import-market-data` merges one into your database.
//
// Only the tables listed in MARKET_TABLES are copied. Everything else stays private, including tables
// added later: purchases, the TSM ledger (buys, sales, gold, money, holdings, characters), inventory,
// price targets, alerts, notifications, settings and the watchlist.
import { createReadStream, createWriteStream, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { openDb, type Db } from "./db/db.ts";

/** Market tables that are safe to share, and the columns blanked on export. */
export const MARKET_TABLES: Record<string, { blank?: string[] }> = {
  item: {},
  item_class: {},
  snapshot: { blank: ["raw_path"] }, // local file path (contains your home folder); the raw files are not exported
  item_snapshot: {},
  ref_price: {},
  ref_backfill: {},
  ue_backfill: {},
  tsm_realm: {},
  tsm_region: {},
};

function columns(db: Db, schema: string, table: string): string[] {
  return (db.prepare(`PRAGMA ${schema}.table_info("${table}")`).all() as { name: string }[]).map((c) => c.name);
}

/** Copies the market tables from `srcPath` into a new gzipped SQLite file at `outPath`. */
export async function exportMarketData(srcPath: string, outPath: string): Promise<Record<string, number>> {
  const tmp = mkdtempSync(join(tmpdir(), "aht-export-"));
  const plain = join(tmp, "market.sqlite");
  const counts: Record<string, number> = {};
  try {
    const out = openDb(plain); // same schema as a normal database, all tables empty
    out.exec("PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF");
    out.prepare("ATTACH DATABASE ? AS src").run(srcPath);
    out.exec("BEGIN");
    for (const [table, { blank = [] }] of Object.entries(MARKET_TABLES)) {
      const cols = columns(out, "main", table).filter((c) => columns(out, "src", table).includes(c));
      const select = cols.map((c) => (blank.includes(c) ? `NULL AS "${c}"` : `"${c}"`)).join(", ");
      const list = cols.map((c) => `"${c}"`).join(", ");
      counts[table] = Number(out.prepare(`INSERT INTO main."${table}" (${list}) SELECT ${select} FROM src."${table}"`).run().changes);
    }
    out.exec("COMMIT");
    out.exec("DETACH DATABASE src");
    // Belt and braces: every other table must be empty in the export.
    for (const { name } of out.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]) {
      if (name in MARKET_TABLES || name === "schema_version" || name.startsWith("sqlite_")) continue;
      const n = (out.prepare(`SELECT count(*) n FROM "${name}"`).get() as { n: number }).n;
      if (n) throw new Error(`export would include ${n} private row(s) from ${name}; aborting`);
    }
    out.exec("VACUUM");
    out.close();
    await pipeline(createReadStream(plain), createGzip({ level: 9 }), createWriteStream(outPath));
    return counts;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Merges an exported market data file into `db`. Rows you already have win; scans are matched by
 * house and content, so importing the same file twice adds nothing.
 */
export async function importMarketData(db: Db, file: string): Promise<Record<string, number>> {
  if (!existsSync(file)) throw new Error(`${file} not found`);
  const tmp = mkdtempSync(join(tmpdir(), "aht-import-"));
  const plain = join(tmp, "market.sqlite");
  const counts: Record<string, number> = {};
  try {
    if (file.endsWith(".gz")) await pipeline(createReadStream(file), createGunzip(), createWriteStream(plain));
    else await pipeline(createReadStream(file), createWriteStream(plain));
    if (statSync(plain).size === 0) throw new Error("empty file");
    db.prepare("ATTACH DATABASE ? AS imp").run(plain);
    try {
      db.exec("BEGIN");
      for (const table of Object.keys(MARKET_TABLES)) {
        if (table === "snapshot" || table === "item_snapshot") continue;
        const cols = columns(db, "main", table).filter((c) => columns(db, "imp", table).includes(c)).map((c) => `"${c}"`).join(", ");
        counts[table] = Number(db.prepare(`INSERT OR IGNORE INTO main."${table}" (${cols}) SELECT ${cols} FROM imp."${table}"`).run().changes);
      }
      // Snapshots get new ids here; item rows follow them through (house_id, content_hash), which is unique.
      counts.snapshot = Number(db.prepare(`INSERT OR IGNORE INTO main.snapshot (house_id, fetched_at, last_modified, content_hash, auction_count, item_count, raw_path, source)
        SELECT house_id, fetched_at, last_modified, content_hash, auction_count, item_count, NULL, source FROM imp.snapshot`).run().changes);
      const cols = columns(db, "imp", "item_snapshot").filter((c) => c !== "snapshot_id" && columns(db, "main", "item_snapshot").includes(c));
      counts.item_snapshot = Number(db.prepare(`INSERT OR IGNORE INTO main.item_snapshot (snapshot_id, ${cols.map((c) => `"${c}"`).join(", ")})
        SELECT m.id, ${cols.map((c) => `i."${c}"`).join(", ")}
        FROM imp.item_snapshot i
        JOIN imp.snapshot s ON s.id = i.snapshot_id
        JOIN main.snapshot m ON m.house_id = s.house_id AND m.content_hash = s.content_hash`).run().changes);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    } finally {
      db.exec("DETACH DATABASE imp");
    }
    return counts;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
