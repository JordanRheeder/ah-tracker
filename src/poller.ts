// Polling jobs: Blizzard every BLIZZARD_POLL_MINUTES, TSM every TSM_POLL_MINUTES, raw pruning daily.
import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { hasBlizzardCredentials, type Config } from "./config.ts";
import { logFetch, type Db } from "./db/db.ts";
import { fetchHouse, lastStoredSnapshot, storeSnapshot } from "./ingest/blizzard.ts";
import { fetchTsm, storeTsm, type TsmKind } from "./ingest/tsm.ts";

const nowSec = () => Math.floor(Date.now() / 1000);

function errorDetail(err: unknown) {
  const e = err as { message?: string; httpStatus?: number };
  return { detail: e.message ?? String(err), httpStatus: e.httpStatus };
}

let lastModifiedHeader: string | null = null;

export async function pollBlizzard(db: Db, config: Config): Promise<string> {
  if (!hasBlizzardCredentials(config)) return "blizzard: skipped, no credentials in .env";
  const started = Date.now();
  const startedAt = nowSec();
  try {
    const res = await fetchHouse(config, lastModifiedHeader);
    if (res.body === null) {
      logFetch(db, { source: "blizzard", startedAt, durationMs: Date.now() - started, status: "unchanged", httpStatus: 304 });
      return "blizzard: not modified";
    }
    lastModifiedHeader = res.lastModified;
    const result = storeSnapshot(db, {
      houseId: config.blizzard.houseId,
      body: res.body,
      fetchedAt: startedAt,
      lastModified: res.lastModified,
      dataDir: config.dataDir,
      buyoutIsStackTotal: config.blizzard.buyoutIsStackTotal,
    });
    logFetch(db, {
      source: "blizzard",
      startedAt,
      durationMs: Date.now() - started,
      status: result.stored ? "stored" : "unchanged",
      httpStatus: res.status,
      bytes: Buffer.byteLength(res.body),
      detail: result.stored
        ? `snapshot ${result.snapshotId}: ${result.auctions} auctions, ${result.items} items, ${result.goneLikelySold} likely sold, ${result.goneExpired} expired`
        : "same content as a stored snapshot",
    });
    return result.stored
      ? `blizzard: stored snapshot ${result.snapshotId} (${result.auctions} auctions, ${result.items} items)`
      : "blizzard: unchanged content";
  } catch (err) {
    const { detail, httpStatus } = errorDetail(err);
    logFetch(db, { source: "blizzard", startedAt, durationMs: Date.now() - started, status: "error", httpStatus, detail });
    return `blizzard: error - ${detail}`;
  }
}

export async function pollTsm(db: Db, config: Config, kind: TsmKind): Promise<string> {
  const started = Date.now();
  const startedAt = nowSec();
  const source = `tsm-${kind}`;
  try {
    const res = await fetchTsm(config, kind);
    const result = storeTsm(db, kind, res.body, startedAt);
    const when = result.updatedAt ? new Date(result.updatedAt * 1000).toISOString() : "unknown";
    logFetch(db, {
      source,
      startedAt,
      durationMs: Date.now() - started,
      status: result.stored ? "stored" : "unchanged",
      httpStatus: res.status,
      bytes: Buffer.byteLength(res.body),
      detail: `${result.rows} rows, updatedAt ${when}`,
    });
    return `${source}: ${result.stored ? "stored" : "unchanged"} (${result.rows} rows, updatedAt ${when})`;
  } catch (err) {
    const { detail, httpStatus } = errorDetail(err);
    logFetch(db, { source, startedAt, durationMs: Date.now() - started, status: "error", httpStatus, detail });
    return `${source}: error - ${detail}`;
  }
}

/** IN-3: deletes raw snapshot files older than the retention window; aggregates are kept. */
export function pruneRaw(db: Db, config: Config): string {
  const cutoff = nowSec() - config.rawRetentionDays * 86400;
  const rawDir = join(config.dataDir, "raw");
  let removed = 0;
  let days: string[] = [];
  try { days = readdirSync(rawDir); } catch { return "prune: no raw folder yet"; }
  for (const day of days) {
    const dir = join(rawDir, day);
    if (statSync(dir).mtimeMs / 1000 < cutoff && Date.parse(day) / 1000 < cutoff) {
      rmSync(dir, { recursive: true });
      removed++;
    }
  }
  db.prepare("UPDATE snapshot SET raw_path = NULL WHERE fetched_at < ? AND raw_path IS NOT NULL").run(cutoff);
  return `prune: removed ${removed} day folder(s) older than ${config.rawRetentionDays} days`;
}

export function startScheduler(db: Db, config: Config, log: (msg: string) => void) {
  let busy = false;
  const guard = (fn: () => Promise<string> | string) => async () => {
    if (busy) return;
    busy = true;
    try { log(await fn()); } catch (err) { log(`scheduler error: ${String(err)}`); } finally { busy = false; }
  };
  const blizzard = guard(() => pollBlizzard(db, config));
  const tsm = guard(async () => `${await pollTsm(db, config, "realm")}; ${await pollTsm(db, config, "region")}`);
  const prune = guard(() => pruneRaw(db, config));

  // Stagger the first runs so they don't overlap, then repeat on their own intervals.
  setTimeout(blizzard, 1_000);
  setTimeout(tsm, 30_000);
  setTimeout(prune, 60_000);
  const timers = [
    setInterval(blizzard, config.pollMinutes.blizzard * 60_000),
    setInterval(tsm, config.pollMinutes.tsm * 60_000),
    setInterval(prune, 24 * 3600_000),
  ];
  return () => timers.forEach(clearInterval);
}
