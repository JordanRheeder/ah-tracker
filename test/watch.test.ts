import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, type Db } from "../src/db/db.ts";
import { buildWatchList, checkWatchBuys, checkWatchlist, setWatch } from "../src/watch.ts";

const DAY = 86400;
let snap = 0;
/** One snapshot per call on PvP Alliance with the cheapest listing of each item. */
function scan(db: Db, ts: number, prices: Record<number, [number, number]>, source = "undermine") {
  const id = ++snap;
  db.prepare(`INSERT INTO snapshot (id, source, house_id, fetched_at, content_hash, auction_count, item_count) VALUES (?, ?, 110, ?, ?, 0, 0)`)
    .run(id, source, ts, `h${id}`);
  for (const [item, [p, q]] of Object.entries(prices))
    db.prepare("INSERT INTO item_snapshot (snapshot_id, item_id, ts, min_buyout, quantity) VALUES (?, ?, ?, ?, ?)").run(id, Number(item), ts, p, q);
}
/** Four points a day for `days` days, the price growing by `daily` a day. */
function history(db: Db, start: number, days: number, item: number, price: number, daily: number, qty = 100) {
  for (let d = 0; d < days; d++)
    for (let h = 0; h < 4; h++) scan(db, start + d * DAY + h * 3600, { [item]: [Math.round(price * (1 + daily) ** d), qty] });
}

test("watchlist: first check is a baseline, then notifies only when a label changes or the price moves 15%", () => {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO item (item_id, name, updated_at) VALUES (10620, 'Thorium Ore', 0)").run();
  const start = 100 * DAY;
  history(db, start, 6, 10620, 1500, 0.05); // rising 5% a day
  setWatch(db, 10620, { buyBelow: 1800 }, start);
  const sent: string[] = [];
  const notify = (title: string, body: string) => sent.push(`${title} | ${body}`);

  let now = start + 6 * DAY;
  checkWatchlist(db, now, notify);
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /^Watching 1 new item \| Thorium Ore: trend rising \(\+5\.0%\/day\)/);

  // Same picture: nothing to say.
  assert.equal(checkWatchlist(db, now + 3600, notify).length, 0);
  assert.equal(sent.length, 1);

  // Then it levels off for four days: rising -> flat (and the price has not moved 15%).
  const top = Math.round(1500 * 1.05 ** 5);
  for (let d = 6; d < 10; d++) for (let h = 0; h < 4; h++) scan(db, start + d * DAY + h * 3600, { 10620: [top, 100] });
  now = start + 10 * DAY;
  const c = checkWatchlist(db, now, notify);
  assert.equal(c.length, 1);
  assert.match(sent[1]!, /^Watchlist: Thorium Ore changed \| Thorium Ore: trend rising → flat/);
  assert.doesNotMatch(sent[1]!, /price (up|down)/);

  // A 20% jump in one scan is news on its own.
  scan(db, now + 60, { 10620: [Math.round(top * 1.2), 100] }, "auctionator-browse");
  checkWatchlist(db, now + 120, notify);
  assert.match(sent[2]!, /price up 20% since the last alert/);
});

test("watchlist: labels have hysteresis, so a trend hovering on the line does not flip-flop", () => {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO item (item_id, name, updated_at) VALUES (13468, 'Black Lotus', 0)").run();
  const start = 100 * DAY;
  history(db, start, 5, 13468, 90000, 0.025); // +2.5%/day: rising
  setWatch(db, 13468, {}, start);
  const sent: string[] = [];
  checkWatchlist(db, start + 5 * DAY, (t, b) => sent.push(`${t} | ${b}`));
  // Slows to about +1.5%/day: under the 2% to become rising, but over the 1% to stay rising.
  const p4 = 90000 * 1.025 ** 4;
  for (let d = 5; d < 9; d++) for (let h = 0; h < 4; h++) scan(db, start + d * DAY + h * 3600, { 13468: [Math.round(p4 * 1.015 ** (d - 4)), 100] });
  assert.equal(checkWatchlist(db, start + 9 * DAY, (t, b) => sent.push(`${t} | ${b}`)).length, 0);
  assert.equal(sent.length, 1); // only the baseline
});

test("watchlist: buy-price alert once at or below your price, re-armed 3% above; [WATCH] list carries the limit", () => {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO item (item_id, name, updated_at) VALUES (12363, 'Arcane Crystal', 0)").run();
  setWatch(db, 12363, { buyBelow: 95000 }, 0);
  const sent: string[] = [];
  const notify = (title: string, body: string) => sent.push(`${title} | ${body}`);
  scan(db, 10, { 12363: [120000, 200] });
  assert.equal(checkWatchBuys(db, 11, notify).length, 0);
  scan(db, 20, { 12363: [94000, 3] }, "auctionator-browse");
  assert.equal(checkWatchBuys(db, 21, notify).length, 1);
  assert.match(sent[0]!, /^Buy price reached: Arcane Crystal \| Cheapest on PvP Alliance is 9g 40s \(your buy price 9g 50s\), 3 listed/);
  assert.equal(checkWatchBuys(db, 22, notify).length, 0); // still under: no repeat
  scan(db, 30, { 12363: [97000, 3] }); // within 3%: not re-armed
  checkWatchBuys(db, 31, notify);
  scan(db, 40, { 12363: [93000, 3] });
  assert.equal(checkWatchBuys(db, 41, notify).length, 0);
  scan(db, 50, { 12363: [99000, 3] }); // re-armed
  checkWatchBuys(db, 51, notify);
  scan(db, 60, { 12363: [90000, 3] });
  assert.equal(checkWatchBuys(db, 61, notify).length, 1);

  assert.deepEqual(buildWatchList(db), { name: "[WATCH] AHT PvP Alliance · Buy on dips", items: [{ itemId: 12363, name: "Arcane Crystal", maxPrice: 95000 }] });
  setWatch(db, 12363, { buyBelow: null });
  assert.equal(buildWatchList(db).items.length, 0);
});
