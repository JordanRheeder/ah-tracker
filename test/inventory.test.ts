import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db/db.ts";
import { inventoryValuation } from "../src/api/queries.ts";
import { importItemMeta } from "../src/ingest/auctionator.ts";

const houses = [
  { houseId: 110, key: "alliance", label: "PvP Alliance", cut: 0.05 },
  { houseId: 116, key: "neutral", label: "PvP Neutral", cut: 0.15 },
];

function seed() {
  const db = openDb(":memory:");
  // Bags and bank as the addon saves them.
  importItemMeta(db, `AHTRACKER_DB = { ["inventory"] = {
    ["Testchar-PvP"] = { ["bags"] = "2447:10,14048:20", ["bagsTs"] = 100, ["bank"] = "2447:5", ["bankTs"] = 90 },
  } }`);
  const stat = db.prepare(`INSERT INTO stats_item (house_id, item_id, computed_at, days, points, current, median, median3d, buy_price, sell_price,
    buy_hours, sell_hours, hour_medians, consistency, pattern_days, z) VALUES (?, ?, 1, 7, 168, ?, ?, ?, 0, ?, '1,2,3', '7,8,9', '[]', ?, 7, 0)`);
  // Peacebloom: usual 100c on Alliance, 125c on Neutral (no reliable pattern -> target = usual).
  stat.run(110, 2447, 96, 100, 100, 110, 0.3);
  stat.run(116, 2447, 125, 125, 125, 130, 0.3);
  // Bolt of Runecloth: reliable pattern on Alliance -> target = dear-hour 3899; Neutral usual 3600.
  stat.run(110, 14048, 3030, 3698, 3698, 3899, 0.8);
  stat.run(116, 14048, 3500, 3600, 3600, 3700, 0.3);
  db.exec("INSERT INTO purchase (ts, item_id, qty, unit, house) VALUES (" + (Math.floor(Date.now() / 1000) - 3600) + ", 14048, 20, 2899, 'alliance')");
  return db;
}

test("inventory is valued on every house and the best place to sell is chosen after each house's cut", () => {
  const { rows, totalValue, characters } = inventoryValuation(seed(), houses);
  const peace = rows.find((r) => r.itemId === 2447);
  const bolt = rows.find((r) => r.itemId === 14048);
  assert.ok(peace && bolt);
  assert.equal(peace.qty, 15); // 10 in bags + 5 in bank
  // Peacebloom: Alliance 100 x 0.95 = 95; Neutral 125 x 0.85 = 106.25 -> Neutral, even after its 15% cut
  assert.equal(peace.bestHouse, "neutral");
  assert.ok(Math.abs((peace.bestPerUnit as number) - 106.25) < 1e-9);
  assert.ok(Math.abs((peace.edgePerUnit as number) - 11.25) < 1e-9);
  // Bolt: Alliance 3899 x 0.95 = 3704.05; Neutral 3600 x 0.85 = 3060 -> Alliance
  assert.equal(bolt.bestHouse, "alliance");
  assert.ok(Math.abs((bolt.bestPerUnit as number) - 3704.05) < 1e-9);
  // Paid 2899 each: profit (3704.05 - 2899) x 20
  assert.ok(Math.abs((bolt.profit as number) - (3704.05 - 2899) * 20) < 1e-6);
  assert.ok(Math.abs(totalValue - (106.25 * 15 + 3704.05 * 20)) < 1e-6);
  assert.equal(characters.length, 2); // bags and bank
});
