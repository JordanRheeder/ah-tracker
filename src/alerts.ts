// Sell-now alerts: tells you when items you bought can be sold right now for at least your minimum
// margin over what you paid, after the AH cut and expected lost deposits. Checked after every
// statistics refresh. Each item alerts once when it becomes ready, and again only after it has
// dropped below the margin and come back.
import { execFile } from "node:child_process";
import { HOUSES } from "./config.ts";
import { getSetting, minMargin, transaction, type Db } from "./db/db.ts";
import { inventoryValuation } from "./api/queries.ts";

export interface ReadyItem {
  itemId: number; name: string; qty: number; house: string; houseLabel: string;
  listPrice: number; net: number; paid: number; margin: number; profit: number;
}

/** Bought units you hold that would make at least `margin` if listed now at the going price on the best house. */
export function readyToSell(db: Db, margin = minMargin(db)): ReadyItem[] {
  const out: ReadyItem[] = [];
  // Items with your own price target wait for that instead (see checkPriceTargets).
  const targeted = new Set((db.prepare("SELECT item_id id FROM price_target").all() as { id: number }[]).map((r) => r.id));
  for (const r of inventoryValuation(db, HOUSES).rows) {
    if (targeted.has(r.itemId) || r.ignored || !r.purchasedQty || !r.paidPerUnit || r.nowPerUnit == null || !r.nowHouse) continue;
    const m = r.nowPerUnit / r.paidPerUnit - 1;
    if (m < margin) continue;
    const h = r.houses.find((x) => x.key === r.nowHouse)!;
    out.push({
      itemId: r.itemId, name: r.name ?? `Item ${r.itemId}`, qty: r.purchasedQty, house: h.key, houseLabel: h.label,
      listPrice: h.now ?? 0, net: r.nowPerUnit, paid: r.paidPerUnit, margin: m, profit: (r.nowPerUnit - r.paidPerUnit) * r.purchasedQty,
    });
  }
  return out.sort((a, b) => b.profit - a.profit);
}

const gold = (c: number) => {
  const g = Math.floor(c / 10000), s = Math.floor((c % 10000) / 100), cu = Math.round(c % 100);
  return [g ? `${g}g` : "", s ? `${s}s` : "", !g && cu ? `${cu}c` : ""].filter(Boolean).join(" ") || "0c";
};

export type Notify = (title: string, body: string, meta?: { kind: string; itemId?: number }) => void;

/** Desktop notifications too (off unless switched on on the Notifications page). */
export const DESKTOP_NOTIFY_KEY = "desktop_notify";

/** A desktop notification (notify-send, KDE/GNOME). Failures are ignored: alerts also show on the dashboard. */
export const desktopNotify: Notify = (title, body) => {
  execFile("notify-send", ["--app-name=AH Tracker", "--icon=wow", "--urgency=normal", title, body], () => {});
};

/** Updates the alert table and notifies about items that just became ready. Returns those items. */
/** The default: a row on the dashboard's Notifications page, and a desktop notification if switched on. */
export function appNotify(db: Db, now = Math.floor(Date.now() / 1000)): Notify {
  return (title, body, meta) => {
    db.prepare("INSERT INTO notification (ts, kind, title, body, item_id) VALUES (?, ?, ?, ?, ?)").run(now, meta?.kind ?? "alert", title, body, meta?.itemId ?? null);
    if (getSetting(db, DESKTOP_NOTIFY_KEY, 0) === 1) desktopNotify(title, body);
  };
}

export function checkSellAlerts(db: Db, now = Math.floor(Date.now() / 1000), notify: Notify = appNotify(db, now)): ReadyItem[] {
  const ready = readyToSell(db);
  const was = new Map((db.prepare("SELECT item_id id, ready FROM sell_alert").all() as { id: number; ready: number }[]).map((r) => [r.id, r.ready]));
  const fresh = ready.filter((r) => was.get(r.itemId) !== 1);
  transaction(db, () => {
    db.prepare("UPDATE sell_alert SET ready = 0, updated_at = ? WHERE ready = 1").run(now);
    const up = db.prepare(`INSERT INTO sell_alert (item_id, ready, house, list_price, net, paid, qty, margin, since, notified_at, updated_at)
      VALUES (:id, 1, :house, :list, :net, :paid, :qty, :margin, :now, :notified, :now)
      ON CONFLICT (item_id) DO UPDATE SET ready = 1, house = :house, list_price = :list, net = :net, paid = :paid, qty = :qty,
        margin = :margin, updated_at = :now,
        since = CASE WHEN :isFresh = 1 THEN :now ELSE sell_alert.since END,
        notified_at = CASE WHEN :isFresh = 1 THEN :notified ELSE sell_alert.notified_at END`);
    for (const r of ready) {
      const isFresh = fresh.includes(r) ? 1 : 0;
      up.run({ id: r.itemId, house: r.house, list: r.listPrice, net: r.net, paid: r.paid, qty: r.qty, margin: r.margin, now,
        notified: isFresh ? now : null, isFresh });
    }
  });
  if (fresh.length) {
    const line = (r: ReadyItem) => `${r.name} ×${r.qty}: list at ${gold(r.listPrice)} on ${r.houseLabel}, +${gold(r.profit)} (${Math.round(r.margin * 100)}%)`;
    const title = fresh.length === 1 ? `Sell now for profit: ${fresh[0]!.name}` : `${fresh.length} items to sell now for profit`;
    notify(title, fresh.slice(0, 6).map(line).join("\n") + (fresh.length > 6 ? `\n…and ${fresh.length - 6} more on the Inventory page` : ""),
      { kind: "sell-now", itemId: fresh.length === 1 ? fresh[0]!.itemId : undefined });
  }
  return fresh;
}

// ---------------------------------------------------------------- your own price targets

export interface TargetStatus {
  itemId: number; name: string; target: number; price: number | null; house: string | null; houseLabel: string | null;
  seenAt: number | null; reached: boolean; held: number; paid: number | null; profitIfSold: number | null;
}

/** Each price target with the best (highest) cheapest listing across the houses, and what you hold. */
export function priceTargets(db: Db): TargetStatus[] {
  const targets = db.prepare(`SELECT t.item_id id, t.target, i.name FROM price_target t LEFT JOIN item i ON i.item_id = t.item_id
    ORDER BY i.name`).all() as { id: number; target: number; name: string | null }[];
  if (!targets.length) return [];
  const latest = db.prepare(`SELECT s.min_buyout p, s.ts FROM item_snapshot s JOIN snapshot sn ON sn.id = s.snapshot_id
    WHERE s.item_id = ? AND sn.house_id = ? AND s.min_buyout > 0 ORDER BY s.ts DESC LIMIT 1`);
  const inv = new Map(inventoryValuation(db, HOUSES).rows.map((r) => [r.itemId, r]));
  return targets.map((t) => {
    let best: { p: number; ts: number; house: (typeof HOUSES)[number] } | null = null;
    for (const h of HOUSES) {
      const l = latest.get(t.id, h.houseId) as { p: number; ts: number } | undefined;
      if (l && (!best || l.p > best.p)) best = { ...l, house: h };
    }
    const r = inv.get(t.id);
    const held = r?.purchasedQty ?? 0;
    const paid = r?.paidPerUnit ?? null;
    return {
      itemId: t.id, name: t.name ?? `Item ${t.id}`, target: t.target, price: best?.p ?? null,
      house: best?.house.key ?? null, houseLabel: best?.house.label ?? null, seenAt: best?.ts ?? null,
      reached: !!best && best.p >= t.target, held, paid,
      profitIfSold: best && held && paid != null ? (best.p * (1 - best.house.cut) - paid) * held : null,
    };
  });
}

/**
 * Notifies when an item's cheapest listing on either house reaches your target. Once per rise: it
 * re-arms after the price falls 3% below the target.
 */
export function checkPriceTargets(db: Db, now = Math.floor(Date.now() / 1000), notify: Notify = appNotify(db, now)): TargetStatus[] {
  const fired: TargetStatus[] = [];
  const state = new Map((db.prepare("SELECT item_id id, triggered FROM price_target").all() as { id: number; triggered: number }[]).map((r) => [r.id, r.triggered]));
  const up = db.prepare("UPDATE price_target SET triggered = ?, notified_at = coalesce(?, notified_at), last_price = ?, last_house = ? WHERE item_id = ?");
  transaction(db, () => {
    for (const t of priceTargets(db)) {
      const was = state.get(t.itemId) === 1;
      if (t.reached && !was) { fired.push(t); up.run(1, now, t.price, t.house, t.itemId); }
      else if (was && t.price !== null && t.price < t.target * 0.97) up.run(0, null, t.price, t.house, t.itemId);
      else up.run(was ? 1 : 0, null, t.price, t.house, t.itemId);
    }
  });
  for (const t of fired) {
    const hold = t.held ? `\nYou hold ${t.held}${t.paid != null ? ` bought at ${gold(t.paid)}` : ""}${t.profitIfSold != null ? `: ${t.profitIfSold >= 0 ? "+" : "-"}${gold(Math.abs(t.profitIfSold))} after the AH cut if sold there` : ""}.` : "";
    notify(`Price target reached: ${t.name}`, `Cheapest on ${t.houseLabel} is ${gold(t.price!)} (your target ${gold(t.target)}).${hold}`,
      { kind: "target", itemId: t.itemId });
  }
  return fired;
}
