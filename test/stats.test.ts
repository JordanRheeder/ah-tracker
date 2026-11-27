import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, anomalies, DEFAULT_RULES, opportunities, robustZ, type Pt } from "../src/stats/analyze.ts";

const H = 3600;
const NOW = Date.UTC(2026, 10, 18, 23) / 1000;
const rules = { ...DEFAULT_RULES, cut: 0.05 };
const liquidItem = { soldPerDay: 500, saleRate: 0.8 };

/** 14 days of hourly points; price(hourUTC, dayIndex) decides each price. */
function series(price: (hour: number, day: number) => number, qty = () => 1000, days = 14): Pt[] {
  const out: Pt[] = [];
  const start = NOW - days * 86400 + H;
  for (let t = start; t <= NOW; t += H) {
    const hour = new Date(t * 1000).getUTCHours();
    out.push({ ts: t, price: price(hour, Math.floor((t - start) / 86400)), qty: qty() });
  }
  return out;
}
// Cheap 04:00-07:00 UTC (80c), dear 18:00-21:00 UTC (130c), otherwise 100c, with a little noise.
const cycle = (hour: number, day: number) =>
  (hour >= 4 && hour <= 7 ? 80 : hour >= 18 && hour <= 21 ? 130 : 100) + ((hour * 7 + day * 3) % 5);

test("robustZ scales MAD like a standard deviation", () => {
  assert.equal(robustZ(110, 100, 10 / 1.4826), 1);
  assert.equal(robustZ(100, 100, 0), 0);
});

test("a clean daily cycle is found as a time-of-day flip", () => {
  const a = analyze(series(cycle), NOW);
  assert.ok(a);
  assert.ok(a.buyHours.every((h) => h >= 4 && h <= 7), `buy hours ${a.buyHours}`);
  assert.ok(a.sellHours.every((h) => h >= 18 && h <= 21), `sell hours ${a.sellHours}`);
  assert.ok(a.patternConsistency >= 0.9);
  const flip = opportunities(a, liquidItem, rules).find((o) => o.kind === "time-flip");
  assert.ok(flip, "expected a time-flip");
  assert.match(flip.why, /held on \d+ of \d+ days/);
  // ~131 * 0.95 - ~81 = ~43c profit per unit, ~50% margin
  assert.ok(flip.profit > 35 && flip.profit < 50, `profit ${flip.profit}`);
});

test("a cycle that held on only some days is not a flip", () => {
  // The cycle only exists on days 0-3; afterwards prices are flat with noise.
  const a = analyze(series((h, d) => (d < 4 ? cycle(h, d) : 100 + ((h * 13 + d * 7) % 9))), NOW);
  assert.ok(a);
  assert.ok(a.patternConsistency < rules.minConsistency, `consistency ${a.patternConsistency}`);
  assert.equal(opportunities(a, liquidItem, rules).some((o) => o.kind === "time-flip"), false);
});

test("a cheap listing now is a buy-now deal, not a crash anomaly unless extreme", () => {
  const s = series((h, d) => 100 + ((h + d) % 4));
  s[s.length - 1] = { ...(s.at(-1) as Pt), price: 60 };
  const a = analyze(s, NOW);
  assert.ok(a);
  const deal = opportunities(a, liquidItem, rules).find((o) => o.kind === "buy-now");
  assert.ok(deal, "expected buy-now");
  assert.equal(deal.buyPrice, 60);
  assert.ok(Math.abs(deal.profit - (a.median * 0.95 - 60)) < 1e-9);
  assert.ok(anomalies(a).some((x) => x.kind === "price-crash"), "60c vs ~101c with tiny spread is extreme");
});

test("a spike is a sell-now and a price-spike anomaly", () => {
  const s = series((h, d) => 100 + ((h + d) % 4));
  s[s.length - 1] = { ...(s.at(-1) as Pt), price: 180 };
  const a = analyze(s, NOW);
  assert.ok(a);
  assert.ok(opportunities(a, liquidItem, rules).some((o) => o.kind === "sell-now"));
  assert.ok(anomalies(a).some((x) => x.kind === "price-spike"));
});

test("most stock vanishing is a buyout anomaly", () => {
  const s = series(() => 100);
  s[s.length - 1] = { ...(s.at(-1) as Pt), qty: 50 };
  const a = analyze(s, NOW);
  assert.ok(a);
  assert.ok(anomalies(a).some((x) => x.kind === "buyout"));
});

test("a lasting level shift is a new normal and suppresses buy-now", () => {
  // Price halves for the last 3 days and stays there (within a 7-day window).
  const a = analyze(series((h, d) => (d >= 11 ? 50 : 100)), NOW, 7);
  assert.ok(a);
  assert.ok(anomalies(a).some((x) => x.kind === "new-normal"));
  assert.equal(opportunities(a, liquidItem, rules).some((o) => o.kind === "buy-now"), false);
});

test("items that do not sell get no opportunities", () => {
  const a = analyze(series(cycle), NOW);
  assert.ok(a);
  assert.deepEqual(opportunities(a, { soldPerDay: 2, saleRate: 0.9 }, rules), []);
  assert.deepEqual(opportunities(a, { soldPerDay: 500, saleRate: 0.1 }, rules), []);
});

test("the neutral house's 15% cut can wipe out a flip that works at 5%", () => {
  // Cheap 100c, dear 112c: 112 * 0.95 - 100 = 6.4 (6%) and 112 * 0.85 - 100 = -4.8
  const a = analyze(series((h) => (h >= 4 && h <= 7 ? 100 : h >= 18 && h <= 21 ? 112 : 106)), NOW);
  assert.ok(a);
  assert.equal(opportunities(a, liquidItem, { ...rules, minProfitPct: 0.05 }).some((o) => o.kind === "time-flip"), true);
  assert.equal(opportunities(a, liquidItem, { ...rules, minProfitPct: 0.05, cut: 0.15 }).some((o) => o.kind === "time-flip"), false);
});

test("too little history gives no analysis", () => {
  assert.equal(analyze(series(cycle, () => 1000, 1), NOW), null);
});

test("safer-trade check: a steady liquid flip passes, a thin or falling one does not", () => {
  const steady = analyze(series(cycle), NOW, 7);
  assert.ok(steady);
  const flip = opportunities(steady, liquidItem, rules).find((o) => o.kind === "time-flip");
  assert.ok(flip);
  assert.equal(flip.safeEvidence, true);
  assert.ok(flip.safeBuy >= flip.buyPrice && flip.safeSell <= flip.sellPrice, "pessimistic prices bracket the model prices");
  assert.ok(flip.safeProfit <= flip.profit && flip.safeProfit > 0);

  // Same pattern, but too few sales across EU: the evidence bar fails.
  const thin = opportunities(steady, { soldPerDay: 8, saleRate: 0.8 }, rules).find((o) => o.kind === "time-flip");
  assert.ok(thin);
  assert.equal(thin.safeEvidence, false);

  // A cheap listing on an item whose price has dropped for the last 2 days: not a safe buy.
  const s = series((h, d) => (d >= 12 ? 85 : 100) + ((h + d) % 3));
  s[s.length - 1] = { ...(s.at(-1) as Pt), price: 60 };
  const falling = analyze(s, NOW, 7);
  assert.ok(falling);
  const deal = opportunities(falling, liquidItem, rules).find((o) => o.kind === "buy-now");
  assert.ok(deal);
  assert.equal(deal.safeEvidence, false);
});

test("listing deposits come off the profit: more for items that rarely sell, all of one in the worst case", async () => {
  const { expectedDepositLoss } = await import("../src/stats/analyze.ts");
  assert.equal(expectedDepositLoss({ soldPerDay: 100, saleRate: 0.5, deposit: 10 }), 10); // 1 failed listing per sale
  assert.ok(Math.abs(expectedDepositLoss({ soldPerDay: 100, saleRate: 0.8, deposit: 10 }) - 2.5) < 1e-9); // 0.25 failed listings
  assert.equal(expectedDepositLoss({ soldPerDay: 100, saleRate: 0.8, deposit: 10 }, true), 10); // worst case: at least one
  assert.equal(expectedDepositLoss({ soldPerDay: 100, saleRate: 0.01, deposit: 10 }), 50); // capped at 5 listings
  assert.equal(expectedDepositLoss({ soldPerDay: 100, saleRate: 0.5 }), 0); // unknown deposit

  const a = analyze(series(cycle), NOW);
  assert.ok(a);
  const free = opportunities(a, liquidItem, rules).find((o) => o.kind === "time-flip");
  const withDeposit = opportunities(a, { ...liquidItem, deposit: 8 }, rules).find((o) => o.kind === "time-flip");
  assert.ok(free && withDeposit);
  assert.ok(Math.abs(free.profit - withDeposit.profit - 8 * (0.2 / 0.8)) < 1e-9);
  assert.ok(withDeposit.safeProfit <= free.safeProfit - 8);
});

test("Horde-only items are never planned for sale on the Alliance AH", async () => {
  const { sellsOn, houseByKey } = await import("../src/config.ts");
  assert.equal(sellsOn(houseByKey("alliance")!, 16645), false); // Shredder Operating Manual - Page 1
  assert.equal(sellsOn(houseByKey("neutral")!, 16645), true);
  assert.equal(sellsOn(houseByKey("alliance")!, 14047), true); // Runecloth
});
