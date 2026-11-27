// TSM groups and an Auctioning operation for your resell stock, written into TradeSkillMaster.lua.
//
// TSM keeps its settings in memory while WoW runs and saves them on logout or /reload, so this file is
// only ever written while WoW is not running (otherwise TSM would overwrite it). It edits just three
// entries of the active profile (groups, items, operations) and leaves everything else byte for byte.
//
// What it sets up:
// - Groups for every item AH Tracker has seen, by the game's item categories: "AH Tracker`Trade Goods`
//   Cloth", "AH Tracker`Armor`Plate", "AH Tracker`Quest", ... Items you ticked Ignore on the Inventory
//   page are left out (you are keeping them), and items already in one of your own TSM groups stay there.
// - Auctioning operation "AHT 2h small" on the "AH Tracker" group: 2-hour listings, at most 5 units up
//   at a time, 1c undercut, cancel when undercut or when you could repost higher. Its lowest price is
//   what you paid plus your margin after the AH cut; the AHTracker addon retunes it for the house you
//   open (5% Alliance, 15% Neutral). Created once: later changes you make in TSM are kept.
import { copyFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import type { Db } from "../db/db.ts";
import { minMargin } from "../db/db.ts";
import { isTable, parseSavedVariables, type LuaTable, type LuaValue } from "../ingest/luaTable.ts";

export const ROOT = "AH Tracker";
export const OPERATION = "AHT 2h small";
/**
 * TSM Sniper: only trade goods (every profession material) are sniped, at half TSM's market value or
 * less. "AH Tracker`Trade Goods" carries the operation and its subgroups inherit it; the AH Tracker
 * root carries none (so gear, consumables and so on are never sniped), and TSM's own default Sniper
 * operation on the base group (ungrouped items) is switched off while it is still the untouched default.
 */
export const SNIPER_OPERATION = "AHT Snipe half price";
export const SNIPER_ROOT = `${ROOT}\`Trade Goods`;
/** Trade goods subgroups left out of sniping (and everything under them). */
export const SNIPER_EXCLUDED = [`${SNIPER_ROOT}\`Cooking`];
/** The Sniper entry an AH Tracker group should have. */
function sniperEntry(path: string, watch: ReadonlyMap<string, WatchSnipe> = new Map()): LuaTable {
  const w = watch.get(path);
  if (w) return tbl([w.op], [["override", true]]);
  if (SNIPER_EXCLUDED.includes(path)) return tbl([], [["override", true]]);
  if (SNIPER_EXCLUDED.some((x) => path.startsWith(`${x}\``))) return tbl([]);
  if (path === ROOT) return tbl([], [["override", true]]);
  if (path === SNIPER_ROOT) return tbl([SNIPER_OPERATION], [["override", true]]);
  return tbl(path.startsWith(`${SNIPER_ROOT}\``) ? [SNIPER_OPERATION] : []);
}
export function newSniperOperation(): LuaTable {
  const map = new Map<string, LuaValue>([["belowPrice", SNIPER_BELOW]]);
  for (const k of ["relationships", "ignorePlayer", "ignoreFactionrealm"]) map.set(k, { list: [], map: new Map() });
  return { list: [], map };
}
/**
 * Watchlist items with a buy price (src/watch.ts) get a subgroup of their own inside their usual category
 * group, "<category>`Watch <item>". It inherits the category's Auctioning operation, so posting is
 * unchanged, and overrides Sniper with "AHT Watch <item>", which snipes at your buy price. The operations
 * follow the dashboard: prices are rewritten on every sync and removed with the item.
 */
export const WATCH_PREFIX = "AHT Watch ";
export interface WatchSnipe { op: string; below: string }
/** TSM money text, e.g. "8g 50s", "18s", "95c". */
export function tsmMoney(copper: number): string {
  const c = Math.max(1, Math.round(copper));
  const g = Math.floor(c / 10000), s = Math.floor((c % 10000) / 100), cu = c % 100;
  return [g ? `${g}g` : "", s ? `${s}s` : "", cu ? `${cu}c` : ""].filter(Boolean).join(" ");
}
/** Moves watched items into their own subgroups in `wanted` and returns each such group's snipe. */
export function watchGroups(db: Db, wanted: Map<string, string>): Map<string, WatchSnipe> {
  const out = new Map<string, WatchSnipe>();
  const rows = db.prepare(`SELECT w.item_id id, i.name, w.buy_below b FROM watch_item w JOIN item i ON i.item_id = w.item_id
    WHERE w.buy_below IS NOT NULL AND i.name IS NOT NULL`).all() as { id: number; name: string; b: number }[];
  for (const r of rows) {
    const base = wanted.get(`i:${r.id}`);
    if (!base) continue; // not in our groups (ignored on the Inventory page, or unknown category)
    const path = `${base}\`Watch ${segment(r.name)}`;
    wanted.set(`i:${r.id}`, path);
    out.set(path, { op: `${WATCH_PREFIX}${segment(r.name)}`, below: tsmMoney(r.b) });
  }
  return out;
}

const MODULES = ["Shopping", "Mailing", "Auctioning", "Crafting", "Warehousing", "Vendoring", "Sniper"] as const;

/** The lowest-price formula for a given AH cut: paid x (1 + margin) / (1 - cut), never below vendor price. */
// TSM's market value runs well above what items actually go for (14% above AH Tracker's usual price at the
// middle, higher on 86% of items, 2026-11-20). Its recent value (dbrecent, with the min buyout when there is
// none) tracks real prices, so every formula uses that instead.
export const TSM_VALUE = "first(dbrecent, dbminbuyout)";
export const SNIPER_BELOW = `0.5 * ${TSM_VALUE}`;
export const NORMAL_PRICE = `check(smartavgbuy, max(${TSM_VALUE}, 1.3 * smartavgbuy), ${TSM_VALUE})`;
export const MAX_PRICE = `check(smartavgbuy, max(3 * ${TSM_VALUE}, 2 * smartavgbuy), 3 * ${TSM_VALUE})`;
/** Formulas this app wrote before switching away from dbmarket: replaced if you have not changed them. */
const OLD_FORMULAS: Record<string, { old: string; now: string }> = {
  belowPrice: { old: "0.5 * first(dbmarket, dbregionmarketavg)", now: SNIPER_BELOW },
  normalPrice: { old: "check(smartavgbuy, max(dbmarket, 1.3 * smartavgbuy), dbmarket)", now: NORMAL_PRICE },
  maxPrice: { old: "check(smartavgbuy, max(3 * dbmarket, 2 * smartavgbuy), 3 * dbmarket)", now: MAX_PRICE },
};

export function minPriceFormula(margin: number, cut: number): string {
  const f = ((1 + margin) / (1 - cut)).toFixed(4);
  return `check(smartavgbuy, max(${f} * smartavgbuy, vendorsell), max(0.8 * ${TSM_VALUE}, vendorsell))`;
}

export function newOperation(margin: number, cut: number): LuaTable {
  const map = new Map<string, LuaValue>(Object.entries({
    duration: 1, // the first duration button: 2 hours on Forever
    postCap: "5", // at most 5 units up at a time
    keepQuantity: "0",
    maxExpires: "0",
    bidPercent: 1,
    undercut: "1c",
    minPrice: minPriceFormula(margin, cut),
    normalPrice: NORMAL_PRICE,
    maxPrice: MAX_PRICE,
    aboveMax: "maxPrice",
    priceReset: "none", // never post below the lowest price
    ignoreLowDuration: 0,
    cancelUndercut: true,
    cancelRepost: true,
    cancelRepostThreshold: "check(smartavgbuy, max(1s, 0.05 * smartavgbuy), 1s)",
  }));
  for (const k of ["relationships", "ignorePlayer", "ignoreFactionrealm"]) map.set(k, { list: [], map: new Map() });
  return { list: [], map };
}

// ---------------------------------------------------------------- Lua text handling

const tbl = (list: LuaValue[] = [], entries: [string, LuaValue][] = []): LuaTable => ({ list, map: new Map(entries) });

/** Lua source for a value, in the layout WoW writes SavedVariables (one entry per line). */
export function luaLiteral(v: LuaValue): string {
  if (v === null) return "nil";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`;
  const lines = ["{"];
  for (const x of v.list) lines.push(`${luaLiteral(x)},`);
  for (const [k, x] of v.map) lines.push(`[${luaLiteral(k)}] = ${luaLiteral(x)},`);
  lines.push("}");
  return lines.join("\n");
}

/** [start, end) of the value of a top-level `["key"] = value,` entry in TradeSkillMasterDB. */
function valueSpan(text: string, key: string): [number, number] {
  const head = `\n["${key}"] = `;
  const pos = text.indexOf(head);
  if (pos < 0) throw new Error(`TradeSkillMaster.lua has no ${key} entry`);
  let i = pos + head.length;
  const start = i;
  let depth = 0;
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
    } else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return [start, i + 1];
    } else if (depth === 0 && (c === "," || c === "\n")) return [start, i];
  }
  throw new Error(`could not find the end of ${key}`);
}

function readValue(text: string, key: string): LuaValue {
  const [a, b] = valueSpan(text, key);
  return parseSavedVariables(`x = ${text.slice(a, b)}`).get("x") ?? null;
}

// ---------------------------------------------------------------- the update

export interface TsmPlan { items: number; groups: number; added: number; removed: number; kept: number; operationCreated: boolean; changed?: boolean }

/** A TSM group path segment: TSM separates levels with a backtick, so none may appear in a name. */
const segment = (s: string) => s.replace(/`/g, "'").trim() || "Other";

/**
 * Every item AH Tracker knows the category of, as "i:123" -> group path. Categories with a single
 * subcategory named like themselves (Quest, Key) get no extra level.
 */
export function catalogItems(db: Db): Map<string, string> {
  const rows = db.prepare(`
    SELECT i.item_id id, i.name, c.name cls, s.name sub
    FROM item i
    LEFT JOIN item_class c ON c.class_id = i.class_id AND c.subclass_id = -1
    LEFT JOIN item_class s ON s.class_id = i.class_id AND s.subclass_id = i.subclass_id
    WHERE i.name IS NOT NULL AND i.class_id IS NOT NULL
      AND i.item_id NOT IN (SELECT item_id FROM inventory_ignore)`).all() as { id: number; name: string; cls: string | null; sub: string | null }[];
  const out = new Map<string, string>();
  for (const r of rows) {
    const cls = segment(r.cls ?? "Other");
    const sub = r.sub && r.sub !== r.cls ? segment(r.sub) : null;
    const base = sub ? `${ROOT}\`${cls}\`${sub}` : `${ROOT}\`${cls}`;
    const split = SPLITS[base]?.find((x) => x.match.test(r.name));
    out.set(`i:${r.id}`, split ? `${base}\`${split.group}` : SPLITS[base] ? `${base}\`${SPLIT_REST[base]}` : base);
  }
  return out;
}

// ---------------------------------------------------------------- how many to post

/**
 * Posting quantities: one Auctioning operation per quantity, each a copy of "AHT 2h small" (same
 * prices and cancel rules) with its own post cap, which on Forever's auction house is how many units
 * go up as one listing. Categories that mix sizes are split into subgroups by item name.
 */
export const POST_OPS = {
  one: { name: "AHT 2h x1", postCap: "1" },
  two: { name: "AHT 2h x2", postCap: "2" },
  quarter: { name: "AHT 2h 25% of stack", postCap: "max(1, roundup(0.25 * NumInventory))" }, // 25% of all you own
} as const;
const TG = `${ROOT}\`Trade Goods`;
const SPLITS: Record<string, { group: string; match: RegExp }[]> = {
  [`${TG}\`Metal & Stone`]: [{ group: "Ore", match: / Ore$/ }, { group: "Bars", match: / Bar$/ }],
  [`${TG}\`Cloth`]: [{ group: "Bolts", match: /^Bolt of |^Mooncloth$/ }],
  [`${TG}\`Parts`]: [{ group: "Casings", match: /Casing$/ }],
  [`${ROOT}\`Quest`]: [{ group: "Green Hills pages", match: /^Green Hills of Stranglethorn - Page / }],
  [`${TG}\`Other`]: [{ group: "Gems & pearls", match: /Pearl$|Opal$|Emerald$|Sapphire$|Ruby$|Diamond$|Citrine$|Aquamarine$|^Jade$|Tigerseye$|^Malachite$|^Shadowgem$|Moss Agate$|Moonstone$|^Arcane Crystal$|^Righteous Orb$/ }],
};
/** What the rest of a split category is called. */
const SPLIT_REST: Record<string, string> = {
  [`${ROOT}\`Quest`]: "Other quest items", [`${TG}\`Metal & Stone`]: "Stone & other", [`${TG}\`Cloth`]: "Cloth", [`${TG}\`Parts`]: "Other parts", [`${TG}\`Other`]: "Misc",
};
/** Groups whose Auctioning operation is not the default 5. */
const POSTING: Record<string, string> = {
  [`${ROOT}\`Consumable\`Food & Drink`]: POST_OPS.quarter.name,
  [`${TG}\`Metal & Stone\`Bars`]: POST_OPS.one.name,
  [`${TG}\`Cloth\`Bolts`]: POST_OPS.two.name,
  [`${TG}\`Elemental`]: POST_OPS.one.name,
  [`${TG}\`Parts\`Casings`]: POST_OPS.one.name,
  [`${TG}\`Other\`Gems & pearls`]: POST_OPS.one.name,
  [`${ROOT}\`Quest\`Green Hills pages`]: POST_OPS.one.name,
};
/** The Auctioning entry an AH Tracker group should have: its own operation, or inherited. */
function auctioningEntry(path: string): LuaTable {
  if (path === ROOT) return tbl([OPERATION], [["override", true]]);
  const own = POSTING[path];
  if (own) return tbl([own], [["override", true]]);
  // Inherit from the nearest ancestor that has its own.
  const parts = path.split("`");
  for (let i = parts.length - 1; i > 0; i--) {
    const anc = POSTING[parts.slice(0, i).join("`")];
    if (anc) return tbl([anc]);
  }
  return tbl([OPERATION]);
}

/** The profile in use (all characters share "Default" unless you made others). */
function profileOf(text: string): string {
  const cur = parseSavedVariables(text).get("TradeSkillMasterDB");
  const profiles = isTable(cur) ? cur.map.get("_currentProfile") : undefined;
  const names = isTable(profiles) ? [...new Set([...profiles.map.values()].filter((v): v is string => typeof v === "string"))] : [];
  if (names.length > 1) throw new Error(`characters use different TSM profiles (${names.join(", ")}); not changing anything`);
  return names[0] ?? "Default";
}

/** Returns the new file text and what changed. Pure: does not touch the disk. */
export function updateTsmText(text: string, wanted: Map<string, string>, margin: number, allianceCut: number,
  watch: ReadonlyMap<string, WatchSnipe> = new Map()): { text: string; plan: TsmPlan } {
  const profile = profileOf(text);
  const keys = { groups: `p@${profile}@userData@groups`, items: `p@${profile}@userData@items`, operations: `p@${profile}@userData@operations` };
  const groups = readValue(text, keys.groups);
  const items = readValue(text, keys.items);
  const operations = readValue(text, keys.operations);
  if (!isTable(groups) || !isTable(items) || !isTable(operations)) throw new Error("unexpected TSM settings layout");

  // Operation: created once.
  let auctioning = operations.map.get("Auctioning");
  if (!isTable(auctioning)) operations.map.set("Auctioning", (auctioning = tbl()));
  const operationCreated = !auctioning.map.has(OPERATION);
  if (operationCreated) auctioning.map.set(OPERATION, newOperation(margin, allianceCut));
  // The other posting quantities: copies of the base operation (created once; your changes are kept).
  for (const op of Object.values(POST_OPS)) {
    if (auctioning.map.has(op.name)) continue;
    const base = auctioning.map.get(OPERATION) as LuaTable;
    const copy: LuaTable = { list: [], map: new Map([...base.map].map(([k, v]) => [k, isTable(v) ? { list: [...v.list], map: new Map(v.map) } : v])) };
    copy.map.set("postCap", op.postCap);
    auctioning.map.set(op.name, copy);
  }
  // Our operations written before the switch from dbmarket: update formulas you have not changed.
  const ourOps = [...[...auctioning.map].filter(([n]) => typeof n === "string" && n.startsWith("AHT 2h")).map(([, v]) => v),
    (operations.map.get("Sniper") as LuaTable | undefined)?.map.get(SNIPER_OPERATION)];
  for (const op of ourOps) {
    if (!isTable(op)) continue;
    for (const [key, f] of Object.entries(OLD_FORMULAS)) if (op.map.get(key) === f.old) op.map.set(key, f.now);
    const min = op.map.get("minPrice");
    if (typeof min === "string" && min.endsWith("max(0.8 * dbmarket, vendorsell))")) op.map.set("minPrice", min.replace("max(0.8 * dbmarket, vendorsell))", `max(0.8 * ${TSM_VALUE}, vendorsell))`));
  }
  let sniper = operations.map.get("Sniper");
  if (!isTable(sniper)) operations.map.set("Sniper", (sniper = tbl()));
  if (!sniper.map.has(SNIPER_OPERATION)) sniper.map.set(SNIPER_OPERATION, newSniperOperation());
  // Watch operations: one per watched item, at your buy price; ones for items no longer watched go.
  const watchOps = new Map([...watch.values()].map((w) => [w.op, w.below]));
  for (const name of [...sniper.map.keys()])
    if (typeof name === "string" && name.startsWith(WATCH_PREFIX) && !watchOps.has(name)) sniper.map.delete(name);
  for (const [name, below] of watchOps) {
    const op = sniper.map.get(name);
    if (isTable(op)) op.map.set("belowPrice", below);
    else { const fresh = newSniperOperation(); fresh.map.set("belowPrice", below); sniper.map.set(name, fresh); }
  }

  // Groups: the root carries the operation; subgroups inherit it.
  const groupEntry = (path: string) => tbl([], MODULES.map((m) => {
    if (m === "Auctioning") return [m, auctioningEntry(path)];
    if (m === "Sniper") return [m, sniperEntry(path, watch)];
    return [m, tbl(["Shopping", "Crafting"].includes(m) ? ["#Default"] : [])];
  }));
  // Every group our items need, with its parents; ours that are no longer needed are removed.
  const wantedGroups = new Set<string>();
  for (const path of wanted.values()) {
    const parts = path.split("`");
    for (let i = 1; i <= parts.length; i++) wantedGroups.add(parts.slice(0, i).join("`"));
  }
  wantedGroups.add(ROOT);
  let groupsRemoved = 0;
  for (const path of [...groups.map.keys()])
    if (path.startsWith(`${ROOT}\``) && !wantedGroups.has(path)) { groups.map.delete(path); groupsRemoved++; }
  for (const path of [...wantedGroups].sort())
    if (!groups.map.has(path)) groups.map.set(path, groupEntry(path));
  // Snipe groups get the snipe operation once (an override); your own changes in TSM are kept afterwards.
  // Sniper: trade goods only (see SNIPER_OPERATION). Auctioning: the posting quantity for each group.
  for (const path of wantedGroups) {
    const g = groups.map.get(path);
    if (isTable(g)) { g.map.set("Sniper", sniperEntry(path, watch)); g.map.set("Auctioning", auctioningEntry(path)); }
  }
  const base = groups.map.get("");
  const baseSniper = isTable(base) ? base.map.get("Sniper") : undefined;
  if (isTable(baseSniper) && baseSniper.list.length === 1 && baseSniper.list[0] === "#Default")
    baseSniper.list.length = 0; // ungrouped items: no sniping (TSM's untouched default only)

  // Items: ours follow your stock; items in your own groups are left alone.
  const ours = (g: LuaValue | undefined) => typeof g === "string" && (g === ROOT || g.startsWith(`${ROOT}\``));
  let added = 0, removed = 0, kept = 0;
  for (const [item, group] of [...items.map]) {
    if (ours(group) && !wanted.has(item)) { items.map.delete(item); removed++; }
  }
  for (const [item, group] of wanted) {
    const current = items.map.get(item);
    if (current !== undefined && !ours(current)) { kept++; continue; }
    if (current !== group) { items.map.set(item, group); added++; }
  }

  let out = text;
  for (const [key, value] of [[keys.operations, operations], [keys.groups, groups], [keys.items, items]] as const) {
    const [a, b] = valueSpan(out, key);
    out = out.slice(0, a) + luaLiteral(value) + out.slice(b);
  }
  return { text: out, plan: { items: wanted.size, groups: wantedGroups.size, added, removed: removed + groupsRemoved, kept, operationCreated } };
}

/** Whether WoW is running (on Windows via tasklist; on Linux/Wine via pgrep, also through host-spawn). */
export function wowRunning(): boolean {
  if (process.platform === "win32") {
    try {
      const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq Wow.exe", "/NH"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      return /^Wow\.exe\s/im.test(out);
    } catch { return false; }
  }
  for (const cmd of [["pgrep", "-fa", "Wow.exe"], ["host-spawn", "pgrep", "-fa", "Wow.exe"]]) {
    try {
      const out = execFileSync(cmd[0]!, cmd.slice(1), { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      // Skip the lookup itself (host-spawn's own command line mentions Wow.exe).
      if (out.split("\n").some((l) => /\\Wow\.exe|\/Wow\.exe|^\d+ Wow\.exe/.test(l) && !/pgrep|host-spawn/.test(l))) return true;
    } catch { /* exit 1 = nothing found, or the command is missing */ }
  }
  return false;
}

/** Writes the groups and operation into a TradeSkillMaster.lua file, with a .ahtracker-backup copy first. */
export function writeTsmGroups(db: Db, path: string, allianceCut: number, opts: { force?: boolean } = {}): TsmPlan {
  if (!opts.force && wowRunning()) throw new Error("WoW is running: TSM would overwrite its settings on logout. Quit WoW first.");
  const before = readFileSync(path, "utf8");
  const wanted = catalogItems(db);
  const watch = watchGroups(db, wanted);
  const { text, plan } = updateTsmText(before, wanted, minMargin(db), allianceCut, watch);
  // Sanity check: the result still parses and applying it again changes nothing.
  const check = updateTsmText(text, wanted, minMargin(db), allianceCut, watch);
  if (check.text !== text) throw new Error("TSM settings did not round-trip; not writing");
  if (check.plan.added || check.plan.removed || check.plan.operationCreated) throw new Error("TSM settings did not round-trip; not writing");
  if (text !== before) {
    plan.changed = true;
    copyFileSync(path, `${path}.ahtracker-backup`);
    writeFileSync(`${path}.tmp`, text);
    renameSync(`${path}.tmp`, path);
  }
  return plan;
}
