// AN-1 candles and the hour-of-day x weekday heat map, as pure functions over a price series.

export interface Point {
  /** Unix seconds (UTC). */
  ts: number;
  /** Copper per unit: price_20 when the scan had every listing, otherwise the cheapest buyout. */
  price: number;
  quantity: number;
}

export interface Candle {
  /** Bucket start, Unix seconds. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Average quantity listed across the scans in the bucket. */
  volume: number;
  scans: number;
}

export const RANGES = {
  "1D": { seconds: 86400, bucket: 3600 },
  "7D": { seconds: 7 * 86400, bucket: 4 * 3600 },
  "30D": { seconds: 30 * 86400, bucket: 86400 },
  "90D": { seconds: 90 * 86400, bucket: 86400 },
} as const;
export type RangeKey = keyof typeof RANGES;

/** Groups points (any order) into OHLC candles of `bucketSeconds`, aligned to UTC. */
export function toCandles(points: Point[], bucketSeconds: number): Candle[] {
  const sorted = [...points].sort((a, b) => a.ts - b.ts);
  const out: Candle[] = [];
  let cur: Candle | null = null;
  let qtySum = 0;
  for (const p of sorted) {
    const time = Math.floor(p.ts / bucketSeconds) * bucketSeconds;
    if (!cur || cur.time !== time) {
      if (cur) { cur.volume = Math.round(qtySum / cur.scans); out.push(cur); }
      cur = { time, open: p.price, high: p.price, low: p.price, close: p.price, volume: 0, scans: 0 };
      qtySum = 0;
    }
    cur.high = Math.max(cur.high, p.price);
    cur.low = Math.min(cur.low, p.price);
    cur.close = p.price;
    cur.scans++;
    qtySum += p.quantity;
  }
  if (cur) { cur.volume = Math.round(qtySum / cur.scans); out.push(cur); }
  return out;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] as number) : Math.round(((s[mid - 1] as number) + (s[mid] as number)) / 2);
}

export interface HeatCell {
  /** 0 = Monday ... 6 = Sunday, in the viewer's time zone. */
  weekday: number;
  hour: number;
  median: number | null;
  /** Median of this cell relative to the median of all points: -0.1 = 10% cheaper than usual. */
  relative: number | null;
  scans: number;
}

/**
 * Median price for each weekday x hour, in the viewer's time zone.
 * `tzOffsetMinutes` is minutes to ADD to UTC to get local time (UTC+2 = 120).
 */
export function toHeatMap(points: Point[], tzOffsetMinutes: number): HeatCell[] {
  const cells = new Map<number, number[]>();
  for (const p of points) {
    const local = new Date((p.ts + tzOffsetMinutes * 60) * 1000);
    const weekday = (local.getUTCDay() + 6) % 7;
    const key = weekday * 24 + local.getUTCHours();
    let bucket = cells.get(key);
    if (!bucket) cells.set(key, (bucket = []));
    bucket.push(p.price);
  }
  const overall = median(points.map((p) => p.price));
  const out: HeatCell[] = [];
  for (let weekday = 0; weekday < 7; weekday++)
    for (let hour = 0; hour < 24; hour++) {
      const prices = cells.get(weekday * 24 + hour) ?? [];
      const m = median(prices);
      out.push({
        weekday,
        hour,
        median: m,
        relative: m !== null && overall ? (m - overall) / overall : null,
        scans: prices.length,
      });
    }
  return out;
}
