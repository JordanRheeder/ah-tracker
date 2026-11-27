import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db/db.ts";
import { modelScoreboard } from "../src/api/queries.ts";

const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);
const DAY = 86400, NOW = 100 * DAY;

function setup() {
  const db = openDb(":memory:");
  db.exec(`INSERT INTO item (item_id, name, class_id, updated_at) VALUES (1, 'Mageweave Cloth', 7, 0), (2, 'Elixir', 0, 0)`);
  let hash = 0;
  const snap = (house: number, source: string, ts: number, itemId: number, price: number) => {
    const { lastInsertRowid: id } = db.prepare(`INSERT INTO snapshot (house_id, source, fetched_at, content_hash, auction_count, item_count)
      VALUES (?, ?, ?, ?, 1, 1)`).run(house, source, ts, `h${hash++}`);
    db.prepare("INSERT INTO item_snapshot (snapshot_id, item_id, ts, min_buyout, quantity) VALUES (?, ?, ?, ?, 10)").run(id, itemId, ts, price);
  };
  const log = (itemId: number, horizon: string, madeAt: number, now: number, q10: number, q50: number, q90: number) =>
    db.prepare("INSERT INTO ml_forecast_log VALUES (?, ?, ?, ?, ?, ?, ?, 0.5)").run(itemId, horizon, madeAt, now, q10, q50, q90);
  return { db, snap, log };
}

test("published forecasts are scored against the median Undermine price within 3 hours of their target", () => {
  const { db, snap, log } = setup();
  const run = NOW - 2 * DAY, target = run + DAY;
  // Item 1 (trade good): forecast 100 -> 110, it went to 106 (median of 104 and 108).
  log(1, "1d", run, 100, 90, 110, 120);
  snap(110, "undermine", target - 3600, 1, 104);
  snap(110, "undermine", target + 2 * 3600, 1, 108);
  snap(110, "auctionator-browse", target + 3600, 1, 500); // browse scans are left out
  snap(110, "undermine", target + 4 * 3600, 1, 999); // outside the window
  snap(109, "undermine", target, 1, 777); // another house
  // Item 2 (other): forecast 100 -> 95 within 92-99, it went to 120.
  log(2, "1d", run, 100, 92, 95, 99);
  snap(110, "undermine", target, 2, 120);
  log(1, "3d", run, 100, 80, 100, 120); // due tomorrow
  log(1, "1d", NOW - 23 * 3600, 100, 90, 100, 110); // due in an hour
  log(2, "1d", NOW - 3 * DAY, 100, 90, 100, 110); // due two days ago, no prices then
  log(1, "1d", NOW - 10 * DAY, 100, 90, 100, 110); // due before the 7-day window

  const sb = modelScoreboard(db, NOW);
  assert.deepEqual(Object.keys(sb.horizons), ["1d"]);
  assert.equal(sb.scored, 2);
  assert.equal(sb.pending, 2);
  assert.equal(sb.missing, 1);
  const { all, trade, other } = sb.horizons["1d"]!;
  assert.equal(all!.n, 2);
  close(trade!.maeModel, Math.log(110 / 106));
  close(trade!.maeNaive, Math.log(1.06));
  close(trade!.bias, Math.log(110 / 106));
  assert.equal(trade!.direction, 1);
  assert.equal(trade!.cover, 1);
  close(other!.maeModel, Math.log(120 / 95));
  close(other!.bias, Math.log(95 / 120));
  assert.equal(other!.direction, 0);
  assert.equal(other!.cover, 0);
  close(all!.direction, 0.5);
  close(all!.skill, 1 - all!.maeModel / all!.maeNaive);
  assert.deepEqual(sb.runs.map((r) => r.madeAt), [run]);
  assert.equal(sb.runs[0]!.horizons["1d"]!.n, 2);
});

test("nothing old enough yet gives an empty scoreboard", () => {
  const { db, log } = setup();
  log(1, "1d", NOW - 3600, 100, 90, 100, 110);
  const sb = modelScoreboard(db, NOW);
  assert.deepEqual(sb.horizons, {});
  assert.deepEqual(sb.runs, []);
  assert.equal(sb.pending, 1);
  assert.equal(sb.loggedSince, NOW - 3600);
});
