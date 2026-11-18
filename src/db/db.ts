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
  const row = db.prepare("SELECT version FROM schema_version").get() as { version: number } | undefined;
  if (!row) db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION);
  return db;
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
