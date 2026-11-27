import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSavedVariables, isTable } from "../src/ingest/luaTable.ts";
import { OPERATION, updateTsmText } from "../src/tsm/groups.ts";

const SUBGROUPS = { tg: "AH Tracker`Trade Goods`Cloth", quest: "AH Tracker`Quest" };

const file = `
TradeSkillMasterDB = {
["p@Default@userData@groups"] = {
[""] = {
["Auctioning"] = {
"#Default",
["override"] = true,
},
["Sniper"] = {
"#Default",
["override"] = true,
},
},
["My Group"] = {
["Auctioning"] = {
"#Default",
},
},
},
["g@ @tooltipOptions@enabled"] = true,
["p@Default@userData@items"] = {
["i:2738"] = "My Group",
["i:999"] = "AH Tracker\`Resell stock\`Other items",
},
["p@Default@userData@operations"] = {
["Auctioning"] = {
["#Default"] = {
["postCap"] = "1",
},
},
},
["_currentProfile"] = {
["Testchar - PvP"] = "Default",
},
}
`;

test("TSM groups: adds our groups, operation and items; leaves the user's groups and items alone; idempotent", () => {
  const wanted = new Map([["i:4306", SUBGROUPS.tg], ["i:8396", SUBGROUPS.quest], ["i:2738", SUBGROUPS.tg], ["i:12037", "AH Tracker`Trade Goods`Cooking"]]);
  const { text, plan } = updateTsmText(file, wanted, 0.1, 0.05);
  assert.deepEqual({ added: plan.added, removed: plan.removed, kept: plan.kept, created: plan.operationCreated }, { added: 3, removed: 1, kept: 1, created: true });
  assert.equal(plan.groups, 5); // AH Tracker, AH Tracker`Trade Goods, ...`Cloth, AH Tracker`Quest
  const db = parseSavedVariables(text).get("TradeSkillMasterDB");
  assert.ok(isTable(db));
  const items = db.map.get("p@Default@userData@items");
  assert.ok(isTable(items));
  assert.equal(items.map.get("i:2738"), "My Group"); // already in the user's own group
  assert.equal(items.map.get("i:8396"), SUBGROUPS.quest);
  assert.equal(items.map.get("i:999"), undefined); // sold since: removed from our group
  const ops = db.map.get("p@Default@userData@operations");
  assert.ok(isTable(ops));
  const auctioning = ops.map.get("Auctioning");
  assert.ok(isTable(auctioning));
  const op = auctioning.map.get(OPERATION);
  assert.ok(isTable(op));
  assert.equal(op.map.get("duration"), 1);
  assert.equal(op.map.get("postCap"), "5");
  assert.match(String(op.map.get("minPrice")), /1\.1579 \* smartavgbuy/);
  // Posting quantities: copies of the base operation with their own post cap.
  const cap = (name: string) => { const o = auctioning.map.get(name); assert.ok(isTable(o)); return o.map.get("postCap"); };
  assert.equal(cap("AHT 2h x1"), "1");
  assert.equal(cap("AHT 2h x2"), "2");
  assert.equal(cap("AHT 2h 25% of stack"), "max(1, roundup(0.25 * NumInventory))");
  assert.equal(db.map.get("g@ @tooltipOptions@enabled"), true); // other settings untouched
  assert.ok(text.includes('["g@ @tooltipOptions@enabled"] = true,'));
  const groups = db.map.get("p@Default@userData@groups");
  assert.ok(isTable(groups));
  assert.deepEqual([...groups.map.keys()].filter((k) => k.startsWith("AH Tracker")).sort(),
    ["AH Tracker", "AH Tracker`Quest", "AH Tracker`Trade Goods", "AH Tracker`Trade Goods`Cloth", "AH Tracker`Trade Goods`Cooking"]);
  assert.ok(groups.map.has("My Group"));
  // Sniper: only trade goods. The root has none, Trade Goods carries the operation, Quest inherits nothing,
  // and TSM's default on the base group (ungrouped items) is switched off.
  const sniper = (path: string) => { const g = groups.map.get(path); assert.ok(isTable(g)); const s = g.map.get("Sniper"); assert.ok(isTable(s)); return [s.list, s.map.get("override") ?? null]; };
  assert.deepEqual(sniper("AH Tracker"), [[], true]);
  assert.deepEqual(sniper("AH Tracker`Trade Goods"), [["AHT Snipe half price"], true]);
  assert.deepEqual(sniper("AH Tracker`Trade Goods`Cloth"), [["AHT Snipe half price"], null]);
  assert.deepEqual(sniper("AH Tracker`Quest"), [[], null]);
  assert.deepEqual(sniper("AH Tracker`Trade Goods`Cooking"), [[], true]); // cooking materials are not sniped
  assert.deepEqual(sniper(""), [[], true]);
  const again = updateTsmText(text, wanted, 0.1, 0.05);
  assert.equal(again.text, text);
});

test("TSM groups: watched items get their own subgroup, sniped at your buy price, posting inherited", async () => {
  const { tsmMoney, watchGroups } = await import("../src/tsm/groups.ts");
  const { openDb } = await import("../src/db/db.ts");
  assert.equal(tsmMoney(85000), "8g 50s");
  assert.equal(tsmMoney(1800), "18s");
  assert.equal(tsmMoney(95), "95c");
  const store = openDb(":memory:");
  store.prepare("INSERT INTO item (item_id, name, updated_at) VALUES (12363, 'Arcane Crystal', 0), (13468, 'Black Lotus', 0)").run();
  store.prepare("INSERT INTO watch_item (item_id, buy_below, created_at) VALUES (12363, 95000, 0), (13468, NULL, 0)").run();
  const gems = "AH Tracker`Trade Goods`Other`Gems & pearls";
  const wanted = new Map([["i:12363", gems], ["i:13468", "AH Tracker`Trade Goods`Herb"]]);
  const watch = watchGroups(store, wanted);
  assert.equal(wanted.get("i:12363"), `${gems}\`Watch Arcane Crystal`);
  assert.equal(wanted.get("i:13468"), "AH Tracker`Trade Goods`Herb"); // no buy price: stays put
  const { text } = updateTsmText(file, wanted, 0.1, 0.05, watch);
  const db = parseSavedVariables(text).get("TradeSkillMasterDB");
  assert.ok(isTable(db));
  const groups = db.map.get("p@Default@userData@groups");
  const ops = db.map.get("p@Default@userData@operations");
  assert.ok(isTable(groups) && isTable(ops));
  const g = groups.map.get(`${gems}\`Watch Arcane Crystal`);
  assert.ok(isTable(g));
  const sn = g.map.get("Sniper"), au = g.map.get("Auctioning");
  assert.ok(isTable(sn) && isTable(au));
  assert.deepEqual([sn.list, sn.map.get("override")], [["AHT Watch Arcane Crystal"], true]);
  assert.deepEqual([au.list, au.map.get("override") ?? null], [["AHT 2h x1"], null]); // gems post one at a time
  const sniperOps = ops.map.get("Sniper");
  assert.ok(isTable(sniperOps));
  const op = sniperOps.map.get("AHT Watch Arcane Crystal");
  assert.ok(isTable(op));
  assert.equal(op.map.get("belowPrice"), "9g 50s");
  // Price change: rewritten. Unwatched: the operation and subgroup go.
  store.prepare("UPDATE watch_item SET buy_below = 90000 WHERE item_id = 12363").run();
  const w2 = new Map([["i:12363", gems], ["i:13468", "AH Tracker`Trade Goods`Herb"]]);
  const t2 = updateTsmText(text, w2, 0.1, 0.05, watchGroups(store, w2)).text;
  assert.match(t2, /\["AHT Watch Arcane Crystal"\] = \{[^}]*\["belowPrice"\] = "9g",/s);
  const w3 = new Map([["i:12363", gems], ["i:13468", "AH Tracker`Trade Goods`Herb"]]);
  const t3 = updateTsmText(t2, w3, 0.1, 0.05).text;
  assert.doesNotMatch(t3, /AHT Watch|Watch Arcane Crystal/);
});
