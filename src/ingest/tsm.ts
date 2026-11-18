// TSM public data: realm prices and EU-wide sales rates (IN-2).
import type { Config } from "../config.ts";
import { transaction, type Db } from "../db/db.ts";

export type TsmKind = "realm" | "region";

export function tsmUrl(config: Config, kind: TsmKind): string {
  const { game, region, realm } = config.tsm;
  const base = `https://public-data.tradeskillmaster.com/${game}/${region}`;
  return kind === "realm" ? `${base}/realm/${realm}/items.csv` : `${base}/region/items.csv`;
}

/** RFC 4180 CSV: quoted fields, doubled quotes, commas and newlines inside quotes. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);

  const [header, ...data] = rows;
  if (!header) return [];
  return data.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

const int = (v: string | undefined) => (v === undefined || v === "" ? null : Math.round(Number(v)));
const real = (v: string | undefined) => (v === undefined || v === "" ? null : Number(v));

export interface TsmStoreResult {
  stored: boolean;
  updatedAt: number | null;
  rows: number;
}

/** Stores a TSM file version unless that `updatedAt` is already stored. */
export function storeTsm(db: Db, kind: TsmKind, csv: string, now: number): TsmStoreResult {
  const rows = parseCsv(csv);
  const first = rows[0];
  if (!first) return { stored: false, updatedAt: null, rows: 0 };
  const updatedAt = Math.floor(Date.parse(first.updatedAt ?? "") / 1000);
  if (!Number.isFinite(updatedAt)) throw new Error(`TSM ${kind} file has no valid updatedAt`);

  const table = kind === "realm" ? "tsm_realm" : "tsm_region";
  const seen = db.prepare(`SELECT 1 FROM ${table} WHERE updated_at = ? LIMIT 1`).get(updatedAt);
  if (seen) return { stored: false, updatedAt, rows: rows.length };

  transaction(db, () => {
    const name = db.prepare(
      `INSERT INTO item (item_id, name, name_source, updated_at) VALUES (?, ?, 'tsm', ?)
       ON CONFLICT (item_id) DO UPDATE SET name = excluded.name, name_source = 'tsm', updated_at = excluded.updated_at
       WHERE item.name IS NOT excluded.name`,
    );
    const ins =
      kind === "realm"
        ? db.prepare(
            `INSERT OR IGNORE INTO tsm_realm (item_id, updated_at, market_value, min_buyout, recent, historical)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
        : db.prepare(
            `INSERT OR IGNORE INTO tsm_region (item_id, updated_at, market_value, historical, avg_sale_price, sale_rate, sold_per_day)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          );
    for (const r of rows) {
      const itemId = int(r.itemId);
      if (itemId === null) continue;
      if (r.name) name.run(itemId, r.name, now);
      if (kind === "realm") ins.run(itemId, updatedAt, int(r.marketValue), int(r.minBuyout), int(r.recent), int(r.historical));
      else ins.run(itemId, updatedAt, int(r.marketValue), int(r.historical), int(r.avgSalePrice), real(r.saleRate), real(r.soldPerDay));
    }
  });
  return { stored: true, updatedAt, rows: rows.length };
}

export async function fetchTsm(config: Config, kind: TsmKind, fetchImpl = fetch) {
  const res = await fetchImpl(tsmUrl(config, kind));
  if (!res.ok) throw Object.assign(new Error(`TSM ${kind} fetch failed: HTTP ${res.status}`), { httpStatus: res.status });
  return { status: res.status, body: await res.text() };
}
