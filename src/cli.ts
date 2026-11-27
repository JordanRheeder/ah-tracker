import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { hasBlizzardCredentials, loadConfig } from "./config.ts";
import { minMargin, openDb, safeOnly } from "./db/db.ts";
import { aggregate } from "./aggregate.ts";
import { listHouses, toListings, type HouseResponse } from "./ingest/blizzard.ts";
import { pollAuctionator, pollBlizzard, pollLedger, runForecastModel, pollTsm, pollUndermine, pruneRaw, runBackfill, startScheduler, syncNow } from "./poller.ts";
import { refreshForecasts, refreshStats } from "./stats/engine.ts";
import { OPERATION, writeTsmGroups } from "./tsm/groups.ts";
import { findTsmFiles } from "./ingest/tsmLedger.ts";
import { auctionatorImport, buildLists, writeListsFile } from "./stats/lists.ts";
import { HOUSES, houseByKey } from "./config.ts";

const config = loadConfig();
const dbPath = join(config.dataDir, "ah-tracker.sqlite");
const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

const commands: Record<string, () => Promise<void> | void> = {
  async run() {
    const db = openDb(dbPath);
    if (!config.auctionator.wowForeverDir) log("WOW_FOREVER_DIR is not set in .env: no Auctionator scans will be imported (see README, Setup)");
    log(`ah-tracker running: Auctionator scans from ${config.auctionator.wowForeverDir}, Undermine Exchange ${config.undermine.apiKey ? `every ${config.pollMinutes.undermine} min + backfill` : "off"}, TSM every ${config.pollMinutes.tsm} min, Blizzard API ${hasBlizzardCredentials(config) ? "on" : "off"}`);
    const stop = startScheduler(db, config, log);
    const shutdown = () => { log("stopping"); stop(); db.close(); process.exit(0); };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  },

  async "poll-once"() {
    const db = openDb(dbPath);
    log(pollAuctionator(db, config, true));
    log(pollLedger(db, config, true));
    log(await pollUndermine(db, config));
    if (hasBlizzardCredentials(config)) log(await pollBlizzard(db, config));
    log(await pollTsm(db, config, "realm"));
    log(await pollTsm(db, config, "region"));
    log(pruneRaw(db, config));
    db.close();
  },

  "import-scans"() {
    const db = openDb(dbPath);
    log(pollAuctionator(db, config, true));
    log(pollLedger(db, config, true));
    db.close();
  },

  /** Runs backfill batches until done or the hourly rate limit pauses it. */
  async backfill() {
    const db = openDb(dbPath);
    for (;;) {
      const msg = await runBackfill(db, config, 100);
      log(msg);
      if (/ 0 item\(s\)|paused|error/.test(msg)) break;
    }
    db.close();
  },

  /** Writes the AH Tracker TSM groups and "AHT 2h small" operation into TradeSkillMaster.lua (WoW must be closed). */
  "tsm-groups"() {
    const db = openDb(dbPath);
    for (const file of findTsmFiles(config.auctionator.wowForeverDir)) {
      const plan = writeTsmGroups(db, file, houseByKey("alliance")!.cut);
      log(`tsm groups: ${plan.items} items in ${plan.groups} groups (${plan.added} added or moved, ${plan.removed} removed, ${plan.kept} left in your own groups)${plan.operationCreated ? `; created operation "${OPERATION}"` : ""} in ${file}`);
    }
    db.close();
  },

  /** Trains and tests the forecasting model (ml/forecast.py) and stores its forecasts. */
  async model() {
    const db = openDb(dbPath);
    log(await runForecastModel(db, config));
    db.close();
  },

  /** Recomputes statistics, opportunities and anomalies. */
  stats() {
    const db = openDb(dbPath);
    const r = refreshStats(db);
    log(`stats: ${Object.entries(r.houses).map(([k, v]) => `${k} ${v.analysed} items, ${v.opportunities} opportunities, ${v.anomaliesOpen} open anomalies`).join("; ")}; ${r.crossHouse} cross-house; ${r.ms} ms`);
    const f = refreshForecasts(db);
    log(`forecasts: ${f.items} items, ${f.ms} ms`);
    db.close();
  },

  /** Best current opportunities: `opportunities [alliance|neutral] [buy-now|time-flip|sell-now|cross-house] [n]`. */
  opportunities() {
    const db = openDb(dbPath);
    const [houseArg, kindArg, nArg] = process.argv.slice(3);
    const house = houseByKey(houseArg);
    const kind = kindArg && kindArg !== "all" ? kindArg : null;
    const g = (c: number) => `${(c / 10000).toFixed(2)}g`;
    interface Row { kind: string; name: string | null; item_id: number; house_id: number; sell_house_id: number;
      buy_price: number; sell_price: number; profit: number; margin: number; confidence: number; sold: number | null; why: string }
    const rows = db.prepare(`
      SELECT o.kind, o.item_id, o.house_id, o.sell_house_id, o.buy_price, o.sell_price, o.profit, o.margin, o.confidence, o.why,
             i.name, g.sold_per_day sold
      FROM stats_opportunity o
      LEFT JOIN item i ON i.item_id = o.item_id
      LEFT JOIN tsm_region g ON g.item_id = o.item_id AND g.updated_at = (SELECT max(updated_at) FROM tsm_region)
      WHERE (? IS NULL OR o.house_id = ?) AND (? IS NULL OR o.kind = ?) AND o.margin >= ?
        AND (? = 0 OR (o.safe_evidence = 1 AND o.safe_margin >= ?))
      ORDER BY o.score DESC LIMIT ?`).all(house?.houseId ?? null, house?.houseId ?? null, kind, kind, minMargin(db), safeOnly(db) ? 1 : 0, minMargin(db), Number(nArg ?? 25)) as unknown as Row[];
    const label = (id: number) => HOUSES.find((h) => h.houseId === id)?.label ?? String(id);
    for (const r of rows)
      console.log(`${r.kind.padEnd(11)} ${String(r.name ?? r.item_id).slice(0, 34).padEnd(34)} buy ${g(r.buy_price).padStart(9)} @${label(r.house_id).padEnd(12)} sell ${g(r.sell_price).padStart(9)} @${label(r.sell_house_id).padEnd(12)} profit ${g(r.profit).padStart(8)} (${Math.round(r.margin * 100)}%) sold/day ${Math.round(r.sold ?? 0)} conf ${r.confidence.toFixed(2)}\n            ${r.why}`);
    if (!rows.length) console.log("No opportunities yet. Run `node src/cli.ts stats` first.");
    db.close();
  },

  /** TSM group import string for the top opportunities: `export-tsm [alliance|neutral] [kind|all] [n]`. */
  "export-tsm"() {
    const db = openDb(dbPath);
    const [houseArg, kindArg, nArg] = process.argv.slice(3);
    const house = houseByKey(houseArg) ?? HOUSES[0]!;
    const kind = kindArg && kindArg !== "all" ? kindArg : null;
    const ids = (db.prepare(`SELECT item_id id FROM stats_opportunity WHERE house_id = ? AND (? IS NULL OR kind = ?) AND margin >= ?
        AND (? = 0 OR (safe_evidence = 1 AND safe_margin >= ?))
      GROUP BY item_id ORDER BY max(score) DESC LIMIT ?`).all(house.houseId, kind, kind, minMargin(db), safeOnly(db) ? 1 : 0, minMargin(db), Number(nArg ?? 50)) as { id: number }[]).map((r) => r.id);
    console.log(ids.map((id) => `i:${id}`).join(","));
    db.close();
  },

  /** Copies addon/AHTracker into WoW's Interface/AddOns (keeping an existing Lists.lua), then writes fresh lists. */
  "install-addon"() {
    if (!config.auctionator.wowForeverDir) throw new Error("set WOW_FOREVER_DIR in .env first");
    const src = join(import.meta.dirname, "..", "addon", "AHTracker");
    const dest = join(config.auctionator.wowForeverDir, "Interface", "AddOns", "AHTracker");
    mkdirSync(dest, { recursive: true });
    for (const f of readdirSync(src))
      if (f !== "Lists.lua" || !existsSync(join(dest, f))) copyFileSync(join(src, f), join(dest, f));
    console.log(`installed addon to ${dest}`);
    commands.lists!();
  },

  /** Rewrites the addon's Lists.lua and prints each list's top items with their max buy prices. */
  lists() {
    const db = openDb(dbPath);
    const written = writeListsFile(db, config.auctionator.wowForeverDir);
    console.log(written ? `wrote ${written.path}: ${written.items} items in ${written.lists} lists` : "AHTracker addon folder not found; nothing written");
    for (const l of buildLists(db))
      console.log(`${l.name} (${l.items.length})${l.items.slice(0, 3).map((i) => `\n   ${i.name}: max ${i.maxPrice === null ? "no limit" : `${(i.maxPrice / 10000).toFixed(4)}g`}`).join("")}`);
    db.close();
  },

  /** Text to paste into Auctionator's Shopping > Import (all non-empty lists, both houses). */
  "auctionator-import"() {
    const db = openDb(dbPath);
    console.log(auctionatorImport(buildLists(db)));
    db.close();
  },

  /** Pull everything now and recompute (what the dashboard's Sync button does). */
  async sync() {
    const db = openDb(dbPath);
    for (const line of await syncNow(db, config)) log(line);
    db.close();
  },

  async houses() {
    const houses = await listHouses(config);
    for (const h of houses) console.log(`${h.id}\t${h.name}${h.id === config.blizzard.houseId ? "   <- configured" : ""}`);
  },

  /** Decides whether `buyout` is per stack or per unit by comparing both readings with TSM's minBuyout. */
  "verify-buyout"() {
    const db = openDb(dbPath);
    const snap = db
      .prepare("SELECT id, raw_path FROM snapshot WHERE raw_path IS NOT NULL ORDER BY fetched_at DESC LIMIT 1")
      .get() as { id: number; raw_path: string } | undefined;
    if (!snap) return console.log("No stored snapshot with raw data yet. Run poll-once first.");
    const house = JSON.parse(gunzipSync(readFileSync(snap.raw_path)).toString()) as HouseResponse;
    const tsm = new Map(
      (db.prepare(
        `SELECT item_id, min_buyout FROM tsm_realm WHERE updated_at = (SELECT max(updated_at) FROM tsm_realm) AND min_buyout > 0`,
      ).all() as { item_id: number; min_buyout: number }[]).map((r) => [r.item_id, r.min_buyout]),
    );
    const stacked = aggregate(toListings(house, true)).filter((s) => (house.auctions ?? []).some((a) => a.item.id === s.itemId && a.quantity > 1));
    for (const [label, asStack] of [["per stack", true], ["per unit", false]] as const) {
      const stats = aggregate(toListings(house, asStack));
      const ratios = stats
        .filter((s) => stacked.some((x) => x.itemId === s.itemId) && s.minBuyout && tsm.has(s.itemId))
        .map((s) => (s.minBuyout as number) / (tsm.get(s.itemId) as number))
        .sort((a, b) => a - b);
      const median = ratios[Math.floor(ratios.length / 2)];
      console.log(`buyout ${label}: ${ratios.length} stacked items compared, median ours/TSM minBuyout = ${median?.toFixed(3) ?? "n/a"}`);
    }
    console.log("The reading whose median is closest to 1.000 is correct; set BLIZZARD_BUYOUT_IS_STACK_TOTAL to match.");
    db.close();
  },

  status() {
    const db = openDb(dbPath);
    const fmt = (t: number | null | undefined) => (t ? new Date(t * 1000).toISOString().replace(".000Z", "Z") : "never");
    console.log(`database: ${dbPath} (${(statSync(dbPath).size / 1e6).toFixed(1)} MB)`);
    for (const source of ["auctionator", "undermine", "undermine-backfill", "tsm-realm", "tsm-region", ...(hasBlizzardCredentials(config) ? ["blizzard"] : [])]) {
      const last = db.prepare("SELECT started_at, status, detail FROM fetch_log WHERE source = ? ORDER BY id DESC LIMIT 1").get(source) as
        | { started_at: number; status: string; detail: string | null } | undefined;
      const ok = db.prepare("SELECT max(started_at) t FROM fetch_log WHERE source = ? AND status != 'error'").get(source) as { t: number | null };
      const errors = db.prepare("SELECT count(*) n FROM fetch_log WHERE source = ? AND status = 'error' AND started_at > ?").get(source, Date.now() / 1000 - 86400) as { n: number };
      console.log(`${source.padEnd(18)} last attempt ${fmt(last?.started_at)} (${last?.status ?? "-"}), last success ${fmt(ok.t)}, errors in 24h: ${errors.n}${last?.detail ? `\n           ${last.detail}` : ""}`);
    }
    const snaps = db.prepare("SELECT source, count(*) n, min(fetched_at) first, max(fetched_at) last FROM snapshot GROUP BY source").all() as { source: string; n: number; first: number; last: number }[];
    if (snaps.length === 0) console.log("snapshots: none yet - run a full scan in Auctionator, then /reload");
    for (const s of snaps) console.log(`snapshots (${s.source}): ${s.n}, from ${fmt(s.first)} to ${fmt(s.last)}`);
    const hours = (db.prepare("SELECT DISTINCT CAST(strftime('%H', fetched_at, 'unixepoch') AS INTEGER) h FROM snapshot").all() as { h: number }[]).map((r) => r.h).sort((a, b) => a - b);
    console.log(`hours of day covered by scans (UTC): ${hours.length ? hours.join(", ") : "none"} (${hours.length}/24)`);
    const times = (db.prepare("SELECT fetched_at t FROM snapshot WHERE fetched_at > ? ORDER BY fetched_at").all(Date.now() / 1000 - 48 * 3600) as { t: number }[]).map((r) => r.t);
    const gaps = times.slice(1).map((t, i) => [times.at(i) as number, t] as const).filter(([a, b]) => b - a > 2 * 3600);
    console.log(`gaps over 2 h between snapshots in the last 48 h (expected when you are not scanning): ${gaps.length}${gaps.map(([a, b]) => `\n           ${fmt(a)} -> ${fmt(b)}`).join("")}`);
    db.close();
  },
};

const name = process.argv[2] ?? "status";
const cmd = commands[name];
if (!cmd) {
  console.error(`Unknown command "${name}". Commands: ${Object.keys(commands).join(", ")}`);
  process.exit(1);
}
await cmd();
