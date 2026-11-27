import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error plain JS module shared with the browser
import { calculate, expectedFailedListings, formatMoney } from "../web/calc.mjs";

const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-6, `${a} vs ${b}`);

test("Bolt of Runecloth: buy 28s 99c, sell 38s 99c, 20 units, 5% cut, 12c deposit, 0.25 failed listings", () => {
  const r = calculate({ buy: 2899, sell: 3899, quantity: 20, cut: 0.05, deposit: 12, failedListings: 0.25, minMargin: 0.1 });
  close(r.purchase, 57980);
  close(r.gross, 77980);
  close(r.ahCut, 3899);
  close(r.depositLost, 60); // 12c x 0.25 x 20
  close(r.net, 77980 - 3899 - 60);
  close(r.profit, 77980 - 3899 - 60 - 57980); // 16041c = 1g 60s 41c
  close(r.profitPerUnit, 16041 / 20);
  close(r.margin, 16041 / 57980);
  close(r.breakEvenSell, (2899 + 3) / 0.95);
  close(r.minSellForMargin, (2899 * 1.1 + 3) / 0.95);
  close(r.maxBuyForMargin, (3899 * 0.95 - 3) / 1.1);
  assert.equal(r.meetsMargin, true);
});

test("selling at break-even makes exactly zero", () => {
  const p = { buy: 1000, quantity: 7, cut: 0.15, deposit: 30, failedListings: 1.5, minMargin: 0.1 };
  const be = calculate({ ...p, sell: 0 }).breakEvenSell;
  close(calculate({ ...p, sell: be }).profit, 0);
  const min = calculate({ ...p, sell: 0 }).minSellForMargin;
  close(calculate({ ...p, sell: min }).margin, 0.1);
});

test("expected failed listings follow the sale rate and are capped", () => {
  close(expectedFailedListings(0.5), 1);
  close(expectedFailedListings(0.8), 0.25);
  assert.equal(expectedFailedListings(0.01), 5);
  assert.equal(expectedFailedListings(null), 0);
});

test("formatMoney writes gold, silver and copper", () => {
  assert.equal(formatMoney(16041), "1g 60s 41c");
  assert.equal(formatMoney(-250), "-2s 50c");
  assert.equal(formatMoney(0), "0c");
  assert.equal(formatMoney(3899), "38s 99c");
});

test("deposits are reported as their own line and their effect on the margin", () => {
  const r = calculate({ buy: 1000, sell: 1500, quantity: 10, cut: 0.05, deposit: 40, failedListings: 1, minMargin: 0.1 });
  close(r.profitBeforeDeposits, 15000 - 750 - 10000); // 4250
  close(r.depositLost, 400);
  close(r.profit, 3850);
  close(r.marginBeforeDeposits, 0.425);
  close(r.margin, 0.385);
  close(r.depositShareOfProfit, 400 / 4250);
  close(r.depositMarginDrag, 0.04); // 40c lost per unit on a 10s buy = 4 points of margin
});
