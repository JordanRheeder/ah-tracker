// Price trends and short-range forecasts from daily prices.
//
// Forever is young (about two weeks of history). Back-tests on that history (scratch analysis,
// 2026-11-19, ~900 liquid items per house) found:
// - Following the trend (damped Theil-Sen, any window or damping) never beat "no change" at 1-3 days;
//   it was up to 47% worse.
// - Pulling today's price halfway back toward its 3-day median beat "no change" by about 6% once
//   launch week was left out, on about 60% of items, on both houses.
// So the forecast is the snap-back estimate, and the trend is shown as a description only. Both
// methods are re-tested on every refresh; the dashboard shows each one's current accuracy so a trend
// forecast can be switched on once it earns it.
//
// Definitions:
// - Daily price: median of that day's hourly prices (the low end of listings, as everywhere else).
// - Trend: Theil-Sen slope of log price over the last TREND_DAYS days (median of all pairwise slopes,
//   so one odd day does not swing it), as % per day.
// - Consistency: Kendall's tau over the same days, -1 (falls every day) .. 1 (rises every day).
// - Skill: 1 - (forecast error / "no change" error) over 1-3 day horizons on the item's own history.

export interface DailyPoint { day: number; price: number; quantity?: number } // day = unix days (ts / 86400)

export const TREND_DAYS = 6;
/** Days at the start of a series left out of back-tests (the launch crash). */
export const SKIP_DAYS = 4;
/** Snap-back: how far toward the recent median the next days are expected to move. */
export const PULL = 0.5;
export const PULL_DAYS = 3;
/** Trend forecast, kept for back-testing only: damped Theil-Sen. */
export const PHI = 0.3;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Theil-Sen slope and Kendall's tau of y over x. */
export function theilSen(x: number[], y: number[]): { slope: number; intercept: number; tau: number } {
  const slopes: number[] = [];
  let concordant = 0, discordant = 0;
  for (let i = 0; i < x.length; i++)
    for (let j = i + 1; j < x.length; j++) {
      if (x[j] === x[i]) continue;
      slopes.push((y[j]! - y[i]!) / (x[j]! - x[i]!));
      const s = Math.sign((y[j]! - y[i]!) * (x[j]! - x[i]!));
      if (s > 0) concordant++;
      else if (s < 0) discordant++;
    }
  if (!slopes.length) return { slope: 0, intercept: y[0] ?? 0, tau: 0 };
  const slope = median(slopes);
  const intercept = median(y.map((v, i) => v - slope * x[i]!));
  const pairs = (x.length * (x.length - 1)) / 2;
  return { slope, intercept, tau: (concordant - discordant) / pairs };
}

/** Snap-back estimate (log price) for the next days from the points up to and including `end`. */
function snapBack(logs: number[], end: number): number {
  const last = logs[end]!;
  const recent = median(logs.slice(Math.max(0, end - PULL_DAYS + 1), end + 1));
  return last + PULL * (recent - last);
}

/** Damped-trend estimate (log price) h days after `end`. */
function trendAhead(days: number[], logs: number[], end: number, h: number): number {
  const from = Math.max(0, end - TREND_DAYS + 1);
  const { slope } = theilSen(days.slice(from, end + 1), logs.slice(from, end + 1));
  let s = 0, p = 1;
  for (let i = 1; i <= h; i++) { p *= PHI; s += p; }
  return logs[end]! + slope * s;
}

export interface BacktestErrors { snap: number; trend: number; naive: number; n: number }

/** Absolute log errors of each method, forecasting 1-3 days ahead from every day after the launch days. */
export function backtest(points: DailyPoint[]): BacktestErrors {
  const pts = points.slice(SKIP_DAYS);
  const days = pts.map((p) => p.day);
  const logs = pts.map((p) => Math.log(p.price));
  const at = new Map(days.map((d, i) => [d, i]));
  const e: BacktestErrors = { snap: 0, trend: 0, naive: 0, n: 0 };
  for (let end = 2; end < pts.length - 1; end++) {
    const snap = snapBack(logs, end);
    for (const h of [1, 2, 3]) {
      const t = at.get(days[end]! + h);
      if (t === undefined) continue;
      const actual = logs[t]!;
      e.snap += Math.abs(snap - actual);
      e.trend += Math.abs(trendAhead(days, logs, end, h) - actual);
      e.naive += Math.abs(logs[end]! - actual);
      e.n++;
    }
  }
  return e;
}

export const skillOf = (err: number, naive: number) => (naive > 0 ? 1 - err / naive : null);

export interface ItemForecast {
  days: number;
  /** Latest daily price and the snap-back estimate for the next 1-3 days. */
  level: number;
  next: number;
  /** Trend over the last TREND_DAYS days: fraction per day, and its consistency (-1..1). */
  trend: number;
  consistency: number;
  /** Trend in the quantity listed (fraction per day); null without quantities. */
  supplyTrend: number | null;
  peak: number;
  low: number;
  /** Back-test skill of the snap-back estimate on this item; null with too little history. */
  skill: number | null;
  backtests: number;
  errors: BacktestErrors;
}

export function itemForecast(points: DailyPoint[]): ItemForecast | null {
  const pts = points.filter((p) => p.price > 0).sort((a, b) => a.day - b.day);
  if (pts.length < 5) return null;
  const days = pts.map((p) => p.day);
  const logs = pts.map((p) => Math.log(p.price));
  const from = Math.max(0, pts.length - TREND_DAYS);
  const t = theilSen(days.slice(from), logs.slice(from));
  const q = pts.slice(from).filter((p) => (p.quantity ?? 0) > 0);
  const supply = q.length >= 4 ? theilSen(q.map((p) => p.day), q.map((p) => Math.log(p.quantity!))).slope : null;
  const errors = backtest(pts);
  return {
    days: pts.length,
    level: pts[pts.length - 1]!.price,
    next: Math.exp(snapBack(logs, logs.length - 1)),
    trend: Math.exp(t.slope) - 1,
    consistency: t.tau,
    supplyTrend: supply === null ? null : Math.exp(supply) - 1,
    peak: Math.max(...pts.map((p) => p.price)),
    low: Math.min(...pts.map((p) => p.price)),
    skill: errors.n >= 6 ? skillOf(errors.snap, errors.naive) : null,
    backtests: errors.n,
    errors,
  };
}

/** Daily points from hourly prices: per day the median price and median quantity (days with 6+ hours). */
export function toDaily(hourly: { ts: number; price: number; quantity: number }[]): DailyPoint[] {
  const by = new Map<number, { p: number[]; q: number[] }>();
  for (const h of hourly) {
    const day = Math.floor(h.ts / 86400);
    let a = by.get(day);
    if (!a) by.set(day, (a = { p: [], q: [] }));
    a.p.push(h.price);
    a.q.push(h.quantity);
  }
  return [...by].filter(([, a]) => a.p.length >= 6)
    .map(([day, a]) => ({ day, price: median(a.p), quantity: median(a.q) }))
    .sort((a, b) => a.day - b.day);
}
