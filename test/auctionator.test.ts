import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db/db.ts";
import { decodeScan, findScanFiles, importScanFile, parseScans } from "../src/ingest/auctionator.ts";
import { isTable, parseSavedVariables } from "../src/ingest/luaTable.ts";

const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

// Laid out the way WoW writes SavedVariables, including its "-- [n]" index comments.
const savedVars = (scans: { ts: number; faction: string; data: string }[]) => `
AHTRACKER_DB = {
["scans"] = {
${scans.map((s, i) => `{
["count"] = ${s.data.split(";").length},
["faction"] = "${s.faction}",
["data"] = "${s.data}",
["ts"] = ${s.ts},
["realm"] = "PvP",
["format"] = 1,
}, -- [${i + 1}]`).join("\n")}
},
}
`;

test("parseSavedVariables reads nested tables, escapes, numbers and booleans", () => {
  const vars = parseSavedVariables(`
-- comment
FOO = {
  ["name"] = "Sword \\"of\\" Doom\\\\x",
  ["n"] = -1.5e2,
  [3] = true,
  plain = nil,
  "first", "second", -- [2]
  ["nested"] = { 1, 2, { ["deep"] = false } },
}
BAR = 0x10
`);
  const foo = vars.get("FOO");
  assert.ok(isTable(foo));
  assert.equal(foo.map.get("name"), 'Sword "of" Doom\\x');
  assert.equal(foo.map.get("n"), -150);
  assert.equal(foo.map.get("3"), true);
  assert.equal(foo.map.get("plain"), null);
  assert.deepEqual(foo.list, ["first", "second"]);
  assert.equal(vars.get("BAR"), 16);
});

test("parseSavedVariables refuses code instead of running it", () => {
  assert.throws(() => parseSavedVariables('X = os.execute("rm -rf /")'));
});

test("decodeScan turns stack buyouts into unit prices and keeps bid-only listings", () => {
  const listings = decodeScan("2447,20,2000,1500;2447,5,1000,0;765,1,0,30");
  assert.deepEqual(plain(listings), [
    { id: 0, itemId: 2447, unitPrice: 100, quantity: 20, timeLeft: null },
    { id: 1, itemId: 2447, unitPrice: 200, quantity: 5, timeLeft: null },
    { id: 2, itemId: 765, unitPrice: null, quantity: 1, timeLeft: null },
  ]);
});

test("decodeScan reads browse-scan summaries as unit prices", () => {
  assert.deepEqual(plain(decodeScan("2447,340,98;765,1200,0", 2)), [
    { id: 0, itemId: 2447, unitPrice: 98, quantity: 340, timeLeft: null },
    { id: 1, itemId: 765, unitPrice: null, quantity: 1200, timeLeft: null },
  ]);
});

test("browse scans are stored as summaries without listing-based measures", () => {
  const wow = mkdtempSync(join(tmpdir(), "ahtracker-"));
  const dir = join(wow, "WTF", "Account", "1", "SavedVariables");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "AHTracker.lua");
  writeFileSync(file, savedVars([{ ts: 1795000000, faction: "Alliance", data: "2447,340,98" }]).replace('["format"] = 1', '["format"] = 2'));
  const db = openDb(":memory:");
  assert.equal(importScanFile(db, file, { dataDir: null }).stored, 1);
  assert.deepEqual(plain(db.prepare("SELECT source FROM snapshot").get()), { source: "auctionator-browse" });
  assert.deepEqual(plain(db.prepare("SELECT min_buyout, price_20, p50, quantity, listings FROM item_snapshot").get()), {
    min_buyout: 98, price_20: null, p50: null, quantity: 340, listings: null,
  });
});

test("an old database with a required listings column is migrated", () => {
  const path = join(mkdtempSync(join(tmpdir(), "ahtracker-db-")), "old.sqlite");
  const old = openDb(path);
  old.exec(`DROP TABLE item_snapshot;
    CREATE TABLE item_snapshot (snapshot_id INTEGER NOT NULL, item_id INTEGER NOT NULL, ts INTEGER NOT NULL,
      min_buyout INTEGER, price_20 INTEGER, p10 INTEGER, p25 INTEGER, p50 INTEGER, quantity INTEGER NOT NULL,
      listings INTEGER NOT NULL, PRIMARY KEY (snapshot_id, item_id)) WITHOUT ROWID;
    INSERT INTO snapshot (id, house_id, fetched_at, content_hash, auction_count, item_count) VALUES (1, 110, 100, 'h', 2, 1);
    INSERT INTO item_snapshot VALUES (1, 2447, 100, 5, 5, 5, 5, 5, 10, 2);`);
  old.close();
  const db = openDb(path);
  const col = (db.prepare("PRAGMA table_info(item_snapshot)").all() as { name: string; notnull: number }[]).find((c) => c.name === "listings");
  assert.equal(col?.notnull, 0);
  assert.deepEqual(plain(db.prepare("SELECT item_id, listings FROM item_snapshot").get()), { item_id: 2447, listings: 2 });
});

test("parseScans reads every saved scan", () => {
  const scans = parseScans(savedVars([
    { ts: 1795000000, faction: "Alliance", data: "2447,20,2000,0" },
    { ts: 1795003600, faction: "Horde", data: "765,10,500,0" },
  ]));
  assert.equal(scans.length, 2);
  assert.equal(scans[0]?.ts, 1795000000);
  assert.equal(scans[1]?.faction, "Horde");
});

test("importScanFile stores each scan once and skips other factions", () => {
  const wow = mkdtempSync(join(tmpdir(), "ahtracker-"));
  const dir = join(wow, "WTF", "Account", "431997778#2", "SavedVariables");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "AHTracker.lua");
  writeFileSync(file, savedVars([
    { ts: 1795000000, faction: "Alliance", data: "2447,20,2000,0;2447,5,1000,0" },
    { ts: 1795003600, faction: "Horde", data: "765,10,500,0" },
  ]));
  assert.deepEqual(findScanFiles(wow), [file]);

  const db = openDb(":memory:");
  const first = importScanFile(db, file, { dataDir: null });
  // Old scans without a house fall back to the player's faction: one Alliance (110), one Horde (untracked).
  assert.equal(first.stored, 1);
  assert.equal(first.skippedHouse, 1);
  const again = importScanFile(db, file, { dataDir: null });
  assert.equal(again.stored, 0);

  assert.deepEqual(plain(db.prepare("SELECT source, fetched_at, auction_count FROM snapshot").all()), [
    { source: "auctionator-full", fetched_at: 1795000000, auction_count: 2 },
  ]);
  // 20 @ 100 is the cheapest 20 units
  assert.deepEqual(plain(db.prepare("SELECT item_id, min_buyout, price_20, quantity FROM item_snapshot").get()), {
    item_id: 2447, min_buyout: 100, price_20: 100, quantity: 25,
  });
  assert.deepEqual(plain(db.prepare("SELECT count(*) n FROM auction_seen").get()), { n: 0 });
});

test("importItemMeta stores category, quality and icon, and keeps a known quality when the new one is unknown", async () => {
  const { importItemMeta } = await import("../src/ingest/auctionator.ts");
  const db = openDb(":memory:");
  const file = (quality: string) => `AHTRACKER_DB = {
["items"] = { [2447] = "7,9,${quality},134187,", [12345] = "2,7,3,135274,INVTYPE_WEAPON" },
["classes"] = { ["7"] = "Trade Goods", ["7.9"] = "Herb", ["2"] = "Weapon", ["2.7"] = "One-Handed Swords" },
}`;
  assert.deepEqual(importItemMeta(db, file("1"), 1), { items: 2, classes: 4, purchases: 0, inventory: 0 });
  importItemMeta(db, file("?"), 2);
  assert.deepEqual(plain(db.prepare("SELECT item_id, class_id, subclass_id, quality, icon_file_id, equip_loc FROM item ORDER BY item_id").all()), [
    { item_id: 2447, class_id: 7, subclass_id: 9, quality: 1, icon_file_id: 134187, equip_loc: null },
    { item_id: 12345, class_id: 2, subclass_id: 7, quality: 3, icon_file_id: 135274, equip_loc: "INVTYPE_WEAPON" },
  ]);
  assert.deepEqual(plain(db.prepare("SELECT class_id, subclass_id, name FROM item_class ORDER BY class_id, subclass_id").all()), [
    { class_id: 2, subclass_id: -1, name: "Weapon" }, { class_id: 2, subclass_id: 7, name: "One-Handed Swords" },
    { class_id: 7, subclass_id: -1, name: "Trade Goods" }, { class_id: 7, subclass_id: 9, name: "Herb" },
  ]);
});
