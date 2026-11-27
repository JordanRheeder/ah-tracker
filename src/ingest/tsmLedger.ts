// Imports TSM's accounting ledger (TradeSkillMaster.lua SavedVariables): auction and vendor purchases
// and sales, expired and cancelled listings, for every character on the account. TSM files both PvP
// auction houses under one realm ("PvP"), so the ledger does not say which house a trade was on.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { transaction, type Db } from "../db/db.ts";
import { isTable, parseSavedVariables } from "./luaTable.ts";

export interface LedgerRow {
  kind: "buy" | "sale" | "expired" | "cancelled";
  itemId: number;
  itemString: string;
  qty: number;
  /** Copper per unit (buys and sales only). */
  price: number | null;
  other: string | null;
  player: string;
  ts: number;
  /** Auction | Vendor | Trade | ... (buys and sales only). */
  source: string | null;
}

/** TradeSkillMaster.lua files under the WoW Forever folder, one per WoW account. */
export function findTsmFiles(wowForeverDir: string): string[] {
  const accounts = join(wowForeverDir, "WTF", "Account");
  if (!existsSync(accounts)) return [];
  return readdirSync(accounts)
    .map((a) => join(accounts, a, "SavedVariables", "TradeSkillMaster.lua"))
    .filter((p) => existsSync(p));
}

const KINDS: Record<string, LedgerRow["kind"]> = { Buys: "buy", Sales: "sale", Expired: "expired", Cancelled: "cancelled" };

/** Rows of every "r@<realm>@internalData@csv<Buys|Sales|Expired|Cancelled>" CSV in the file. */
export function parseLedger(text: string): LedgerRow[] {
  const root = parseSavedVariables(text).get("TradeSkillMasterDB");
  if (!isTable(root)) return [];
  const out: LedgerRow[] = [];
  for (const [key, value] of root.map) {
    const m = /^r@.*@internalData@csv(Buys|Sales|Expired|Cancelled)$/.exec(String(key));
    if (!m || typeof value !== "string") continue;
    const kind = KINDS[m[1]!]!;
    const [header, ...lines] = value.split("\n");
    const cols = (header ?? "").split(",");
    for (const line of lines) {
      if (!line) continue;
      const f = Object.fromEntries(line.split(",").map((v, i) => [cols[i], v]));
      const itemId = Number(/^i:(\d+)/.exec(f.itemString ?? "")?.[1]);
      const qty = Number(f.quantity);
      const ts = Number(f.time);
      if (!itemId || !qty || !ts) continue;
      out.push({
        kind, itemId, itemString: f.itemString!, qty, ts, player: f.player ?? "",
        price: f.price !== undefined ? Number(f.price) : null, other: f.otherPlayer ?? null, source: f.source ?? null,
      });
    }
  }
  return out;
}

export interface MoneyRow { kind: "income" | "expense"; type: string; amount: number; other: string; player: string; ts: number }

/** Rows of every "r@<realm>@internalData@csv<Income|Expense>" CSV: postage, money transfers, repairs, ... */
export function parseMoney(text: string): MoneyRow[] {
  const root = parseSavedVariables(text).get("TradeSkillMasterDB");
  if (!isTable(root)) return [];
  const out: MoneyRow[] = [];
  for (const [key, value] of root.map) {
    const m = /^r@.*@internalData@csv(Income|Expense)$/.exec(String(key));
    if (!m || typeof value !== "string") continue;
    const [header, ...lines] = value.split("\n");
    const cols = (header ?? "").split(",");
    for (const line of lines) {
      if (!line) continue;
      const f = Object.fromEntries(line.split(",").map((v, i) => [cols[i], v]));
      const amount = Number(f.amount), ts = Number(f.time);
      if (!f.type || !Number.isFinite(amount) || !ts) continue;
      out.push({ kind: m[1] === "Income" ? "income" : "expense", type: f.type, amount, other: f.otherPlayer ?? "", player: f.player ?? "", ts });
    }
  }
  return out;
}

export interface CharacterGold { character: string; faction: string | null; money: number | null; updatedAt: number | null; log: { ts: number; copper: number }[] }

/** Each character's gold: "s@<name> - <faction> - <realm>@internalData@money" and its goldLog ("minute,copper"). */
export function parseCharacters(text: string): CharacterGold[] {
  const root = parseSavedVariables(text).get("TradeSkillMasterDB");
  if (!isTable(root)) return [];
  const chars = new Map<string, CharacterGold>();
  for (const [key, value] of root.map) {
    const m = /^s@(.+?) - (\w+) - .+@internalData@(money|goldLog|goldLogLastUpdate)$/.exec(String(key));
    if (!m) continue;
    const c = chars.get(m[1]!) ?? { character: m[1]!, faction: m[2]!, money: null, updatedAt: null, log: [] };
    chars.set(m[1]!, c);
    if (m[3] === "money" && typeof value === "number") c.money = value;
    if (m[3] === "goldLogLastUpdate" && typeof value === "number") c.updatedAt = value;
    if (m[3] === "goldLog" && typeof value === "string")
      for (const line of value.split("\n").slice(1)) {
        const [minute, copper] = line.split(",").map(Number);
        if (minute && Number.isFinite(copper)) c.log.push({ ts: minute! * 60, copper: copper! });
      }
  }
  return [...chars.values()];
}

/** What each character owns per TSM: "s@<name> - <faction> - <realm>@internalData@<bag|bank|mail|auction>Quantity". */
export function parseHoldings(text: string): { character: string; location: string; itemId: number; qty: number }[] {
  const root = parseSavedVariables(text).get("TradeSkillMasterDB");
  if (!isTable(root)) return [];
  const out: { character: string; location: string; itemId: number; qty: number }[] = [];
  for (const [key, value] of root.map) {
    const m = /^s@(.+?) - \w+ - .+@internalData@(bag|bank|mail|auction)Quantity$/.exec(String(key));
    if (!m || !isTable(value)) continue;
    const byItem = new Map<number, number>();
    for (const [itemString, qty] of value.map) {
      const id = Number(/^i:(\d+)/.exec(itemString)?.[1]);
      if (id && typeof qty === "number" && qty > 0) byItem.set(id, (byItem.get(id) ?? 0) + qty); // variants (suffixes) summed
    }
    for (const [itemId, qty] of byItem) out.push({ character: m[1]!, location: m[2]!, itemId, qty });
  }
  return out;
}

/** Stores new ledger, money and gold rows; returns how many were new. */
export function importLedger(db: Db, text: string, now = Math.floor(Date.now() / 1000), savedAt = now): number {
  const ins = db.prepare(`INSERT OR IGNORE INTO tsm_ledger (kind, item_id, item_string, qty, price, other, player, ts, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insMoney = db.prepare(`INSERT OR IGNORE INTO tsm_money (kind, type, amount, other, player, ts) VALUES (?, ?, ?, ?, ?, ?)`);
  const upChar = db.prepare(`INSERT INTO tsm_character (character, faction, money, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (character) DO UPDATE SET faction = excluded.faction, money = excluded.money, updated_at = excluded.updated_at
    WHERE excluded.updated_at >= tsm_character.updated_at`);
  const insGold = db.prepare(`INSERT OR IGNORE INTO tsm_gold_log (character, ts, copper) VALUES (?, ?, ?)`);
  let n = 0;
  transaction(db, () => {
    for (const r of parseLedger(text))
      n += Number(ins.run(r.kind, r.itemId, r.itemString, r.qty, r.price ?? 0, r.other ?? "", r.player, r.ts, r.source).changes);
    for (const r of parseMoney(text)) n += Number(insMoney.run(r.kind, r.type, r.amount, r.other, r.player, r.ts).changes);
    for (const c of parseCharacters(text)) {
      if (c.money !== null) upChar.run(c.character, c.faction, c.money, c.updatedAt ?? now);
      for (const g of c.log) n += Number(insGold.run(c.character, g.ts, g.copper).changes);
    }
    // Holdings are a snapshot as of TSM's save: replace them, and remember when that was.
    const holdings = parseHoldings(text);
    if (holdings.length) {
      db.prepare("DELETE FROM tsm_holding").run();
      const ins = db.prepare("INSERT INTO tsm_holding (character, location, item_id, qty) VALUES (?, ?, ?, ?)");
      for (const h of holdings) ins.run(h.character, h.location, h.itemId, h.qty);
      db.prepare("INSERT INTO setting (key, value) VALUES ('tsm_holding_at', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(String(savedAt));
    }
  });
  return n;
}

export function importLedgerFile(db: Db, path: string): number {
  // The file's modification time is when TSM saved it: the moment its holdings describe.
  return importLedger(db, readFileSync(path, "utf8"), undefined, Math.floor(statSync(path).mtimeMs / 1000));
}
