import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db/db.ts";
import { checkSellAlerts } from "../src/alerts.ts";

test("sell alerts: notify once when bought stock can be sold now at your margin, again only after it drops and recovers", () => {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO item (item_id, name, deposit_unit, updated_at) VALUES (4338, 'Mageweave Cloth', 0, 0)").run();
  db.prepare("INSERT INTO inventory (character, location, item_id, qty, updated_at) VALUES ('Testchar', 'bags', 4338, 20, 0)").run();
  // Bought 20 at 1s each (TSM ledger).
  db.prepare(`INSERT INTO tsm_ledger (kind, item_id, item_string, qty, price, other, player, ts, source)
    VALUES ('buy', 4338, 'i:4338', 20, 100, 'Multiple Sellers', 'Testchar', 1000, 'Auction')`).run();
  const price = (current: number) => db.prepare(`INSERT OR REPLACE INTO stats_item (house_id, item_id, computed_at, days, points, current, median,
    median3d, buy_price, sell_price, buy_hours, sell_hours, hour_medians, consistency, pattern_days)
    VALUES (110, 4338, 0, 7, 100, ?, ?, ?, ?, ?, '', '', '[]', 0, 0)`).run(current, current, current, current, current);
  const sent: string[] = [];
  const notify = (title: string, body: string) => sent.push(`${title} | ${body}`);

  price(105); // 105 x 0.95 = 99.75: a loss
  assert.equal(checkSellAlerts(db, 1, notify).length, 0);
  price(130); // 123.5 a unit after the 5% cut: +23.5%, over the 10% default margin
  assert.equal(checkSellAlerts(db, 2, notify).length, 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /Mageweave Cloth ×20: list at 1s 30c on PvP Alliance, \+4s 70c \(24%\)/);
  assert.equal(checkSellAlerts(db, 3, notify).length, 0); // still ready: no repeat
  price(110);
  checkSellAlerts(db, 4, notify);
  price(140);
  assert.equal(checkSellAlerts(db, 5, notify).length, 1); // ready again after dropping below
  assert.equal(sent.length, 2);
  // Ticked (ignored) items never alert.
  db.prepare("INSERT INTO inventory_ignore (item_id, ignored_at) VALUES (4338, 0)").run();
  price(100); checkSellAlerts(db, 6, notify); price(200);
  assert.equal(checkSellAlerts(db, 7, notify).length, 0);
});

test("price targets: notify once when the cheapest listing reaches your target, re-arm after it drops 3% below", async () => {
  const { checkPriceTargets, readyToSell } = await import("../src/alerts.ts");
  const db = openDb(":memory:");
  db.prepare("INSERT INTO item (item_id, name, updated_at) VALUES (13468, 'Black Lotus', 0)").run();
  db.prepare("INSERT INTO price_target (item_id, target, created_at) VALUES (13468, 200000, 0)").run(); // 20g
  const snap = { run: (house: number, ts: number) => db.prepare(`INSERT INTO snapshot (house_id, fetched_at, source, content_hash, auction_count, item_count)
    VALUES (?, ?, 'undermine', ?, 1, 1)`).run(house, ts, `${house}-${ts}`) };
  const row = db.prepare("INSERT INTO item_snapshot (snapshot_id, item_id, ts, min_buyout, quantity) VALUES (?, 13468, ?, ?, 10)");
  const price = (ts: number, alliance: number, neutral: number) => {
    row.run(Number(snap.run(110, ts).lastInsertRowid), ts, alliance);
    row.run(Number(snap.run(116, ts).lastInsertRowid), ts, neutral);
  };
  const sent: string[] = [];
  const notify = (title: string, body: string) => sent.push(`${title} | ${body}`);
  price(1, 100000, 150000);
  assert.equal(checkPriceTargets(db, 1, notify).length, 0);
  price(2, 120000, 205000); // Neutral reaches 20g 50s
  assert.equal(checkPriceTargets(db, 2, notify).length, 1);
  assert.match(sent[0]!, /Price target reached: Black Lotus \| Cheapest on PvP Neutral is 20g 50s \(your target 20g\)/);
  price(3, 120000, 201000);
  assert.equal(checkPriceTargets(db, 3, notify).length, 0); // still above: no repeat
  price(4, 120000, 190000); // 5% below: re-armed
  checkPriceTargets(db, 4, notify);
  price(5, 210000, 150000); // Alliance reaches 21g
  assert.equal(checkPriceTargets(db, 5, notify).length, 1);
  assert.equal(sent.length, 2);
  assert.equal(readyToSell(db).length, 0);
});
