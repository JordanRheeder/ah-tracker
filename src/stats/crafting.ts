// Crafting: what each WoW Forever alchemy and cooking recipe costs to make from today's PvP Alliance
// prices, what the result sells for, and the profit after the AH cut and expected lost deposits.
//
// Recipes come from recipes-forever.json (Wowhead's Forever profession pages; cooking recipe sources
// from method.gg). Prices:
// - Reagents: what buying them costs now, from the latest scan within RECENT_SECONDS: the average of the
//   cheapest 20 units when that is close to the cheapest one (you rarely need just one), otherwise the
//   cheapest. Vendor reagents (vials, spices, drinks) at the vendor: 4x their vendor sell-back price, the
//   usual buy/sell ratio, so these are estimates.
// - Result: the lower of its cheapest listing now and its usual price, so a brief spike is not counted.
// A recipe "pays" when it makes at least your minimum margin and its result sells at least
// MIN_SOLD_PER_DAY a day across EU. checkCraftAlerts notifies once when one starts paying, and again only
// after it has stopped paying and come back.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { HOUSES } from "../config.ts";
import { minMargin, transaction, type Db } from "../db/db.ts";
import { appNotify, type Notify } from "../alerts.ts";

export interface Recipe {
  profession: "alchemy" | "cooking";
  spell: number;
  name: string;
  creates: number;
  qmin: number;
  qmax: number;
  reagents: [number, number][];
  skill: number;
  source: string | null;
  /** Seconds between casts (transmutes), when there is one. */
  cooldown?: number;
}

const DATA = JSON.parse(readFileSync(resolve(import.meta.dirname, "recipes-forever.json"), "utf8")) as { source: string; recipes: Recipe[] };
/** Crafting stations and other furniture: not trade items. */
const STATIONS = /Campfire|Oven|Laboratory|Fermenter|Mana Well/;
export const RECIPES: Recipe[] = DATA.recipes.filter((r) => r.qmax > 0 && !STATIONS.test(r.name));
export const RECIPE_SOURCE = DATA.source;

/** Reagents sold by vendors: priced at the vendor, never at the AH. */
export const VENDOR_REAGENTS = new Set([3371, 3372, 8925, 18256, 2678, 2692, 3713, 159, 1179, 1205, 1645, 1708, 8766, 4536, 2596, 2894, 17194, 17196, 4470]);
/** Vendors sell for about 4x what they pay you. */
export const VENDOR_MARKUP = 4;
export const RECENT_SECONDS = 12 * 3600;
export const MIN_SOLD_PER_DAY = 5;
const HOUSE = HOUSES.find((h) => h.key === "alliance")!;

export interface Reagent { itemId: number; name: string; qty: number; unit: number | null; vendor: boolean; icon: string | null; quality: number | null }
export interface CraftRow {
  spell: number; profession: Recipe["profession"]; recipe: string; skill: number; source: string | null; cooldown: number | null;
  itemId: number; name: string; icon: string | null; quality: number | null; classId: number | null;
  yield: number; reagents: Reagent[]; missing: string[];
  /** Copper per craft: reagent cost, and the result's sale proceeds after the cut and deposits. */
  cost: number | null; revenue: number | null; profit: number | null; margin: number | null;
  sellEach: number | null; nowEach: number | null; usualEach: number | null; soldPerDay: number; saleRate: number; listed: number | null;
  pays: boolean;
}

export function craftingTable(db: Db, now = Math.floor(Date.now() / 1000)): { rows: CraftRow[]; minMargin: number; source: string } {
  const margin = minMargin(db);
  const item = db.prepare(`SELECT name, icon_name icon, quality, class_id classId, coalesce(vendor_price, 0) vp, coalesce(deposit_unit, 0) dep FROM item WHERE item_id = ?`);
  const last = db.prepare(`SELECT s.min_buyout p, s.price_20 p20, s.quantity q FROM item_snapshot s JOIN snapshot sn ON sn.id = s.snapshot_id
    WHERE s.item_id = ? AND sn.house_id = ? AND s.min_buyout > 0 AND s.ts >= ? ORDER BY s.ts DESC LIMIT 1`);
  const usual = db.prepare("SELECT median m FROM stats_item WHERE house_id = ? AND item_id = ?");
  const region = db.prepare("SELECT sold_per_day sold, sale_rate rate FROM tsm_region WHERE item_id = ? ORDER BY updated_at DESC LIMIT 1");
  type ItemRow = { name: string | null; icon: string | null; quality: number | null; classId: number | null; vp: number; dep: number };
  const info = (id: number) => item.get(id) as ItemRow | undefined;
  const latest = (id: number) => last.get(id, HOUSE.houseId, now - RECENT_SECONDS) as { p: number; p20: number | null; q: number } | undefined;

  const rows = RECIPES.map((r): CraftRow => {
    const reagents: Reagent[] = [];
    const missing: string[] = [];
    let cost = 0;
    for (const [id, qty] of r.reagents) {
      const i = info(id);
      const vendor = VENDOR_REAGENTS.has(id);
      let unit: number | null = null;
      if (vendor) unit = i?.vp ? i.vp * VENDOR_MARKUP : null;
      else { const l = latest(id); if (l) unit = l.p20 && l.p20 < l.p * 1.3 ? l.p20 : l.p; }
      const name = i?.name ?? `Item ${id}`;
      if (unit === null) missing.push(name); else cost += unit * qty;
      reagents.push({ itemId: id, name, qty, unit, vendor, icon: i?.icon ?? null, quality: i?.quality ?? null });
    }
    const out = info(r.creates);
    const l = latest(r.creates);
    const u = (usual.get(HOUSE.houseId, r.creates) as { m: number } | undefined)?.m ?? null;
    const reg = region.get(r.creates) as { sold: number | null; rate: number | null } | undefined;
    const sellEach = l && u !== null ? Math.min(l.p, u) : l ? l.p : u;
    const rate = Math.max(reg?.rate ?? 0, 0.05);
    // A 24-hour listing's deposit, lost on the expected number of failed listings before one sells.
    const depositLoss = (out?.dep ?? 0) * 12 * Math.min(5, (1 - rate) / rate);
    const y = (r.qmin + r.qmax) / 2;
    const revenue = sellEach === null ? null : (sellEach * (1 - HOUSE.cut) - depositLoss) * y;
    const priced = !missing.length && revenue !== null;
    const profit = priced ? revenue! - cost : null;
    const m = priced && cost > 0 ? profit! / cost : null;
    const soldPerDay = reg?.sold ?? 0;
    return {
      spell: r.spell, profession: r.profession, recipe: r.name, skill: r.skill, source: r.source, cooldown: r.cooldown ?? null,
      itemId: r.creates, name: out?.name ?? r.name, icon: out?.icon ?? null, quality: out?.quality ?? null, classId: out?.classId ?? null,
      yield: y, reagents, missing, cost: missing.length ? null : cost, revenue, profit, margin: m,
      sellEach, nowEach: l?.p ?? null, usualEach: u, soldPerDay, saleRate: reg?.rate ?? 0, listed: l?.q ?? null,
      pays: m !== null && m >= margin && soldPerDay >= MIN_SOLD_PER_DAY,
    };
  });
  return { rows, minMargin: margin, source: RECIPE_SOURCE };
}

const gold = (c: number) => {
  const v = Math.round(Math.abs(c)), g = Math.floor(v / 10000), s = Math.floor((v % 10000) / 100), cu = v % 100;
  return (c < 0 ? "-" : "") + ([g ? `${g}g` : "", s ? `${s}s` : "", !g && cu ? `${cu}c` : ""].filter(Boolean).join(" ") || "0c");
};

/** Notifies about recipes that just started paying. Returns them. */
export function checkCraftAlerts(db: Db, now = Math.floor(Date.now() / 1000), notify: Notify = appNotify(db, now)): CraftRow[] {
  const { rows } = craftingTable(db, now);
  const was = new Map((db.prepare("SELECT spell, pays FROM craft_alert").all() as { spell: number; pays: number }[]).map((r) => [r.spell, r.pays]));
  // The first check only records the current state: alerts are for changes.
  const first = was.size === 0;
  const fresh = first ? [] : rows.filter((r) => r.pays && was.get(r.spell) !== 1);
  transaction(db, () => {
    const up = db.prepare(`INSERT INTO craft_alert (spell, pays, profit, margin, updated_at, notified_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (spell) DO UPDATE SET pays = excluded.pays, profit = excluded.profit, margin = excluded.margin, updated_at = excluded.updated_at,
        notified_at = coalesce(excluded.notified_at, craft_alert.notified_at)`);
    for (const r of rows) up.run(r.spell, r.pays ? 1 : 0, r.profit, r.margin, now, fresh.includes(r) ? now : null);
  });
  if (fresh.length) {
    const line = (r: CraftRow) => `${r.recipe}: +${gold(r.profit!)} a craft (${Math.round(r.margin! * 100)}%), ${Math.round(r.soldPerDay)} sold a day`;
    notify(fresh.length === 1 ? `Profitable craft: ${fresh[0]!.recipe}` : `${fresh.length} crafts are now profitable`,
      fresh.slice(0, 8).map(line).join("\n") + (fresh.length > 8 ? `\n…and ${fresh.length - 8} more on the Crafting page` : ""),
      { kind: "craft", itemId: fresh.length === 1 ? fresh[0]!.itemId : undefined });
  }
  return fresh;
}
