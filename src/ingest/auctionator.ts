// Imports Auctionator full scans saved by the AHTracker companion addon (addon/AHTracker).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Listing } from "../aggregate.ts";
import { houseByKey, type House } from "../config.ts";
import { transaction, type Db } from "../db/db.ts";
import { storeListings, type StoreResult } from "./blizzard.ts";
import { isTable, parseSavedVariables, type LuaValue } from "./luaTable.ts";

export interface SavedScan {
  ts: number;
  realm: string | null;
  /** The player's faction. */
  faction: string | null;
  /** The auction house scanned: alliance | horde | neutral (addon 1.1+; older scans lack it). */
  house: string | null;
  format: number;
  count: number;
  data: string;
}

/** All AHTracker.lua SavedVariables files under the WoW Forever folder, one per WoW account. */
export function findScanFiles(wowForeverDir: string): string[] {
  const accounts = join(wowForeverDir, "WTF", "Account");
  if (!existsSync(accounts)) return [];
  return readdirSync(accounts)
    .map((a) => join(accounts, a, "SavedVariables", "AHTracker.lua"))
    .filter((p) => existsSync(p));
}

export function parseScans(text: string): SavedScan[] {
  const db = parseSavedVariables(text).get("AHTRACKER_DB");
  if (!isTable(db)) return [];
  const scans = db.map.get("scans");
  if (!isTable(scans)) return [];
  const str = (v: LuaValue | undefined) => (typeof v === "string" ? v : null);
  const num = (v: LuaValue | undefined) => (typeof v === "number" ? v : null);
  return scans.list.flatMap((s) => {
    if (!isTable(s)) return [];
    const ts = num(s.map.get("ts"));
    const data = str(s.map.get("data"));
    if (ts === null || data === null) return [];
    return [{
      ts,
      realm: str(s.map.get("realm")),
      faction: str(s.map.get("faction")),
      house: str(s.map.get("house")),
      format: num(s.map.get("format")) ?? 1,
      count: num(s.map.get("count")) ?? 0,
      data,
    }];
  });
}

/**
 * Format 1 (full scan): listings joined by ";", each "itemId,count,buyout,minBid" in copper, where
 * buyout covers the whole stack and 0 means bid only.
 * Format 2 (browse scan): one summary per item, "itemId,totalQuantity,minPrice" with minPrice the
 * cheapest unit buyout.
 * Auctions carry no stable id in either format, so ids are positional.
 */
export function decodeScan(data: string, format = 1): Listing[] {
  const out: Listing[] = [];
  let id = 0;
  for (const part of data.split(";")) {
    const [itemId, count, price] = part.split(",").map(Number);
    if (!itemId || !count || count <= 0) continue;
    const unitPrice = !price || price <= 0 ? null : format === 2 ? price : Math.round(price / count);
    out.push({ id: id++, itemId, unitPrice, quantity: count, timeLeft: null });
  }
  return out;
}

export interface ImportResult {
  file: string;
  scans: number;
  stored: number;
  /** Scans from an auction house AH Tracker does not follow. */
  skippedHouse: number;
  /** Items with category/quality/icon details in the file. */
  items: number;
  results: StoreResult[];
}

/**
 * Which auction house a scan came from. Addon 1.1+ records it; older scans only know the player's
 * faction, which is wrong for scans made at a neutral auction house, so those fall back to `fallback`.
 */
export function scanHouse(scan: SavedScan, fallback: House | undefined): House | undefined {
  return houseByKey(scan.house) ?? fallback ?? houseByKey(scan.faction);
}

export function importScanFile(
  db: Db,
  file: string,
  opts: { dataDir: string | null; fallbackHouse?: House },
): ImportResult {
  const text = readFileSync(file, "utf8");
  const scans = parseScans(text);
  const meta = importItemMeta(db, text);
  const result: ImportResult = { file, scans: scans.length, stored: 0, skippedHouse: 0, items: meta.items, results: [] };
  for (const scan of scans) {
    const house = scanHouse(scan, opts.fallbackHouse);
    if (!house) {
      result.skippedHouse++;
      continue;
    }
    if (scan.format !== 1 && scan.format !== 2) throw new Error(`Unknown AHTracker scan format ${scan.format}`);
    const browse = scan.format === 2;
    const stored = storeListings(db, {
      source: browse ? "auctionator-browse" : "auctionator-full",
      houseId: house.houseId,
      fetchedAt: scan.ts,
      lastModified: null,
      raw: { body: scan.data, ext: "txt" },
      dataDir: opts.dataDir,
      listings: decodeScan(scan.data, scan.format),
      trackAuctionIds: false,
      summary: browse,
    });
    if (stored.stored) result.stored++;
    result.results.push(stored);
  }
  return result;
}

/**
 * Item metadata the addon records from the game client (addon 1.2+): category, quality, icon.
 * items[itemId] = "classId,subclassId,quality,iconFileId,equipLoc" (quality "?" = not cached yet),
 * classes["7"] = "Trade Goods", classes["7.9"] = "Herb".
 */
export function importItemMeta(db: Db, text: string, now = Math.floor(Date.now() / 1000)) {
  const root = parseSavedVariables(text).get("AHTRACKER_DB");
  if (!isTable(root)) return { items: 0, classes: 0 };
  const items = root.map.get("items");
  const classes = root.map.get("classes");
  let nItems = 0;
  let nClasses = 0;
  transaction(db, () => {
    if (isTable(items)) {
      const up = db.prepare(
        `INSERT INTO item (item_id, updated_at, class_id, subclass_id, quality, icon_file_id, equip_loc, vendor_price, deposit_unit)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (item_id) DO UPDATE SET class_id = excluded.class_id, subclass_id = excluded.subclass_id,
           quality = coalesce(excluded.quality, item.quality), icon_file_id = excluded.icon_file_id,
           equip_loc = excluded.equip_loc, vendor_price = coalesce(excluded.vendor_price, item.vendor_price),
           deposit_unit = coalesce(excluded.deposit_unit, item.deposit_unit)`,
      );
      for (const [key, value] of items.map) {
        if (typeof value !== "string") continue;
        const [classId, subclassId, quality, icon, equipLoc, vendor, deposit] = value.split(",");
        const optNum = (v: string | undefined) => (v === undefined || v === "" || v === "?" || !Number.isFinite(Number(v)) ? null : Number(v));
        const id = Number(key);
        if (!Number.isInteger(id) || id <= 0 || classId === undefined) continue;
        const q = quality === undefined || quality === "?" ? null : Number(quality);
        up.run(id, now, Number(classId), Number(subclassId ?? 0), q, Number(icon ?? 0) || null, equipLoc || null, optNum(vendor), optNum(deposit));
        nItems++;
      }
    }
    if (isTable(classes)) {
      const up = db.prepare(
        `INSERT INTO item_class (class_id, subclass_id, name) VALUES (?, ?, ?)
         ON CONFLICT (class_id, subclass_id) DO UPDATE SET name = excluded.name`,
      );
      for (const [key, value] of classes.map) {
        if (typeof value !== "string") continue;
        const [c, sub] = key.split(".");
        up.run(Number(c), sub === undefined ? -1 : Number(sub), value);
        nClasses++;
      }
    }
  });
  // Purchases recorded by the addon (1.5+); the key makes re-imports idempotent.
  const purchases = root.map.get("purchases");
  let nPurchases = 0;
  if (isTable(purchases)) {
    const ins = db.prepare("INSERT OR IGNORE INTO purchase (ts, item_id, qty, unit, house) VALUES (?, ?, ?, ?, ?)");
    transaction(db, () => {
      for (const p of purchases.list) {
        if (!isTable(p)) continue;
        const [ts, itemId, qty, unit] = ["ts", "itemId", "qty", "unit"].map((k) => p.map.get(k));
        if ([ts, itemId, qty, unit].every((v) => typeof v === "number")) {
          nPurchases += Number(ins.run(ts as number, itemId as number, qty as number, unit as number, (p.map.get("house") as string) ?? null).changes);
        }
      }
    });
  }
  // Inventory (addon 1.6+): replace each character's bags/bank with the latest scan.
  const inventory = root.map.get("inventory");
  let nInventory = 0;
  if (isTable(inventory)) {
    const del = db.prepare("DELETE FROM inventory WHERE character = ? AND location = ?");
    const ins = db.prepare("INSERT INTO inventory (character, location, item_id, qty, updated_at) VALUES (?, ?, ?, ?, ?)");
    transaction(db, () => {
      for (const [character, value] of inventory.map) {
        if (!isTable(value)) continue;
        for (const location of ["bags", "bank"]) {
          const data = value.map.get(location);
          const ts = value.map.get(`${location}Ts`);
          if (typeof data !== "string" || typeof ts !== "number") continue;
          del.run(character, location);
          for (const pair of data.split(",")) {
            const [id, qty] = pair.split(":").map(Number);
            if (id && qty && qty > 0) { ins.run(character, location, id, qty, ts); nInventory++; }
          }
        }
      }
    });
  }
  return { items: nItems, classes: nClasses, purchases: nPurchases, inventory: nInventory };
}

/** Remembers file modification times so unchanged files are not re-parsed every minute. */
export class ScanFileWatcher {
  private readonly seen = new Map<string, number>();
  changedFiles(wowForeverDir: string): string[] {
    return findScanFiles(wowForeverDir).filter((f) => {
      const mtime = statSync(f).mtimeMs;
      if (this.seen.get(f) === mtime) return false;
      this.seen.set(f, mtime);
      return true;
    });
  }
}
