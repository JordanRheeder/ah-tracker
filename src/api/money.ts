// The Overview page: income, costs and profit from TSM's ledger, plus gold on hand per character.
// TSM records sales at their full price and does not say which auction house they were on, so the
// AH cut is estimated at the faction rate; deposits lost on expired listings are estimated from each
// item's deposit.
import type { DatabaseSync } from "node:sqlite";
import { tradeBook } from "./queries.ts";

type Db = DatabaseSync;

export interface OverviewOptions {
  /** Start of the period (unix seconds); 0 = everything. */
  since: number;
  now: number;
  /** AH cut assumed for auction sales, whose house TSM does not record. */
  cut: number;
  /** Minutes to add to UTC for the viewer's local day boundaries. */
  tzOffsetMinutes: number;
}

const sum = <T>(rows: T[], f: (r: T) => number) => rows.reduce((t, r) => t + f(r), 0);

export function moneyOverview(db: Db, o: OverviewOptions) {
  const inPeriod = (ts: number) => ts >= o.since && ts <= o.now;
  // Your characters: anyone TSM tracks gold for or who appears as the player in the ledger.
  const own = new Set<string>([
    ...(db.prepare("SELECT character c FROM tsm_character").all() as { c: string }[]).map((r) => r.c),
    ...(db.prepare("SELECT DISTINCT player c FROM tsm_ledger UNION SELECT DISTINCT player FROM tsm_money").all() as { c: string }[]).map((r) => r.c),
  ]);

  const book = tradeBook(db);
  const sales = book.sales.filter((s) => inPeriod(s.ts));
  const buys = (db.prepare(`SELECT item_id itemId, ts, qty, price unit, source, player FROM tsm_ledger WHERE kind = 'buy' AND ts >= ? AND ts <= ?`)
    .all(o.since, o.now)) as { itemId: number; ts: number; qty: number; unit: number; source: string | null; player: string }[];
  const expired = (db.prepare(`SELECT l.item_id itemId, l.ts, l.qty, l.player, i.deposit_unit deposit FROM tsm_ledger l
      LEFT JOIN item i ON i.item_id = l.item_id WHERE l.kind = 'expired' AND l.ts >= ? AND l.ts <= ?`)
    .all(o.since, o.now)) as { itemId: number; ts: number; qty: number; player: string; deposit: number | null }[];
  const money = (db.prepare(`SELECT kind, type, amount, other, player, ts FROM tsm_money WHERE ts >= ? AND ts <= ?`)
    .all(o.since, o.now)) as { kind: string; type: string; amount: number; other: string; player: string; ts: number }[];
  const internal = (m: { type: string; other: string }) => m.type === "Money Transfer" && own.has(m.other);

  const cutOf = (s: { source: string | null; qty: number; unit: number }) => (s.source === "Auction" ? s.qty * s.unit * o.cut : 0);
  const auctionSales = sales.filter((s) => s.source === "Auction");
  const vendorSales = sales.filter((s) => s.source === "Vendor");
  const otherSales = sales.filter((s) => s.source !== "Auction" && s.source !== "Vendor");
  const otherIncome = money.filter((m) => m.kind === "income" && !internal(m));
  const postage = money.filter((m) => m.kind === "expense" && m.type === "Postage");
  const otherExpense = money.filter((m) => m.kind === "expense" && m.type !== "Postage" && !internal(m));
  const lostDeposits = sum(expired, (e) => e.qty * (e.deposit ?? 0));

  const income = {
    auctionSales: sum(auctionSales, (s) => s.qty * s.unit),
    vendorSales: sum(vendorSales, (s) => s.qty * s.unit),
    otherSales: sum(otherSales, (s) => s.qty * s.unit),
    other: sum(otherIncome, (m) => m.amount),
  };
  const costs = {
    ahCut: sum(sales, cutOf),
    auctionBuys: sum(buys.filter((b) => b.source === "Auction"), (b) => b.qty * b.unit),
    vendorBuys: sum(buys.filter((b) => b.source !== "Auction"), (b) => b.qty * b.unit),
    postage: sum(postage, (m) => m.amount),
    lostDeposits,
    other: sum(otherExpense, (m) => m.amount),
  };
  const totalIncome = Object.values(income).reduce((a, b) => a + b, 0);
  const totalCosts = Object.values(costs).reduce((a, b) => a + b, 0);

  // Trading profit: sales of units you bought, after the cut, minus what those units cost.
  // Postage and lost deposits are the running costs of trading, taken off after.
  const traded = sales.filter((s) => s.boughtQty > 0);
  const tradeRevenue = sum(traded, (s) => s.boughtQty * s.unit - (s.source === "Auction" ? s.boughtQty * s.unit * o.cut : 0));
  const tradeCost = sum(traded, (s) => s.boughtCost);
  const farmed = sales.filter((s) => s.qty > s.boughtQty);
  const trading = {
    unitsSold: sum(traded, (s) => s.boughtQty),
    revenue: tradeRevenue,
    cost: tradeCost,
    grossProfit: tradeRevenue - tradeCost,
    netProfit: tradeRevenue - tradeCost - costs.postage - lostDeposits,
    // Items you did not buy (farmed, looted, crafted): all of it is income.
    farmedSales: sum(farmed, (s) => (s.qty - s.boughtQty) * s.unit - (s.source === "Auction" ? (s.qty - s.boughtQty) * s.unit * o.cut : 0)),
  };

  // Income and costs per local day.
  const dayOf = (ts: number) => new Date((ts + o.tzOffsetMinutes * 60) * 1000).toISOString().slice(0, 10);
  const days = new Map<string, { day: string; income: number; costs: number }>();
  const add = (ts: number, field: "income" | "costs", v: number) => {
    const d = dayOf(ts);
    const row = days.get(d) ?? { day: d, income: 0, costs: 0 };
    row[field] += v;
    days.set(d, row);
  };
  for (const s of sales) { add(s.ts, "income", s.qty * s.unit); add(s.ts, "costs", cutOf(s)); }
  for (const b of buys) add(b.ts, "costs", b.qty * b.unit);
  for (const e of expired) add(e.ts, "costs", e.qty * (e.deposit ?? 0));
  for (const m of money) if (!internal(m)) add(m.ts, m.kind === "income" ? "income" : "costs", m.amount);
  const daily = [...days.values()].sort((a, b) => a.day.localeCompare(b.day)).map((d) => ({ ...d, net: d.income - d.costs }));

  // Gold on hand: latest per character, and the total over time from TSM's gold logs.
  const characters = db.prepare("SELECT character, faction, money, updated_at updatedAt FROM tsm_character ORDER BY money DESC").all() as
    { character: string; faction: string | null; money: number; updatedAt: number }[];
  const log = db.prepare("SELECT character, ts, copper FROM tsm_gold_log ORDER BY ts").all() as { character: string; ts: number; copper: number }[];
  const last = new Map<string, number>();
  const goldSeries: { ts: number; copper: number }[] = [];
  for (const g of log) {
    last.set(g.character, g.copper);
    const total = [...last.values()].reduce((a, b) => a + b, 0);
    if (goldSeries.length && goldSeries[goldSeries.length - 1]!.ts === g.ts) goldSeries[goldSeries.length - 1]!.copper = total;
    else goldSeries.push({ ts: g.ts, copper: total });
  }

  // Latest activity, newest first.
  const names = db.prepare("SELECT name, quality, icon_name icon FROM item WHERE item_id = ?");
  const item = (id: number) => (names.get(id) as { name: string | null; quality: number | null; icon: string | null } | undefined) ?? { name: null, quality: null, icon: null };
  const activity = [
    ...sales.map((s) => ({ ts: s.ts, what: s.source === "Vendor" ? "Sold to vendor" : s.source === "Auction" ? "Sold on AH" : `Sold (${s.source ?? "other"})`,
      itemId: s.itemId, ...item(s.itemId), qty: s.qty, amount: s.qty * s.unit, player: s.player,
      profit: s.boughtQty ? s.boughtQty * s.unit * (s.source === "Auction" ? 1 - o.cut : 1) - s.boughtCost : null })),
    ...buys.map((b) => ({ ts: b.ts, what: b.source === "Auction" ? "Bought on AH" : `Bought (${b.source ?? "other"})`,
      itemId: b.itemId, ...item(b.itemId), qty: b.qty, amount: -b.qty * b.unit, player: b.player, profit: null })),
    ...expired.map((e) => ({ ts: e.ts, what: "Listing expired", itemId: e.itemId, ...item(e.itemId), qty: e.qty,
      amount: e.deposit ? -e.qty * e.deposit : null, player: e.player, profit: null })),
    ...money.map((m) => ({ ts: m.ts,
      what: m.type === "Postage" ? `Postage to ${m.other || "?"}` : internal(m) ? `${m.type} to/from ${m.other} (your character, not counted)` : m.other ? `${m.type} · ${m.other}` : m.type,
      itemId: null, name: null, quality: null, icon: null, qty: null, amount: m.kind === "income" ? m.amount : -m.amount, player: m.player, profit: null,
      internal: internal(m) })),
  ].sort((a, b) => b.ts - a.ts).slice(0, 60);

  // Bought units not sold yet (anywhere: bags, bank, mail or listed), at what they cost.
  let stockUnits = 0, stockCost = 0;
  for (const lots of book.open.values()) for (const l of lots) { stockUnits += l.qty; stockCost += l.qty * l.unit; }

  const lastLedger = (db.prepare("SELECT max(ts) t FROM (SELECT ts FROM tsm_ledger UNION ALL SELECT ts FROM tsm_money)").get() as { t: number | null }).t;
  return {
    period: { since: o.since, now: o.now, cut: o.cut },
    income, costs, totalIncome, totalCosts, net: totalIncome - totalCosts, trading,
    counts: { sales: sales.length, buys: buys.length, expired: expired.length, postage: postage.length,
      expiredWithoutDeposit: expired.filter((e) => !e.deposit).length },
    stock: { units: stockUnits, cost: stockCost },
    daily, characters, goldTotal: sum(characters, (c) => c.money), goldSeries, activity, lastLedger,
  };
}

/**
 * Every item you bought on the AH, with what happened to it: units bought and what they cost, units
 * of those sold (oldest bought sold first) and what they made after the AH cut, deposits lost on
 * expired listings, and what is still held. Newest activity first. Postage is not split per item.
 */
export function flipBook(db: Db, o: { since: number; cut: number }) {
  const book = tradeBook(db);
  const expired = db.prepare(`SELECT l.item_id itemId, l.ts, l.qty, i.deposit_unit deposit FROM tsm_ledger l
    LEFT JOIN item i ON i.item_id = l.item_id WHERE l.kind = 'expired'`).all() as { itemId: number; ts: number; qty: number; deposit: number | null }[];
  const names = db.prepare("SELECT name, quality, icon_name icon FROM item WHERE item_id = ?");
  type Trade = { ts: number; what: string; qty: number; unit: number; total: number; player?: string; house?: string | null; profit?: number | null };
  const items = new Map<number, {
    itemId: number; boughtQty: number; boughtCost: number; soldQty: number; revenue: number; soldGross: number; costOfSold: number;
    depositsLost: number; expiredListings: number; heldQty: number; heldCost: number; firstBuy: number; lastActivity: number;
    houses: Set<string>; trades: Trade[];
  }>();
  const get = (id: number, ts: number) => {
    let it = items.get(id);
    if (!it) items.set(id, (it = { itemId: id, boughtQty: 0, boughtCost: 0, soldQty: 0, revenue: 0, soldGross: 0, costOfSold: 0,
      depositsLost: 0, expiredListings: 0, heldQty: 0, heldCost: 0, firstBuy: ts, lastActivity: ts, houses: new Set(), trades: [] }));
    return it;
  };
  for (const b of book.buys) {
    const it = get(b.itemId, b.ts);
    it.boughtQty += b.qty;
    it.boughtCost += b.qty * b.unit;
    it.firstBuy = Math.min(it.firstBuy, b.ts);
    it.lastActivity = Math.max(it.lastActivity, b.ts);
    if (b.house) it.houses.add(b.house);
    it.trades.push({ ts: b.ts, what: "Bought", qty: b.qty, unit: b.unit, total: -b.qty * b.unit, house: b.house });
  }
  for (const s of book.sales) {
    const it = items.get(s.itemId);
    if (!it || s.boughtQty === 0) continue; // only sales of units you bought
    const net = s.boughtQty * s.unit * (s.source === "Auction" ? 1 - o.cut : 1);
    it.soldQty += s.boughtQty;
    it.soldGross += s.boughtQty * s.unit;
    it.revenue += net;
    it.costOfSold += s.boughtCost;
    it.lastActivity = Math.max(it.lastActivity, s.ts);
    it.trades.push({ ts: s.ts, what: s.source === "Vendor" ? "Sold to vendor" : s.source === "Auction" ? "Sold on AH" : `Sold (${s.source})`,
      qty: s.boughtQty, unit: s.unit, total: net, player: s.player, profit: net - s.boughtCost });
  }
  for (const e of expired) {
    const it = items.get(e.itemId);
    if (!it || e.ts < it.firstBuy) continue;
    it.expiredListings++;
    it.depositsLost += e.qty * (e.deposit ?? 0);
    it.lastActivity = Math.max(it.lastActivity, e.ts);
    it.trades.push({ ts: e.ts, what: "Listing expired", qty: e.qty, unit: e.deposit ?? 0, total: -(e.qty * (e.deposit ?? 0)) });
  }
  for (const [id, lots] of book.open) {
    const it = items.get(id);
    if (!it) continue;
    for (const l of lots) { it.heldQty += l.qty; it.heldCost += l.qty * l.unit; }
  }
  // Bought units you no longer own without a recorded sale: used, crafted, turned in, given away, or
  // sold with the gold still in the mailbox (TSM records a sale when you collect it).
  const goneQty = (id: number) => book.gone.get(id) ?? 0;
  const rows = [...items.values()].filter((it) => it.lastActivity >= o.since).map(({ houses, trades, ...it }) => {
    const profit = it.revenue - it.costOfSold - it.depositsLost;
    return {
      ...it, ...((names.get(it.itemId) as { name: string | null; quality: number | null; icon: string | null } | undefined) ?? { name: null, quality: null, icon: null }),
      boughtOn: [...houses],
      goneQty: goneQty(it.itemId),
      avgBuy: it.boughtQty ? it.boughtCost / it.boughtQty : null,
      avgSell: it.soldQty ? it.soldGross / it.soldQty : null,
      profit: it.soldQty ? profit : null,
      margin: it.costOfSold ? profit / it.costOfSold : null,
      status: it.heldQty === 0 ? (it.soldQty === 0 ? "gone" : "sold") : it.soldQty === 0 ? "holding" : "part-sold",
      trades: trades.sort((a, b) => b.ts - a.ts),
    };
  }).sort((a, b) => b.lastActivity - a.lastActivity);
  const sold = rows.filter((r) => r.profit !== null);
  return {
    cut: o.cut,
    rows,
    totals: {
      items: rows.length,
      flipsWithSales: sold.length,
      winners: sold.filter((r) => (r.profit ?? 0) > 0).length,
      profit: sold.reduce((t, r) => t + (r.profit ?? 0), 0),
      costOfSold: sold.reduce((t, r) => t + r.costOfSold, 0),
      unitsSold: sold.reduce((t, r) => t + r.soldQty, 0),
      heldQty: rows.reduce((t, r) => t + r.heldQty, 0),
      heldCost: rows.reduce((t, r) => t + r.heldCost, 0),
    },
  };
}
