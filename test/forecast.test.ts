import { test } from "node:test";
import assert from "node:assert/strict";
import { backtest, itemForecast, theilSen, toDaily, type DailyPoint } from "../src/stats/forecast.ts";

const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

test("Theil-Sen ignores one wild point; Kendall's tau measures consistency", () => {
  const x = [0, 1, 2, 3, 4, 5];
  const y = [0, 1, 2, 30, 4, 5]; // one spike
  const t = theilSen(x, y);
  close(t.slope, 1);
  assert.ok(t.tau > 0.6);
  close(theilSen(x, [5, 4, 3, 2, 1, 0]).tau, -1);
});

test("a steady 5% a day rise reads as +5%/day with full consistency; the estimate pulls back toward the 3-day median", () => {
  const pts: DailyPoint[] = Array.from({ length: 10 }, (_, i) => ({ day: 20000 + i, price: 10000 * 1.05 ** i, quantity: 100 }));
  const f = itemForecast(pts)!;
  close(f.trend, 0.05, 1e-9);
  close(f.consistency, 1);
  close(f.supplyTrend!, 0);
  // Last price 10000 x 1.05^9; 3-day median 1.05^8; halfway in log terms = 1.05^8.5.
  close(f.next, 10000 * 1.05 ** 8.5, 1e-6);
  assert.equal(f.peak, pts[9]!.price);
});

test("back-test: on a price that bounces around a level, snap-back beats no change and the trend does not", () => {
  const prices = [100, 100, 100, 100, 110, 95, 108, 92, 111, 94, 106, 96, 109, 93];
  const e = backtest(prices.map((price, i) => ({ day: i, price })));
  assert.ok(e.n > 0);
  assert.ok(e.snap < e.naive, `snap ${e.snap} vs naive ${e.naive}`);
  assert.ok(e.trend >= e.snap);
});

test("daily points use the median of days with at least 6 hourly prices", () => {
  const h = (day: number, hour: number, price: number) => ({ ts: day * 86400 + hour * 3600, price, quantity: 10 });
  const hourly = [...[1, 2, 3, 4, 5, 6, 7].map((i) => h(5, i, i * 100)), h(6, 1, 999)];
  assert.deepEqual(toDaily(hourly), [{ day: 5, price: 400, quantity: 10 }]);
});
