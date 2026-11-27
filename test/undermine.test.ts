import { test } from "node:test";
import assert from "node:assert/strict";
import { HOUSES, type Config } from "../src/config.ts";
import { openDb } from "../src/db/db.ts";
import { backfillBatch, backfillQueue, pollHouseSummary } from "../src/ingest/undermine.ts";
import { storeTsm } from "../src/ingest/tsm.ts";

const plain = (v: unknown) => JSON.parse(JSON.stringify(v));
const alliance = HOUSES[0]!;
const config = {
  undermine: { apiKey: "k", region: "euf", backfillMinSoldPerDay: 5, reservePoints: 10 },
} as Config;

function fakeFetch(remaining = 2900) {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(url);
    const headers = { "ratelimit-remaining": String(remaining), "ratelimit-reset": "3600" };
    if (url.endsWith("/items.json"))
      return new Response(JSON.stringify({ result: { snapshot: "2026-11-18T18:23:10Z", items: {
        "2447": { item: 2447, price: 96, quantity: 6723 }, "765": { item: 765, price: 23, quantity: 7738 }, "9": { item: 9, price: 5, quantity: 0 },
      } } }), { headers });
    return new Response(JSON.stringify({ result: { hourly: [
      { snapshot: "2026-11-18T17:23:10Z", price: 90, quantity: 6800 },
      { snapshot: "2026-11-18T18:23:10Z", price: 96, quantity: 6723 },
    ] } }), { headers });
  }) as typeof fetch;
  return { impl, calls };
}

test("house summary stores every listed item once per Undermine snapshot", async () => {
  const db = openDb(":memory:");
  const { impl, calls } = fakeFetch();
  const first = await pollHouseSummary(db, config, alliance, impl);
  assert.equal(first.stored, true);
  assert.equal(first.items, 2);
  assert.equal(calls[0], "https://api.undermine.exchange/v1/realm/euf/pvp-alliance/items.json");
  assert.equal((await pollHouseSummary(db, config, alliance, impl)).stored, false);
  assert.deepEqual(plain(db.prepare("SELECT source, house_id, item_count FROM snapshot").all()), [{ source: "undermine", house_id: 110, item_count: 2 }]);
  assert.deepEqual(plain(db.prepare("SELECT min_buyout, price_20, quantity FROM item_snapshot WHERE item_id = 2447").get()), { min_buyout: 96, price_20: null, quantity: 6723 });
});

test("backfill adds history, shares snapshots with summaries and does not repeat items", async () => {
  const db = openDb(":memory:");
  storeTsm(db, "region", "itemId,name,marketValue,historical,avgSalePrice,saleRate,soldPerDay,updatedAt\n2447,Peacebloom,84,80,70,0.8,2394,2026-11-17T01:02:06Z\n765,Silverleaf,21,20,19,0.8,4229,2026-11-17T01:02:06Z\n1,Slow Item,1,1,1,0.1,2,2026-11-17T01:02:06Z\n", 1);
  const { impl } = fakeFetch();
  await pollHouseSummary(db, config, alliance, impl);
  assert.deepEqual(backfillQueue(db, config, alliance, 10), [765, 2447]); // items in the latest summary, busiest first

  const r = await backfillBatch(db, config, [alliance], 10, impl);
  assert.equal(r.done, 2);
  assert.deepEqual(backfillQueue(db, config, alliance, 10), []);
  // 2 Undermine times -> 2 snapshots; the 18:23 one is shared with the summary
  assert.deepEqual(plain(db.prepare("SELECT count(*) n FROM snapshot").get()), { n: 2 });
  assert.deepEqual(plain(db.prepare("SELECT ts, min_buyout FROM item_snapshot WHERE item_id = 2447 ORDER BY ts").all()), [
    { ts: Date.parse("2026-11-18T17:23:10Z") / 1000, min_buyout: 90 },
    { ts: Date.parse("2026-11-18T18:23:10Z") / 1000, min_buyout: 96 },
  ]);
});

test("backfill pauses when the rate-limit budget runs low", async () => {
  const db = openDb(":memory:");
  storeTsm(db, "region", "itemId,name,marketValue,historical,avgSalePrice,saleRate,soldPerDay,updatedAt\n2447,Peacebloom,84,80,70,0.8,2394,2026-11-17T01:02:06Z\n765,Silverleaf,21,20,19,0.8,4229,2026-11-17T01:02:06Z\n", 1);
  await pollHouseSummary(db, config, alliance, fakeFetch().impl); // backfill works from the latest summary
  const { impl } = fakeFetch(12); // after the first item only 12 points remain; reserve is 10, cost is 3
  const r = await backfillBatch(db, config, [alliance], 10, impl);
  assert.equal(r.done, 1);
  assert.equal(r.stoppedForBudget, true);
});
