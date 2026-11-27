// Polling jobs: Auctionator scan import every SCAN_IMPORT_MINUTES, Undermine Exchange house summaries every
// UNDERMINE_POLL_MINUTES plus a rate-limited history backfill, TSM every TSM_POLL_MINUTES, raw pruning daily,
// and the optional Blizzard API poller every BLIZZARD_POLL_MINUTES when credentials are set.
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { HOUSES, hasBlizzardCredentials, houseByKey, reloadEnv, type Config } from "./config.ts";
import { getSetting, logFetch, setSetting, type Db } from "./db/db.ts";
import { fetchHouse, lastStoredSnapshot, storeSnapshot } from "./ingest/blizzard.ts";
import { fetchTsm, storeTsm, type TsmKind } from "./ingest/tsm.ts";
import { importScanFile, ScanFileWatcher } from "./ingest/auctionator.ts";
import { findTsmFiles, importLedgerFile } from "./ingest/tsmLedger.ts";
import { refBackfillBatch, refProgress } from "./ingest/markets.ts";
import { wowRunning, writeTsmGroups } from "./tsm/groups.ts";
import { backfillBatch, backfillProgress, budgetRemaining, pollHouseSummary } from "./ingest/undermine.ts";
import { refreshForecasts, refreshStats } from "./stats/engine.ts";
import { checkPriceTargets, checkSellAlerts } from "./alerts.ts";
import { checkWatchBuys, checkWatchlist, TSM_GROUPS_DIRTY_KEY, WATCH_HOURS } from "./watch.ts";
import { checkCraftAlerts } from "./stats/crafting.ts";
import { writeListsFile } from "./stats/lists.ts";

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

const scanWatcher = new ScanFileWatcher();

/**
 * Imports Auctionator scans from AHTracker.lua files that changed since the last check.
 * `force` re-reads every file (the CLI uses it); identical scans are still stored only once.
 */
export function pollAuctionator(db: Db, config: Config, force = false): string {
  const { wowForeverDir } = config.auctionator;
  const files = force ? new ScanFileWatcher().changedFiles(wowForeverDir) : scanWatcher.changedFiles(wowForeverDir);
  if (files.length === 0) return "auctionator: no new scan file";
  const out: string[] = [];
  for (const file of files) {
    const started = Date.now();
    const startedAt = nowSec();
    try {
      const r = importScanFile(db, file, { dataDir: config.dataDir });
      const detail = `${r.stored} new of ${r.scans} saved scan(s)${r.skippedHouse ? `, ${r.skippedHouse} from untracked houses skipped` : ""}${r.items ? `, ${r.items} item details` : ""} from ${file}`;
      logFetch(db, { source: "auctionator", startedAt, durationMs: Date.now() - started, status: r.stored ? "stored" : "unchanged", detail });
      out.push(`auctionator: ${detail}`);
    } catch (err) {
      const { detail } = errorDetail(err);
      logFetch(db, { source: "auctionator", startedAt, durationMs: Date.now() - started, status: "error", detail: `${file}: ${detail}` });
      out.push(`auctionator: error - ${detail}`);
    }
  }
  return out.join("; ");
}

const ledgerSeen = new Map<string, number>();
/** Imports TSM's accounting ledger (purchases, sales, expired listings) from TradeSkillMaster.lua files that changed. */
export function pollLedger(db: Db, config: Config, force = false): string {
  const files = findTsmFiles(config.auctionator.wowForeverDir).filter((f) => {
    const mtime = statSync(f).mtimeMs;
    if (!force && ledgerSeen.get(f) === mtime) return false;
    ledgerSeen.set(f, mtime);
    return true;
  });
  if (files.length === 0) return "tsm ledger: unchanged";
  const out: string[] = [];
  for (const file of files) {
    const started = Date.now();
    const startedAt = nowSec();
    try {
      const n = importLedgerFile(db, file);
      logFetch(db, { source: "tsm-ledger", startedAt, durationMs: Date.now() - started, status: n ? "stored" : "unchanged", detail: `${n} new ledger rows from ${file}` });
      out.push(`tsm ledger: ${n} new rows`);
    } catch (err) {
      const { detail } = errorDetail(err);
      logFetch(db, { source: "tsm-ledger", startedAt, durationMs: Date.now() - started, status: "error", detail: `${file}: ${detail}` });
      out.push(`tsm ledger: error - ${detail}`);
    }
  }
  return out.join("; ");
}

/**
 * Keeps the AH Tracker TSM groups in step with your resell stock. Only while WoW is closed (TSM would
 * overwrite its file on logout), so in practice right after you log out, when TSM's ledger is fresh.
 */
export function syncTsmGroups(db: Db, config: Config): string {
  if (wowRunning()) return "tsm groups: WoW is running, will update after you log out";
  const out: string[] = [];
  for (const file of findTsmFiles(config.auctionator.wowForeverDir)) {
    try {
      const p = writeTsmGroups(db, file, houseByKey("alliance")!.cut, { force: true });
      if (p.added || p.removed || p.operationCreated || p.changed) out.push(`tsm groups: ${p.added} added, ${p.removed} removed${p.changed ? ", settings rewritten" : ""}`);
    } catch (err) {
      out.push(`tsm groups: error - ${errorDetail(err).detail}`);
    }
  }
  return out.join("; ") || "tsm groups: unchanged";
}

/** Latest Undermine Exchange summary for every tracked house (one call each, 3 points). */
export async function pollUndermine(db: Db, config: Config): Promise<string> {
  if (!config.undermine.apiKey) return "undermine: skipped, no UNDERMINE_API_KEY in .env";
  const out: string[] = [];
  for (const house of HOUSES) {
    const started = Date.now();
    const startedAt = nowSec();
    try {
      const r = await pollHouseSummary(db, config, house);
      const when = new Date(r.ts * 1000).toISOString();
      logFetch(db, { source: "undermine", startedAt, durationMs: Date.now() - started, status: r.stored ? "stored" : "unchanged",
        detail: `${house.label}: snapshot ${when}, ${r.items} items` });
      out.push(`${house.key} ${r.stored ? "stored" : "unchanged"} (${when})`);
    } catch (err) {
      const { detail, httpStatus } = errorDetail(err);
      logFetch(db, { source: "undermine", startedAt, durationMs: Date.now() - started, status: "error", httpStatus, detail: `${house.label}: ${detail}` });
      out.push(`${house.key} error - ${detail}`);
    }
  }
  return `undermine: ${out.join(", ")}`;
}

/** Backfills hourly history for queued items while rate-limit budget remains. */
export async function runBackfill(db: Db, config: Config, maxItems = 300): Promise<string> {
  if (!config.undermine.apiKey) return "backfill: skipped, no UNDERMINE_API_KEY";
  const startedAt = nowSec();
  const started = Date.now();
  try {
    const r = await backfillBatch(db, config, HOUSES, maxItems);
    // Once your own houses are done, spend the rest of the budget on the other PvP markets (forecasting).
    let ref = "";
    if (!r.stoppedForBudget && r.done < maxItems) {
      const rr = await refBackfillBatch(db, config, maxItems - r.done);
      if (rr.done || rr.errors) {
        const progress = refProgress(db).map((p) => `${p.market} ${p.done}/${p.total}`).join(", ");
        logFetch(db, { source: "undermine-markets", startedAt, durationMs: Date.now() - started, status: rr.errors && !rr.done ? "error" : "stored",
          detail: `${rr.done} item histories (${rr.points} hourly prices)${rr.errors ? `, ${rr.errors} errors` : ""}; ${progress}; budget left ${budgetRemaining()}` });
        ref = `; other markets: ${rr.done} item(s)${rr.stoppedForBudget ? " (paused for rate limit)" : ""}, ${progress}`;
      }
    }
    const progress = HOUSES.map((h) => { const p = backfillProgress(db, config, h); return `${h.key} ${p.done}/${p.total}`; }).join(", ");
    if (r.done > 0 || r.errors > 0)
      logFetch(db, { source: "undermine-backfill", startedAt, durationMs: Date.now() - started, status: r.errors ? "error" : "stored",
        detail: `${r.done} item histories${r.errors ? `, ${r.errors} errors` : ""}; progress ${progress}; budget left ${budgetRemaining()}` });
    return `backfill: ${r.done} item(s)${r.stoppedForBudget ? " (paused for rate limit)" : ""}; progress ${progress}${ref}`;
  } catch (err) {
    const { detail, httpStatus } = errorDetail(err);
    logFetch(db, { source: "undermine-backfill", startedAt, durationMs: Date.now() - started, status: "error", httpStatus, detail });
    return `backfill: error - ${detail}`;
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

/**
 * The forecasting model (ml/forecast.py) in the project's Python environment: trains on all four PvP
 * markets, tests itself on EU Alliance and writes ml_forecast / ml_eval. Skipped if the environment is missing.
 */
export function runForecastModel(db: Db, config: Config): Promise<string> {
  const python = process.platform === "win32" ? join(process.cwd(), ".venv", "Scripts", "python.exe") : join(process.cwd(), ".venv", "bin", "python");
  const script = join(process.cwd(), "ml", "forecast.py");
  const dbPath = process.env.AH_DB ?? join(config.dataDir, "ah-tracker.sqlite");
  if (!existsSync(python) || !existsSync(script)) return Promise.resolve("forecast model: skipped, no .venv (see ml/requirements.txt)");
  const startedAt = nowSec(), started = Date.now();
  return new Promise((resolve) => {
    execFile(python, [script, dbPath], { timeout: 20 * 60_000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const detail = `${err.message} ${String(stderr).slice(-400)}`;
        logFetch(db, { source: "ml-forecast", startedAt, durationMs: Date.now() - started, status: "error", detail });
        return resolve(`forecast model: error - ${detail}`);
      }
      let summary = "done";
      try {
        const r = JSON.parse(stdout) as { evals: Record<string, { skill_naive: number; passed: boolean } | null>; forecasts: number };
        summary = `${r.forecasts} forecasts; ` + Object.entries(r.evals).map(([h, e]) => e ? `${h} ${Math.round(e.skill_naive * 100)}% better than no change${e.passed ? "" : " (not used)"}` : `${h} not testable yet`).join(", ");
      } catch { /* keep "done" */ }
      logFetch(db, { source: "ml-forecast", startedAt, durationMs: Date.now() - started, status: "stored", detail: summary });
      resolve(`forecast model: ${summary}`);
    });
  });
}

let tsmGroupsPending = true; // also check once at start-up

export function startScheduler(db: Db, config: Config, log: (msg: string) => void) {
  let busy = false;
  const guard = (fn: () => Promise<string> | string) => async () => {
    if (busy) return;
    busy = true;
    try { log(await fn()); } catch (err) { log(`scheduler error: ${String(err)}`); } finally { busy = false; }
  };
  const blizzard = guard(() => pollBlizzard(db, config));
  // Saved-variables files (Auctionator scans via AHTracker, TSM's ledger) are checked every 20 seconds so a
  // /reload shows up on the dashboard almost at once. Only their modification times are read unless they
  // changed, and this runs outside the shared guard: it is synchronous, so it cannot interleave with the
  // database writes of a running Undermine poll or backfill.
  let lastQuiet = 0;
  const auctionator = () => {
    if (reloadEnv(config)) log(`settings: .env changed, now using WoW folder "${config.auctionator.wowForeverDir || "(not set)"}", Undermine ${config.undermine.apiKey ? "on" : "off"}, Blizzard API ${hasBlizzardCredentials(config) ? "on" : "off"}`);
    try {
      const scans = pollAuctionator(db, config);
      const ledger = pollLedger(db, config);
      const changed = !scans.startsWith("auctionator: no new scan file") || !ledger.endsWith("unchanged");
      // New ledger rows arrive when you log out: refresh the TSM groups then, once WoW has fully closed.
      if (!ledger.endsWith("unchanged")) tsmGroupsPending = true;
      // Watchlist buy prices changed on the dashboard: their TSM Sniper subgroups need rewriting.
      if (getSetting(db, TSM_GROUPS_DIRTY_KEY, 0) === 1) { setSetting(db, TSM_GROUPS_DIRTY_KEY, 0); tsmGroupsPending = true; }
      if (tsmGroupsPending && !syncTsmGroups(db, config).includes("WoW is running")) tsmGroupsPending = false;
      if (!changed) {
        if (Date.now() - lastQuiet > 30 * 60_000) { lastQuiet = Date.now(); log("auctionator: watching for new scans"); }
        return;
      }
      // New scans, purchases or bag contents can make an item ready to sell.
      const alerts = [...checkSellAlerts(db), ...checkPriceTargets(db), ...checkWatchBuys(db)];
      log(`${scans}; ${ledger}${alerts.length ? `; sell alerts: ${alerts.map((a) => a.name).join(", ")}` : ""}`);
    } catch (err) {
      log(`scheduler error: ${String(err)}`);
    }
  };
  // After each Undermine poll, recompute statistics so opportunities and anomalies stay current.
  const undermine = guard(async () => {
    const polled = await pollUndermine(db, config);
    const r = refreshStats(db);
    refreshForecasts(db);
    const alerts = [...checkSellAlerts(db), ...checkPriceTargets(db), ...checkWatchBuys(db)];
    const parts = Object.entries(r.houses).map(([k, v]) => `${k} ${v.opportunities} opp/${v.anomaliesOpen} anom`);
    const lists = writeListsFile(db, config.auctionator.wowForeverDir);
    const crafts = checkCraftAlerts(db);
    return `${polled}; stats: ${parts.join(", ")}, ${r.crossHouse} cross-house (${r.ms} ms)${lists ? `; shopping lists: ${lists.items} items in ${lists.lists} lists` : ""}${alerts.length ? `; sell alerts: ${alerts.map((a) => a.name).join(", ")}` : ""}${crafts.length ? `; profitable crafts: ${crafts.map((c) => c.recipe).join(", ")}` : ""}`;
  });
  const backfill = guard(() => runBackfill(db, config));
  const tsm = guard(async () => `${await pollTsm(db, config, "realm")}; ${await pollTsm(db, config, "region")}`);
  const prune = guard(() => pruneRaw(db, config));
  const model = guard(() => runForecastModel(db, config));
  // Watchlist trends (src/watch.ts): rechecked every few hours, notifying only when something changes.
  const watch = guard(() => {
    const c = checkWatchlist(db);
    return `watchlist: ${c.length ? c.map((x) => x.name).join(", ") + " changed" : "no changes"}`;
  });

  // Stagger the first runs so they don't overlap, then repeat on their own intervals.
  setTimeout(auctionator, 1_000);
  setTimeout(undermine, 5_000);
  setTimeout(backfill, 90_000);
  // The Blizzard job always runs and skips itself until credentials are set (they can be added from the dashboard).
  setTimeout(blizzard, 10_000);
  setTimeout(tsm, 30_000);
  setTimeout(prune, 60_000);
  setTimeout(model, 10 * 60_000);
  setTimeout(watch, 15 * 60_000);
  const timers = [
    setInterval(auctionator, 20_000),
    setInterval(undermine, config.pollMinutes.undermine * 60_000),
    // Backfill runs in small batches every 5 minutes; it pauses itself when the hourly budget runs low.
    setInterval(backfill, 5 * 60_000),
    setInterval(blizzard, config.pollMinutes.blizzard * 60_000),
    setInterval(tsm, config.pollMinutes.tsm * 60_000),
    setInterval(prune, 24 * 3600_000),
    setInterval(model, 6 * 3600_000),
    setInterval(watch, WATCH_HOURS * 3600_000),
  ];
  return () => timers.forEach(clearInterval);
}

/**
 * Everything the scheduler does, once, now: new Auctionator scans, Undermine summaries, TSM files,
 * statistics and the addon's shopping lists. Used by the dashboard's Sync button and `cli.ts sync`.
 */
export async function syncNow(db: Db, config: Config): Promise<string[]> {
  const out: string[] = [];
  out.push(pollAuctionator(db, config, true));
  out.push(pollLedger(db, config, true));
  out.push(await pollUndermine(db, config));
  out.push(await pollTsm(db, config, "realm"));
  out.push(await pollTsm(db, config, "region"));
  const r = refreshStats(db);
  refreshForecasts(db);
  const alerts = [...checkSellAlerts(db), ...checkPriceTargets(db), ...checkWatchBuys(db)];
  if (alerts.length) out.push(`sell alerts: ${alerts.map((a) => a.name).join(", ")}`);
  const crafts = checkCraftAlerts(db);
  if (crafts.length) out.push(`profitable crafts: ${crafts.map((c) => c.recipe).join(", ")}`);
  out.push(`stats: ${Object.entries(r.houses).map(([k, v]) => `${k} ${v.analysed} items, ${v.opportunities} opportunities`).join("; ")}`);
  const lists = writeListsFile(db, config.auctionator.wowForeverDir);
  if (lists) out.push(`shopping lists: ${lists.items} items in ${lists.lists} lists (/reload in game to load them)`);
  return out;
}
