import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregate, type Listing } from "../src/aggregate.ts";

const l = (id: number, itemId: number, unitPrice: number | null, quantity: number): Listing => ({
  id, itemId, unitPrice, quantity, timeLeft: "LONG",
});

test("price20 averages the cheapest 20 units across listings", () => {
  // 5 @ 100, 10 @ 200, 20 @ 300 -> cheapest 20 = 5*100 + 10*200 + 5*300 = 4000 -> 200 per unit
  const [s] = aggregate([l(1, 7, 300, 20), l(2, 7, 100, 5), l(3, 7, 200, 10)]);
  assert.equal(s?.price20, 200);
  assert.equal(s?.minBuyout, 100);
  assert.equal(s?.quantity, 35);
  assert.equal(s?.listings, 3);
});

test("price20 uses all stock when fewer than 20 units exist", () => {
  const [s] = aggregate([l(1, 7, 100, 3), l(2, 7, 400, 1)]); // (300 + 400) / 4 = 175
  assert.equal(s?.price20, 175);
});

test("quantity-weighted percentiles follow units, not listings", () => {
  // 90 units @ 10 in one listing, 10 single units @ 1000: the median unit costs 10
  const listings = [l(1, 9, 10, 90), ...Array.from({ length: 10 }, (_, i) => l(100 + i, 9, 1000, 1))];
  const [s] = aggregate(listings);
  assert.equal(s?.p50, 10);
  assert.equal(s?.p10, 10);
  assert.equal(s?.listings, 11);
});

test("bid-only auctions count toward quantity but not prices", () => {
  const [s] = aggregate([l(1, 5, null, 4), l(2, 5, 50, 2)]);
  assert.equal(s?.quantity, 6);
  assert.equal(s?.minBuyout, 50);
  assert.equal(s?.price20, 50);
});

test("an item with only bid-only auctions has null prices", () => {
  const [s] = aggregate([l(1, 5, null, 4)]);
  assert.equal(s?.minBuyout, null);
  assert.equal(s?.price20, null);
  assert.equal(s?.p50, null);
});

test("items are separated and sorted by id", () => {
  const out = aggregate([l(1, 20, 5, 1), l(2, 10, 7, 1)]);
  assert.deepEqual(out.map((s) => s.itemId), [10, 20]);
});
