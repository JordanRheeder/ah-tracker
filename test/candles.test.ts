import { test } from "node:test";
import assert from "node:assert/strict";
import { median, toCandles, toHeatMap, type Point } from "../src/api/candles.ts";

const H = 3600;
const p = (ts: number, price: number, quantity = 10): Point => ({ ts, price, quantity });

test("toCandles builds OHLC per bucket from unsorted points", () => {
  const candles = toCandles([p(H + 1800, 120, 30), p(H, 100, 10), p(H + 2400, 90, 20), p(2 * H + 5, 150, 40)], H);
  assert.deepEqual(candles, [
    { time: H, open: 100, high: 120, low: 90, close: 90, volume: 20, scans: 3 },
    { time: 2 * H, open: 150, high: 150, low: 150, close: 150, volume: 40, scans: 1 },
  ]);
});

test("toCandles returns nothing for no points", () => {
  assert.deepEqual(toCandles([], H), []);
});

test("median handles odd, even and empty inputs", () => {
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 1, 3, 2]), 3); // (2 + 3) / 2 rounded
  assert.equal(median([]), null);
});

test("toHeatMap places points by local weekday and hour and compares to the overall median", () => {
  // 2026-11-16 is a Monday. 22:00 UTC Monday = 00:00 Tuesday at UTC+2.
  const mon22utc = Date.UTC(2026, 10, 16, 22) / 1000;
  const cells = toHeatMap([p(mon22utc, 80), p(mon22utc + 7 * 86400, 100), p(mon22utc + 12 * H, 120)], 120);
  const tue0 = cells.find((c) => c.weekday === 1 && c.hour === 0);
  assert.equal(tue0?.scans, 2);
  assert.equal(tue0?.median, 90);
  assert.equal(tue0?.relative, (90 - 100) / 100);
  const tue12 = cells.find((c) => c.weekday === 1 && c.hour === 12);
  assert.equal(tue12?.median, 120);
  assert.equal(cells.length, 168);
  assert.equal(cells.filter((c) => c.scans > 0).length, 2);
});
