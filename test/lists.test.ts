import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db/db.ts";
import { auctionatorImport, auctionatorSearch, buildLists, luaString, maxBuyPrice, toLua } from "../src/stats/lists.ts";
import { parseSavedVariables, isTable } from "../src/ingest/luaTable.ts";

test("max buy price keeps the target margin after the selling house's cut", () => {
  // Sell at 1g, 5% cut, 10% margin: 10000 * 0.95 / 1.1 = 8636c
  assert.equal(maxBuyPrice(10000, 0.05, 0.1), 8636);
  // Neutral 15% cut: 10000 * 0.85 / 1.1 = 7727c
  assert.equal(maxBuyPrice(10000, 0.15, 0.1), 7727);
  const buy = maxBuyPrice(10000, 0.05, 0.1);
  assert.ok((10000 * 0.95 - buy) / buy >= 0.1);
  // Expected lost deposits come off the sale first: (10000 * 0.95 - 50) / 1.1 = 8590c
  assert.equal(maxBuyPrice(10000, 0.05, 0.1, 50), 8590);
});

test("luaString escapes quotes, backslashes and newlines", () => {
  assert.equal(luaString('A "quoted" \\ name\n'), '"A \\"quoted\\" \\\\ name\\n"');
});

test("the generated Lists.lua is valid Lua data with names and prices intact", () => {
  const lua = toLua([
    { name: "AHT PvP Alliance · Time flips", items: [{ itemId: 7076, name: 'Essence of "Earth"', maxPrice: 8636 }] },
    { name: "AHT PvP Alliance · Sell now", items: [{ itemId: 765, name: "Silverleaf", maxPrice: null }] },
  ], 1795000000);
  const root = parseSavedVariables(lua).get("AHTRACKER_LISTS");
  assert.ok(isTable(root));
  assert.equal(root.map.get("generated"), 1795000000);
  const lists = root.map.get("lists");
  assert.ok(isTable(lists));
  const first = lists.list[0];
  assert.ok(isTable(first));
  assert.equal(first.map.get("name"), "AHT PvP Alliance · Time flips");
  const items = first.map.get("items");
  assert.ok(isTable(items) && isTable(items.list[0]));
  assert.equal(items.list[0].map.get("name"), 'Essence of "Earth"');
  assert.equal(items.list[0].map.get("maxPrice"), 8636);
  const sell = lists.list[1];
  assert.ok(isTable(sell));
  const sellItems = sell.map.get("items");
  assert.ok(isTable(sellItems) && isTable(sellItems.list[0]));
  assert.equal(sellItems.list[0].map.get("maxPrice"), null);
});

test("Auctionator search strings match its advanced-search layout", () => {
  assert.equal(auctionatorSearch({ itemId: 1, name: "Warbear Leather", maxPrice: 7962 }), '"Warbear Leather";;;;;;;;;0.7962;;#;;');
  assert.equal(auctionatorSearch({ itemId: 2, name: "Blue Pearl", maxPrice: null }), '"Blue Pearl";;;;;;;;;;;#;;');
});

test("Auctionator import text has one line per non-empty list and strips separators from names", () => {
  const text = auctionatorImport([
    { name: "AHT PvP Alliance · Buy now", items: [{ itemId: 1, name: "Odd^Name", maxPrice: 10000 }, { itemId: 2, name: "Silverleaf", maxPrice: 50 }] },
    { name: "AHT PvP Neutral · Buy now", items: [] },
  ]);
  assert.equal(text, 'AHT PvP Alliance · Buy now^"Odd Name";;;;;;;;;1;;#;;^"Silverleaf";;;;;;;;;0.005;;#;;');
});

test("sell targets are written as per-house item tables in Lists.lua", () => {
  const lua = toLua([], 1, { alliance: { 7076: 55500, 765: 23 }, neutral: {} });
  const root = parseSavedVariables(lua).get("AHTRACKER_LISTS");
  assert.ok(isTable(root));
  const targets = root.map.get("sellTargets");
  assert.ok(isTable(targets));
  const alliance = targets.map.get("alliance");
  assert.ok(isTable(alliance));
  assert.equal(alliance.map.get("7076"), 55500);
  assert.equal(alliance.map.get("765"), 23);
});

test("between-houses lists: only trades that pay now, best Margin (N) first, max price from Sell (N) less deposits", () => {
  const db = openDb(":memory:");
  const item = db.prepare("INSERT INTO item (item_id, name, updated_at) VALUES (?, ?, 0)");
  const opp = db.prepare(`INSERT INTO stats_opportunity (house_id, item_id, kind, sell_house_id, buy_price, sell_price, profit, margin,
    confidence, score, why, computed_at, safe_buy, safe_sell, safe_profit, safe_margin, safe_evidence, sell_now, sell_now_ts, profit_now, margin_now)
    VALUES (116, ?, 'cross-house', 110, ?, 2000, 0, 0.5, 1, ?, '', 0, 0, 0, 0, 0, 0, ?, 0, ?, ?)`);
  // [id, buy, score, sellNow, profitNow]; Alliance cut 5%, 10% minimum margin.
  const rows: [number, number, number, number | null, number | null][] = [
    [1, 1000, 900, 1500, 1500 * 0.95 - 1000 - 10], // 41.5%
    [2, 1000, 100, 2000, 2000 * 0.95 - 1000 - 10], // 89%: lower score, but first
    [3, 1000, 999, 1100, 1100 * 0.95 - 1000 - 10], // loses money now: left out
    [4, 1000, 999, null, null],                    // not scanned recently: left out
  ];
  for (const [id, buy, score, sellNow, profitNow] of rows) {
    item.run(id, `Item ${id}`);
    opp.run(id, buy, score, sellNow, profitNow, profitNow === null ? null : profitNow / buy);
  }
  const list = buildLists(db, { targetMargin: 0.1, safeOnly: false }).find((l) => l.name === "AHT PvP Neutral · Between houses > PvP Alliance")!;
  assert.deepEqual(list.items.map((i) => i.itemId), [2, 1]);
  assert.equal(list.items[0]!.maxPrice, Math.floor((2000 * 0.95 - 10) / 1.1));
});

test("time-of-day flips are split into [TG] (trade goods) and [BOE] (other items) lists", () => {
  const db = openDb(":memory:");
  const item = db.prepare("INSERT INTO item (item_id, name, class_id, updated_at) VALUES (?, ?, ?, 0)");
  item.run(1, "Runecloth", 7);
  item.run(2, "Belt of Valor", 4);
  item.run(3, "Major Healing Potion", 0);
  const opp = db.prepare(`INSERT INTO stats_opportunity (house_id, item_id, kind, sell_house_id, buy_price, sell_price, profit, margin,
    confidence, score, why, computed_at) VALUES (110, ?, 'time-flip', 110, 100, 200, 90, 0.9, 1, 1, '', 0)`);
  for (const id of [1, 2, 3]) opp.run(id);
  const lists = buildLists(db, { targetMargin: 0.1, safeOnly: false });
  const ids = (name: string) => lists.find((l) => l.name === name)?.items.map((i) => i.itemId);
  assert.deepEqual(ids("[TG] AHT PvP Alliance · Time-of-day flips"), [1]);
  assert.deepEqual(ids("[BOE] AHT PvP Alliance · Time-of-day flips"), [2, 3]);
  assert.equal(ids("AHT PvP Alliance · Time-of-day flips"), undefined);
});

test("between houses also gets a [Q] list with quest items only", () => {
  const db = openDb(":memory:");
  const item = db.prepare("INSERT INTO item (item_id, name, class_id, updated_at) VALUES (?, ?, ?, 0)");
  item.run(1, "Vulture Gizzard", 12);
  item.run(2, "Black Diamond", 7);
  const opp = db.prepare(`INSERT INTO stats_opportunity (house_id, item_id, kind, sell_house_id, buy_price, sell_price, profit, margin,
    confidence, score, why, computed_at, sell_now, profit_now, margin_now) VALUES (110, ?, 'cross-house', 116, 100, 300, 100, 1, 1, 1, '', 0, ?, ?, ?)`);
  opp.run(1, 200, 60, 0.6);
  opp.run(2, 9000, 7000, 70); // a huge snipe margin
  const lists = buildLists(db, { targetMargin: 0.1, safeOnly: false });
  const ids = (name: string) => lists.find((l) => l.name === name)?.items.map((i) => i.itemId);
  assert.deepEqual(ids("AHT PvP Alliance · Between houses > PvP Neutral"), [2, 1]);
  assert.deepEqual(ids("[Q] AHT PvP Alliance · Between houses > PvP Neutral"), [1]);
});

test("the export's item toggle builds lists of only that kind of item, picked from all trades", () => {
  const db = openDb(":memory:");
  const item = db.prepare("INSERT INTO item (item_id, name, class_id, updated_at) VALUES (?, ?, ?, 0)");
  const opp = db.prepare(`INSERT INTO stats_opportunity (house_id, item_id, kind, sell_house_id, buy_price, sell_price, profit, margin,
    confidence, score, why, computed_at, sell_now, profit_now, margin_now) VALUES (110, ?, 'cross-house', 116, 100, 300, 100, 1, 1, 1, '', 0, 200, 60, ?)`);
  // 60 armour pieces with huge margins, then one trade good: in a shared top 50 the cloth would be crowded out.
  for (let i = 1; i <= 60; i++) { item.run(i, `Armor ${i}`, 4); opp.run(i, 50); }
  item.run(100, "Runecloth", 7); opp.run(100, 0.3);
  const names = (goods: "tg" | "other") => buildLists(db, { targetMargin: 0.1, safeOnly: false, goods })
    .filter((l) => l.name.includes("PvP Alliance · Between houses")).map((l) => [l.name, l.items.length]);
  assert.deepEqual(names("tg"), [["[TG] AHT PvP Alliance · Between houses > PvP Neutral", 1]]);
  assert.deepEqual(names("other"), [["[BOE] AHT PvP Alliance · Between houses > PvP Neutral", 50]]);
});

test("in game, the Between houses lists follow the dashboard's item toggle", async () => {
  const { setSetting, LIST_GOODS_KEY } = await import("../src/db/db.ts");
  const db = openDb(":memory:");
  const item = db.prepare("INSERT INTO item (item_id, name, class_id, updated_at) VALUES (?, ?, ?, 0)");
  const opp = db.prepare(`INSERT INTO stats_opportunity (house_id, item_id, kind, sell_house_id, buy_price, sell_price, profit, margin,
    confidence, score, why, computed_at, sell_now, profit_now, margin_now) VALUES (110, ?, 'cross-house', 116, 100, 300, 100, 1, 1, 1, '', 0, 200, 60, 0.6)`);
  item.run(1, "Runecloth", 7); opp.run(1);
  item.run(2, "Vulture Gizzard", 12); opp.run(2);
  item.run(3, "Belt of Valor", 4); opp.run(3);
  const cross = () => buildLists(db, { targetMargin: 0.1, safeOnly: false })
    .filter((l) => l.name.includes("PvP Alliance · Between houses")).map((l) => `${l.name.split(" AHT")[0]}:${l.items.map((i) => i.itemId)}`);
  // All items: the full list plus the [Q] quest list.
  assert.deepEqual(cross(), ["AHT PvP Alliance · Between houses > PvP Neutral:1,2,3", "[Q]:2"]);
  setSetting(db, LIST_GOODS_KEY, 1); // trade goods
  assert.deepEqual(cross(), ["[TG]:1"]);
  setSetting(db, LIST_GOODS_KEY, 3); // other items
  assert.deepEqual(cross(), ["[BOE]:3"]);
});

test("snipe lists: materials that sell, limited to half the lower of the two houses' usual prices", async () => {
  const { buildSnipeLists } = await import("../src/stats/lists.ts");
  const db = openDb(":memory:");
  db.prepare("INSERT INTO item_class (class_id, subclass_id, name) VALUES (7, 12, 'Enchanting'), (7, 5, 'Cloth')").run();
  const item = db.prepare("INSERT INTO item (item_id, name, class_id, subclass_id, updated_at) VALUES (?, ?, 7, ?, 0)");
  item.run(16204, "Illusion Dust", 12);
  item.run(14047, "Runecloth", 5);
  const st = db.prepare(`INSERT INTO stats_item (house_id, item_id, computed_at, days, points, current, median, median3d, buy_price, sell_price,
    buy_hours, sell_hours, hour_medians, consistency, pattern_days) VALUES (?, ?, 0, 7, 100, ?, ?, ?, ?, ?, '', '', '[]', 0, 0)`);
  st.run(110, 16204, 3900, 3900, 3900, 3900, 3900);
  st.run(116, 16204, 6100, 6100, 6100, 6100, 6100);
  st.run(110, 14047, 600, 600, 600, 600, 600);
  db.prepare("INSERT INTO tsm_region (item_id, updated_at, market_value, sold_per_day) VALUES (16204, 1, 4000, 329), (14047, 1, 600, 4570)").run();
  const lists = buildSnipeLists(db, 0.5);
  // Runecloth (Cloth) goes in the Tailoring list; enchanting lists hold only enchanting materials.
  assert.deepEqual(lists.find((l) => l.name === "[SNIPE] AHT PvP Alliance · Tailoring")?.items.map((i) => [i.name, i.maxPrice]), [["Runecloth", 300]]);
  assert.deepEqual(lists.filter((l) => l.name.endsWith("Enchanting")).map((l) => [l.name, l.items.map((i) => [i.name, i.maxPrice])]), [
    ["[SNIPE] AHT PvP Alliance · Enchanting", [["Illusion Dust", 1950]]],
    // Neutral's usual is 61s but Alliance's is 39s: a Neutral snipe is at half Alliance's price.
    ["[SNIPE] AHT PvP Neutral · Enchanting", [["Illusion Dust", 1950]]],
  ]);
});

test("conversion lists: the most you can pay per unit you buy still makes the margin on what the conversion sells", () => {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO item (item_id, name, class_id, updated_at) VALUES (10998, 'Lesser Astral Essence', 7, 0), (11082, 'Greater Astral Essence', 7, 0)").run();
  // Buy 3 Lesser on Alliance at 5s, combine, sell the Greater on Neutral at 42s (15% cut), 10c deposits lost.
  const profitNow = 4200 * 0.85 - 3 * 500 - 10;
  db.prepare(`INSERT INTO stats_opportunity (house_id, item_id, kind, sell_house_id, buy_price, sell_price, profit, margin, confidence, score, why,
    computed_at, sell_now, profit_now, margin_now, sell_item_id, convert_in, convert_out)
    VALUES (110, 10998, 'convert', 116, 500, 4200, 0, 1, 1, 1, '', 0, 4200, ?, ?, 11082, 3, 1)`).run(profitNow, profitNow / 1500);
  const list = buildLists(db, { targetMargin: 0.1, safeOnly: false }).find((l) => l.name === "[CONV] AHT PvP Alliance · Essence conversions > PvP Neutral")!;
  const max = list.items[0]!.maxPrice!;
  assert.equal(list.items[0]!.name, "Lesser Astral Essence");
  assert.equal(max, Math.floor(Math.floor((4200 * 0.85 - 10) / 1.1) / 3));
  // Buying 3 at that limit still makes at least 10%.
  assert.ok((4200 * 0.85 - 10 - 3 * max) / (3 * max) >= 0.1);
});

test("sell targets: your own listing price replaces the usual/dear-hour target on Alliance only", async () => {
  const { buildSellTargets } = await import("../src/stats/lists.ts");
  const db = openDb(":memory:");
  db.prepare("INSERT INTO item (item_id, name, updated_at) VALUES (3182, 'Spider''s Silk', 0)").run();
  db.prepare("INSERT INTO tsm_region (item_id, updated_at, sold_per_day, sale_rate) VALUES (3182, 1, 220, 0.86)").run();
  for (const h of [110, 116])
    db.prepare(`INSERT INTO stats_item (house_id, item_id, computed_at, days, points, current, median, median3d, buy_price, sell_price,
      buy_hours, sell_hours, hour_medians, consistency, pattern_days) VALUES (?, 3182, 0, 7, 100, 1100, 1200, 1200, 1100, 1300, '', '', '[]', 0, 0)`).run(h);
  assert.deepEqual(buildSellTargets(db), { alliance: { 3182: 1200 }, neutral: { 3182: 1200 } });
  db.prepare("INSERT INTO list_price (item_id, price, created_at) VALUES (3182, 1477, 0)").run();
  assert.deepEqual(buildSellTargets(db), { alliance: { 3182: 1477 }, neutral: { 3182: 1200 } });
});
