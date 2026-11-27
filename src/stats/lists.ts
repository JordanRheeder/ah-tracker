// Shopping lists for in-game scanning, built from the statistics engine's opportunities.
// The app writes them into the AHTracker addon folder as Lists.lua; on login or /reload the addon
// turns them into Auctionator shopping lists whose searches carry each item's maximum buy price.
import { writeFileSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { HOUSES, sellsOn } from "../config.ts";
import { crossDirection, directionAllows, listGoods, minMargin, safeOnly, snipeFraction, type Db } from "../db/db.ts";
import { openPurchases } from "../api/queries.ts";
import { buildWatchList } from "../watch.ts";

export interface ListItem {
  itemId: number;
  name: string;
  /** Highest price per unit that still makes the target margin after the selling house's cut; null = no limit. */
  maxPrice: number | null;
}
export interface ShoppingList { name: string; items: ListItem[] }

export const KIND_TITLE: Record<string, string> = {
  "buy-now": "Buy now",
  "time-flip": "Time-of-day flips",
  "sell-now": "Sell now",
  "cross-house": "Between houses",
  convert: "Essence conversions",
};

/** Item classes 7 and 12 in the game's item classes. */
export const TRADE_GOODS_CLASS = 7;
export const QUEST_CLASS = 12;
/**
 * Some lists come split by kind of item, tagged at the front of the name. Time-of-day flips: [TG] for
 * trade goods and [BOE] for everything else (gear, consumables, recipes, ...). Between houses: the full
 * list plus [Q] with quest items only, which the full list's highest margins would otherwise crowd out.
 */
export const LIST_TAGS = ["[TG] ", "[BOE] ", "[Q] ", "[CONV] "] as const;
const TAGS_FOR: Record<string, readonly string[]> = { "time-flip": ["[TG] ", "[BOE] "], "cross-house": ["", "[Q] "], convert: ["[CONV] "] };
/** The dashboard's item toggle: trade goods, quest items, or everything else. */
export type Goods = "tg" | "quest" | "other";
export const GOODS_TAG: Record<Goods, string> = { tg: "[TG] ", quest: "[Q] ", other: "[BOE] " };
export function isGoods(goods: Goods, classId: number | null): boolean {
  if (goods === "tg") return classId === TRADE_GOODS_CLASS;
  if (goods === "quest") return classId === QUEST_CLASS;
  return classId !== TRADE_GOODS_CLASS && classId !== QUEST_CLASS;
}

/** Whether an item of `classId` belongs in a list with `tag`. */
function inTag(tag: string, classId: number | null): boolean {
  if (tag === "[TG] ") return classId === TRADE_GOODS_CLASS;
  if (tag === "[BOE] ") return classId !== TRADE_GOODS_CLASS;
  if (tag === "[Q] ") return classId === QUEST_CLASS;
  return true;
}
/** A list name without its [TG]/[BOE] tag. */
export function untagged(name: string): string {
  const tag = LIST_TAGS.find((t) => name.startsWith(t));
  return tag ? name.slice(tag.length) : name;
}

/** Most you can pay per unit and still make `targetMargin` after the selling house's cut (and expected lost deposits). */
export function maxBuyPrice(expectedSell: number, sellCut: number, targetMargin: number, depositLoss = 0): number {
  return Math.floor((expectedSell * (1 - sellCut) - depositLoss) / (1 + targetMargin));
}

/**
 * `goods` builds one list per kind holding only that kind of item, picked from all of them (so they are
 * not crowded out of a shared top 50), tagged [TG], [Q] or [BOE]. Used by the dashboard's export.
 */
export function buildLists(db: Db, opts: { perList?: number; targetMargin?: number; safeOnly?: boolean; goods?: Goods | null } = {}): ShoppingList[] {
  const perList = opts.perList ?? 50;
  const targetMargin = opts.targetMargin ?? minMargin(db);
  // Safer mode: only trades that clear the margin in the pessimistic case, priced off the pessimistic sell.
  const safe = opts.safeOnly ?? safeOnly(db);
  // In game, the Between houses lists follow the dashboard's item toggle: [TG], [Q] or [BOE] only, or
  // with "All items" the full list plus the [Q] quest list.
  const crossGoods = opts.goods === undefined ? listGoods(db) : null;
  // Between houses and conversions only in the direction you carry (dashboard setting).
  const dir = crossDirection(db);
  const lists: ShoppingList[] = [];
  // Between houses: only trades that make the margin at the other house's price right now (Sell (N),
  // from your latest Auctionator scan), best margin first, with the max buy price worked out from that
  // price less expected lost deposits. Other lists: usual prices, best score first.
  const rows = db.prepare(`
    SELECT o.kind, o.item_id itemId, o.house_id buyHouse, o.sell_house_id sellHouse,
           CASE WHEN o.kind IN ('cross-house', 'convert') THEN CASE WHEN :safe = 1 THEN min(o.safe_sell, o.sell_now) ELSE o.sell_now END
                WHEN :safe = 1 AND o.kind != 'sell-now' THEN o.safe_sell ELSE o.sell_price END sellPrice,
           o.sell_now sellNow, o.buy_price buyPrice, o.profit_now profitNow, i.name, i.class_id classId,
           coalesce(o.convert_in, 1) convertIn, coalesce(o.convert_out, 1) convertOut
    FROM stats_opportunity o JOIN item i ON i.item_id = o.item_id
    WHERE i.name IS NOT NULL
      AND CASE WHEN o.kind IN ('cross-house', 'convert') THEN o.margin_now >= :m ELSE o.margin >= :m END
      AND (:safe = 0 OR (o.safe_evidence = 1 AND o.safe_margin >= :m))
    ORDER BY CASE WHEN o.kind IN ('cross-house', 'convert') THEN o.margin_now ELSE 0 END DESC, o.score DESC`)
    .all({ m: targetMargin, safe: safe ? 1 : 0 }) as { kind: string; itemId: number; buyHouse: number; sellHouse: number; sellPrice: number;
      sellNow: number | null; buyPrice: number; profitNow: number | null; name: string; classId: number | null; convertIn: number; convertOut: number }[];

  for (const buy of HOUSES)
    for (const kind of Object.keys(KIND_TITLE))
      for (const sell of (kind === "cross-house" ? HOUSES.filter((h) => h !== buy) : kind === "convert" ? HOUSES : [buy])
        .filter((s) => (kind !== "cross-house" && kind !== "convert") || directionAllows(dir, buy.key, s.key)))
        for (const tag of opts.goods ? [GOODS_TAG[opts.goods]] : kind === "cross-house" && crossGoods ? [GOODS_TAG[crossGoods]] : TAGS_FOR[kind] ?? [""]) {
          const goods = opts.goods ?? (kind === "cross-house" ? crossGoods : null);
          const items: ListItem[] = [];
          const seen = new Set<number>();
          for (const r of rows) {
            if (r.kind !== kind || r.buyHouse !== buy.houseId || r.sellHouse !== sell.houseId || seen.has(r.itemId)) continue;
            if (goods ? !isGoods(goods, r.classId) : !inTag(tag, r.classId)) continue;
            seen.add(r.itemId);
            // Sell-now lists are for checking competing listings before you post: no price limit.
            // Between houses and conversions: expected lost deposits, from
            // profit_now = out x sell_now x (1 - cut) - in x buy - deposits.
            const now = kind === "cross-house" || kind === "convert";
            const depositLoss = now && r.sellNow !== null && r.profitNow !== null
              ? Math.max(0, r.convertOut * r.sellNow * (1 - sell.cut) - r.convertIn * r.buyPrice - r.profitNow) : 0;
            // A conversion's limit is per unit you buy: what the output sells for, shared over the inputs.
            const maxPrice = kind === "sell-now" ? null
              : kind === "convert" ? Math.floor(maxBuyPrice(r.convertOut * r.sellPrice, sell.cut, targetMargin, depositLoss) / r.convertIn)
              : maxBuyPrice(r.sellPrice, sell.cut, targetMargin, depositLoss);
            if (maxPrice !== null && maxPrice <= 0) continue;
            items.push({ itemId: r.itemId, name: r.name, maxPrice });
            if (items.length >= perList) break;
          }
          // Plain ">" rather than an arrow: WoW's default font only covers basic Latin characters.
          const title = kind === "cross-house" || kind === "convert" ? `${KIND_TITLE[kind]} > ${sell.label}` : KIND_TITLE[kind];
          lists.push({ name: `${tag}AHT ${buy.label} · ${title}`, items });
        }
  return lists;
}

/**
 * Target sell price per item and house, for the addon's Selling-tab pricing: the dear-hour price when
 * the item's daily pattern is reliable, otherwise its usual (median) price. Only items that sell. Your
 * own listing prices (list_price) replace these on Alliance.
 */
export function buildSellTargets(db: Db): Record<string, Record<number, number>> {
  const out: Record<string, Record<number, number>> = {};
  for (const house of HOUSES) {
    const rows = db.prepare(`
      SELECT st.item_id id,
             CASE WHEN st.consistency >= 0.6 AND st.pattern_days >= 3 THEN st.sell_price ELSE st.median END target
      FROM stats_item st
      JOIN tsm_region g ON g.item_id = st.item_id AND g.updated_at = (SELECT max(updated_at) FROM tsm_region)
      WHERE st.house_id = ? AND g.sold_per_day >= 5`).all(house.houseId) as { id: number; target: number }[];
    out[house.key] = Object.fromEntries(rows.filter((r) => r.target > 0 && sellsOn(house, r.id)).map((r) => [r.id, Math.round(r.target)]));
  }
  // Your own listing prices (list_price) win on Alliance, where you sell.
  const alliance = HOUSES.find((h) => h.key === "alliance");
  if (alliance)
    for (const r of db.prepare("SELECT item_id id, price FROM list_price").all() as { id: number; price: number }[])
      if (sellsOn(alliance, r.id)) (out[alliance.key] ??= {})[r.id] = Math.round(r.price);
  return out;
}

/** What you paid per unit for the bought units you have not sold yet, per item: [copper per unit, units]. */
export function buildCosts(db: Db): Record<number, [number, number]> {
  const out: Record<number, [number, number]> = {};
  for (const [id, lots] of openPurchases(db)) {
    const qty = lots.reduce((t, l) => t + l.qty, 0);
    if (qty > 0) out[id] = [Math.ceil(lots.reduce((t, l) => t + l.qty * l.unit, 0) / qty), qty];
  }
  return out;
}

/**
 * Snipe lists: materials people dump far below value (often bots or gold sellers). One list per house
 * with every item of the snipe categories that sells, each with a buy limit of the snipe fraction of the
 * lower of the two houses' usual prices. On Neutral that is usually Alliance's price, so a Neutral snipe
 * is at half Alliance's value or less, never "half of Neutral's inflated price".
 */
/** Crafting materials by profession: the Trade Goods subcategory holding them. */
export const PROFESSIONS = [
  // Enchanting also takes reagents the game files under other categories (Trade Goods > Other / Elemental).
  { key: "enchanting", title: "Enchanting", subclass: "Enchanting", snipeList: true, extra: [
    "Righteous Orb", "Arcane Crystal", "Large Opal", "Huge Emerald", "Golden Pearl", "Iridescent Pearl", "Black Pearl",
    "Essence of Fire", "Essence of Water", "Essence of Earth", "Essence of Air", "Essence of Undeath", "Living Essence",
    "Minor Essence of the Four Winds"] },
  { key: "tailoring", title: "Tailoring", subclass: "Cloth", snipeList: true },
  { key: "blacksmithing", title: "Blacksmithing", subclass: "Metal & Stone", snipeList: true },
  { key: "leatherworking", title: "Leatherworking", subclass: "Leather", snipeList: false },
  { key: "alchemy", title: "Alchemy (herbs)", subclass: "Herb", snipeList: false },
  { key: "engineering", title: "Engineering (parts)", subclass: "Parts", snipeList: false },
  { key: "elemental", title: "Elemental", subclass: "Elemental", snipeList: false },
  { key: "cooking", title: "Cooking", subclass: "Cooking", snipeList: false },
] as const;
export const SNIPE_CATEGORIES = PROFESSIONS.filter((p) => p.snipeList)
  .map((p) => ({ classId: TRADE_GOODS_CLASS, subclass: p.subclass, title: p.title, extra: "extra" in p ? [...p.extra] : [] }));
export function buildSnipeLists(db: Db, fraction = snipeFraction(db)): ShoppingList[] {
  const lists: ShoppingList[] = [];
  for (const house of HOUSES)
    for (const c of SNIPE_CATEGORIES) {
      const rows = db.prepare(`
        SELECT i.item_id itemId, i.name, min(st.median, coalesce(other.median, st.median)) median
        FROM item i
        LEFT JOIN item_class sc ON sc.class_id = i.class_id AND sc.subclass_id = i.subclass_id
        JOIN stats_item st ON st.item_id = i.item_id AND st.house_id = ?
        LEFT JOIN stats_item other ON other.item_id = i.item_id AND other.house_id != st.house_id
        LEFT JOIN tsm_region g ON g.item_id = i.item_id AND g.updated_at = (SELECT max(updated_at) FROM tsm_region)
        WHERE i.name IS NOT NULL AND coalesce(g.sold_per_day, 0) >= 5
          AND ((i.class_id = ? AND sc.name = ?) OR i.name IN (SELECT value FROM json_each(?)))
        ORDER BY st.median * coalesce(g.sold_per_day, 0) DESC`).all(house.houseId, c.classId, c.subclass, JSON.stringify(c.extra)) as { itemId: number; name: string; median: number }[];
      const items = rows.map((r) => ({ itemId: r.itemId, name: r.name, maxPrice: Math.floor(r.median * fraction) })).filter((i) => i.maxPrice >= 1);
      lists.push({ name: `[SNIPE] AHT ${house.label} · ${c.title}`, items: items.slice(0, 100) });
    }
  return lists;
}

/** Lua string literal with every byte that could break the file escaped. */
export function luaString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\0/g, "\\0")}"`;
}

export function toLua(lists: ShoppingList[], generatedAt: number, sellTargets: Record<string, Record<number, number>> = {},
  settings: { minMargin: number; cuts: Record<string, number> } = { minMargin: 0.1, cuts: {} },
  costs: Record<number, [number, number]> = {}): string {
  const lines = [
    "-- Generated by the AH Tracker app (src/stats/lists.ts). Rewritten after every statistics refresh;",
    "-- WoW reads it on login or /reload. Do not edit.",
    "AHTRACKER_LISTS = {",
    `  generated = ${generatedAt},`,
    "  lists = {",
  ];
  for (const l of lists) {
    lines.push(`    { name = ${luaString(l.name)}, items = {`);
    for (const i of l.items) lines.push(`      { id = ${i.itemId}, name = ${luaString(i.name)}, maxPrice = ${i.maxPrice ?? "nil"} },`);
    lines.push("    } },");
  }
  lines.push("  },");
  // The dashboard's minimum margin and each house's AH cut, for the addon's profit-safe listing price.
  lines.push(`  settings = { minMargin = ${settings.minMargin}, cuts = { ${Object.entries(settings.cuts).map(([k, v]) => `${k} = ${v}`).join(", ")} } },`);
  // What you paid for your unsold purchases: costs[itemId] = { copper per unit, units }
  const costEntries = Object.entries(costs).map(([id, [unit, qty]]) => `[${id}]={${unit},${qty}}`);
  lines.push("  costs = {");
  for (let i = 0; i < costEntries.length; i += 10) lines.push(`    ${costEntries.slice(i, i + 10).join(",")},`);
  lines.push("  },");
  // Target sell prices, copper per unit: sellTargets.<house key>[itemId]
  lines.push("  sellTargets = {");
  for (const [house, targets] of Object.entries(sellTargets)) {
    const entries = Object.entries(targets).map(([id, p]) => `[${id}]=${p}`);
    lines.push(`    ${house} = {`);
    for (let i = 0; i < entries.length; i += 12) lines.push(`      ${entries.slice(i, i + 12).join(",")},`);
    lines.push("    },");
  }
  lines.push("  },", "}", "");
  return lines.join("\n");
}

/** Writes Lists.lua into the installed AHTracker addon, atomically. Returns the path, or null if the addon is not installed. */
export function writeListsFile(db: Db, wowForeverDir: string, now = Math.floor(Date.now() / 1000)): { path: string; lists: number; items: number } | null {
  const dir = join(wowForeverDir, "Interface", "AddOns", "AHTracker");
  if (!existsSync(dir)) return null;
  const lists = [...buildLists(db), ...buildSnipeLists(db), buildWatchList(db)];
  const path = join(dir, "Lists.lua");
  const settings = { minMargin: minMargin(db), cuts: Object.fromEntries(HOUSES.map((h) => [h.key, h.cut])) };
  writeFileSync(`${path}.tmp`, toLua(lists, now, buildSellTargets(db), settings, buildCosts(db)));
  renameSync(`${path}.tmp`, path);
  return { path, lists: lists.length, items: lists.reduce((s, l) => s + l.items.length, 0) };
}

/** One search in Auctionator's advanced format (Auctionator.Search.ReconstituteAdvancedSearch): exact name, max price in gold. */
export function auctionatorSearch(item: ListItem): string {
  const gold = item.maxPrice === null ? "" : String(item.maxPrice / 10000);
  return [`"${item.name}"`, "", "", "", "", "", "", "", "", gold, "", "#", "", ""].join(";");
}

/**
 * Text for Auctionator's Shopping > Import: one line per list, "List name^search^search...".
 * Importing a list with an existing name replaces its items. "^" and line breaks in item names are
 * dropped because they are the format's separators.
 */
export function auctionatorImport(lists: ShoppingList[]): string {
  const clean = (s: string) => s.replace(/[\^\r\n]/g, " ");
  return lists
    .filter((l) => l.items.length > 0)
    .map((l) => [clean(l.name), ...l.items.map((i) => auctionatorSearch({ ...i, name: clean(i.name) }))].join("^"))
    .join("\n");
}
