// Per-item statistics behind the Opportunities and Anomalies pages. Pure functions over an hourly
// price series, so every rule is unit-tested with synthetic data (test/stats.test.ts).
// Robust statistics throughout (medians, MAD): single absurd listings must not move a signal.

export interface Pt {
  ts: number; // Unix seconds
  price: number; // copper per unit
  qty: number;
}

export interface Analysis {
  points: number;
  days: number;
  current: number;
  currentQty: number;
  currentTs: number;
  /** Median price over the lookback window: the item's "usual" price. */
  median: number;
  /** Median absolute deviation of price (robust spread). */
  mad: number;
  /** Median of the last 2 days (the "recent" level). */
  median3d: number;
  medianQty: number;
  /** Median price per UTC hour of day (null where no data). */
  hourMedian: (number | null)[];
  /** The 3 cheapest / dearest UTC hours, cheapest / dearest first. */
  buyHours: number[];
  sellHours: number[];
  /** Median of the cheapest / dearest hours' medians. */
  buyPrice: number;
  sellPrice: number;
  /** Share of full days where the cheap hours were below that day's median, the dear hours above it, and the gap was at least half the usual one. */
  patternConsistency: number;
  patternDays: number;
  /** Robust z-score of the current price against the window. */
  z: number;
  /** Conservative prices for "safer trade" checks: a low typical price overall, a low typical
   *  price in the dear hours, and a high typical price in the cheap hours (25th/25th/75th percentiles). */
  p25: number;
  sellP25: number;
  buyP75: number;
}

export function quantile(values: number[], q: number): number {
  if (values.length === 0) return Number.NaN;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return (s[lo] as number) + ((s[hi] as number) - (s[lo] as number)) * (pos - lo);
}

export function median(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

export function mad(values: number[], m = median(values)): number {
  return median(values.map((v) => Math.abs(v - m)));
}

/** Robust z-score; MAD is scaled by 1.4826 to match a standard deviation for normal data. */
export function robustZ(x: number, m: number, madValue: number): number {
  const scale = 1.4826 * madValue;
  if (scale > 0) return (x - m) / scale;
  return x === m ? 0 : Math.sign(x - m) * Number.POSITIVE_INFINITY;
}

const hourOf = (ts: number) => new Date(ts * 1000).getUTCHours();
const dayOf = (ts: number) => Math.floor(ts / 86400);

/** Returns null when there is not enough history to say anything (needs >= 3 days and 48 points). */
export function analyze(series: Pt[], now: number, lookbackDays = 14): Analysis | null {
  const pts = series.filter((p) => p.ts >= now - lookbackDays * 86400 && p.price > 0).sort((a, b) => a.ts - b.ts);
  if (pts.length < 48) return null;
  const days = new Set(pts.map((p) => dayOf(p.ts))).size;
  if (days < 3) return null;

  const prices = pts.map((p) => p.price);
  const m = median(prices);
  const d = mad(prices, m);
  const last = pts.at(-1) as Pt;
  // "Recent" level for new-normal detection: the last 2 days.
  const recent = pts.filter((p) => p.ts >= now - 2 * 86400).map((p) => p.price);

  const byHour: number[][] = Array.from({ length: 24 }, () => []);
  for (const p of pts) (byHour[hourOf(p.ts)] as number[]).push(p.price);
  const hourMedian = byHour.map((h) => (h.length >= 2 ? median(h) : null));
  const ranked = hourMedian
    .map((v, h) => ({ h, v }))
    .filter((x): x is { h: number; v: number } => x.v !== null)
    .sort((a, b) => a.v - b.v);
  const buyHours = ranked.slice(0, 3).map((x) => x.h);
  const sellHours = ranked.slice(-3).reverse().map((x) => x.h);
  const buyPrice = median(ranked.slice(0, 3).map((x) => x.v));
  const sellPrice = median(ranked.slice(-3).map((x) => x.v));

  // Consistency: on each day with good coverage, were the cheap hours cheap and the dear hours dear?
  const byDay = new Map<number, Pt[]>();
  for (const p of pts) {
    const k = dayOf(p.ts);
    let b = byDay.get(k);
    if (!b) byDay.set(k, (b = []));
    b.push(p);
  }
  let held = 0;
  let counted = 0;
  for (const dayPts of byDay.values()) {
    if (dayPts.length < 16) continue;
    const dm = median(dayPts.map((p) => p.price));
    const cheap = dayPts.filter((p) => buyHours.includes(hourOf(p.ts))).map((p) => p.price);
    const dear = dayPts.filter((p) => sellHours.includes(hourOf(p.ts))).map((p) => p.price);
    if (!cheap.length || !dear.length) continue;
    counted++;
    // A day counts only if it shows at least half the usual cheap-to-dear gap; noise on a flat day
    // would otherwise pass the above/below-median check about half the time.
    const gap = median(dear) - median(cheap);
    if (median(cheap) <= dm && median(dear) >= dm && gap >= 0.5 * (sellPrice - buyPrice) && gap > 0) held++;
  }

  const atHours = (hours: number[]) => pts.filter((p) => hours.includes(hourOf(p.ts))).map((p) => p.price);
  return {
    p25: quantile(prices, 0.25),
    sellP25: quantile(atHours(sellHours), 0.25),
    buyP75: quantile(atHours(buyHours), 0.75),
    points: pts.length,
    days,
    current: last.price,
    currentQty: last.qty,
    currentTs: last.ts,
    median: m,
    mad: d,
    median3d: recent.length ? median(recent) : m,
    medianQty: median(pts.map((p) => p.qty)),
    hourMedian,
    buyHours,
    sellHours,
    buyPrice,
    sellPrice,
    patternConsistency: counted ? held / counted : 0,
    patternDays: counted,
    z: robustZ(last.price, m, d),
  };
}

export interface Rules {
  /** AH cut on the house you sell on: 5% at faction houses, 15% at the neutral (goblin) house in Classic-style rules. */
  cut: number;
  minProfitPct: number;
  minSoldPerDay: number;
  minSaleRate: number;
  /** "Buy now" needs the current price at least this far under the usual price. */
  dealDiscount: number;
  /** Time-of-day flips need the pattern to hold on at least this share of days. */
  minConsistency: number;
}

export const DEFAULT_RULES: Omit<Rules, "cut"> = {
  minProfitPct: 0.1,
  minSoldPerDay: 5,
  minSaleRate: 0.2,
  dealDiscount: 0.2,
  minConsistency: 0.6,
};

/** Evidence bar for "safer" trades. */
export const SAFE = { minSoldPerDay: 20, minSaleRate: 0.5, minDays: 5, minConsistency: 0.75, maxRecentDrop: 0.1 };

function safeEvidence(a: Analysis, l: Liquidity, kind: Opportunity["kind"]): boolean {
  const falling = (a.median - a.median3d) / a.median > SAFE.maxRecentDrop;
  return (l.soldPerDay ?? 0) >= SAFE.minSoldPerDay && (l.saleRate ?? 0) >= SAFE.minSaleRate && a.days >= SAFE.minDays && !falling &&
    (kind !== "time-flip" || a.patternConsistency >= SAFE.minConsistency);
}

function withSafe(o: Omit<Opportunity, "safeProfit" | "safeMargin" | "safeEvidence">, cut: number, a: Analysis, l: Liquidity): Opportunity {
  // Listing costs: subtract the expected lost deposits from the model profit, and the pessimistic
  // (at least one lost deposit) amount from the worst case.
  const profit = o.profit - expectedDepositLoss(l);
  const safeProfit = o.safeSell * (1 - cut) - o.safeBuy - expectedDepositLoss(l, true);
  return { ...o, profit, margin: profit / o.buyPrice, safeProfit, safeMargin: safeProfit / o.safeBuy, safeEvidence: safeEvidence(a, l, o.kind) };
}

export interface Liquidity {
  soldPerDay: number | null;
  saleRate: number | null;
  /** Auction deposit for one unit at a 2-hour listing (copper), when known. */
  deposit?: number | null;
}

/**
 * Expected deposit lost per unit sold. Deposits are refunded on a sale and lost on expiry; with short
 * listings you relist until it sells, so expect (1 - saleRate) / saleRate failed listings per sale
 * (capped at 5). Safer mode assumes at least one lost deposit.
 */
export function expectedDepositLoss(l: Liquidity, safe = false): number {
  const d = l.deposit ?? 0;
  if (d <= 0) return 0;
  const s = Math.max(0.05, Math.min(1, l.saleRate ?? 0.2));
  const failedListings = Math.min(5, (1 - s) / s);
  return d * (safe ? Math.max(1, failedListings) : failedListings);
}

export function liquid(l: Liquidity, rules: Omit<Rules, "cut">): boolean {
  return (l.soldPerDay ?? 0) >= rules.minSoldPerDay && (l.saleRate ?? 0) >= rules.minSaleRate;
}

export interface Opportunity {
  kind: "buy-now" | "time-flip" | "sell-now";
  buyPrice: number;
  sellPrice: number;
  /** After the AH cut on the sale. */
  profit: number;
  margin: number;
  /** Pessimistic case: buy at a high typical price, sell at a low typical one (see Analysis.p25). */
  safeBuy: number;
  safeSell: number;
  safeProfit: number;
  safeMargin: number;
  /** Whether the item meets the safer-trade evidence bar (liquidity, history, consistency, no falling market). */
  safeEvidence: boolean;
  /** 0..1, how much the evidence supports it. */
  confidence: number;
  why: string;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** Turns one item's analysis into the opportunities it qualifies for. */
export function opportunities(a: Analysis, l: Liquidity, rules: Rules): Opportunity[] {
  const out: Opportunity[] = [];
  if (!liquid(l, rules)) return out;
  // A whole-market move (the last 3 days also low/high) is a "new normal", not a one-off.
  const levelShift = Math.abs(a.median3d - a.median) / a.median > 0.25;

  // Buy now: listed well under its usual price, and reselling at the usual price clears the cut.
  const discount = (a.median - a.current) / a.median;
  const dealProfit = a.median * (1 - rules.cut) - a.current;
  if (discount >= rules.dealDiscount && dealProfit / a.current >= rules.minProfitPct && !levelShift)
    out.push(withSafe({
      kind: "buy-now",
      buyPrice: a.current,
      sellPrice: a.median,
      profit: dealProfit,
      margin: dealProfit / a.current,
      // Pessimistic: you pay today's price but only manage to sell at a low typical price.
      safeBuy: a.current,
      safeSell: a.p25,
      confidence: Math.min(1, a.days / 10) * Math.min(1, Math.abs(a.z) / 4),
      why: `Listed at ${pct(discount)} under its ${a.days}-day usual price; reselling at the usual price clears the ${pct(rules.cut)} cut.`,
    }, rules.cut, a, l));

  // Time-of-day flip: buy in the cheap hours, relist for the dear hours.
  const flipProfit = a.sellPrice * (1 - rules.cut) - a.buyPrice;
  if (flipProfit / a.buyPrice >= rules.minProfitPct && a.patternConsistency >= rules.minConsistency && a.patternDays >= 3)
    out.push(withSafe({
      kind: "time-flip",
      buyPrice: a.buyPrice,
      sellPrice: a.sellPrice,
      profit: flipProfit,
      margin: flipProfit / a.buyPrice,
      // Pessimistic: a dear-ish buy in the cheap hours and a cheap-ish sale in the dear hours.
      safeBuy: a.buyP75,
      safeSell: a.sellP25,
      confidence: a.patternConsistency * Math.min(1, a.patternDays / 7),
      why: `Reliably cheapest and dearest at the same hours: the pattern held on ${Math.round(a.patternConsistency * a.patternDays)} of ${a.patternDays} days.`,
    }, rules.cut, a, l));

  // Sell now: if you hold it, today's price is well above usual.
  const premium = (a.current - a.median) / a.median;
  if (premium >= rules.dealDiscount && !levelShift)
    out.push(withSafe({
      kind: "sell-now",
      buyPrice: a.median,
      sellPrice: a.current,
      profit: a.current * (1 - rules.cut) - a.median,
      margin: (a.current * (1 - rules.cut) - a.median) / a.median,
      // Pessimistic: someone undercuts, so you sell a little under today's cheapest listing.
      safeBuy: a.median,
      safeSell: a.current * 0.97,
      confidence: Math.min(1, a.days / 10) * Math.min(1, Math.abs(a.z) / 4),
      why: `Selling at ${pct(premium)} over its ${a.days}-day usual price. If you hold stock, list now.`,
    }, rules.cut, a, l));
  // Drop anything the listing costs pushed under the minimum margin.
  return out.filter((o) => o.margin >= rules.minProfitPct);
}

export interface Anomaly {
  kind: "price-spike" | "price-crash" | "buyout" | "new-normal";
  severity: number;
  detail: string;
}

/** AN-6: unusual price, a large share of stock disappearing, or a lasting level shift. */
export function anomalies(a: Analysis): Anomaly[] {
  const out: Anomaly[] = [];
  if (Math.abs(a.z) >= 4 && Number.isFinite(a.z))
    out.push({
      kind: a.z > 0 ? "price-spike" : "price-crash",
      severity: Math.abs(a.z),
      detail: `Price is ${Math.abs(a.z).toFixed(1)} robust standard deviations ${a.z > 0 ? "above" : "below"} its usual level.`,
    });
  if (a.medianQty > 20 && a.currentQty < 0.2 * a.medianQty)
    out.push({
      kind: "buyout",
      severity: a.medianQty / Math.max(1, a.currentQty),
      detail: `Only ${a.currentQty} listed vs a usual ${Math.round(a.medianQty)}: most stock was bought up (or withdrawn).`,
    });
  const shift = (a.median3d - a.median) / a.median;
  if (Math.abs(shift) > 0.25)
    out.push({
      kind: "new-normal",
      severity: Math.abs(shift) * 10,
      detail: `The last 2 days run ${shift > 0 ? "+" : ""}${Math.round(shift * 100)}% vs the ${a.days}-day usual price: the market level has moved.`,
    });
  return out;
}
