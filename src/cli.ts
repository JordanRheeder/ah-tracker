import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { hasBlizzardCredentials, loadConfig } from "./config.ts";
import { openDb } from "./db/db.ts";
import { aggregate } from "./aggregate.ts";
import { listHouses, toListings, type HouseResponse } from "./ingest/blizzard.ts";
import { pollBlizzard, pollTsm, pruneRaw, startScheduler } from "./poller.ts";

const config = loadConfig();
const dbPath = join(config.dataDir, "ah-tracker.sqlite");
const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

const commands: Record<string, () => Promise<void> | void> = {
  async run() {
    const db = openDb(dbPath);
    log(`ah-tracker running: house ${config.blizzard.houseId}, Blizzard every ${config.pollMinutes.blizzard} min, TSM every ${config.pollMinutes.tsm} min`);
    if (!hasBlizzardCredentials(config)) log("WARNING: no Blizzard credentials in .env; only TSM data will be collected");
    const stop = startScheduler(db, config, log);
    const shutdown = () => { log("stopping"); stop(); db.close(); process.exit(0); };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  },

  async "poll-once"() {
    const db = openDb(dbPath);
    log(await pollBlizzard(db, config));
    log(await pollTsm(db, config, "realm"));
    log(await pollTsm(db, config, "region"));
    log(pruneRaw(db, config));
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
    console.log(`blizzard credentials: ${hasBlizzardCredentials(config) ? "present" : "MISSING"}`);
    for (const source of ["blizzard", "tsm-realm", "tsm-region"]) {
      const last = db.prepare("SELECT started_at, status, detail FROM fetch_log WHERE source = ? ORDER BY id DESC LIMIT 1").get(source) as
        | { started_at: number; status: string; detail: string | null } | undefined;
      const ok = db.prepare("SELECT max(started_at) t FROM fetch_log WHERE source = ? AND status != 'error'").get(source) as { t: number | null };
      const errors = db.prepare("SELECT count(*) n FROM fetch_log WHERE source = ? AND status = 'error' AND started_at > ?").get(source, Date.now() / 1000 - 86400) as { n: number };
      console.log(`${source.padEnd(10)} last attempt ${fmt(last?.started_at)} (${last?.status ?? "-"}), last success ${fmt(ok.t)}, errors in 24h: ${errors.n}${last?.detail ? `\n           ${last.detail}` : ""}`);
    }
    const snaps = db.prepare("SELECT count(*) n, min(fetched_at) first, max(fetched_at) last FROM snapshot").get() as { n: number; first: number | null; last: number | null };
    console.log(`snapshots: ${snaps.n}, from ${fmt(snaps.first)} to ${fmt(snaps.last)}`);
    const times = (db.prepare("SELECT fetched_at t FROM snapshot WHERE fetched_at > ? ORDER BY fetched_at").all(Date.now() / 1000 - 48 * 3600) as { t: number }[]).map((r) => r.t);
    const gaps = times.slice(1).map((t, i) => [times.at(i) as number, t] as const).filter(([a, b]) => b - a > 2 * 3600);
    console.log(`gaps over 2 h in the last 48 h: ${gaps.length}${gaps.map(([a, b]) => `\n           ${fmt(a)} -> ${fmt(b)}`).join("")}`);
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
