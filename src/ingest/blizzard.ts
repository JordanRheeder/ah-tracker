// Blizzard API client and snapshot storage for the WoW: Forever auction house (IN-1, IN-3, ST-1, ST-2).
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { Config } from "../config.ts";
import { aggregate, type Listing } from "../aggregate.ts";
import { transaction, type Db } from "../db/db.ts";

export interface RawAuction {
  id: number;
  item: { id: number };
  buyout?: number;
  bid?: number;
  unit_price?: number;
  quantity: number;
  time_left?: string;
}

export interface HouseResponse {
  id?: number;
  name?: string;
  auctions?: RawAuction[];
  commodities?: RawAuction[] | { href: string };
}

let cachedToken: { value: string; expiresAt: number } | null = null;

export async function getToken(config: Config, fetchImpl = fetch): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 60_000) return cachedToken.value;
  const basic = Buffer.from(`${config.blizzard.clientId}:${config.blizzard.clientSecret}`).toString("base64");
  const res = await fetchImpl("https://oauth.battle.net/token", {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`Blizzard token request failed: HTTP ${res.status}`);
  const body = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { value: body.access_token, expiresAt: now + body.expires_in * 1000 };
  return cachedToken.value;
}

function apiUrl(config: Config, path: string): string {
  const { region, namespace } = config.blizzard;
  return `https://${region}.api.blizzard.com${path}?namespace=${namespace}&locale=en_GB`;
}

export async function listHouses(config: Config, fetchImpl = fetch) {
  const token = await getToken(config, fetchImpl);
  const res = await fetchImpl(apiUrl(config, `/data/wow/ruleset/${config.blizzard.rulesetId}/auctions/`), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Auction house index failed: HTTP ${res.status}`);
  return ((await res.json()) as { auctions: { id: number; name: string }[] }).auctions;
}

export interface FetchedHouse {
  status: number;
  lastModified: string | null;
  body: string | null; // null when 304 Not Modified
}

export async function fetchHouse(
  config: Config,
  ifModifiedSince: string | null,
  fetchImpl = fetch,
): Promise<FetchedHouse> {
  const token = await getToken(config, fetchImpl);
  const { rulesetId, houseId } = config.blizzard;
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, "Accept-Encoding": "gzip" };
  if (ifModifiedSince) headers["If-Modified-Since"] = ifModifiedSince;
  const res = await fetchImpl(apiUrl(config, `/data/wow/ruleset/${rulesetId}/auctions/${houseId}`), { headers });
  if (res.status === 304) return { status: 304, lastModified: ifModifiedSince, body: null };
  if (!res.ok) throw Object.assign(new Error(`Auction house ${houseId} fetch failed: HTTP ${res.status}`), { httpStatus: res.status });
  return { status: res.status, lastModified: res.headers.get("last-modified"), body: await res.text() };
}

/**
 * Converts raw auctions to per-unit listings.
 * `buyoutIsStackTotal`: whether `buyout` covers the whole stack (true) or one unit (false).
 * Commodities always carry `unit_price`.
 */
export function toListings(house: HouseResponse, buyoutIsStackTotal: boolean): Listing[] {
  const raw = [...(house.auctions ?? []), ...(Array.isArray(house.commodities) ? house.commodities : [])];
  return raw.map((a) => {
    let unitPrice: number | null = null;
    if (a.unit_price !== undefined) unitPrice = a.unit_price;
    else if (a.buyout !== undefined && a.buyout > 0)
      unitPrice = buyoutIsStackTotal ? Math.round(a.buyout / Math.max(1, a.quantity)) : a.buyout;
    return { id: a.id, itemId: a.item.id, unitPrice, quantity: a.quantity, timeLeft: a.time_left ?? null };
  });
}

export function lastStoredSnapshot(db: Db, houseId: number) {
  return db
    .prepare("SELECT id, fetched_at, last_modified, content_hash FROM snapshot WHERE house_id = ? ORDER BY fetched_at DESC LIMIT 1")
    .get(houseId) as { id: number; fetched_at: number; last_modified: number | null; content_hash: string } | undefined;
}

export interface StoreResult {
  stored: boolean;
  snapshotId?: number;
  auctions: number;
  items: number;
  goneLikelySold?: number;
  goneExpired?: number;
}

/** Stores a snapshot unless an identical one is already stored. */
export function storeSnapshot(
  db: Db,
  opts: {
    houseId: number;
    body: string;
    fetchedAt: number;
    lastModified: string | null;
    dataDir: string | null;
    buyoutIsStackTotal: boolean;
  },
): StoreResult {
  const hash = createHash("sha256").update(opts.body).digest("hex");
  const exists = db.prepare("SELECT id FROM snapshot WHERE house_id = ? AND content_hash = ?").get(opts.houseId, hash);
  const house = JSON.parse(opts.body) as HouseResponse;
  const listings = toListings(house, opts.buyoutIsStackTotal);
  if (exists) return { stored: false, auctions: listings.length, items: 0 };

  const stats = aggregate(listings);
  const lastModified = opts.lastModified ? Math.floor(Date.parse(opts.lastModified) / 1000) : null;

  return transaction(db, () => {
    const snap = db
      .prepare(
        `INSERT INTO snapshot (house_id, fetched_at, last_modified, content_hash, auction_count, item_count)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(opts.houseId, opts.fetchedAt, lastModified, hash, listings.length, stats.length);
    const snapshotId = Number(snap.lastInsertRowid);

    if (opts.dataDir) {
      const day = new Date(opts.fetchedAt * 1000).toISOString().slice(0, 10);
      const dir = join(opts.dataDir, "raw", day);
      mkdirSync(dir, { recursive: true });
      const rawPath = join(dir, `house-${opts.houseId}-snapshot-${snapshotId}.json.gz`);
      writeFileSync(rawPath, gzipSync(opts.body));
      db.prepare("UPDATE snapshot SET raw_path = ? WHERE id = ?").run(rawPath, snapshotId);
    }

    const ins = db.prepare(
      `INSERT INTO item_snapshot (snapshot_id, item_id, ts, min_buyout, price_20, p10, p25, p50, quantity, listings)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const s of stats)
      ins.run(snapshotId, s.itemId, opts.fetchedAt, s.minBuyout, s.price20, s.p10, s.p25, s.p50, s.quantity, s.listings);

    const gone = trackAuctions(db, snapshotId, listings);
    return { stored: true, snapshotId, auctions: listings.length, items: stats.length, ...gone };
  });
}

/**
 * ST-2: records which auctions are present, and classifies auctions that vanished since the
 * previous snapshot. An auction last seen with SHORT time left most likely expired; anything
 * else that vanished early most likely sold (or was cancelled, which the API cannot tell apart).
 */
function trackAuctions(db: Db, snapshotId: number, listings: Listing[]) {
  const upsert = db.prepare(
    `INSERT INTO auction_seen (auction_id, item_id, unit_price, quantity, first_seen, last_seen, last_time_left)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (auction_id) DO UPDATE SET
       last_seen = excluded.last_seen, last_time_left = excluded.last_time_left,
       quantity = excluded.quantity, unit_price = excluded.unit_price`,
  );
  for (const l of listings) upsert.run(l.id, l.itemId, l.unitPrice, l.quantity, snapshotId, snapshotId, l.timeLeft);

  const expired = db
    .prepare(
      `UPDATE auction_seen SET gone_at = ?, gone_reason = 'expired'
       WHERE gone_at IS NULL AND last_seen < ? AND last_time_left = 'SHORT'`,
    )
    .run(snapshotId, snapshotId);
  const sold = db
    .prepare(
      `UPDATE auction_seen SET gone_at = ?, gone_reason = 'likely_sold'
       WHERE gone_at IS NULL AND last_seen < ?`,
    )
    .run(snapshotId, snapshotId);
  return { goneExpired: Number(expired.changes), goneLikelySold: Number(sold.changes) };
}
