import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db/db.ts";
import { storeSnapshot, toListings, type HouseResponse } from "../src/ingest/blizzard.ts";
import { parseCsv, storeTsm } from "../src/ingest/tsm.ts";

// node:sqlite returns null-prototype rows; compare them as plain data.
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));
const eq = (actual: unknown, expected: unknown) => assert.deepEqual(plain(actual), expected);

const house = (auctions: HouseResponse["auctions"]): string => JSON.stringify({ id: 110, auctions });

const store = (db: ReturnType<typeof openDb>, body: string, fetchedAt: number) =>
  storeSnapshot(db, { houseId: 110, body, fetchedAt, lastModified: null, dataDir: null, buyoutIsStackTotal: true });

test("toListings divides stack buyouts when buyout is the stack total", () => {
  const h: HouseResponse = { auctions: [{ id: 1, item: { id: 765 }, buyout: 2000, quantity: 20, time_left: "LONG" }] };
  assert.equal(toListings(h, true)[0]?.unitPrice, 100);
  assert.equal(toListings(h, false)[0]?.unitPrice, 2000);
});

test("toListings uses unit_price for commodities and null for bid-only", () => {
  const h: HouseResponse = {
    auctions: [{ id: 1, item: { id: 1 }, bid: 50, quantity: 1 }],
    commodities: [{ id: 2, item: { id: 2 }, unit_price: 75, quantity: 200 }],
  };
  const [bidOnly, commodity] = toListings(h, true);
  assert.equal(bidOnly?.unitPrice, null);
  assert.equal(commodity?.unitPrice, 75);
});

test("identical snapshots are stored once", () => {
  const db = openDb(":memory:");
  const body = house([{ id: 1, item: { id: 765 }, buyout: 200, quantity: 2, time_left: "LONG" }]);
  assert.equal(store(db, body, 1000).stored, true);
  assert.equal(store(db, body, 1900).stored, false);
  eq(db.prepare("SELECT count(*) n FROM snapshot").get(), { n: 1 });
});

test("item aggregates are written per snapshot", () => {
  const db = openDb(":memory:");
  store(db, house([
    { id: 1, item: { id: 765 }, buyout: 200, quantity: 2, time_left: "LONG" },
    { id: 2, item: { id: 765 }, buyout: 300, quantity: 1, time_left: "LONG" },
  ]), 1000);
  const row = db.prepare("SELECT min_buyout, price_20, quantity, listings, ts FROM item_snapshot WHERE item_id = 765").get();
  eq(row, { min_buyout: 100, price_20: 167, quantity: 3, listings: 2, ts: 1000 });
});

test("vanished auctions are classified as likely sold or expired", () => {
  const db = openDb(":memory:");
  store(db, house([
    { id: 1, item: { id: 765 }, buyout: 100, quantity: 1, time_left: "LONG" },  // vanishes early -> likely sold
    { id: 2, item: { id: 765 }, buyout: 100, quantity: 1, time_left: "SHORT" }, // vanishes when nearly done -> expired
    { id: 3, item: { id: 765 }, buyout: 100, quantity: 1, time_left: "LONG" },  // stays
  ]), 1000);
  const second = store(db, house([{ id: 3, item: { id: 765 }, buyout: 100, quantity: 1, time_left: "MEDIUM" }]), 4600);
  assert.equal(second.goneLikelySold, 1);
  assert.equal(second.goneExpired, 1);
  const rows = db.prepare("SELECT auction_id, gone_reason, last_time_left FROM auction_seen ORDER BY auction_id").all();
  eq(rows, [
    { auction_id: 1, gone_reason: "likely_sold", last_time_left: "LONG" },
    { auction_id: 2, gone_reason: "expired", last_time_left: "SHORT" },
    { auction_id: 3, gone_reason: null, last_time_left: "MEDIUM" },
  ]);
});

test("parseCsv handles quoted names with commas and quotes", () => {
  const rows = parseCsv('itemId,name,marketValue\r\n1,"Pattern: Robe, ""Fancy""",50\n2,Linen Cloth,27\n');
  assert.deepEqual(rows, [
    { itemId: "1", name: 'Pattern: Robe, "Fancy"', marketValue: "50" },
    { itemId: "2", name: "Linen Cloth", marketValue: "27" },
  ]);
});

test("TSM realm and region files are stored once per updatedAt", () => {
  const db = openDb(":memory:");
  const realm = "itemId,name,marketValue,minBuyout,recent,historical,updatedAt\n2589,Linen Cloth,27,25,39,27,2026-11-18T15:22:57Z\n";
  assert.equal(storeTsm(db, "realm", realm, 1).stored, true);
  assert.equal(storeTsm(db, "realm", realm, 2).stored, false);
  const region = "itemId,name,marketValue,historical,avgSalePrice,saleRate,soldPerDay,updatedAt\n929,Healing Potion,144,130,112,0.839,480.747,2026-11-18T08:14:54Z\n";
  assert.equal(storeTsm(db, "region", region, 3).stored, true);
  eq(db.prepare("SELECT sale_rate, sold_per_day FROM tsm_region WHERE item_id = 929").get(), { sale_rate: 0.839, sold_per_day: 480.747 });
  eq(db.prepare("SELECT name FROM item WHERE item_id = 2589").get(), { name: "Linen Cloth" });
});
