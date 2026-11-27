import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db/db.ts";
import { importLedger, parseLedger } from "../src/ingest/tsmLedger.ts";
import { openPurchases } from "../src/api/queries.ts";

const csv = (s: string) => JSON.stringify(s); // a Lua string literal with \n escapes
const file = `TradeSkillMasterDB = {
["r@PvP@internalData@csvBuys"] = ${csv("itemString,stackSize,quantity,price,otherPlayer,player,time,source\ni:4338,20,20,250,Multiple Sellers,Testchar,1000,Auction\ni:4338,10,10,300,Someone,Testchar,2000,Auction\ni:2320,5,5,10,Merchant,Testchar,1500,Vendor\ni:15260::1:12718,1,1,11500,Someseller,Testchar,1600,Auction")},
["r@PvP@internalData@csvSales"] = ${csv("itemString,stackSize,quantity,price,otherPlayer,player,time,source\ni:4338,5,5,400,Buyer,Testchar,500,Auction\ni:4338,25,25,420,Buyer,Testchar,3000,Auction")},
["r@PvP@internalData@csvExpired"] = ${csv("itemString,stackSize,quantity,player,time\ni:4338,20,20,Testchar,2500")},
["c@Testchar - PvP@mainUIContext@x"] = {},
}
`;

test("TSM ledger rows are parsed by kind, and imports are not repeated", () => {
  const rows = parseLedger(file);
  assert.equal(rows.filter((r) => r.kind === "buy").length, 4);
  assert.equal(rows.find((r) => r.itemString === "i:15260::1:12718")?.itemId, 15260);
  assert.deepEqual({ ...rows.find((r) => r.kind === "expired") }, { kind: "expired", itemId: 4338, itemString: "i:4338", qty: 20, ts: 2500, player: "Testchar", price: null, other: null, source: null });
  const db = openDb(":memory:");
  assert.equal(importLedger(db, file), 7);
  assert.equal(importLedger(db, file), 0);
});

test("open purchases: sales use up the oldest buys, earlier sales and vendor buys are ignored, AH Tracker adds the house", () => {
  const db = openDb(":memory:");
  importLedger(db, file);
  db.prepare("INSERT INTO purchase (ts, item_id, qty, unit, house) VALUES (?, ?, ?, ?, ?)").run(2030, 4338, 10, 300, "neutral"); // TSM's second buy
  db.prepare("INSERT INTO purchase (ts, item_id, qty, unit, house) VALUES (?, ?, ?, ?, ?)").run(4000, 4338, 3, 280, "alliance"); // missing from TSM
  const open = openPurchases(db);
  // Bought 20 @250 and 10 @300; the sale of 5 at t=500 came before any buy (farmed). Selling 25 at t=3000
  // uses all 20 @250 and 5 @300, leaving 5 @300 (house from AH Tracker) plus AH Tracker's own 3 @280.
  assert.deepEqual(open.get(4338)?.map((l) => ({ ...l })), [
    { ts: 2000, qty: 5, unit: 300, house: "neutral" },
    { ts: 4000, qty: 3, unit: 280, house: "alliance" },
  ]);
  assert.equal(open.has(2320), false); // vendor purchase
  assert.equal(open.get(15260)?.[0]?.qty, 1);
});

test("money ledger and gold: postage counts, transfers between your own characters do not", async () => {
  const { moneyOverview } = await import("../src/api/money.ts");
  const text = file.replace("\n}\n", `
["r@PvP@internalData@csvExpense"] = ${csv("type,amount,otherPlayer,player,time\nPostage,30,Bankalt,Testchar,2100\nMoney Transfer,10000,Bankalt,Testchar,2200\nRepair Bill,500,Merchant,Testchar,2300")},
["r@PvP@internalData@csvIncome"] = ${csv("type,amount,otherPlayer,player,time\nMoney Transfer,10000,Testchar,Bankalt,2200")},
["s@Testchar - Alliance - PvP@internalData@money"] = 40177,
["s@Testchar - Alliance - PvP@internalData@goldLogLastUpdate"] = 3000,
["s@Testchar - Alliance - PvP@internalData@goldLog"] = ${csv("minute,copper\n10,90000\n20,40000")},
["s@Bankalt - Alliance - PvP@internalData@money"] = 104693,
}
`);
  const db = openDb(":memory:");
  importLedger(db, text);
  db.prepare("INSERT INTO item (item_id, name, deposit_unit, updated_at) VALUES (4338, 'Mageweave Cloth', 15, 0)").run();
  const o = moneyOverview(db, { since: 0, now: 10_000, cut: 0.05, tzOffsetMinutes: 0 });
  assert.equal(o.costs.postage, 30);
  assert.equal(o.costs.other, 500); // the repair; the 1g transfer to Bankalt is internal
  assert.equal(o.income.other, 0);
  assert.equal(o.costs.lostDeposits, 20 * 15);
  assert.equal(o.goldTotal, 40177 + 104693);
  assert.deepEqual(o.goldSeries.map((p) => ({ ...p })), [{ ts: 600, copper: 90000 }, { ts: 1200, copper: 40000 }]);
  // Sold 25 at 4s20c at t=3000: 20 bought at 2s50c, 5 at 3s. Revenue after 5% cut, minus their cost.
  const revenue = 25 * 420 * 0.95;
  assert.ok(Math.abs(o.trading.grossProfit - (revenue - (20 * 250 + 5 * 300))) < 1e-6);
  assert.ok(Math.abs(o.trading.netProfit - (o.trading.grossProfit - 30 - 300)) < 1e-6);
  assert.equal(o.stock.units, 5 + 1); // 5 Mageweave at 3s left, plus the one i:15260
});

test("one AH Tracker purchase that TSM split into several rows is not counted twice", () => {
  const db = openDb(":memory:");
  importLedger(db, `TradeSkillMasterDB = {
["r@PvP@internalData@csvBuys"] = ${csv("itemString,stackSize,quantity,price,otherPlayer,player,time,source\ni:7070,15,15,476,Multiple Sellers,Testchar,1000,Auction\ni:7070,20,20,476,Multiple Sellers,Testchar,1000,Auction")},
}
`);
  db.prepare("INSERT INTO purchase (ts, item_id, qty, unit, house) VALUES (?, ?, ?, ?, ?)").run(1030, 7070, 35, 477, "neutral");
  const lots = openPurchases(db).get(7070)!;
  assert.equal(lots.reduce((t, l) => t + l.qty, 0), 35);
  assert.ok(lots.every((l) => l.house === "neutral"));
});

test("still held never exceeds what TSM counted you owning: the rest was used or gone", () => {
  const db = openDb(":memory:");
  importLedger(db, `TradeSkillMasterDB = {
["r@PvP@internalData@csvBuys"] = ${csv("itemString,stackSize,quantity,price,otherPlayer,player,time,source\ni:13759,20,20,100,Multiple Sellers,Testchar,1000,Auction\ni:13759,10,10,120,Multiple Sellers,Testchar,3000,Auction")},
["s@Testchar - Alliance - PvP@internalData@bagQuantity"] = { ["i:13759"] = 5, },
["s@Bankalt - Alliance - PvP@internalData@auctionQuantity"] = { ["i:13759"] = 3, },
}
`, 0, 2000); // TSM saved at t=2000, when you owned 8 (5 in bags + 3 listed) of the 20 bought so far
  const book = openPurchases(db).get(13759)!;
  // At t=2000: 20 bought, 8 owned -> 12 gone (oldest). Then 10 more bought at t=3000 -> 18 held.
  assert.deepEqual(book.map((l) => ({ ...l })), [
    { ts: 1000, qty: 8, unit: 100, house: null },
    { ts: 3000, qty: 10, unit: 120, house: null },
  ]);
});
