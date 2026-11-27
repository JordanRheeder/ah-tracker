// Local dashboard server: read-only JSON API plus the static dashboard in web/, on 127.0.0.1 only.
import { createServer, type IncomingMessage, type RequestListener, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ENV_FILE, HOUSES, houseByKey, loadConfig, reloadEnv } from "../config.ts";
import { checkWowDir, installAddon, listDirs, readEnvFile, saveEnv, SECRET_FIELDS, SETUP_FIELDS, wowDirCandidates, type SetupField } from "../setup.ts";
import { CROSS_DIRECTION_KEY, crossDirection, getSetting, goodsCode, LIST_GOODS_KEY, listGoods, SNIPE_FRACTION_KEY, snipeFraction, minMargin, MIN_MARGIN_FLOOR, MIN_MARGIN_KEY, openDb, safeOnly, SAFE_ONLY_KEY, setSetting } from "../db/db.ts";
import { RANGES, toCandles, toHeatMap, type RangeKey } from "./candles.ts";
import { browseItems, categories, health, inventoryValuation, itemDetail, itemSeries, conversionShuffles, essenceConversions, itemStats, modelForecasts, modelScoreboard, shuffles, listAnomalies, listedQuantities, listForecasts, materials, listOpportunities, rightNow, searchItems, topMovers, tsmSeries } from "./queries.ts";
import { ensureIcons } from "./wowhead.ts";
import { flipBook, moneyOverview } from "./money.ts";
import { DESKTOP_NOTIFY_KEY, priceTargets, readyToSell } from "../alerts.ts";
import { syncNow } from "../poller.ts";
import { checkWatchlist, setWatch, watchItems, WATCH_HOURS, WATCH_HOUSE } from "../watch.ts";
import { craftingTable, MIN_SOLD_PER_DAY } from "../stats/crafting.ts";
import { auctionatorImport, buildLists, isGoods, PROFESSIONS, KIND_TITLE, untagged, writeListsFile, type Goods, type ShoppingList } from "../stats/lists.ts";

const config = loadConfig();
const root = resolve(import.meta.dirname, "..", "..");
const dbPath = process.env.AH_DB ?? join(config.dataDir, "ah-tracker.sqlite");
const port = Number(process.env.DASHBOARD_PORT ?? 8787);

// Writable connection, opened first so schema migrations run before any read. The dashboard's only
// writes are caching icon names looked up from Wowhead; every query uses the read-only connection.
const iconDb = openDb(dbPath);
const db = new DatabaseSync(dbPath, { readOnly: true });
db.exec("PRAGMA busy_timeout = 5000");

const STATIC: Record<string, string> = {
  "/": "web/index.html",
  "/app.js": "web/app.js",
  "/calc.mjs": "web/calc.mjs",
  "/style.css": "web/style.css",
  "/vendor/lightweight-charts.js": "node_modules/lightweight-charts/dist/lightweight-charts.standalone.production.js",
};
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

let syncing = false;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
/**
 * Setup endpoints change .env and list folder names, so they only answer the dashboard itself: the Host
 * must be local (blocks DNS rebinding), any Origin must be this dashboard, and POSTs must be JSON (a
 * cross-site JSON POST needs a CORS preflight, which this server never grants).
 */
function localOnly(req: IncomingMessage): string | null {
  const host = (req.headers.host ?? "").replace(/:\d+$/, "");
  if (!LOCAL_HOSTS.has(host)) return "setup is only available at http://localhost";
  const origin = req.headers.origin;
  if (origin) {
    try { if (!LOCAL_HOSTS.has(new URL(origin).hostname.replace(/^::1$/, "[::1]"))) return "cross-site request refused"; } catch { return "bad origin"; }
  }
  if (req.method === "POST" && !(req.headers["content-type"] ?? "").startsWith("application/json")) return "expected JSON";
  return null;
}

const readBody = (req: IncomingMessage) => new Promise<string>((resolve) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => resolve(b)); });

function setupState() {
  const env = readEnvFile();
  const wowDir = config.auctionator.wowForeverDir;
  return {
    platform: process.platform,
    envFile: ENV_FILE,
    wowDir,
    check: checkWowDir(wowDir),
    candidates: wowDir ? [] : wowDirCandidates(),
    // Whether each key is set; the values never leave the server.
    keys: Object.fromEntries(SETUP_FIELDS.filter((f) => SECRET_FIELDS.has(f)).map((f) => [f, Boolean(env[f])])),
  };
}

const handler: RequestListener = async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const now = Date.now() / 1000;

    const file = STATIC[path];
    if (file) {
      const body = await readFile(join(root, file));
      res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
      return res.end(body);
    }

    if (path.startsWith("/api/setup")) {
      const refused = localOnly(req);
      if (refused) return json(res, 403, { error: refused });
      if (path === "/api/setup/dirs") return json(res, 200, listDirs(url.searchParams.get("path")));
      if (path === "/api/setup/check") return json(res, 200, checkWowDir(url.searchParams.get("path") ?? ""));
      if (path === "/api/setup/install-addon" && req.method === "POST") {
        const dest = installAddon(config.auctionator.wowForeverDir);
        const lists = writeListsFile(iconDb, config.auctionator.wowForeverDir);
        return json(res, 200, { dest, lists: lists?.items ?? 0, setup: setupState() });
      }
      if (path === "/api/setup" && req.method === "POST") {
        // Only the fields sent are changed; "" clears a key.
        const body = JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>;
        const updates: Partial<Record<SetupField, string>> = {};
        for (const f of SETUP_FIELDS) if (typeof body[f] === "string") updates[f] = body[f] as string;
        if (updates.WOW_FOREVER_DIR) {
          const c = checkWowDir(updates.WOW_FOREVER_DIR);
          if (!c.looksRight) return json(res, 400, { error: c.hint ?? "not a WoW _forever_ folder" });
          updates.WOW_FOREVER_DIR = c.path;
        }
        if (!Object.keys(updates).length) return json(res, 400, { error: "nothing to save" });
        saveEnv(updates);
        reloadEnv(config); // the collector service picks the change up on its next 20-second check
        return json(res, 200, setupState());
      }
      if (path === "/api/setup") return json(res, 200, setupState());
      return json(res, 404, { error: "not found" });
    }

    const house = houseByKey(url.searchParams.get("house")) ?? HOUSES[0]!;
    if (path === "/api/houses") return json(res, 200, HOUSES);
    if (path === "/api/search") return json(res, 200, searchItems(db, url.searchParams.get("q") ?? "", house.houseId));
    if (path === "/api/health") return json(res, 200, { ...health(db, dbPath), houses: HOUSES });
    if (path === "/api/movers") {
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 15) || 15));
      return json(res, 200, topMovers(db, house.houseId, limit));
    }
    if (path === "/api/categories") return json(res, 200, categories(db, house.houseId));
    if (path === "/api/shuffles") {
      // Enchanting only: its materials (as on the Materials page) and the essence conversions.
      const ench = PROFESSIONS.find((p) => p.key === "enchanting")!;
      const rows = [...shuffles(db, HOUSES, { subclass: ench.subclass, extra: "extra" in ench ? ench.extra : [] }), ...conversionShuffles(db, HOUSES)];
      return json(res, 200, { cuts: Object.fromEntries(HOUSES.map((h) => [h.key, h.cut])), crossDirection: crossDirection(db), rows });
    }
    if (path === "/api/essences") return json(res, 200, essenceConversions(db, HOUSES));
    if (path === "/api/materials") {
      if (req.method === "POST") {
        // Snipe threshold (share of the usual price); rewrites the addon's snipe lists.
        const body = await new Promise<string>((resolve) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => resolve(b)); });
        const f = Number((JSON.parse(body || "{}") as { fraction?: unknown }).fraction);
        if (!Number.isFinite(f) || f < 0.05 || f > 0.95) return json(res, 400, { error: "Snipe price must be 5-95% of the usual price" });
        setSetting(iconDb, SNIPE_FRACTION_KEY, f);
        const lists = writeListsFile(iconDb, config.auctionator.wowForeverDir);
        return json(res, 200, { fraction: snipeFraction(db), listsRewritten: lists !== null });
      }
      const prof = PROFESSIONS.find((p) => p.key === url.searchParams.get("prof")) ?? PROFESSIONS[0];
      const fraction = snipeFraction(db);
      const extra = "extra" in prof ? prof.extra : [];
      const rows = materials(db, house.houseId, prof.subclass, fraction, extra);
      const missing = rows.filter((r) => !r.icon).map((r) => r.itemId);
      const out = () => ({ fraction, profession: prof.key, professions: PROFESSIONS, rows: materials(db, house.houseId, prof.subclass, fraction, extra) });
      if (missing.length) await ensureIcons(iconDb, missing);
      return json(res, 200, out());
    }
    if (path === "/api/model") {
      // The pooled forecasting model: test report, and forecasts for EU PvP Alliance (your house) only.
      const m = modelForecasts(db);
      const id = url.searchParams.get("item");
      return json(res, 200, id ? { computedAt: m.computedAt, report: m.report, forecast: m.forecasts[Number(id)] ?? null } : m);
    }
    if (path === "/api/model/scoreboard") {
      // Published forecasts (EU PvP Alliance) scored against what happened, last 7 days.
      return json(res, 200, modelScoreboard(db));
    }
    if (path === "/api/forecasts") {
      const q = url.searchParams;
      const cls = q.get("class");
      const opts = { view: q.get("view") ?? "rising", minPrice: Number(q.get("minPrice") ?? 0) || 0, minSold: Number(q.get("minSold") ?? 0) || 0,
        classId: cls === null || cls === "" ? null : Number(cls) };
      const out = listForecasts(db, house.houseId, opts);
      const missing = (out.rows as { itemId: number; icon: string | null }[]).filter((r) => !r.icon).map((r) => r.itemId);
      if (missing.length && (await ensureIcons(iconDb, missing)) > 0) return json(res, 200, listForecasts(db, house.houseId, opts));
      return json(res, 200, out);
    }
    if (path === "/api/flips") {
      const days = Number(url.searchParams.get("days") ?? 0);
      const opts = { since: days > 0 ? Math.floor(now) - days * 86400 : 0, cut: HOUSES[0]!.cut };
      const out = flipBook(db, opts);
      const missing = out.rows.filter((r) => !r.icon).map((r) => r.itemId);
      if (missing.length && (await ensureIcons(iconDb, missing)) > 0) return json(res, 200, flipBook(db, opts));
      return json(res, 200, out);
    }
    if (path === "/api/overview") {
      // ?days=1|7|30 (or 0 = everything) and ?tz=<minutes east of UTC> for local day boundaries.
      const days = Number(url.searchParams.get("days") ?? 7);
      const tz = Number(url.searchParams.get("tz") ?? 0);
      const t = Math.floor(now);
      const out = moneyOverview(db, { since: days > 0 ? t - days * 86400 : 0, now: t, cut: HOUSES[0]!.cut, tzOffsetMinutes: Number.isFinite(tz) ? tz : 0 });
      const missing = out.activity.filter((r) => r.itemId && !r.icon).map((r) => r.itemId as number);
      if (missing.length && (await ensureIcons(iconDb, [...new Set(missing)])) > 0)
        return json(res, 200, moneyOverview(db, { since: days > 0 ? t - days * 86400 : 0, now: t, cut: HOUSES[0]!.cut, tzOffsetMinutes: Number.isFinite(tz) ? tz : 0 }));
      return json(res, 200, out);
    }
    if (path === "/api/notifications") {
      // POST { read: id | "all" } marks read; { clear: true } deletes read ones; { desktop: bool } switches desktop notifications.
      if (req.method === "POST") {
        const body = await new Promise<string>((resolve) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => resolve(b)); });
        const input = JSON.parse(body || "{}") as { read?: unknown; clear?: unknown; desktop?: unknown };
        if (input.read === "all") iconDb.prepare("UPDATE notification SET read = 1").run();
        else if (input.read !== undefined) iconDb.prepare("UPDATE notification SET read = 1 WHERE id = ?").run(Number(input.read));
        if (input.clear) iconDb.prepare("DELETE FROM notification WHERE read = 1").run();
        if (input.desktop !== undefined) setSetting(iconDb, DESKTOP_NOTIFY_KEY, input.desktop ? 1 : 0);
        return json(res, 200, { ok: true });
      }
      const items = db.prepare(`SELECT n.id, n.ts, n.kind, n.title, n.body, n.item_id itemId, n.read, i.name, i.quality, i.icon_name icon
        FROM notification n LEFT JOIN item i ON i.item_id = n.item_id ORDER BY n.id DESC LIMIT 200`).all();
      const unread = (db.prepare("SELECT count(*) n FROM notification WHERE read = 0").get() as { n: number }).n;
      const latest = (db.prepare("SELECT max(id) id FROM notification").get() as { id: number | null }).id ?? 0;
      return json(res, 200, { unread, latest, desktop: getSetting(db, DESKTOP_NOTIFY_KEY, 0) === 1, items });
    }
    if (path === "/api/watch") {
      // Watchlist: POST { itemId, buyBelow?: copper | null, note?, remove? } changes one item, { check: true } rechecks now.
      if (req.method === "POST") {
        const body = await new Promise<string>((resolve) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => resolve(b)); });
        const input = JSON.parse(body || "{}") as { itemId?: unknown; buyBelow?: unknown; note?: unknown; remove?: unknown; check?: unknown };
        if (input.check) return json(res, 200, { changes: checkWatchlist(iconDb) });
        const itemId = Number(input.itemId);
        if (!Number.isInteger(itemId) || itemId <= 0) return json(res, 400, { error: "itemId must be an item id" });
        let buyBelow: number | null | undefined;
        if (input.buyBelow === null || input.buyBelow === "") buyBelow = null;
        else if (input.buyBelow !== undefined) {
          buyBelow = Math.round(Number(input.buyBelow));
          if (!Number.isFinite(buyBelow) || buyBelow < 1) return json(res, 400, { error: "Buy price must be at least 1c" });
        }
        setWatch(iconDb, itemId, { buyBelow, note: typeof input.note === "string" ? input.note : undefined, remove: Boolean(input.remove) }, Math.floor(now));
        // New items get their first reading at once; the [WATCH] list follows the buy prices.
        if (!input.remove) checkWatchlist(iconDb);
        writeListsFile(iconDb, config.auctionator.wowForeverDir);
        return json(res, 200, { ok: true });
      }
      const info = new Map((db.prepare(`SELECT w.item_id id, i.icon_name icon, i.quality, i.class_id classId, sc.name category
        FROM watch_item w LEFT JOIN item i ON i.item_id = w.item_id
        LEFT JOIN item_class sc ON sc.class_id = i.class_id AND sc.subclass_id = i.subclass_id`).all() as
        { id: number; icon: string | null; quality: number | null; classId: number | null; category: string | null }[]).map((r) => [r.id, r]));
      return json(res, 200, { hours: WATCH_HOURS, house: WATCH_HOUSE.label,
        items: watchItems(db).map((w) => { const i = info.get(w.itemId); return { ...w, icon: i?.icon ?? null, quality: i?.quality ?? null, classId: i?.classId ?? null, category: i?.category ?? null }; }) });
    }
    if (path === "/api/crafting") {
      // Every alchemy and cooking recipe priced from current Alliance prices (src/stats/crafting.ts).
      const t = craftingTable(db);
      return json(res, 200, { ...t, minSoldPerDay: MIN_SOLD_PER_DAY, house: WATCH_HOUSE.label });
    }
    if (path === "/api/list-prices") {
      // Your own listing prices for the addon: POST { itemId, price: copper | null, note? } sets or removes one.
      if (req.method === "POST") {
        const body = await new Promise<string>((resolve) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => resolve(b)); });
        const input = JSON.parse(body || "{}") as { itemId?: unknown; price?: unknown; note?: unknown };
        const itemId = Number(input.itemId);
        if (!Number.isInteger(itemId) || itemId <= 0) return json(res, 400, { error: "itemId must be an item id" });
        if (input.price === null || input.price === "" || input.price === undefined) {
          iconDb.prepare("DELETE FROM list_price WHERE item_id = ?").run(itemId);
        } else {
          const price = Math.round(Number(input.price));
          if (!Number.isFinite(price) || price < 1) return json(res, 400, { error: "Price must be at least 1c" });
          iconDb.prepare(`INSERT INTO list_price (item_id, price, note, created_at) VALUES (?, ?, ?, ?)
            ON CONFLICT (item_id) DO UPDATE SET price = excluded.price, note = excluded.note`)
            .run(itemId, price, typeof input.note === "string" ? input.note : null, Math.floor(now));
        }
        const lists = writeListsFile(iconDb, config.auctionator.wowForeverDir);
        return json(res, 200, { ok: true, listsWritten: Boolean(lists) });
      }
      return json(res, 200, db.prepare(`SELECT l.item_id itemId, i.name, l.price, l.note, l.created_at createdAt
        FROM list_price l LEFT JOIN item i ON i.item_id = l.item_id ORDER BY i.name`).all());
    }
    if (path === "/api/targets") {
      // Your own sell targets: POST { itemId, target: copper | null } sets or removes one.
      if (req.method === "POST") {
        const body = await new Promise<string>((resolve) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => resolve(b)); });
        const input = JSON.parse(body || "{}") as { itemId?: unknown; target?: unknown };
        const itemId = Number(input.itemId);
        if (!Number.isInteger(itemId) || itemId <= 0) return json(res, 400, { error: "itemId must be an item id" });
        if (input.target === null || input.target === "" || input.target === undefined) {
          iconDb.prepare("DELETE FROM price_target WHERE item_id = ?").run(itemId);
        } else {
          const target = Math.round(Number(input.target));
          if (!Number.isFinite(target) || target < 1) return json(res, 400, { error: "Target must be at least 1c" });
          iconDb.prepare(`INSERT INTO price_target (item_id, target, created_at) VALUES (?, ?, ?)
            ON CONFLICT (item_id) DO UPDATE SET target = excluded.target, triggered = 0`).run(itemId, target, Math.floor(now));
        }
        return json(res, 200, { ok: true });
      }
      return json(res, 200, priceTargets(db));
    }
    if (path === "/api/alerts") {
      // Bought items you could sell right now for at least your minimum margin, and since when.
      const since = new Map((db.prepare("SELECT item_id id, since FROM sell_alert WHERE ready = 1").all() as { id: number; since: number }[]).map((r) => [r.id, r.since]));
      return json(res, 200, { minMargin: minMargin(db), items: readyToSell(db).map((r) => ({ ...r, since: since.get(r.itemId) ?? null })) });
    }
    if (path === "/api/inventory/ignore" && req.method === "POST") {
      // Tick or untick an item on the Inventory page.
      const body = await new Promise<string>((resolve) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => resolve(b)); });
      const input = JSON.parse(body || "{}") as { itemId?: unknown; ignored?: unknown };
      const itemId = Number(input.itemId);
      if (!Number.isInteger(itemId) || itemId <= 0) return json(res, 400, { error: "itemId must be an item id" });
      if (input.ignored) iconDb.prepare("INSERT OR IGNORE INTO inventory_ignore (item_id, ignored_at) VALUES (?, ?)").run(itemId, Math.floor(now));
      else iconDb.prepare("DELETE FROM inventory_ignore WHERE item_id = ?").run(itemId);
      return json(res, 200, { itemId, ignored: Boolean(input.ignored) });
    }
    if (path === "/api/inventory") {
      const result = inventoryValuation(db, HOUSES);
      const missing = result.rows.filter((r) => !r.icon).map((r) => r.itemId);
      if (missing.length && (await ensureIcons(iconDb, missing)) > 0) return json(res, 200, inventoryValuation(db, HOUSES));
      return json(res, 200, result);
    }
    if (path === "/api/sync" && req.method === "POST") {
      if (syncing) return json(res, 409, { error: "A sync is already running" });
      syncing = true;
      try {
        const started = Date.now();
        const lines = await syncNow(iconDb, config);
        return json(res, 200, { ok: true, ms: Date.now() - started, lines });
      } finally {
        syncing = false;
      }
    }
    if (path === "/api/last-update") {
      const row = db.prepare(`SELECT max(started_at) t FROM fetch_log WHERE status != 'error'`).get() as { t: number | null };
      const snap = db.prepare(`SELECT max(fetched_at) t FROM snapshot`).get() as { t: number | null };
      return json(res, 200, { lastFetch: row.t, lastSnapshot: snap.t });
    }
    if (path === "/api/settings") {
      if (req.method === "POST") {
        const body = await new Promise<string>((resolve) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => resolve(b)); });
        const input = JSON.parse(body || "{}") as { minMargin?: unknown; safeOnly?: unknown; goods?: unknown; crossDirection?: unknown };
        if (input.minMargin !== undefined) {
          const margin = Number(input.minMargin);
          if (!Number.isFinite(margin) || margin < MIN_MARGIN_FLOOR || margin > 2)
            return json(res, 400, { error: `Minimum margin must be between ${MIN_MARGIN_FLOOR * 100}% and 200%` });
          setSetting(iconDb, MIN_MARGIN_KEY, margin);
        }
        if (input.safeOnly !== undefined) setSetting(iconDb, SAFE_ONLY_KEY, input.safeOnly ? 1 : 0);
        if (input.goods !== undefined) setSetting(iconDb, LIST_GOODS_KEY, goodsCode(input.goods));
        if (input.crossDirection !== undefined) setSetting(iconDb, CROSS_DIRECTION_KEY, [0, 1, 2].includes(Number(input.crossDirection)) ? Number(input.crossDirection) : 0);
        // Max buy prices depend on the margin: rewrite the addon's shopping lists now.
        const lists = writeListsFile(iconDb, config.auctionator.wowForeverDir);
        return json(res, 200, { minMargin: minMargin(db), safeOnly: safeOnly(db), goods: listGoods(db), crossDirection: crossDirection(db), listsRewritten: lists !== null });
      }
      return json(res, 200, { minMargin: minMargin(db), safeOnly: safeOnly(db), goods: listGoods(db), crossDirection: crossDirection(db) });
    }
    if (path === "/api/now") {
      const result = rightNow(db, house, new Date().getUTCHours(), minMargin(db), safeOnly(db));
      const missing = [...result.buy, ...result.sell].filter((r) => !r.icon).map((r) => r.itemId);
      if (missing.length && (await ensureIcons(iconDb, missing)) > 0) return json(res, 200, rightNow(db, house, new Date().getUTCHours(), minMargin(db), safeOnly(db)));
      return json(res, 200, result);
    }
    if (path === "/api/opportunities") {
      const kind = url.searchParams.get("kind");
      // Between-houses trades are shown in both directions whichever house is selected; an optional
      // ?direction=<buy house key> narrows them to one direction.
      const cross = kind === "cross-house";
      const direction = houseByKey(url.searchParams.get("direction"));
      const buyHouseId = cross ? (direction?.houseId ?? null) : house.houseId;
      const opts = { houseId: buyHouseId, kind: kind && kind !== "all" ? kind : null, limit: 6000, minMargin: minMargin(db), safeOnly: safeOnly(db),
        includeUnprofitable: cross && url.searchParams.get("all") === "1" };
      // Each row also gets how many are listed on the house you buy from (for stack totals).
      const listed = new Map(HOUSES.map((h) => [h.houseId, listedQuantities(db, h.houseId)]));
      const withListed = (rows: { itemId: number; buyHouseId: number }[]) =>
        rows.map((r) => ({ ...r, listedQty: listed.get(r.buyHouseId)?.get(r.itemId) ?? null }));
      const rows = listOpportunities(db, opts) as { itemId: number; buyHouseId: number; icon: string | null }[];
      const missing = rows.filter((r) => !r.icon).map((r) => r.itemId);
      if (missing.length && (await ensureIcons(iconDb, missing)) > 0)
        return json(res, 200, withListed(listOpportunities(db, opts) as { itemId: number; buyHouseId: number }[]));
      return json(res, 200, withListed(rows));
    }
    if (path === "/api/auctionator-import") {
      // Same lists (and max prices) the addon builds automatically, for pasting into Shopping > Import.
      const kind = url.searchParams.get("kind");
      // ?goods=tg | quest | other keeps only trade goods, quest items or everything else (the Opportunities toggle).
      const g = url.searchParams.get("goods");
      const goods: Goods | null = g === "tg" || g === "quest" || g === "other" ? g : null;
      const classOf = db.prepare("SELECT class_id c FROM item WHERE item_id = ?");
      const keep = (id: number) => !goods || isGoods(goods, (classOf.get(id) as { c: number | null } | undefined)?.c ?? null);
      const byGoods = (lists: ShoppingList[]) => lists.map((l) => ({ ...l, items: l.items.filter((i) => keep(i.itemId)) }));
      if (kind === "now") {
        // This hour's buys with their pay-at-most prices, and this hour's sells (no limit). Fixed names so
        // importing again next hour replaces the lists.
        const now = rightNow(db, house, new Date().getUTCHours(), minMargin(db), safeOnly(db));
        const named = (rows: { itemId: number; name: string | null }[], price: (i: number) => number | null) =>
          rows.flatMap((r, i) => (r.name ? [{ itemId: r.itemId, name: r.name, maxPrice: price(i) }] : []));
        const text = auctionatorImport(byGoods([
          { name: `AHT ${house.label} · Right now buy`, items: named(now.buy, (i) => now.buy[i]!.maxBuy) },
          { name: `AHT ${house.label} · Right now sell`, items: named(now.sell, () => null) },
        ]));
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
        return res.end(text);
      }
      // The Between houses tab also holds conversions, so its export includes the [CONV] lists.
      const titles = kind === "cross-house" ? [KIND_TITLE["cross-house"], KIND_TITLE.convert] : kind && kind !== "all" ? [KIND_TITLE[kind]] : Object.values(KIND_TITLE);
      // Between-houses lists come in both directions (one per buy house); others follow the selected house.
      const direction = houseByKey(url.searchParams.get("direction"));
      const buyHouses = kind === "cross-house" ? (direction ? [direction] : HOUSES) : [house];
      // With the toggle on: lists of only that kind of item, picked from all trades. Without it: the full
      // lists (not the [Q] quest lists the addon also gets, which would repeat items).
      const built = goods ? buildLists(db, { goods }) : buildLists(db, { goods: null }).filter((l) => !l.name.startsWith("[Q] "));
      const lists = built.filter((l) => buyHouses.some((h) => {
        const prefix = `AHT ${h.label} · `;
        const name = untagged(l.name);
        return name.startsWith(prefix) && titles.some((t) => t && name.slice(prefix.length).startsWith(t));
      }));
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(auctionatorImport(lists));
    }
    if (path === "/api/anomalies") {
      const rows = listAnomalies(db, house.houseId) as { itemId: number; icon: string | null }[];
      const missing = rows.filter((r) => !r.icon).map((r) => r.itemId);
      if (missing.length && (await ensureIcons(iconDb, missing)) > 0) return json(res, 200, listAnomalies(db, house.houseId));
      return json(res, 200, rows);
    }
    if (path === "/api/browse") {
      const q = url.searchParams;
      const optNum = (v: string | null) => (v === null || v === "" ? null : Number(v));
      const opts = {
        q: q.get("q") ?? "", sort: q.get("sort") ?? "sold", dir: q.get("dir") ?? "desc",
        page: Number(q.get("page") ?? 1), pageSize: Number(q.get("size") ?? 50),
        classId: optNum(q.get("class")), subclassId: optNum(q.get("subclass")), uncategorised: q.get("class") === "none",
      };
      let result = browseItems(db, house.houseId, opts);
      const missing = result.rows.filter((r) => !(r as { icon: string | null }).icon).map((r) => (r as { itemId: number }).itemId);
      if (missing.length && (await ensureIcons(iconDb, missing)) > 0) result = browseItems(db, house.houseId, opts);
      return json(res, 200, result);
    }

    const m = /^\/api\/item\/(\d+)(?:\/(candles|heatmap|series|stats))?$/.exec(path);
    if (m) {
      const itemId = Number(m[1]);
      if (!m[2]) {
        let detail = itemDetail(db, itemId, house.houseId);
        if (detail && !detail.icon && (await ensureIcons(iconDb, [itemId])) > 0) detail = itemDetail(db, itemId, house.houseId);
        return detail ? json(res, 200, detail) : json(res, 404, { error: "unknown item" });
      }
      if (m[2] === "stats") return json(res, 200, itemStats(db, itemId, house.houseId));
      if (m[2] === "series") {
        const key = (url.searchParams.get("range") ?? "7D") as RangeKey;
        const range = RANGES[key];
        if (!range) return json(res, 400, { error: "range must be 1D, 7D, 30D or 90D" });
        const since = now - range.seconds;
        return json(res, 200, { range: key, points: itemSeries(db, itemId, house.houseId, since), tsm: tsmSeries(db, itemId, house.houseId, since) });
      }
      if (m[2] === "candles") {
        const key = (url.searchParams.get("range") ?? "7D") as RangeKey;
        const range = RANGES[key];
        if (!range) return json(res, 400, { error: "range must be 1D, 7D, 30D or 90D" });
        return json(res, 200, { range: key, bucketSeconds: range.bucket, candles: toCandles(itemSeries(db, itemId, house.houseId, now - range.seconds), range.bucket) });
      }
      const tz = Number(url.searchParams.get("tz") ?? 0);
      const days = Number(url.searchParams.get("days") ?? 28);
      return json(res, 200, { tzOffsetMinutes: tz, days, cells: toHeatMap(itemSeries(db, itemId, house.houseId, now - days * 86400), tz) });
    }
    json(res, 404, { error: "not found" });
  } catch (err) {
    json(res, 500, { error: String(err) });
  }
};

// Loopback only, on both IPv4 and IPv6, because browsers may resolve "localhost" to either.
// Nothing listens on a network interface, so the dashboard is not reachable from other machines.
for (const host of ["127.0.0.1", "::1"]) {
  createServer(handler)
    .on("error", (err) => console.error(`could not listen on [${host}]:${port}: ${err.message}`))
    .listen(port, host, () => console.log(`AH Tracker dashboard listening on http://${host.includes(":") ? `[${host}]` : host}:${port}/`));
}
console.log(`Open http://localhost:${port}/ (database ${dbPath})`);
