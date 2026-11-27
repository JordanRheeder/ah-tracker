import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, type Db } from "../src/db/db.ts";
import { checkCraftAlerts, craftingTable, RECIPES } from "../src/stats/crafting.ts";

let snap = 0;
function price(db: Db, itemId: number, p: number, ts: number, qty = 100) {
  const id = ++snap;
  db.prepare("INSERT INTO snapshot (id, source, house_id, fetched_at, content_hash, auction_count, item_count) VALUES (?, 'undermine', 110, ?, ?, 0, 0)").run(id, ts, `h${id}`);
  db.prepare("INSERT INTO item_snapshot (snapshot_id, item_id, ts, min_buyout, quantity) VALUES (?, ?, ?, ?, ?)").run(id, itemId, ts, p, qty);
}
function usual(db: Db, itemId: number, median: number) {
  db.prepare(`INSERT OR REPLACE INTO stats_item (house_id, item_id, computed_at, days, points, current, median, median3d, buy_price, sell_price,
    buy_hours, sell_hours, hour_medians, consistency, pattern_days) VALUES (110, ?, 0, 7, 100, ?, ?, ?, ?, ?, '', '', '[]', 0, 0)`)
    .run(itemId, median, median, median, median, median);
}

test("recipes: Forever alchemy and cooking load, with transmute cooldowns and no crafting stations", () => {
  assert.ok(RECIPES.length > 250);
  const arcanite = RECIPES.find((r) => r.name === "Transmute: Arcanite")!;
  assert.deepEqual([arcanite.creates, arcanite.reagents, arcanite.cooldown], [12360, [[12359, 1], [12363, 1]], 169171]);
  assert.equal(RECIPES.find((r) => r.name === "Transmute: Elemental Fire")!.qmax, 3);
  assert.ok(!RECIPES.some((r) => /Campfire|Oven|Laboratory/.test(r.name)));
  assert.ok(RECIPES.some((r) => r.profession === "cooking" && r.name === "Smoked Desert Dumplings"));
});

test("crafting: profit after the cut from reagent cost and the lower of now/usual sale price; alerts only on a change", () => {
  const db = openDb(":memory:");
  const now = 1_000_000;
  db.prepare("INSERT INTO item (item_id, name, updated_at, deposit_unit) VALUES (12808, 'Essence of Undeath', 0, 0), (7080, 'Essence of Water', 0, 0)").run();
  db.prepare("INSERT INTO tsm_region (item_id, updated_at, sold_per_day, sale_rate) VALUES (7080, 1, 83, 0.5)").run();
  price(db, 12808, 3_300, now - 600);
  price(db, 7080, 48_700, now - 600);
  usual(db, 7080, 41_700);
  const row = craftingTable(db, now).rows.find((r) => r.recipe === "Transmute: Undeath to Water")!;
  // Sells at min(48 700 now, 41 700 usual) x 0.95 = 39 615; minus 3 300 = 36 315.
  assert.deepEqual([row.cost, row.sellEach, Math.round(row.profit!), row.pays], [3_300, 41_700, 36_315, true]);
  assert.equal(row.cooldown, 82_800);
  // A reagent without a recent price leaves the recipe unpriced rather than free.
  const water = craftingTable(db, now).rows.find((r) => r.recipe === "Transmute: Earth to Water")!;
  assert.deepEqual([water.cost, water.profit, water.missing], [null, null, ["Item 7076"]]);

  const sent: string[] = [];
  const notify = (title: string) => sent.push(title);
  assert.equal(checkCraftAlerts(db, now, notify).length, 0); // first check: records, no alert
  price(db, 12808, 60_000, now + 60); // Undeath now dearer than Water: stops paying
  checkCraftAlerts(db, now + 120, notify);
  price(db, 12808, 3_000, now + 180); // pays again: one alert
  assert.equal(checkCraftAlerts(db, now + 240, notify).map((r) => r.recipe).join(), "Transmute: Undeath to Water");
  assert.deepEqual(sent, ["Profitable craft: Transmute: Undeath to Water"]);
  assert.equal(checkCraftAlerts(db, now + 300, notify).length, 0); // still paying: no repeat
});
