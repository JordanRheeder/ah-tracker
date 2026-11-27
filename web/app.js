// AH Tracker dashboard. Prices from the API are copper per unit.
"use strict";

const $ = (sel) => document.querySelector(sel);
const tzOffset = -new Date().getTimezoneOffset(); // minutes to add to UTC for local time
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// The auction house shown everywhere; remembered between visits.
let house = "alliance";
try { house = localStorage.getItem("ah-house") || house; } catch { /* storage unavailable */ }

async function api(path) {
  const res = await fetch(`${path}${path.includes("?") ? "&" : "?"}house=${encodeURIComponent(house)}`);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

/** 1234567 copper -> "123g 45s 67c" as HTML, coloured like the game. */
function money(copper, { html = true } = {}) {
  if (copper === null || copper === undefined || !Number.isFinite(copper)) return "—";
  const sign = copper < 0 ? "−" : "";
  const c = Math.round(Math.abs(copper));
  const g = Math.floor(c / 10000), s = Math.floor((c % 10000) / 100), cu = c % 100;
  const parts = [];
  if (g) parts.push(html ? `${g.toLocaleString()}<span class="g">g</span>` : `${g.toLocaleString()}g`);
  if (s || (g && cu)) parts.push(html ? `${s}<span class="s">s</span>` : `${s}s`);
  if (cu || parts.length === 0) parts.push(html ? `${cu}<span class="c">c</span>` : `${cu}c`);
  return sign + parts.join(" ");
}
const num = (n, digits = 0) => (n === null || n === undefined ? "—" : Number(n).toLocaleString(undefined, { maximumFractionDigits: digits }));
const when = (ts) => (ts ? new Date(ts * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "never");
const ago = (ts) => {
  if (!ts) return "never";
  const m = Math.round((Date.now() / 1000 - ts) / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
};
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);

// ---------- search ----------
let searchTimer;
async function runSearch(q) {
  const rows = await api(`/api/search?q=${encodeURIComponent(q)}`);
  $("#search-hint").textContent = q ? `${rows.length} match${rows.length === 1 ? "" : "es"}` : "Busiest sellers in the latest scan";
  $("#results").innerHTML = rows.length
    ? rows.map((r) => `<li data-id="${r.itemId}"><span class="name">${esc(r.name ?? `Item ${r.itemId}`)}</span><span class="price">${money(r.price)}</span></li>`).join("")
    : `<li class="muted">No items found. Have you run a scan yet?</li>`;
  markSelected();
}
$("#search").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runSearch(e.target.value), 200);
});
$("#results").addEventListener("click", (e) => {
  const li = e.target.closest("li[data-id]");
  if (li) location.hash = `#/item/${li.dataset.id}`;
});
function markSelected() {
  document.querySelectorAll("#results li").forEach((li) => li.classList.toggle("selected", li.dataset.id === String(currentItem)));
}

// ---------- chart ----------
let chart, priceSeries, volumeSeries, marketSeries, avgSaleSeries;
function ensureChart() {
  if (chart) return;
  const LC = window.LightweightCharts;
  chart = LC.createChart($("#chart"), {
    autoSize: true,
    layout: { background: { color: "transparent" }, textColor: css("--muted"), fontFamily: "system-ui, sans-serif" },
    grid: { vertLines: { color: css("--border") }, horzLines: { color: css("--border") } },
    rightPriceScale: { borderColor: css("--border") },
    timeScale: { borderColor: css("--border"), timeVisible: true, secondsVisible: false },
    crosshair: { mode: LC.CrosshairMode.Normal },
  });
  priceSeries = chart.addSeries(LC.LineSeries, {
    color: css("--accent"), lineWidth: 1.5,
    pointMarkersVisible: true, pointMarkersRadius: 2.5,
    crosshairMarkerRadius: 5,
    priceFormat: { type: "custom", formatter: (p) => money(p, { html: false }), minMove: 1 },
  });
  volumeSeries = chart.addSeries(LC.HistogramSeries, {
    priceScaleId: "", priceFormat: { type: "volume" }, color: css("--muted") + "55",
    lastValueVisible: false, priceLineVisible: false,
  });
  const moneyFormat = { type: "custom", formatter: (p) => money(p, { html: false }), minMove: 1 };
  marketSeries = chart.addSeries(LC.LineSeries, {
    color: css("--gold"), lineWidth: 2, lineStyle: LC.LineStyle.Dashed, lineType: LC.LineType.WithSteps,
    priceLineVisible: false, crosshairMarkerVisible: false, title: "TSM market", priceFormat: moneyFormat,
  });
  avgSaleSeries = chart.addSeries(LC.LineSeries, {
    color: css("--silver"), lineWidth: 1.5, lineStyle: LC.LineStyle.Dotted, lineType: LC.LineType.WithSteps,
    priceLineVisible: false, crosshairMarkerVisible: false, title: "EU avg sale", priceFormat: moneyFormat,
  });
  volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
  priceSeries.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.22 } });
}

let currentItem = null;
let currentRange = "7D";

async function loadChart() {
  const data = await api(`/api/item/${currentItem}/series?range=${currentRange}`);
  ensureChart();
  // The chart library shows UTC; shift by the local offset so axis times read as local time.
  // Times must be unique and increasing, so a later point at the same second replaces an earlier one.
  const shift = tzOffset * 60;
  const byTime = new Map();
  for (const p of data.points) byTime.set(p.ts + shift, p);
  const points = [...byTime.entries()].sort((a, b) => a[0] - b[0]);
  priceSeries.setData(points.map(([time, p]) => ({ time, value: p.price })));
  volumeSeries.setData(points.map(([time, p]) => ({ time, value: p.quantity })));
  // TSM values change only when TSM publishes a new file: draw them as steps across the visible range.
  const firstTime = points[0]?.[0], lastTime = points.at(-1)?.[0];
  const steps = (rows) => {
    if (!rows.length || firstTime === undefined) return [];
    const out = [];
    let current = rows.filter((r) => r.ts + shift <= firstTime).at(-1) ?? rows[0];
    out.push({ time: firstTime, value: current.value });
    for (const r of rows) if (r.ts + shift > firstTime && r.ts + shift < lastTime) out.push({ time: r.ts + shift, value: r.value });
    if (lastTime > firstTime) out.push({ time: lastTime, value: rows.filter((r) => r.ts + shift <= lastTime).at(-1)?.value ?? current.value });
    return out;
  };
  marketSeries.setData(steps(data.tsm.market));
  avgSaleSeries.setData(steps(data.tsm.avgSale));
  $("#chart-legend").innerHTML = [
    `<span><i class="key price"></i>Price (cheapest listing)</span>`,
    data.tsm.market.length ? `<span><i class="key market"></i>TSM market value</span>` : `<span class="muted">TSM market value: Alliance house only</span>`,
    data.tsm.avgSale.length ? `<span><i class="key avg"></i>EU average sale price</span>` : "",
    `<span><i class="key qty"></i>Quantity listed</span>`,
  ].join("");
  // Thin the markers out on long ranges so the line stays readable.
  priceSeries.applyOptions({ pointMarkersVisible: points.length <= 400 });
  chart.timeScale().fitContent();
  $("#chart-note").textContent = `${points.length} price point(s), one per snapshot`;
  const empty = points.length === 0;
  $("#chart-empty").hidden = !empty;
  $("#chart").style.visibility = empty ? "hidden" : "visible";
  $("#chart-empty").textContent = empty ? `No scans of this item in the last ${currentRange}.` : "";
}

document.querySelectorAll(".ranges button").forEach((b) =>
  b.addEventListener("click", () => {
    currentRange = b.dataset.range;
    document.querySelectorAll(".ranges button").forEach((x) => x.classList.toggle("active", x === b));
    loadChart();
  }),
);

// ---------- heat map ----------
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
async function loadHeatmap() {
  const { cells } = await api(`/api/item/${currentItem}/heatmap?tz=${tzOffset}`);
  const up = css("--up"), down = css("--down");
  const maxAbs = Math.max(0.05, ...cells.filter((c) => c.relative !== null).map((c) => Math.abs(c.relative)));
  let html = `<div></div>${Array.from({ length: 24 }, (_, h) => `<div class="hr">${h % 3 === 0 ? h : ""}</div>`).join("")}`;
  for (let d = 0; d < 7; d++) {
    html += `<div class="lbl">${DAYS[d]}</div>`;
    for (let h = 0; h < 24; h++) {
      const c = cells.find((x) => x.weekday === d && x.hour === h);
      if (!c || c.median === null) { html += `<div class="cell" title="${DAYS[d]} ${h}:00 · no scans"></div>`; continue; }
      const strength = Math.min(1, Math.abs(c.relative) / maxAbs);
      const color = c.relative <= 0 ? up : down;
      const alpha = Math.round((0.18 + 0.82 * strength) * 255).toString(16).padStart(2, "0");
      const pct = `${c.relative > 0 ? "+" : ""}${(c.relative * 100).toFixed(1)}%`;
      html += `<div class="cell" style="background:${color}${alpha}" title="${DAYS[d]} ${h}:00 · ${money(c.median, { html: false })} (${pct} vs usual) · ${c.scans} scan(s)"></div>`;
    }
  }
  $("#heatmap").innerHTML = html;
}

// ---------- item page ----------
function vsPct(price, reference) {
  if (!price || !reference) return "—";
  const pct = (100 * (price - reference)) / reference;
  return `<span class="${pct < 0 ? "ok" : pct > 0 ? "bad" : ""}">${pct > 0 ? "+" : ""}${pct.toFixed(1)}%</span>`;
}

async function showItem(id) {
  currentItem = id;
  markSelected();
  $("#empty").hidden = true;
  $("#item").hidden = false;
  const d = await api(`/api/item/${id}`);
  $("#item-name").textContent = d.name ?? `Item ${id}`;
  setTitle(d.name ?? `Item ${id}`, houseName());
  $("#item-name").className = qClass(d.quality);
  $("#item-icon").hidden = false;
  $("#item-icon").outerHTML = iconImg(d.icon, d.quality, "icon icon-lg").replace("<img", '<img id="item-icon"');
  const kind = { "auctionator-full": "cheapest-20 price from your full scan", "auctionator-browse": "cheapest listing from your browse scan", undermine: "cheapest listing from Undermine Exchange's hourly snapshot" }[d.latestScanKind] ?? "cheapest listing";
  loadTargets().then(() => {
    if (currentItem !== id) return;
    const t = targets.get(id);
    $("#item-target").value = t ? +(t.target / 10000).toFixed(4) : "";
    $("#item-target-msg").innerHTML = t ? (t.reached ? ` <span class="ok">reached (${money(t.price)})</span>` : ` · now ${money(t.price)}`) : "";
  });
  $("#item-sub").textContent = `${d.className ? `${d.className}${d.subclassName ? ` › ${d.subclassName}` : ""} · ` : ""}Item ${id} · ${d.scans} scan(s) · last scanned ${ago(d.lastScan)} · price = ${kind}`;
  const stat = (label, value, title = "") => `<div class="stat" title="${esc(title)}"><div class="label">${label}</div><div class="value">${value}</div></div>`;
  $("#stats").innerHTML = [
    stat("Price now", money(d.price), "From your latest scan"),
    stat("Quantity listed", num(d.quantity)),
    stat("7-day low / high", `${money(d.low7d)} <span class="muted">/</span> ${money(d.high7d)}`),
    stat("Usual (7-day)", money(d.usual), "AH Tracker's usual price on this house: median of the last 7 days of hourly prices"),
    `<div class="stat" id="item-model" hidden></div>`,
    stat("Price vs usual", vsPct(d.price, d.usual), "Current price compared with the usual price. Negative = cheaper than usual."),
    stat("EU avg sale price", money(d.avgSalePrice), "TSM region data: average price items actually sold for across EU"),
    stat("Sold per day (EU)", num(d.soldPerDay, 1), "TSM region data: all of EU, not just your house"),
    stat("Sale rate (EU)", d.saleRate === null ? "—" : `${Math.round(d.saleRate * 100)}%`, "Share of listings that sell"),
  ].join("");
  // The pooled model's forecast (trade goods on PvP Alliance).
  if (house === "alliance") api(`/api/model?item=${id}`).then((m) => {
    if (currentItem !== id || !m.forecast) return;
    const el = $("#item-model");
    el.hidden = false;
    el.title = "Pooled model (EU and US PvP markets): most likely price, 80% range and chance of going up";
    el.innerHTML = `<div class="label">Model forecast</div><div class="value small-value">1 day: ${modelCell(m.forecast["1d"])}${m.forecast["3d"] ? `<br>3 days: ${modelCell(m.forecast["3d"])}` : ""}</div>`;
  }).catch(() => {});
  await Promise.all([loadChart(), loadHeatmap(), loadTradeSummary(id)]);
}

async function showHome() {
  currentItem = null;
  markSelected();
  $("#empty").hidden = false;
  $("#item").hidden = true;
  moversRows = await api("/api/movers?limit=200");
  $("#movers").innerHTML = moversRows.length
    ? `<h2 style="margin-top:20px">Biggest moves in 24 h <span class="muted small">${moversRows.length} items · click a column to sort</span></h2>
       <table class="opp-table"><thead id="movers-head"><tr><th data-key="name">Item</th><th data-key="before" class="num">24 h ago</th><th data-key="now" class="num">Now</th>
         <th data-key="changePct" class="num">Change</th><th data-key="soldPerDay" class="num">Sold/day (EU)</th></tr></thead><tbody id="movers-rows"></tbody></table>`
    : `<p class="muted">Biggest 24-hour price moves appear here once you have scans at least 12 hours apart.</p>`;
  if (!moversRows.length) return;
  sortable("#movers-head", moversSort, renderMovers);
  renderMovers();
}
let moversRows = [];
const moversSort = { key: null, dir: "desc" };
function renderMovers() {
  $("#movers-rows").innerHTML = applySort(moversRows, moversSort, "#movers-head").map((m) => `<tr data-id="${m.itemId}">
      <td>${itemCell(m)}</td><td class="num">${money(m.before)}</td><td class="num">${money(m.now)}</td>
      <td class="num ${m.changePct < 0 ? "ok" : "bad"}">${m.changePct > 0 ? "+" : ""}${m.changePct}%</td><td class="num">${num(m.soldPerDay, 1)}</td></tr>`).join("");
}
$("#movers").addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-id]");
  if (tr) location.hash = `#/item/${tr.dataset.id}`;
});

// ---------- health ----------
// Data health refreshes itself every 20 seconds while it is open.
setInterval(() => {
  if (!document.hidden && !$("#view-health").hidden) showHealth().catch(() => {});
}, 20_000);
async function showHealth() {
  const h = await api("/api/health");
  const status = (s) => (s.lastStatus === "error" ? `<span class="bad">error</span>` : s.lastStatus ? `<span class="ok">${s.lastStatus}</span>` : "—");
  const hours = Array.from({ length: 24 }, (_, i) => i);
  const covered = new Set(h.hoursCoveredUtc.map((u) => (u + Math.round(tzOffset / 60) + 24) % 24));
  $("#health").innerHTML = `
    <p class="muted">${h.scanCount} snapshot(s) stored${h.firstScan ? `, from ${when(h.firstScan)} to ${when(h.lastScan)}` : ""} · database ${(h.sizeBytes / 1e6).toFixed(1)} MB</p>
    <h2>Snapshots per house</h2>
    <table><tr><th>House</th><th>Source</th><th>Snapshots</th><th>From</th><th>To</th></tr>
      ${h.perHouse.map((p) => `<tr><td>${esc((h.houses.find((x) => x.houseId === p.houseId) || {}).label ?? p.houseId)}</td><td>${esc(p.source)}</td><td>${num(p.n)}</td><td>${when(p.first)}</td><td>${when(p.last)}</td></tr>`).join("")}
    </table>
    <h2>Sources</h2>
    <table><tr><th>Source</th><th>Last check</th><th>Status</th><th>Last success</th><th>Errors (24 h)</th><th>Detail</th></tr>
      ${h.sources.map((s) => `<tr><td>${s.source}</td><td>${ago(s.lastAttempt)}</td><td>${status(s)}</td><td>${ago(s.lastSuccess)}</td><td>${s.errors24h}</td><td class="muted">${esc(s.lastDetail ?? "")}</td></tr>`).join("")}
    </table>
    <h2>Hours of the day you have scanned yourself (local time)</h2>
    <p class="muted">Undermine Exchange already covers every hour; your own scans add detail. ${covered.size}/24 hours covered by your scans.</p>
    <div class="heatmap" style="grid-template-columns: repeat(24, 1fr); max-width: 760px">
      ${hours.map((x) => `<div class="hr">${x}</div>`).join("")}
      ${hours.map((x) => `<div class="cell" style="${covered.has(x) ? `background:${css("--accent")}` : ""}" title="${x}:00"></div>`).join("")}
    </div>
    <h2 style="margin-top:20px">Recent scans</h2>
    <table><tr><th>When</th><th>House</th><th>Type</th><th>Items</th></tr>
      ${h.scans.map((s) => `<tr><td>${when(s.ts)}</td><td>${esc((h.houses.find((x) => x.houseId === s.houseId) || {}).label ?? s.houseId)}</td><td>${{ "auctionator-full": "Your full scan (every listing)", "auctionator-browse": "Your browse scan (cheapest per item)", undermine: "Undermine Exchange hourly" }[s.source] ?? esc(s.source)}</td><td>${s.items ? num(s.items) : "backfill"}</td></tr>`).join("") || `<tr><td colspan="4" class="muted">No scans yet.</td></tr>`}
    </table>`;
}

// ---------- icons and quality ----------
const ICON_CDN = "https://wow.zamimg.com/images/wow/icons/medium/";
const qClass = (q) => (q === null || q === undefined ? "q1" : `q${q}`);
const iconImg = (icon, quality, cls = "icon") =>
  `<img class="${cls} ${qClass(quality)}" loading="lazy" alt="" src="${ICON_CDN}${encodeURIComponent(icon || "inv_misc_questionmark")}.jpg" onerror="this.onerror=null;this.src='${ICON_CDN}inv_misc_questionmark.jpg'">`;

// ---------- browse (auction-house style list of every item) ----------
const browse = { q: "", sort: "sold", dir: "desc", page: 1, cls: "", sub: "", title: "All items" };

async function loadCategories() {
  const data = await api("/api/categories");
  const classes = data.classes || [];
  const cat = (attrs, label, count, active) =>
    `<div class="cat${active ? " active" : ""}" ${attrs}><span>${esc(label)}</span><span class="count">${num(count)}</span></div>`;
  const total = classes.reduce((s, c) => s + c.items, 0) + (data.uncategorised || 0);
  let html = `<li>${cat(`data-cls="" data-sub=""`, "All items", total, browse.cls === "")}</li>`;
  for (const c of classes) {
    const open = String(c.classId) === browse.cls;
    html += `<li>${cat(`data-cls="${c.classId}" data-sub=""`, c.name, c.items, open && browse.sub === "")}`;
    if (open) html += `<ul>${c.subclasses.map((s) => `<li>${cat(`data-cls="${c.classId}" data-sub="${s.subclassId}"`, s.name, s.items, browse.sub === String(s.subclassId))}</li>`).join("")}</ul>`;
    html += `</li>`;
  }
  if (data.uncategorised) html += `<li>${cat(`data-cls="none" data-sub=""`, "Not yet categorised", data.uncategorised, browse.cls === "none")}</li>`;
  $("#cat-tree").innerHTML = html;
}
$("#cat-tree").addEventListener("click", (e) => {
  const el = e.target.closest(".cat");
  if (!el) return;
  const parent = el.dataset.sub ? el.closest("ul")?.closest("li")?.querySelector(":scope > .cat span")?.textContent : null;
  browse.cls = el.dataset.cls;
  browse.sub = el.dataset.sub;
  browse.title = parent ? `${parent} › ${el.querySelector("span").textContent}` : el.querySelector("span").textContent;
  browse.page = 1;
  setTitle(`Browse · ${browse.title}`, houseName());
  loadCategories();
  showBrowse();
});
let browseTimer;
async function showBrowse() {
  $("#browse-title").textContent = browse.title;
  const d = await api(`/api/browse?q=${encodeURIComponent(browse.q)}&sort=${browse.sort}&dir=${browse.dir}&page=${browse.page}&size=50&class=${browse.cls}&subclass=${browse.sub}`);
  const pages = Math.max(1, Math.ceil(d.total / d.pageSize || 1));
  $("#browse-meta").textContent = d.snapshotTs ? `${num(d.total)} items · snapshot ${ago(d.snapshotTs)}` : "No data for this house yet";
  $("#page-info").textContent = `Page ${d.page} of ${pages}`;
  $("#prev-page").disabled = d.page <= 1;
  $("#next-page").disabled = d.page >= pages;
  document.querySelectorAll(".browse-table th[data-sort]").forEach((th) => {
    th.classList.toggle("sorted", th.dataset.sort === browse.sort);
    th.classList.toggle("asc", th.dataset.sort === browse.sort && browse.dir === "asc");
  });
  const change = (c) => (c === null || c === undefined ? `<span class="muted">—</span>` : `<span class="${c < 0 ? "ok" : c > 0 ? "bad" : "muted"}">${c > 0 ? "+" : ""}${c}%</span>`);
  $("#browse-rows").innerHTML = d.rows.map((r) => `<tr data-id="${r.itemId}">
      <td><div class="item-cell">${iconImg(r.icon, r.quality)}<span class="nm ${qClass(r.quality)}">${esc(r.name ?? `Item ${r.itemId}`)}</span></div></td>
      <td class="num">${money(r.price)}</td>
      <td class="num">${num(r.quantity)}</td>
      <td class="num">${change(r.change24h)}</td>
      <td class="num">${money(r.usual)}</td>
      <td class="num">${num(r.soldPerDay, 1)}</td>
      <td class="num">${r.saleRate === null ? "—" : `${Math.round(r.saleRate * 100)}%`}</td>
      <td class="num">${patternCell(r.patternHeld, r.patternDays)}</td>
    </tr>`).join("") || `<tr><td colspan="8" class="muted">No items match.</td></tr>`;
}
$("#browse-rows").addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-id]");
  if (tr) location.hash = `#/item/${tr.dataset.id}`;
});
document.querySelectorAll(".browse-table th[data-sort]").forEach((th) =>
  th.addEventListener("click", () => {
    const key = th.dataset.sort;
    if (browse.sort === key) browse.dir = browse.dir === "desc" ? "asc" : "desc";
    else { browse.sort = key; browse.dir = key === "name" ? "asc" : "desc"; }
    browse.page = 1;
    showBrowse();
  }),
);
$("#browse-filter").addEventListener("input", (e) => {
  clearTimeout(browseTimer);
  browseTimer = setTimeout(() => { browse.q = e.target.value; browse.page = 1; showBrowse(); }, 200);
});
$("#prev-page").addEventListener("click", () => { browse.page--; showBrowse(); });
$("#next-page").addEventListener("click", () => { browse.page++; showBrowse(); });

// ---------- opportunities and anomalies ----------
let housesList = [];
const houseLabel = (id) => (housesList.find((h) => h.houseId === id) || {}).label || `House ${id}`;
const localHour = (utcHour) => (Number(utcHour) + Math.round(tzOffset / 60) + 24) % 24;
const hoursText = (csv) => (csv ? csv.split(",").map((h) => `${String(localHour(h)).padStart(2, "0")}:00`).join(", ") : "—");
// Same names as the Opportunities tabs and the shopping lists ("AHT <house> · <name>").
const KIND_LABEL = { "buy-now": "Buy now", "time-flip": "Time-of-day flips", "sell-now": "Sell now", "cross-house": "Between houses", convert: "Conversion" };
const NOW_KINDS = new Set(["cross-house", "convert"]); // judged on the price at the other house right now
const TAB_LABEL = { now: "Right now", all: "Best overall", ...KIND_LABEL };
const KIND_HELP = {
  now: "What to buy and what to sell during the current hour, from each item's reliable cheap and dear hours plus today's deals. Refreshes every hour.",
  all: "Every kind of trade, best first.",
  "buy-now": "Listed well under its usual price right now. Buy, then relist at the usual price.",
  "time-flip": "Reliably cheap at some hours and dear at others. Buy in the cheap hours, list for the dear hours.",
  "sell-now": "Selling well above its usual price right now. If you have some, list it now.",
  "cross-house": "Also essence conversions (3 Lesser = 1 Greater: buy one, combine or split, sell the other), on one house or across. Between houses: cheaper on one auction house than the other house sells it for right now (Sell (N), your latest scan of that house in the last 6 hours), in both directions. Only trades that make your minimum margin if sold straight away are listed. Scan the house you will sell on first. Buy, carry it over yourself, sell. Neutral is a thin market: bring small batches.",
};
function doThis(o) {
  if (o.kind === "convert") {
    const verb = o.convertIn > o.convertOut ? "combine" : "split";
    return `Buy ${o.convertIn} on ${esc(houseLabel(o.buyHouseId))}, ${verb} into ${o.convertOut} ${esc(o.sellName ?? "")}, sell on ${esc(houseLabel(o.sellHouseId))}`;
  }
  if (o.kind === "buy-now") return `Buy now, relist near ${money(o.sellPrice)}`;
  if (o.kind === "time-flip") return `Buy around ${hoursText(o.buyHours)}, sell around ${hoursText(o.sellHours)}`;
  if (o.kind === "sell-now") return `Sell your stock now`;
  if (o.kind === "cross-house") return `Buy on ${esc(houseLabel(o.buyHouseId))} → sell on ${esc(houseLabel(o.sellHouseId))}`;
  return "";
}
/** "7/10 days": on how many days the item was cheapest and dearest at its usual hours. */
const patternCell = (held, days) =>
  !days ? `<span class="muted">—</span>` : `<span class="${held >= 0.75 ? "ok" : held < 0.5 ? "muted" : ""}">${Math.round(held * days)}/${days} days</span>`;
const conf = (c) => `<span class="conf" title="${Math.round(c * 100)}%"><i style="width:${Math.round(c * 100)}%"></i></span>`;
const itemCell = (r) => `<div class="item-cell">${iconImg(r.icon, r.quality)}<span class="nm ${qClass(r.quality)}">${esc(r.name ?? `Item ${r.itemId}`)}</span></div>`;

// Click-to-sort for tables whose rows are already loaded: click a header to sort, again to reverse.
// With no column chosen, rows keep the server's ranking.
function sortable(headSel, state, render) {
  $(headSel).addEventListener("click", (e) => {
    const th = e.target.closest("th[data-key]");
    if (!th) return;
    const key = th.dataset.key;
    if (state.key === key) state.dir = state.dir === "desc" ? "asc" : "desc";
    else { state.key = key; state.dir = key === "name" || key === "kind" ? "asc" : "desc"; }
    render();
  });
}
function applySort(rows, state, headSel) {
  document.querySelectorAll(`${headSel} th[data-key]`).forEach((th) => {
    th.classList.toggle("sorted", th.dataset.key === state.key);
    th.classList.toggle("asc", th.dataset.key === state.key && state.dir === "asc");
  });
  if (!state.key) return rows;
  const k = state.key, sign = state.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = a[k] ?? null, y = b[k] ?? null;
    if (x === y) return 0;
    if (x === null) return 1; // blanks last either way
    if (y === null) return -1;
    return (typeof x === "string" ? x.localeCompare(y) : x - y) * sign;
  });
}

let oppKind = "all";
let oppAll = []; // this tab's rows before the route and item filters
// "" all items, "tg" trade goods only, "other" everything else. Applies to every tab and the exports. Remembered.
let oppGoods = "";
try { oppGoods = localStorage.getItem("ah-opp-goods") || ""; } catch { /* storage unavailable */ }
const TRADE_GOODS = 7, QUEST = 12;
const goodsOk = (r) => !oppGoods
  || (oppGoods === "tg" ? r.classId === TRADE_GOODS : oppGoods === "quest" ? r.classId === QUEST : r.classId !== TRADE_GOODS && r.classId !== QUEST);
// Minimum profit per unit, in copper (0 = off). Lists: Profit / unit; Right now: profit at today's
// price (buys) or gain over the usual price (sells). Remembered.
// Between houses: also show trades that do not make the margin now (the full price comparison). Remembered.
let oppIncludeAll = false;
try { oppIncludeAll = localStorage.getItem("ah-opp-all") === "1"; } catch { /* storage unavailable */ }
// null = off; 0 hides anything that loses money. Between houses uses Profit (N) (selling straight away).
let oppMinProfit = null;
try { const v = localStorage.getItem("ah-opp-min-profit"); oppMinProfit = v === null || v === "" ? null : Number(v); } catch { /* storage unavailable */ }
// Units you would buy and carry, for the Total column. Remembered.
let oppUnits = 20;
try { oppUnits = Number(localStorage.getItem("ah-opp-units")) || 20; } catch { /* storage unavailable */ }
const profitOf = (r) => (NOW_KINDS.has(r.kind) ? r.profitNow : r.profitAtCurrent ?? r.profitVsUsual ?? r.profit);
const profitOk = (r) => oppMinProfit === null || (profitOf(r) ?? -Infinity) >= oppMinProfit;
const oppOk = (r) => goodsOk(r) && profitOk(r);
let oppRows = [];
// Trade routes switched off on the Opportunities page, as "<buy house key>><sell house key>"
// ("alliance>neutral" = buy on Alliance, sell on Neutral). Remembered between visits.
let routesOff = new Set();
try { routesOff = new Set(JSON.parse(localStorage.getItem("ah-routes-off") || "[]")); } catch { /* storage unavailable */ }
const houseKeyOf = (id) => (housesList.find((h) => h.houseId === id) || {}).key;
/** Routes a tab can contain: Best overall has the selected house's own trades plus its Between-houses trades. */
function tabRoutes(kind) {
  const self = housesList.find((h) => h.key === house);
  if (kind === "cross-house") return housesList.flatMap((b) => housesList.filter((s) => s !== b).map((s) => [b, s]));
  if (kind === "all" && self) return [[self, self], ...housesList.filter((s) => s !== self).map((s) => [self, s])];
  return []; // Right now, Buy now, Time-of-day flips and Sell now only hold trades within the selected house
}
const routeFiltered = (kind) => tabRoutes(kind).length > 1;
// Between houses: the direction you carry, saved on the server (it also decides the in-game lists).
// 0 both, 1 only Neutral -> Alliance, 2 only Alliance -> Neutral.
let crossDir = 0;
const routeOn = (buyKey, sellKey) => {
  if (oppKind === "cross-house" && crossDir !== 0)
    return crossDir === 1 ? buyKey === "neutral" && sellKey === "alliance" : buyKey === "alliance" && sellKey === "neutral";
  return !routesOff.has(`${buyKey}>${sellKey}`);
};
const dirFromRoutes = () => {
  const an = !routesOff.has("alliance>neutral"), na = !routesOff.has("neutral>alliance");
  return an && !na ? 2 : na && !an ? 1 : 0;
};
const routesFromDir = (d) => {
  routesOff.delete("alliance>neutral"); routesOff.delete("neutral>alliance");
  if (d === 1) routesOff.add("alliance>neutral");
  if (d === 2) routesOff.add("neutral>alliance");
};
function renderRoutes() {
  const routes = tabRoutes(oppKind);
  $("#opp-direction").hidden = routes.length < 2;
  $("#opp-routes").innerHTML = routes.map(([b, s]) => {
    const k = `${b.key}>${s.key}`;
    const name = b === s ? `Within ${b.label}` : `Buy ${b.label} → sell ${s.label}`;
    return `<label class="route"><input type="checkbox" data-route="${esc(k)}"${routesOff.has(k) ? "" : " checked"}> ${esc(name)}</label>`;
  }).join("");
}
function applyRoutes() {
  // Between houses trades and conversions only in the direction you carry, on every tab.
  const dirOk = (o) => !NOW_KINDS.has(o.kind) || crossDir === 0 || (crossDir === 1
    ? houseKeyOf(o.buyHouseId) === "neutral" && houseKeyOf(o.sellHouseId) === "alliance"
    : houseKeyOf(o.buyHouseId) === "alliance" && houseKeyOf(o.sellHouseId) === "neutral");
  oppRows = (routeFiltered(oppKind) ? oppAll.filter((o) => routeOn(houseKeyOf(o.buyHouseId), houseKeyOf(o.sellHouseId))) : oppAll).filter(dirOk).filter(oppOk)
    .map((o) => {
      // Total for the units you would carry, capped at what is listed on the buy house.
      // Conversions count in conversions: each needs convertIn units of what you buy.
      const perConv = o.kind === "convert" ? o.convertIn : 1;
      const units = o.listedQty == null ? oppUnits : Math.min(oppUnits, Math.floor(o.listedQty / perConv));
      const perUnit = NOW_KINDS.has(o.kind) ? o.profitNow : o.profit;
      return { ...o, totalUnits: units, total: perUnit == null ? null : perUnit * units };
    });
  $("#opp-total-head").textContent = `Total (×${oppUnits})`;
  renderOpportunities();
}
const oppSort = { key: null, dir: "desc" };
async function showOpportunities() {
  $("#opp-kind-help").textContent = KIND_HELP[oppKind];
  document.querySelectorAll("#opp-goods button").forEach((b) => b.classList.toggle("active", b.dataset.goods === oppGoods));
  if (document.activeElement !== $("#opp-units")) $("#opp-units").value = oppUnits;
  if (document.activeElement !== $("#min-profit")) $("#min-profit").value = oppMinProfit === null ? "" : oppMinProfit / 10000;
  document.querySelectorAll("#opp-tabs button").forEach((b) => b.classList.toggle("active", b.dataset.kind === oppKind));
  loadMargin();
  const now = oppKind === "now";
  $("#now-view").hidden = !now;
  if (now) { $("#opp-direction").hidden = true; $("#opp-count").textContent = ""; }
  $("#opp-table").hidden = now;
  if (now) return showNow();
  renderRoutes();
  $("#opp-all").checked = oppIncludeAll;
  $("#opp-all-wrap").hidden = oppKind !== "cross-house";
  oppAll = await api(`/api/opportunities?kind=${oppKind}${oppKind === "cross-house" && oppIncludeAll ? "&all=1" : ""}`);
  applyRoutes();
}

// ---------- minimum margin (one setting for opportunities, shopping lists and exports) ----------
async function loadMargin() {
  const s = await api("/api/settings");
  if (document.activeElement !== $("#min-margin")) $("#min-margin").value = Math.round(s.minMargin * 100);
  $("#safe-only").checked = s.safeOnly;
  if ((s.crossDirection ?? 0) !== crossDir) {
    crossDir = s.crossDirection ?? 0;
    routesFromDir(crossDir);
    renderRoutes();
    if (oppKind !== "now") applyRoutes();
  }
  // The item toggle is kept on the server too: it decides the in-game Between houses lists.
  if ((s.goods ?? "") !== oppGoods) {
    oppGoods = s.goods ?? "";
    try { localStorage.setItem("ah-opp-goods", oppGoods); } catch { /* storage unavailable */ }
    document.querySelectorAll("#opp-goods button").forEach((x) => x.classList.toggle("active", x.dataset.goods === oppGoods));
    if (oppKind === "now") renderNow(); else applyRoutes();
  }
}
$("#safe-only").addEventListener("change", async (e) => {
  const res = await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ safeOnly: e.target.checked }) });
  const out = await res.json();
  $("#margin-msg").textContent = res.ok ? `${out.safeOnly ? "Safer trades only" : "All trades"} · shopping lists updated, /reload in game` : out.error;
  showOpportunities();
});
$("#min-margin").addEventListener("change", async (e) => {
  const pct = Number(e.target.value);
  if (!Number.isFinite(pct) || pct < 5 || pct > 200) { $("#margin-msg").textContent = "Use 5–200%: nothing is suggested under 5%"; return; }
  const res = await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ minMargin: pct / 100 }) });
  const out = await res.json();
  $("#margin-msg").textContent = res.ok ? (out.listsRewritten ? "Saved · shopping lists updated, /reload in game" : "Saved") : out.error;
  showOpportunities();
});

// ---------- right now: what to buy and sell at the current hour ----------
let nowData = { buy: [], sell: [] };
const nowBuySort = { key: null, dir: "desc" };
const nowSellSort = { key: null, dir: "desc" };
async function showNow() {
  nowData = await api("/api/now");
  renderNow();
}
function renderNow() {
  const d = { ...nowData, buy: nowData.buy.filter(oppOk), sell: nowData.sell.filter(oppOk) };
  const localNow = `${String(localHour(d.utcHour)).padStart(2, "0")}:00–${String((localHour(d.utcHour) + 1) % 24).padStart(2, "0")}:00`;
  $("#now-title").textContent = `This hour (${localNow} your time) · minimum margin ${Math.round(d.minMargin * 100)}%${d.safeOnly ? " · safer trades only: limits assume a weak sale" : ""}`;
  const why = (r, side) => r.reason === "time-flip"
    ? `<span class="badge time-flip">${side === "buy" ? "Cheap hour" : "Dear hour"}</span>`
    : `<span class="badge ${r.reason}">${KIND_LABEL[r.reason]}</span>`;
  $("#now-buy").innerHTML = applySort(d.buy, nowBuySort, "#now-buy-head").map((r) => `<tr data-id="${r.itemId}">
      <td>${itemCell(r)}</td>
      <td>${why(r, "buy")}${r.underMax ? `<span class="tag-ok">Buy</span>` : `<span class="tag-wait">Above your limit, wait</span>`}</td>
      <td class="num">${money(r.current)}</td>
      <td class="num">${money(r.maxBuy)}</td>
      <td class="num">${money(r.sellTarget)}</td>
      <td class="num ${r.profitAtCurrent > 0 ? "ok" : "bad"}">${money(Math.abs(r.profitAtCurrent))}${r.profitAtCurrent < 0 ? " loss" : ""} <span class="muted">(${Math.round(r.marginAtCurrent * 100)}%)</span></td>
      <td class="num">${patternCell(r.patternHeld, r.patternDays)}</td>
      <td>${r.reason === "time-flip" ? hoursText(r.sellHours) : "Any time, at the usual price"}</td>
    </tr>`).join("") || `<tr><td colspan="8" class="muted">Nothing is in its cheap hours right now with at least a ${Math.round(d.minMargin * 100)}% margin. Check back next hour.</td></tr>`;
  $("#now-sell").innerHTML = applySort(d.sell, nowSellSort, "#now-sell-head").map((r) => `<tr data-id="${r.itemId}">
      <td>${itemCell(r)}</td>
      <td>${why(r, "sell")}</td>
      <td class="num">${money(r.listAt)}</td>
      <td class="num">${money(r.usual)}</td>
      <td class="num ${r.vsUsual > 0 ? "ok" : "bad"}">${r.vsUsual > 0 ? "+" : ""}${(r.vsUsual * 100).toFixed(0)}%</td>
      <td class="num ok">${money(Math.max(0, r.profitVsUsual))}</td>
      <td class="num">${patternCell(r.patternHeld, r.patternDays)}</td>
      <td>${r.reason === "time-flip" ? hoursText(r.buyHours) : "When it is back near usual"}</td>
    </tr>`).join("") || `<tr><td colspan="8" class="muted">Nothing is in its dear hours right now. Check back next hour.</td></tr>`;
}
sortable("#now-buy-head", nowBuySort, renderNow);
sortable("#now-sell-head", nowSellSort, renderNow);
for (const tbody of ["#now-buy", "#now-sell"])
  $(tbody).addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-id]");
    if (tr) location.hash = `#/item/${tr.dataset.id}`;
  });
function renderOpportunities() {
  const rows = applySort(oppRows, oppSort, "#opp-head");
  const hidden = oppAll.length - rows.length;
  // What is filtering rows out, and a button that clears it all.
  const active = [oppGoods && `items: ${{ tg: "trade goods", quest: "quest items", other: "other items" }[oppGoods]}`,
    oppMinProfit !== null && `profit / unit ≥ ${money(oppMinProfit, { html: false })}`,
    routeFiltered(oppKind) && routesOff.size && "route checkboxes"].filter(Boolean);
  $("#opp-count").innerHTML = `${num(rows.length)} trade${rows.length === 1 ? "" : "s"}`
    + (hidden > 0 ? ` · ${num(hidden)} hidden by your filters (${esc(active.join(", ") || "filters")}) <button class="btn small" id="opp-show-all">Show all</button>` : "");
  const minM = Number($("#min-margin").value) / 100 || 0.1;
  const pl = (v) => `<span class="${v >= 0 ? "ok" : "bad"}">${money(Math.abs(v))}${v < 0 ? " loss" : ""}</span>`;
  $("#opp-rows").innerHTML = rows.map((o) => `<tr data-id="${o.itemId}">
      <td>${itemCell(o)}</td>
      <td class="do-cell"><div class="do-tags"><span class="badge ${o.kind}">${KIND_LABEL[o.kind]}</span>${o.marginNow != null && o.marginNow >= minM ? `<span class="badge flip" title="Pays at least your minimum margin at the other house's price right now">Flip now</span>` : ""}</div><span class="do">${doThis(o)}</span>${NOW_KINDS.has(o.kind) ? "" : `<div class="why">${esc(o.why)}</div>`}</td>
      <td class="num">${money(o.buyPrice)}${o.kind === "convert" ? `<div class="why">total ${o.convertIn} × ${money(o.buyPrice)} = <b>${money(o.buyPrice * o.convertIn)}</b></div>` : ""}</td>
      <td class="num">${o.listedQty == null ? `<span class="muted">—</span>` : num(o.listedQty)}</td>
      <td class="num">${o.sellNow == null ? `<span class="muted">—</span>` : `${money(o.sellNow)}<div class="why">${ago(o.sellNowTs)}</div>`}</td>
      <td class="num">${money(o.sellPrice)}</td>
      <td class="num">${pl(o.profit)}</td>
      <td class="num">${o.profitNow == null ? `<span class="muted">—</span>` : pl(o.profitNow)}</td>
      <td class="num">${o.total == null ? `<span class="muted">—</span>` : `${pl(o.total)}${o.totalUnits < oppUnits ? `<div class="why">only ${num(o.totalUnits)} listed</div>` : ""}`}</td>
      <td class="num">${Math.round(o.margin * 100)}%</td>
      <td class="num">${o.marginNow == null ? `<span class="muted">—</span>` : `<span class="${o.marginNow >= minM ? "ok" : o.marginNow < 0 ? "bad" : ""}">${Math.round(o.marginNow * 100)}%</span>`}</td>
      <td class="num ${o.safeProfit > 0 ? "ok" : "bad"}">${o.safeProfit === null ? "—" : `${money(Math.abs(o.safeProfit))}${o.safeProfit < 0 ? " loss" : ""} <span class="muted">(${Math.round(o.safeMargin * 100)}%)</span>`}</td>
      <td class="num">${num(o.soldPerDay, 0)}</td>
      <td class="num">${patternCell(o.patternHeld, o.patternDays)}</td>
      <td>${conf(o.confidence)}</td>
    </tr>`).join("") || `<tr><td colspan="15" class="muted">${oppKind === "cross-house" ? "Nothing pays at the other house's current price. Scan the house you would sell on (Auctionator full or browse scan), then click Sync now. " : ""}Nothing qualifies right now on this house. Statistics need at least 3 days of hourly prices; the backfill and hourly updates keep adding them.</td></tr>`;
}
$("#opp-all").addEventListener("change", (e) => {
  oppIncludeAll = e.target.checked;
  try { localStorage.setItem("ah-opp-all", oppIncludeAll ? "1" : "0"); } catch { /* storage unavailable */ }
  showOpportunities();
});
$("#opp-count").addEventListener("click", (e) => {
  if (e.target.id !== "opp-show-all") return;
  oppMinProfit = null;
  routesOff.clear();
  crossDir = 0;
  fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ crossDirection: 0 }) }).catch(() => {});
  try { localStorage.setItem("ah-opp-min-profit", ""); localStorage.setItem("ah-routes-off", "[]"); } catch { /* storage unavailable */ }
  $("#min-profit").value = "";
  document.querySelector('#opp-goods [data-goods=""]').click(); // all items (also rewrites the in-game lists)
  renderRoutes();
  if (oppKind === "now") renderNow(); else applyRoutes();
});
$("#opp-units").addEventListener("change", (e) => {
  const n = Math.floor(Number(e.target.value));
  if (!Number.isFinite(n) || n < 1) return;
  oppUnits = n;
  try { localStorage.setItem("ah-opp-units", String(n)); } catch { /* storage unavailable */ }
  if (oppKind !== "now") applyRoutes();
});
$("#min-profit").addEventListener("change", (e) => {
  const raw = e.target.value.trim();
  const g = Number(raw);
  if (raw !== "" && !Number.isFinite(g)) return;
  oppMinProfit = raw === "" ? null : Math.round(g * 10000);
  try { localStorage.setItem("ah-opp-min-profit", oppMinProfit === null ? "" : String(oppMinProfit)); } catch { /* storage unavailable */ }
  if (oppKind === "now") renderNow(); else applyRoutes();
});
$("#opp-goods").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-goods]");
  if (!b) return;
  oppGoods = b.dataset.goods;
  try { localStorage.setItem("ah-opp-goods", oppGoods); } catch { /* storage unavailable */ }
  // Rewrites the addon's Between houses lists for this choice ([TG], [Q], [BOE] or all items).
  fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ goods: oppGoods || null }) })
    .then((r) => r.json())
    .then((out) => { $("#margin-msg").textContent = out.listsRewritten ? `In-game Between houses lists: ${{ tg: "trade goods", quest: "quest items", other: "other items" }[oppGoods] ?? "all items"} · /reload in game` : ""; })
    .catch(() => {});
  document.querySelectorAll("#opp-goods button").forEach((x) => x.classList.toggle("active", x.dataset.goods === oppGoods));
  if (oppKind === "now") renderNow(); else applyRoutes();
});
$("#opp-direction").addEventListener("change", (e) => {
  const k = e.target.dataset.route;
  if (!k) return;
  if (e.target.checked) routesOff.delete(k); else routesOff.add(k);
  try { localStorage.setItem("ah-routes-off", JSON.stringify([...routesOff])); } catch { /* storage unavailable */ }
  // Between houses directions are saved on the server too: they decide the in-game lists.
  if (oppKind === "cross-house" && (k === "alliance>neutral" || k === "neutral>alliance")) {
    crossDir = dirFromRoutes();
    fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ crossDirection: crossDir }) })
      .then((r) => r.json()).then((out) => {
        $("#margin-msg").textContent = out.listsRewritten ? `In-game Between houses lists: ${["both directions", "Neutral → Alliance only", "Alliance → Neutral only"][crossDir]} · /reload in game` : "";
      }).catch(() => {});
  }
  applyRoutes();
});
$("#opp-tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-kind]");
  if (!b) return;
  oppKind = b.dataset.kind;
  // Between houses shows both directions, so it is not about the selected house.
  setTitle(`Opportunities · ${TAB_LABEL[oppKind]}`, oppKind === "cross-house" ? "" : houseName());
  showOpportunities();
});
for (const tbody of ["#opp-rows", "#anom-rows"])
  $(tbody).addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-id]");
    if (tr) location.hash = `#/item/${tr.dataset.id}`;
  });

sortable("#opp-head", oppSort, renderOpportunities);

/**
 * TSM group import string: unique item ids as "i:<id>" joined by commas, in the order shown
 * (current tab and sort). Paste it into TSM's group Import; TSM's operations then decide prices.
 */
function tsmItemList(rows, limit) {
  const ids = [];
  for (const r of rows) if (!ids.includes(r.itemId)) ids.push(r.itemId);
  return (limit > 0 ? ids.slice(0, limit) : ids).map((id) => `i:${id}`).join(",");
}
// Same lists and max prices the addon builds automatically, as text for Auctionator's Shopping > Import.
$("#export-auctionator").addEventListener("click", async () => {
  const res = await fetch(`/api/auctionator-import?house=${encodeURIComponent(house)}&kind=${oppKind}${oppGoods ? `&goods=${oppGoods}` : ""}`);
  const all = (await res.text()).trim();
  // Drop the lists for routes switched off ("AHT <buy> · <name>" or "AHT <buy> · Between houses > <sell>").
  const lines = (all ? all.split("\n") : []).filter((line) => {
    if (!routeFiltered(oppKind)) return true;
    const name = line.split("^")[0].replace(/^\[\w+\] /, "");
    const buy = housesList.find((h) => name.startsWith(`AHT ${h.label} · `));
    if (!buy) return true;
    const rest = name.slice(`AHT ${buy.label} · `.length);
    const sell = rest.startsWith("Between houses > ") ? housesList.find((h) => rest === `Between houses > ${h.label}`) : buy;
    return !sell || routeOn(buy.key, sell.key);
  });
  // With a profit filter on, keep only the items shown on screen.
  const shown = oppMinProfit !== null ? new Set((oppKind === "now" ? [...nowData.buy, ...nowData.sell].filter(oppOk) : oppRows).map((r) => r.name)) : null;
  const text = lines.map((line) => {
    if (!shown) return line;
    const [name, ...searches] = line.split("^");
    const kept = searches.filter((s) => shown.has(s.match(/^"(.*?)";/)?.[1]));
    return kept.length ? [name, ...kept].join("^") : null;
  }).filter(Boolean).join("\n");
  if (!text) { $("#export-msg").textContent = "No list has items for this tab and house yet."; return; }
  const items = text.split("\n").reduce((n, l) => n + l.split("^").length - 1, 0);
  try {
    await navigator.clipboard.writeText(text);
    $("#export-msg").textContent = `Copied ${text.split("\n").length} list(s), ${items} items with max prices. In Auctionator: Shopping → Import → paste → OK.`;
  } catch {
    window.prompt(`Copy this, then in Auctionator: Shopping → Import → paste:`, text);
  }
});
$("#export-tsm").addEventListener("click", async () => {
  const limit = Number($("#export-count").value);
  const rows = oppKind === "now"
    ? [...applySort(nowData.buy.filter(oppOk), nowBuySort, "#now-buy-head"), ...applySort(nowData.sell.filter(oppOk), nowSellSort, "#now-sell-head")]
    : applySort(oppRows, oppSort, "#opp-head");
  const list = tsmItemList(rows, limit);
  const n = list ? list.split(",").length : 0;
  if (!n) { $("#export-msg").textContent = "Nothing to export on this tab."; return; }
  try {
    await navigator.clipboard.writeText(list);
    $("#export-msg").textContent = `Copied ${n} items. In TSM: Groups → pick or create a group → Import → paste.`;
  } catch {
    // Clipboard blocked: show the text so it can be copied by hand.
    window.prompt(`Copy these ${n} items, then paste into TSM's group Import:`, list);
  }
});

const ANOM_LABEL = { "price-spike": "Price spike", "price-crash": "Price crash", buyout: "Bought out", "new-normal": "New price level" };
let anomRows = [];
const anomSort = { key: null, dir: "desc" };
async function showAnomalies() {
  anomRows = await api("/api/anomalies");
  renderAnomalies();
}
function renderAnomalies() {
  const rows = applySort(anomRows, anomSort, "#anom-head");
  $("#anom-rows").innerHTML = rows.map((a) => `<tr data-id="${a.itemId}">
      <td>${itemCell(a)}</td>
      <td><span class="badge ${a.kind}">${ANOM_LABEL[a.kind] ?? a.kind}</span><div class="why">${esc(a.detail)}</div></td>
      <td class="num">${money(a.current)}</td>
      <td class="num">${money(a.median)}</td>
      <td>${ago(a.firstSeen)}</td>
      <td class="num">${num(a.soldPerDay, 0)}</td>
    </tr>`).join("") || `<tr><td colspan="6" class="muted">No open anomalies on this house.</td></tr>`;
}
sortable("#anom-head", anomSort, renderAnomalies);

async function loadTradeSummary(id) {
  const t = await api(`/api/item/${id}/stats`);
  const card = $("#trade-card");
  if (!t.stats) { card.hidden = true; return; }
  card.hidden = false;
  const s = t.stats;
  $("#trade-note").textContent = `last ${s.days} days, ${s.points} hourly prices`;
  const vsUsual = (s.current - s.median) / s.median;
  const box = (label, value) => `<div><div class="label">${label}</div><div class="value">${value}</div></div>`;
  $("#trade").innerHTML = [
    box("Usual price (median)", money(s.median)),
    box("Now vs usual", `<span class="${vsUsual < 0 ? "ok" : vsUsual > 0 ? "bad" : ""}">${vsUsual > 0 ? "+" : ""}${(vsUsual * 100).toFixed(1)}%</span>`),
    box("Cheapest hours (local)", `${hoursText(s.buyHours)} <span class="muted" style="font-weight:400">~${money(s.buyPrice)}</span>`),
    box("Dearest hours (local)", `${hoursText(s.sellHours)} <span class="muted" style="font-weight:400">~${money(s.sellPrice)}</span>`),
    box("Daily pattern held", `${Math.round(s.consistency * s.patternDays)} of ${s.patternDays} days`),
    `<div class="trade-opps">${t.opportunities.map((o) => `<div><span class="badge ${o.kind}">${KIND_LABEL[o.kind]}</span>${esc(o.why)} <b class="ok">${money(o.profit)}</b>/unit (${Math.round(o.margin * 100)}%)</div>`).join("")}
      ${t.anomalies.map((a) => `<div><span class="badge ${a.kind}">${ANOM_LABEL[a.kind] ?? a.kind}</span>${esc(a.detail)}</div>`).join("")}
      ${!t.opportunities.length && !t.anomalies.length ? `<div class="muted">No trade signal for this item right now.</div>` : ""}</div>`,
  ].join("");
}

// ---------- notifications: alerts on the dashboard ----------
let notifLatest = null; // newest id seen, so new ones pop up
async function pollNotifications(toast = true) {
  const d = await fetch("/api/notifications").then((r) => r.json());
  $("#notif-badge").hidden = !d.unread;
  $("#notif-badge").textContent = d.unread;
  if (notifLatest !== null && toast) for (const n of d.items.filter((x) => x.id > notifLatest).reverse()) showToast(n);
  notifLatest = d.latest;
  return d;
}
function showToast(n) {
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = `<b>${esc(n.title)}</b><div>${esc(n.body).replace(/\n/g, "<br>")}</div>`;
  el.addEventListener("click", () => { el.remove(); location.hash = n.href ?? (n.itemId ? `#/item/${n.itemId}` : "#/notifications"); });
  $("#toasts").appendChild(el);
  setTimeout(() => el.remove(), 20000);
}
async function showNotifications() {
  const d = await pollNotifications(false);
  $("#notif-desktop").checked = d.desktop;
  $("#notif-list").innerHTML = d.items.map((n) => `<div class="notif${n.read ? "" : " unread"}" data-id="${n.id}" data-item="${n.itemId ?? ""}">
      <div class="notif-head">${n.itemId ? iconImg(n.icon, n.quality) : ""}<b>${esc(n.title)}</b>
        <span class="badge ${n.kind === "target" ? "flip" : "cross-house"}">${n.kind === "target" ? "Price target" : "Sell now"}</span>
        <span class="muted small">${new Date(n.ts * 1000).toLocaleString()} · ${ago(n.ts)}</span>
        ${n.read ? "" : `<button class="btn small" data-read="${n.id}">Mark read</button>`}</div>
      <div class="notif-body">${esc(n.body).replace(/\n/g, "<br>")}</div>
    </div>`).join("") || `<p class="muted">No notifications yet. Set price targets on the Inventory page; sell-now alerts come for items you bought once they make your margin.</p>`;
}
const postNotif = (body) => fetch("/api/notifications", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
$("#notif-list").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-read]");
  if (b) { await postNotif({ read: Number(b.dataset.read) }); return showNotifications(); }
  const card = e.target.closest(".notif[data-id]");
  if (card?.dataset.item) { await postNotif({ read: Number(card.dataset.id) }); location.hash = `#/item/${card.dataset.item}`; }
});
$("#notif-read-all").addEventListener("click", async () => { await postNotif({ read: "all" }); showNotifications(); });
$("#notif-clear").addEventListener("click", async () => { await postNotif({ clear: true }); showNotifications(); });
$("#notif-desktop").addEventListener("change", (e) => postNotif({ desktop: e.target.checked }));
pollNotifications(false).catch(() => {});
setInterval(() => { if (!document.hidden) pollNotifications().catch(() => {}); }, 20_000);

// ---------- overview: income, costs and profit from TSM's ledger, gold per character ----------
let ovDays = 7;
try { ovDays = Number(localStorage.getItem("ah-ov-days") ?? 7); } catch { /* storage unavailable */ }
let goldChart = null;
async function showOverview() {
  document.querySelectorAll("#ov-period button").forEach((b) => b.classList.toggle("active", Number(b.dataset.days) === ovDays));
  const d = await api(`/api/overview?days=${ovDays}&tz=${tzOffset}`);
  const signed = (v) => (v == null ? "—" : `<span class="${v >= 0 ? "ok" : "bad"}">${v < 0 ? "−" : ""}${money(Math.abs(v))}</span>`);
  const box = (label, value, title = "") => `<div class="stat"${title ? ` title="${esc(title)}"` : ""}><div class="label">${label}</div><div class="value">${value}</div></div>`;
  const cutPct = Math.round(d.period.cut * 100);
  $("#ov-note").textContent = `From TSM's ledger for all your characters${d.lastLedger ? `, last entry ${ago(d.lastLedger)}` : ""}. TSM updates it when you log out or /reload. `
    + `The AH cut is estimated at ${cutPct}% because TSM does not record which auction house a sale was on (Neutral takes 15%). Money sent between your own characters is not counted.`;
  $("#ov-stats").innerHTML = [
    box("Gold on hand", money(d.goldTotal), "All characters, from TSM"),
    box("Trading profit", signed(d.trading.netProfit), "Sales of items you bought, after the AH cut, minus what they cost, postage and lost deposits"),
    box("Money in", money(d.totalIncome)),
    box("Money out", money(d.totalCosts)),
    box("Net cash", signed(d.net), "Money in minus money out. Stock you bought and still hold counts as money out until you sell it"),
    box("Stock still held (at cost)", `${money(d.stock.cost)} <span class="muted small">${num(d.stock.units)} units</span>`, "Units you bought on the AH and have not sold yet: bags, bank, mail or listed"),
  ].join("");
  const line = (label, v, note = "", cls = "") => `<tr class="${cls}"><td>${label}${note ? ` <span class="muted small">${note}</span>` : ""}</td><td class="num">${v}</td></tr>`;
  const t = d.trading;
  $("#ov-trading").innerHTML = [
    line("Sold", money(t.revenue), `${num(t.unitsSold)} units, after AH cut`),
    line("What they cost", `−${money(t.cost)}`),
    line("Gross profit", signed(t.grossProfit), t.cost ? `${Math.round((t.grossProfit / t.cost) * 100)}% margin` : "", "sub"),
    line("Postage", `−${money(d.costs.postage)}`, `${d.counts.postage} mail${d.counts.postage === 1 ? "" : "s"} (moving items to your bank alt)`),
    line("Deposits lost", `−${money(d.costs.lostDeposits)}`, `${d.counts.expired} expired listing${d.counts.expired === 1 ? "" : "s"}${d.counts.expiredWithoutDeposit ? `, ${d.counts.expiredWithoutDeposit} with unknown deposit` : ""}`),
    line("Trading profit", signed(t.netProfit), "", "total"),
    line("Sales of farmed or looted items", money(t.farmedSales), "after AH cut, not part of trading"),
  ].join("");
  $("#ov-income").innerHTML = [
    line("Auction sales", money(d.income.auctionSales), "full price"),
    line("Vendor sales", money(d.income.vendorSales)),
    d.income.otherSales ? line("Other sales", money(d.income.otherSales)) : "",
    d.income.other ? line("Other income", money(d.income.other)) : "",
    line("Total", money(d.totalIncome), "", "total"),
  ].join("");
  $("#ov-costs").innerHTML = [
    line("Auction purchases", money(d.costs.auctionBuys)),
    d.costs.vendorBuys ? line("Vendor purchases", money(d.costs.vendorBuys)) : "",
    line("AH cut", money(d.costs.ahCut), `estimated, ${cutPct}%`),
    line("Postage", money(d.costs.postage)),
    line("Deposits lost", money(d.costs.lostDeposits), "estimated from each item's deposit"),
    d.costs.other ? line("Other", money(d.costs.other), "repairs and the like") : "",
    line("Total", money(d.totalCosts), "", "total"),
  ].join("");
  $("#ov-chars").innerHTML = d.characters.map((c) => line(esc(c.character), money(c.money), `updated ${ago(c.updatedAt)}`)).join("")
    || line("No characters yet", "—", "TSM records gold when you log in");
  $("#ov-gold-note").textContent = d.goldSeries.length ? "all characters, rounded to the gold" : "";
  drawGold(d.goldSeries);
  renderFlipsPanel(await api("/api/flips?days=0"));
  $("#ov-daily").innerHTML = [...d.daily].reverse().map((r) => `<tr><td>${r.day}</td><td class="num">${money(r.income)}</td><td class="num">${money(r.costs)}</td><td class="num">${signed(r.net)}</td></tr>`).join("")
    || `<tr><td colspan="4" class="muted">Nothing in this period.</td></tr>`;
  $("#ov-activity").innerHTML = d.activity.map((r) => `<tr${r.itemId ? ` data-id="${r.itemId}"` : ""}${r.internal ? ` class="ignored"` : ""}>
      <td class="muted">${ago(r.ts)}</td>
      <td>${esc(r.what)}</td>
      <td>${r.itemId ? itemCell(r) : ""}</td>
      <td class="num">${r.qty == null ? "" : num(r.qty)}</td>
      <td class="num">${r.qty && r.amount != null ? money(Math.abs(r.amount) / r.qty) : ""}</td>
      <td class="num">${r.amount == null ? "—" : signed(r.amount)}</td>
      <td class="num">${r.profit == null ? "" : signed(r.profit)}</td>
      <td class="muted">${esc(r.player)}</td>
    </tr>`).join("") || `<tr><td colspan="8" class="muted">No activity in this period. TSM writes its ledger when you log out or /reload.</td></tr>`;
}
/** The Overview's right-hand panel: every item bought, units sold and profit so far (all time). */
function renderFlipsPanel(f) {
  const signed = (v) => `<span class="${v >= 0 ? "ok" : "bad"}">${v < 0 ? "−" : ""}${money(Math.abs(v))}</span>`;
  const t = f.totals;
  $("#ov-flips-total").innerHTML = t.flipsWithSales
    ? `${signed(t.profit)} <span class="muted small">on ${num(t.unitsSold)} units sold${t.costOfSold ? `, ${Math.round((t.profit / t.costOfSold) * 100)}% margin` : ""}</span>`
    : `<span class="muted small">Nothing sold yet</span>`;
  $("#ov-flips").innerHTML = f.rows.map((r) => `<tr data-flip="${r.itemId}" title="${esc(FL_STATUS[r.status])}${r.heldQty ? `: ${num(r.heldQty)} still held` : ""}">
      <td><div class="item-cell">${iconImg(r.icon, r.quality)}<span class="nm ${qClass(r.quality)}">${esc(r.name ?? `Item ${r.itemId}`)}</span></div></td>
      <td class="num">${num(r.boughtQty)}</td>
      <td class="num">${num(r.soldQty)}</td>
      <td class="num">${r.profit == null ? `<span class="muted">holding</span>` : signed(r.profit)}</td>
      <td class="num">${r.margin == null ? `<span class="muted">—</span>` : `<span class="${r.margin >= 0 ? "ok" : "bad"}">${Math.round(r.margin * 100)}%</span>`}</td>
    </tr>`).join("") || `<tr><td colspan="5" class="muted">No purchases yet.</td></tr>`;
}
$("#ov-flips").addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-flip]");
  if (!tr) return;
  flOpen.add(Number(tr.dataset.flip)); // open that item's trades on the Flips page
  location.hash = "#/flips";
});
function drawGold(series) {
  const el = $("#ov-gold-chart");
  el.hidden = series.length < 2;
  if (series.length < 2) return;
  const LC = window.LightweightCharts;
  if (!goldChart) {
    const css = getComputedStyle(document.documentElement);
    goldChart = LC.createChart(el, {
      autoSize: true,
      layout: { background: { color: "transparent" }, textColor: css.getPropertyValue("--muted").trim() || "#888" },
      grid: { vertLines: { visible: false }, horzLines: { color: css.getPropertyValue("--border").trim() || "#333" } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true },
      localization: { priceFormatter: (p) => `${Math.round(p).toLocaleString()}g` },
    });
    goldChart.series = goldChart.addSeries(LC.LineSeries, { color: css.getPropertyValue("--accent").trim() || "#2f6fde", lineWidth: 2, lineType: 1 });
  }
  goldChart.series.setData(series.map((p) => ({ time: p.ts + tzOffset * 60, value: p.copper / 10000 })));
  goldChart.timeScale().fitContent();
}
$("#ov-period").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-days]");
  if (!b) return;
  ovDays = Number(b.dataset.days);
  try { localStorage.setItem("ah-ov-days", String(ovDays)); } catch { /* storage unavailable */ }
  showOverview();
});
$("#ov-activity").addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-id]");
  if (tr) location.hash = `#/item/${tr.dataset.id}`;
});

// ---------- flips: profit and loss per item you bought ----------
let flData = null;
let flDays = 0;
let flStatus = "";
const flOpen = new Set(); // items whose trades are expanded
const flSort = { key: null, dir: "desc" };
try { flDays = Number(localStorage.getItem("ah-fl-days") ?? 0); } catch { /* storage unavailable */ }
const FL_STATUS = { sold: "Sold out", "part-sold": "Partly sold", holding: "Still holding", gone: "Used / gone" };
async function showFlips() {
  document.querySelectorAll("#fl-period button").forEach((b) => b.classList.toggle("active", Number(b.dataset.days) === flDays));
  flData = await api(`/api/flips?days=${flDays}`);
  const t = flData.totals;
  const signed = (v) => `<span class="${v >= 0 ? "ok" : "bad"}">${v < 0 ? "−" : ""}${money(Math.abs(v))}</span>`;
  const box = (label, value, title = "") => `<div class="stat"${title ? ` title="${esc(title)}"` : ""}><div class="label">${label}</div><div class="value">${value}</div></div>`;
  $("#fl-note").textContent = `Items you bought on the auction house, from TSM's ledger and AH Tracker. Sales use up your oldest purchases first; farmed or looted units are left out. `
    + `The AH cut is estimated at ${Math.round(flData.cut * 100)}% (TSM does not record which house a sale was on; Neutral takes 15%). Postage is on the Overview, not split per item. TSM updates when you log out or /reload.`;
  $("#fl-stats").innerHTML = [
    box("Profit on sold units", t.flipsWithSales ? signed(t.profit) : "—", "After the AH cut and lost deposits"),
    box("Margin", t.costOfSold ? `${Math.round((t.profit / t.costOfSold) * 100)}%` : "—", "Profit as a share of what the sold units cost"),
    box("Units sold", num(t.unitsSold)),
    box("Profitable", t.flipsWithSales ? `${t.winners} of ${t.flipsWithSales} items` : "—"),
    box("Still held (at cost)", `${money(t.heldCost)} <span class="muted small">${num(t.heldQty)} units</span>`),
  ].join("");
  renderFlips();
}
function renderFlips() {
  document.querySelectorAll("#fl-status button").forEach((b) => b.classList.toggle("active", b.dataset.status === flStatus));
  const signed = (v) => (v == null ? `<span class="muted">—</span>` : `<span class="${v >= 0 ? "ok" : "bad"}">${v < 0 ? "−" : ""}${money(Math.abs(v))}</span>`);
  const labelOfKey = (k) => (housesList.find((h) => h.key === k) || {}).label || k;
  const rows = applySort(flData.rows.filter((r) => !flStatus || r.status === flStatus), flSort, "#fl-head");
  $("#fl-rows").innerHTML = rows.map((r) => {
    const main = `<tr data-flip="${r.itemId}" class="${flOpen.has(r.itemId) ? "open" : ""}">
      <td>${itemCell(r)}</td>
      <td><span class="badge fl-${r.status}">${FL_STATUS[r.status]}</span></td>
      <td class="num">${num(r.boughtQty)}${r.boughtOn.length ? `<div class="why">${r.boughtOn.map((k) => esc(labelOfKey(k))).join(", ")}</div>` : ""}</td>
      <td class="num">${r.avgBuy == null ? "—" : money(r.avgBuy)}</td>
      <td class="num">${num(r.soldQty)}</td>
      <td class="num">${r.avgSell == null ? "—" : money(r.avgSell)}</td>
      <td class="num">${r.soldQty ? money(r.revenue) : "—"}</td>
      <td class="num">${r.soldQty ? money(r.costOfSold) : "—"}</td>
      <td class="num">${r.depositsLost ? `−${money(r.depositsLost)}` : "—"}${r.expiredListings ? `<div class="why">${r.expiredListings} expired</div>` : ""}</td>
      <td class="num">${signed(r.profit)}</td>
      <td class="num">${r.margin == null ? "—" : `<span class="${r.margin >= 0 ? "ok" : "bad"}">${Math.round(r.margin * 100)}%</span>`}</td>
      <td class="num">${r.heldQty ? `${num(r.heldQty)}<div class="why">${money(r.heldCost)} cost</div>` : "—"}</td>
      <td class="num">${r.goneQty ? num(r.goneQty) : "—"}</td>
      <td class="muted">${ago(r.lastActivity)}</td>
    </tr>`;
    if (!flOpen.has(r.itemId)) return main;
    const trades = r.trades.map((x) => `<tr><td class="muted">${new Date(x.ts * 1000).toLocaleString()}</td><td>${esc(x.what)}${x.house ? ` <span class="muted">on ${esc(labelOfKey(x.house))}</span>` : ""}${x.player ? ` <span class="muted">· ${esc(x.player)}</span>` : ""}</td>
      <td class="num">${num(x.qty)}</td><td class="num">${money(x.unit)}</td><td class="num">${signed(x.total)}</td><td class="num">${x.profit == null ? "" : signed(x.profit)}</td></tr>`).join("");
    return main + `<tr class="fl-detail"><td colspan="14"><table class="fl-trades"><thead><tr><th>When</th><th>What</th><th class="num">Qty</th><th class="num">Per unit</th><th class="num">Amount</th><th class="num">Profit</th></tr></thead><tbody>${trades}</tbody></table>
      <a href="#/item/${r.itemId}" class="small">Price history for this item →</a></td></tr>`;
  }).join("") || `<tr><td colspan="14" class="muted">No flips in this period. Buy something on the AH, then /reload so TSM writes its ledger.</td></tr>`;
}
sortable("#fl-head", flSort, renderFlips);
$("#fl-period").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-days]");
  if (!b) return;
  flDays = Number(b.dataset.days);
  try { localStorage.setItem("ah-fl-days", String(flDays)); } catch { /* storage unavailable */ }
  showFlips();
});
$("#fl-status").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-status]");
  if (!b || !flData) return;
  flStatus = b.dataset.status;
  renderFlips();
});
$("#fl-rows").addEventListener("click", (e) => {
  if (e.target.closest("a")) return;
  const tr = e.target.closest("tr[data-flip]");
  if (!tr) return;
  const id = Number(tr.dataset.flip);
  if (flOpen.has(id)) flOpen.delete(id); else flOpen.add(id);
  renderFlips();
});

// ---------- shuffles: every item on both houses, profit by route ----------
const SH_ROUTES = { "neutral>alliance": "Neutral → Alliance", "alliance>neutral": "Alliance → Neutral", "alliance>alliance": "Alliance → Alliance", "neutral>neutral": "Neutral → Neutral" };
const SH_SHORT = { "neutral>alliance": "N→A", "alliance>neutral": "A→N", "alliance>alliance": "A→A", "neutral>neutral": "N→N" };
const sh = { route: null, show: "", profitable: true, minSold: 0, q: "", data: null };
try { Object.assign(sh, JSON.parse(localStorage.getItem("ah-sh") || "{}"), { data: null }); } catch { /* storage unavailable */ }
const shSort = { key: null, dir: "desc" };
const saveSh = () => { try { localStorage.setItem("ah-sh", JSON.stringify({ route: sh.route, show: sh.show, profitable: sh.profitable, minSold: sh.minSold })); } catch { /* storage unavailable */ } };
async function showShuffles() {
  sh.data = await api("/api/shuffles");
  // First visit: start on the direction you carry (Show trades), else Neutral -> Alliance.
  if (!sh.route) sh.route = sh.data.crossDirection === 2 ? "alliance>neutral" : "neutral>alliance";
  $("#sh-profitable").checked = sh.profitable;
  $("#sh-min-sold").value = sh.minSold || "";
  renderShuffles();
}
function renderShuffles() {
  if (!sh.data) return;
  document.querySelectorAll("#sh-route button").forEach((b) => b.classList.toggle("active", b.dataset.route === sh.route));
  document.querySelectorAll("#sh-show button").forEach((b) => b.classList.toggle("active", b.dataset.show === (sh.show ?? "")));
  const houseOf = (k) => (k.startsWith("neutral") ? "Neutral" : "Alliance");
  const sellOf = (k) => (k.endsWith("neutral") ? "Neutral" : "Alliance");
  const q = sh.q.trim().toLowerCase();
  let rows = sh.data.rows.map((r) => {
    let key = sh.route;
    if (key === "best") key = Object.entries(r.routes).sort((a, b) => b[1].profit - a[1].profit)[0]?.[0] ?? null;
    const rt = key ? r.routes[key] : null;
    return { ...r, key, buy: rt?.buy ?? null, sell: rt?.sell ?? null, profit: rt?.profit ?? null, margin: rt?.margin ?? null };
  }).filter((r) => r.profit !== null
    && (!sh.profitable || r.profit > 0)
    && (r.soldPerDay ?? 0) >= (sh.minSold || 0)
    && (!sh.show || (sh.show === "conv") === Boolean(r.conversion))
    && (!q || r.name.toLowerCase().includes(q)));
  rows = shSort.key ? applySort(rows, shSort, "#sh-head") : [...applySort(rows, shSort, "#sh-head")].sort((a, b) => b.profit - a.profit);
  const shown = rows.slice(0, 1500);
  $("#sh-count").textContent = `${num(rows.length)} item${rows.length === 1 ? "" : "s"}${rows.length > shown.length ? ` (showing the first ${num(shown.length)})` : ""}`;
  const best = sh.route === "best";
  $("#sh-buy-head").textContent = best ? "Buy" : `Buy on ${houseOf(sh.route)}`;
  $("#sh-sell-head").textContent = best ? "Sell" : `Sell on ${sellOf(sh.route)}${houseOf(sh.route) === sellOf(sh.route) ? " (usual)" : " (now)"}`;
  const pl = (v) => `<span class="${v >= 0 ? "ok" : "bad"}">${v < 0 ? "−" : ""}${money(Math.abs(v))}</span>`;
  const seen = (k, r) => { const p = k.startsWith("neutral") ? r.neutral : r.alliance; return p ? `${num(p.qty)} listed · ${ago(p.ts)}${p.scan ? " · your scan" : ""}` : ""; };
  // Conversions: the buy is the inputs for one conversion (e.g. 3 Lesser), the sell is its output.
  const buyCell = (r) => r.conversion
    ? `${money(r.buy / r.conversion.fromQty)}<div class="why">total ${r.conversion.fromQty} × ${money(r.buy / r.conversion.fromQty)} = <b>${money(r.buy)}</b> · ${seen(r.key, r)}</div>`
    : `${money(r.buy)}<div class="why">${seen(r.key, r)}</div>`;
  const sellCell = (r) => r.conversion
    ? `${money(r.sell / r.conversion.toQty)}${r.conversion.toQty > 1 ? `<div class="why">total ${r.conversion.toQty} × ${money(r.sell / r.conversion.toQty)} = ${money(r.sell)}</div>` : ""}`
    : money(r.sell);
  $("#sh-rows").innerHTML = shown.map((r) => `<tr data-id="${r.itemId}">
      <td>${itemCell(r)}${r.conversion ? ` <span class="badge convert">${r.conversion.verb === "combine" ? "Combine" : "Split"}</span>` : ""}${best && r.key ? `<div class="why">${SH_ROUTES[r.key]}</div>` : ""}</td>
      <td class="num">${buyCell(r)}</td>
      <td class="num">${sellCell(r)}</td>
      <td class="num">${pl(r.profit)}</td>
      <td class="num"><span class="${r.margin >= 0 ? "ok" : "bad"}">${Math.round(r.margin * 100)}%</span></td>
      <td class="num">${num(r.soldPerDay, r.soldPerDay != null && r.soldPerDay < 10 ? 1 : 0)}</td>
      <td class="small">${Object.keys(SH_ROUTES).map((k) => r.routes[k] ? `<span class="sh-route${k === r.key ? " sel" : ""}">${SH_SHORT[k]} ${pl(r.routes[k].profit)}</span>` : "").join(" ")}</td>
    </tr>`).join("") || `<tr><td colspan="7" class="muted">Nothing matches. Untick Only profitable or change the filters.</td></tr>`;
}
sortable("#sh-head", shSort, renderShuffles);
$("#sh-route").addEventListener("click", (e) => { const b = e.target.closest("button[data-route]"); if (!b) return; sh.route = b.dataset.route; saveSh(); renderShuffles(); });
$("#sh-show").addEventListener("click", (e) => { const b = e.target.closest("button[data-show]"); if (!b) return; sh.show = b.dataset.show; saveSh(); renderShuffles(); });
$("#sh-profitable").addEventListener("change", (e) => { sh.profitable = e.target.checked; saveSh(); renderShuffles(); });
$("#sh-min-sold").addEventListener("change", (e) => { sh.minSold = Math.max(0, Number(e.target.value) || 0); saveSh(); renderShuffles(); });
let shTimer;
$("#sh-search").addEventListener("input", (e) => { clearTimeout(shTimer); shTimer = setTimeout(() => { sh.q = e.target.value; renderShuffles(); }, 200); });
$("#sh-rows").addEventListener("click", (e) => { const tr = e.target.closest("tr[data-id]"); if (tr) location.hash = `#/item/${tr.dataset.id}`; });

// ---------- forecasts: trends and next-days estimates ----------
const fc = { view: "rising", minPrice: 1, minSold: 5, classId: "", rows: [] };
try { Object.assign(fc, JSON.parse(localStorage.getItem("ah-fc") || "{}"), { rows: [] }); } catch { /* storage unavailable */ }
const fcSort = { key: null, dir: "desc" };
let fcSeq = 0;
const saveFc = () => { try { localStorage.setItem("ah-fc", JSON.stringify({ view: fc.view, minPrice: fc.minPrice, minSold: fc.minSold, classId: fc.classId })); } catch { /* storage unavailable */ } };
const pct = (v, digits = 1) => (v == null ? "—" : `${v > 0 ? "+" : ""}${(v * 100).toFixed(digits)}%`);
async function showForecasts() {
  document.querySelectorAll("#fc-view button").forEach((b) => b.classList.toggle("active", b.dataset.view === fc.view));
  if (document.activeElement !== $("#fc-min-price")) $("#fc-min-price").value = fc.minPrice;
  if (document.activeElement !== $("#fc-min-sold")) $("#fc-min-sold").value = fc.minSold;
  const seq = ++fcSeq; // only the newest request may update the page
  const d = await api(`/api/forecasts?view=${fc.view}&minPrice=${Math.round(fc.minPrice * 10000)}&minSold=${fc.minSold}&class=${encodeURIComponent(fc.classId)}`);
  if (seq !== fcSeq) return;
  // Categories, busiest sellers first, with their average sold per day.
  $("#fc-class").innerHTML = `<option value="">All categories</option>` + d.classes.map((c) =>
    `<option value="${c.classId}"${String(c.classId) === String(fc.classId) ? " selected" : ""}>${esc(c.name)} (${num(c.avgSold)}/day avg)</option>`).join("");
  const m = Object.fromEntries(d.methods.map((x) => [x.method, x]));
  const box = (label, value, title = "") => `<div class="stat"${title ? ` title="${esc(title)}"` : ""}><div class="label">${label}</div><div class="value">${value}</div></div>`;
  const skillText = (x) => (x?.skill == null ? "—" : `<span class="${x.skill > 0 ? "ok" : "bad"}">${x.skill > 0 ? `${Math.round(x.skill * 100)}% better` : `${Math.round(-x.skill * 100)}% worse`}</span> <span class="muted small">than "no change", ${Math.round((x.wins ?? 0) * 100)}% of ${num(x.items)} items</span>`);
  $("#fc-methods").innerHTML = [
    box("Next 1–3 days estimate (snap-back)", skillText(m["snap-back"]), "Back-test over 1-3 day horizons, launch week left out, items selling 20+ a day"),
    box("Following the trend", `${skillText(m.trend)}<div class="why">${m.trend?.skill > 0 ? "Now beating no change: trend projections can be switched on" : "Shown as a description only, not projected"}</div>`),
  ].join("");
  // The pooled model (EU Alliance only): attach its 1- and 3-day forecasts and show its test results.
  const model = await api("/api/model");
  renderModelCard(model);
  api("/api/model/scoreboard").then(renderScoreboard).catch(() => { $("#fc-live").hidden = true; });
  const mf = house === "alliance" ? model.forecasts : {};
  fc.rows = d.rows.map((r) => {
    const m1 = mf[r.itemId]?.["1d"] ?? null, m3 = mf[r.itemId]?.["3d"] ?? null;
    return { ...r, nextPct: r.next / r.level - 1, m1, m3, m1pct: m1 ? m1.q50 / m1.now - 1 : null, m3pct: m3 ? m3.q50 / m3.now - 1 : null };
  });
  renderForecasts();
}
/** One model forecast cell: most likely price and change, 80% range, chance of going up. */
function modelCell(m) {
  if (!m) return `<span class="muted">—</span>`;
  const pct = m.q50 / m.now - 1;
  return `${money(m.q50)} <span class="${Math.abs(pct) < 0.005 ? "muted" : pct > 0 ? "ok" : "bad"} small">${pct > 0 ? "+" : ""}${(pct * 100).toFixed(1)}%</span>`
    + `<div class="why">${money(m.q10)} – ${money(m.q90)} · ${Math.round(m.pUp * 100)}% up</div>`;
}
function renderModelCard(model) {
  const el = $("#fc-model");
  const ev = model.report?.evals;
  el.hidden = !ev;
  if (!ev) return;
  const pc = (v) => `${Math.round(v * 100)}%`;
  const line = (h, label) => {
    const e = ev[h];
    if (!e) return `<li><b>${label}:</b> <span class="muted">not testable yet (needs more history)</span></li>`;
    return `<li><b>${label}:</b> ${e.passed ? `<span class="ok">in use</span>` : `<span class="bad">not used</span>`} · typical error ${pc(e.mae_model)} vs ${pc(e.mae_naive)} for "no change" (<b>${pc(e.skill_naive)} better</b>) and ${pc(e.mae_snap)} for snap-back (${pc(e.skill_snap)} better) · direction right ${pc(e.direction)} · 80% range holds ${pc(e.cover_calibrated ?? e.cover)} · ${num(e.n)} test forecasts</li>`;
  };
  const al = model.report.alignment ?? {};
  const names = { "eu-horde": "EU Horde", "us-alliance": "US Alliance", "us-horde": "US Horde" };
  el.innerHTML = `<div class="card-title">Prediction model <span class="muted">trained on EU and US PvP Alliance and Horde (${num(model.report.items)} trade goods), tested on EU Alliance prices it had not seen · updated ${ago(model.computedAt)}</span></div>
    <ul class="model-lines">${line("1d", "Next day")}${line("3d", "Next 3 days")}${line("7d", "Next 7 days")}</ul>
    <div class="muted small">How your house moves with the others (correlation of daily moves, same day / a day earlier): ${Object.entries(al).map(([k, v]) => `${names[k] ?? k} ${v.corr_same_day?.toFixed(2) ?? "—"} / ${v.corr_leads_by_1d?.toFixed(2) ?? "—"}`).join(" · ")}${house !== "alliance" ? " · <b>Model forecasts are for PvP Alliance only</b>" : ""}</div>`;
}
/** Live results: the model's published forecasts scored against the prices that followed (last 7 days). */
function renderScoreboard(sb) {
  const el = $("#fc-live");
  el.hidden = false;
  const pc = (v) => `${Math.round(v * 100)}%`;
  const lean = (v) => `${v > 0 ? "+" : ""}${(v * 100).toFixed(1)}%`;
  const stats = (s) => s
    ? `typical error ${pc(s.maeModel)} vs ${pc(s.maeNaive)} for "no change" (<b class="${s.skill > 0 ? "ok" : "bad"}">${s.skill >= 0 ? `${pc(s.skill)} better` : `${pc(-s.skill)} worse`}</b>) · leans <span class="${Math.abs(s.bias) > 0.03 ? "bad" : ""}">${lean(s.bias)}</span> · direction right ${pc(s.direction)} · 80% range held ${pc(s.cover)} · ${num(s.n)} forecasts`
    : `<span class="muted">none scored</span>`;
  const labels = { "1d": "Next day", "3d": "Next 3 days", "7d": "Next 7 days" };
  const hs = Object.keys(sb.horizons);
  const title = `<div class="card-title">Live results: published forecasts vs what happened <span class="muted">EU PvP Alliance, forecasts due in the last ${sb.days} days${sb.loggedSince ? ` · logging since ${ago(sb.loggedSince)}` : ""}${sb.pending ? ` · ${num(sb.pending)} still to come` : ""}${sb.missing ? ` · ${num(sb.missing)} without a price` : ""}</span></div>`;
  if (!hs.length) {
    el.innerHTML = `${title}<div class="muted">No forecasts old enough yet: the first are scored a day after they are published.</div>`;
    return;
  }
  const lines = hs.map((h) => {
    const g = sb.horizons[h];
    return `<li><b>${labels[h] ?? h}:</b> ${stats(g.all)}<div class="why">Trade goods: ${stats(g.trade)}<br>Other watched items: ${stats(g.other)}</div></li>`;
  }).join("");
  const cell = (s) => s ? `${pc(s.maeModel)} <span class="muted small">vs ${pc(s.maeNaive)}</span> · <span class="${Math.abs(s.bias) > 0.03 ? "bad" : ""}">${lean(s.bias)}</span> · ${pc(s.direction)} · ${pc(s.cover)} <span class="muted small">(${num(s.n)})</span>` : `<span class="muted">—</span>`;
  const runs = sb.runs.slice(0, 28).map((r) => `<tr><td>${new Date(r.madeAt * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</td>${hs.map((h) => `<td class="num">${cell(r.horizons[h])}</td>`).join("")}</tr>`).join("");
  el.innerHTML = `${title}<ul class="model-lines">${lines}</ul>
    <details><summary class="muted small">Per run (typical error vs "no change" · lean · direction right · in 80% range)</summary>
      <table><thead><tr><th>Published</th>${hs.map((h) => `<th class="num">${labels[h] ?? h}</th>`).join("")}</tr></thead><tbody>${runs}</tbody></table>
    </details>`;
}
function renderForecasts() {
  const rows = applySort(fc.rows, fcSort, "#fc-head");
  $("#fc-count").textContent = `${num(rows.length)} item${rows.length === 1 ? "" : "s"}`;
  const cons = (c) => {
    const a = Math.abs(c);
    const word = a >= 0.6 ? (c > 0 ? "steady rise" : "steady fall") : a >= 0.3 ? "mixed" : "no pattern";
    return `<span class="${a >= 0.6 ? (c > 0 ? "ok" : "bad") : "muted"}">${word}</span> <span class="muted small">${c.toFixed(2)}</span>`;
  };
  $("#fc-rows").innerHTML = rows.map((r) => `<tr data-id="${r.itemId}">
      <td>${itemCell(r)}</td>
      <td class="num">${money(r.level)}</td>
      <td class="num">${money(r.next)} <span class="${Math.abs(r.nextPct) < 0.005 ? "muted" : r.nextPct > 0 ? "ok" : "bad"} small">${pct(r.nextPct)}</span></td>
      <td class="num">${modelCell(r.m1)}</td>
      <td class="num">${modelCell(r.m3)}</td>
      <td class="num ${r.trend > 0 ? "ok" : r.trend < 0 ? "bad" : ""}">${pct(r.trend)}</td>
      <td class="num">${cons(r.consistency)}</td>
      <td class="num">${pct(r.supplyTrend)}</td>
      <td class="num">${money(r.peak)}<div class="why">${money(r.low)}</div></td>
      <td class="num">${num(r.soldPerDay, r.soldPerDay != null && r.soldPerDay < 10 ? 1 : 0)}</td>
      <td class="num">${r.skill == null ? `<span class="muted" title="Too little history to test">—</span>` : `<span class="${r.skill > 0 ? "ok" : "bad"}">${pct(r.skill, 0)}</span>`}</td>
    </tr>`).join("") || `<tr><td colspan="11" class="muted">Nothing matches. Try a lower price or sold/day filter.</td></tr>`;
}
sortable("#fc-head", fcSort, renderForecasts);
$("#fc-view").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-view]");
  if (!b) return;
  fc.view = b.dataset.view;
  saveFc();
  showForecasts();
});
$("#fc-all-trade").addEventListener("click", () => {
  Object.assign(fc, { view: "all", classId: "7", minPrice: 0, minSold: 0 }); // 7 = Trade Goods
  saveFc();
  showForecasts();
});
$("#fc-class").addEventListener("change", (e) => {
  fc.classId = e.target.value;
  saveFc();
  showForecasts();
});
for (const [id, key] of [["#fc-min-price", "minPrice"], ["#fc-min-sold", "minSold"]])
  $(id).addEventListener("change", (e) => {
    const v = Number(e.target.value);
    if (!Number.isFinite(v) || v < 0) return;
    fc[key] = v;
    saveFc();
    showForecasts();
  });
$("#fc-rows").addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-id]");
  if (tr) location.hash = `#/item/${tr.dataset.id}`;
});

// ---------- materials: crafting materials by profession, with snipe prices ----------
let matProf = "enchanting";
try { matProf = localStorage.getItem("ah-mat-prof") || matProf; } catch { /* storage unavailable */ }
let matData = null;
const matSort = { key: null, dir: "desc" };
async function showMaterials() {
  matData = await api(`/api/materials?prof=${encodeURIComponent(matProf)}`);
  $("#mat-tabs").innerHTML = matData.professions.map((p) => `<button data-prof="${p.key}"${p.key === matData.profession ? ' class="active"' : ""}>${esc(p.title)}</button>`).join("");
  if (document.activeElement !== $("#mat-fraction")) $("#mat-fraction").value = Math.round(matData.fraction * 100);
  renderMaterials();
  showEssences().catch(() => {});
}
const HOUSE_SHORT = { alliance: "Alliance", neutral: "Neutral" };
async function showEssences() {
  const show = matProf === "enchanting";
  $("#ess-card").hidden = !show;
  if (!show) return;
  const [d, settings] = await Promise.all([api("/api/essences"), api("/api/settings")]);
  // Your Show trades directions (Opportunities -> Between houses): 0 both, 1 Neutral -> Alliance only, 2 Alliance -> Neutral only.
  const dir = settings.crossDirection ?? 0;
  const allowed = (r) => dir === 0 || (dir === 1 ? r.buy === "neutral" && r.sell === "alliance" : r.buy === "alliance" && r.sell === "neutral");
  const pl = (v) => (v == null ? `<span class="muted">—</span>` : `<span class="${v >= 0 ? "ok" : "bad"}">${v < 0 ? "−" : "+"}${money(Math.abs(v))}</span>`);
  // The better of combine and split for one direction (buy on one house, sell on the other).
  const way = (e, buy, sell) => e.routes.filter((r) => r.buy === buy && r.sell === sell).sort((a, b) => b.profit - a.profit)[0];
  const offCell = `<span class="muted" title="Switched off in Show trades on Opportunities → Between houses">off (Show trades)</span>`;
  const cell = (r) => (!r ? `<span class="muted">—</span>` : !allowed(r) ? offCell
    : `${pl(r.profit)} <span class="${r.margin >= 0 ? "ok" : "bad"} small">${Math.round(r.margin * 100)}%</span>`
      + `<div class="why">${r.kind === "combine" ? "buy 3 Lesser, combine" : "buy 1 Greater, split"} · cost ${money(r.cost)}</div>`);
  $("#ess-rows").innerHTML = d.map((e) => {
    const p = (k, w) => money(e.prices[k]?.[w]?.p ?? null);
    // Only routes in your direction count as the best way.
    const b = e.routes.filter(allowed).sort((x, y) => y.profit - x.profit)[0];
    const route = !b ? "—" : `${b.kind === "combine" ? "Buy 3 Lesser" : "Buy 1 Greater"} on ${HOUSE_SHORT[b.buy]}, ${b.kind === "combine" ? "combine, sell the Greater" : "split, sell the 3 Lesser"}${b.buy === b.sell ? " there" : ` on ${HOUSE_SHORT[b.sell]}`}`;
    return `<tr${b && b.profit > 0 ? ' class="snipe"' : ""}>
      <td>${esc(e.name)}</td>
      <td class="num">${p("alliance", "lesser")} / ${p("neutral", "lesser")}</td>
      <td class="num">${p("alliance", "greater")} / ${p("neutral", "greater")}</td>
      <td class="num">${cell(way(e, "neutral", "alliance"))}</td>
      <td class="num">${cell(way(e, "alliance", "neutral"))}</td>
      <td>${b && b.profit > 0 ? esc(route) : `<span class="muted">nothing pays${dir ? " in your direction" : ""} now</span>`}</td>
      <td class="num">${b ? pl(b.profit) : "—"}</td>
      <td class="num">${b ? `<span class="${b.margin >= 0 ? "ok" : "bad"}">${Math.round(b.margin * 100)}%</span>` : "—"}</td>
    </tr>`;
  }).join("");
}
function renderMaterials() {
  // With no column chosen: snipes first, then the biggest discounts.
  const rows = matSort.key ? applySort(matData.rows, matSort, "#mat-head")
    : [...applySort(matData.rows, matSort, "#mat-head")].sort((a, b) => Number(b.isSnipe) - Number(a.isSnipe) || (a.vsUsual ?? 9) - (b.vsUsual ?? 9));
  const snipes = rows.filter((r) => r.isSnipe).length;
  $("#mat-count").innerHTML = `${num(rows.length)} materials · ${snipes ? `<b class="ok">${snipes} at snipe price now</b>` : "none at snipe price right now"}`;
  const pct = (v) => (v == null ? "—" : `${Math.round(v * 100)}%`);
  $("#mat-rows").innerHTML = rows.map((r) => `<tr data-id="${r.itemId}"${r.isSnipe ? ' class="snipe"' : ""}>
      <td>${itemCell(r)}${r.isSnipe ? ' <span class="badge flip">Snipe</span>' : ""}</td>
      <td class="num">${money(r.cheapest)}${r.seenAt ? `<div class="why">${ago(r.seenAt)}${r.fromScan ? " · your scan" : ""}</div>` : ""}</td>
      <td class="num">${money(r.usual)}</td>
      <td class="num">${money(r.usualOther)}</td>
      <td class="num ${r.vsUsual == null ? "" : r.vsUsual <= matData.fraction ? "ok" : r.vsUsual > 1 ? "bad" : ""}">${pct(r.vsUsual)}</td>
      <td class="num">${money(r.snipeAt)}</td>
      <td class="num">${num(r.listed)}</td>
      <td class="num">${num(r.soldPerDay, r.soldPerDay != null && r.soldPerDay < 10 ? 1 : 0)}</td>
      <td class="num ${r.trend > 0 ? "ok" : r.trend < 0 ? "bad" : ""}">${r.trend == null ? "—" : `${r.trend > 0 ? "+" : ""}${(r.trend * 100).toFixed(1)}%`}</td>
    </tr>`).join("") || `<tr><td colspan="9" class="muted">No materials in this category yet.</td></tr>`;
  $("#mat-other-head").textContent = `Usual on ${house === "neutral" ? "Alliance" : "Neutral"}`;
}
sortable("#mat-head", matSort, renderMaterials);
$("#mat-tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-prof]");
  if (!b) return;
  matProf = b.dataset.prof;
  try { localStorage.setItem("ah-mat-prof", matProf); } catch { /* storage unavailable */ }
  showMaterials();
});
$("#mat-fraction").addEventListener("change", async (e) => {
  const pct = Number(e.target.value);
  if (!Number.isFinite(pct) || pct < 5 || pct > 95) { $("#mat-msg").textContent = "Use 5–95%"; return; }
  const res = await fetch("/api/materials", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fraction: pct / 100 }) });
  const out = await res.json();
  $("#mat-msg").textContent = res.ok ? (out.listsRewritten ? "Saved · [SNIPE] lists updated, /reload in game" : "Saved") : out.error;
  showMaterials();
});
$("#mat-rows").addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-id]");
  if (tr) location.hash = `#/item/${tr.dataset.id}`;
});

// ---------- inventory: what you hold, priced on every house ----------
let invData = null;
let invRows = [];
const invSort = { key: null, dir: "desc" };
// Ticked ("ignored") items are greyed out and left out of the totals; this hides them altogether. Remembered.
let invHideIgnored = false;
// "all" = everything held; "bought" = only units bought on the AH and not sold yet. Remembered.
let invMode = "all";
try { invMode = localStorage.getItem("ah-inv-mode") || invMode; } catch { /* storage unavailable */ }
try { invHideIgnored = localStorage.getItem("ah-inv-hide-ignored") === "1"; } catch { /* storage unavailable */ }
let targets = new Map(); // itemId -> target status (the Inventory page and item pages)
async function loadTargets() {
  const list = await api("/api/targets");
  targets = new Map(list.map((t) => [t.itemId, t]));
  return list;
}
/** Sets (gold) or removes (empty) a price target. */
async function setTarget(itemId, goldText) {
  const g = goldText.trim() === "" ? null : Number(goldText);
  if (g !== null && (!Number.isFinite(g) || g <= 0)) return false;
  const res = await fetch("/api/targets", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ itemId, target: g === null ? null : Math.round(g * 10000) }) });
  return res.ok;
}
function renderTargets(list) {
  // Suggestions for the form: what you hold first, then items with a target.
  const names = new Map();
  for (const r of invData?.rows ?? []) if (r.name) names.set(r.name, r.itemId);
  for (const t of list) names.set(t.name, t.itemId);
  $("#target-items").innerHTML = [...names.keys()].sort().map((n) => `<option value="${esc(n)}">`).join("");
  $("#inv-targets").innerHTML = list.map((t) => {
    const row = invData?.rows.find((r) => r.itemId === t.itemId) || {};
    const status = t.price == null ? `<span class="muted">no price yet</span>`
      : t.reached ? `<span class="badge flip">Reached</span>`
      : `<span class="muted">${Math.round((t.target / t.price - 1) * 100)}% to go</span>`;
    return `<tr data-id="${t.itemId}">
      <td>${itemCell({ ...row, ...t })}</td>
      <td class="num">${money(t.target)}</td>
      <td class="num">${money(t.price)}${t.houseLabel ? `<div class="why">${esc(t.houseLabel)} · ${ago(t.seenAt)}</div>` : ""}</td>
      <td>${status}</td>
      <td class="num">${t.held ? `${num(t.held)}${t.paid != null ? `<div class="why">paid ${money(t.paid)}</div>` : ""}` : "—"}</td>
      <td class="num">${t.profitIfSold == null ? "—" : `<span class="${t.profitIfSold >= 0 ? "ok" : "bad"}">${money(Math.abs(t.profitIfSold))}${t.profitIfSold < 0 ? " loss" : ""}</span>`}</td>
      <td><button class="btn small" data-remove-target="${t.itemId}">Remove</button></td>
    </tr>`;
  }).join("") || `<tr><td colspan="7" class="muted">No targets yet. Pick an item above and the price you want to be told at.</td></tr>`;
}
// Set a target from the form: an item you hold, one with a target, or any item found by name.
$("#target-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#target-item").value.trim();
  const goldText = $("#target-gold").value;
  let id = (invData?.rows ?? []).find((r) => r.name?.toLowerCase() === name.toLowerCase())?.itemId
    ?? [...targets.values()].find((t) => t.name.toLowerCase() === name.toLowerCase())?.itemId;
  if (!id && name) {
    const hits = await api(`/api/search?q=${encodeURIComponent(/^\d+$/.test(name) ? name : name)}`);
    id = (hits.find((h) => h.name?.toLowerCase() === name.toLowerCase()) ?? hits[0])?.itemId;
  }
  if (!id) { $("#target-msg").textContent = "No item by that name"; return; }
  const ok = await setTarget(id, goldText);
  $("#target-msg").textContent = ok ? "Saved: you will get a desktop notification" : "Use a gold amount, e.g. 20 or 1.5";
  if (ok) { $("#target-item").value = ""; $("#target-gold").value = ""; renderTargets(await loadTargets()); }
});
$("#inv-targets").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-remove-target]");
  if (b) { await setTarget(Number(b.dataset.removeTarget), ""); return showInventory(); }
  const tr = e.target.closest("tr[data-id]");
  if (tr) location.hash = `#/item/${tr.dataset.id}`;
});
async function showInventory() {
  invData = await api("/api/inventory");
  renderTargets(await loadTargets());
  showReady();
  renderInventorySummary();
}
/** "Ready to sell now": bought items that make your minimum margin at today's going price. */
async function showReady() {
  const d = await api("/api/alerts");
  $("#inv-ready").hidden = !d.items.length;
  $("#inv-ready-note").textContent = `bought items you can sell at the going price for at least your ${Math.round(d.minMargin * 100)}% margin, after the AH cut and lost deposits. You also get a desktop notification when one becomes ready.`;
  $("#inv-ready-rows").innerHTML = d.items.map((r) => `<tr data-id="${r.itemId}">
      <td>${itemCell({ ...r, ...(invData?.rows.find((x) => x.itemId === r.itemId) ?? {}) })}</td>
      <td class="num">${num(r.qty)}</td>
      <td><b>${esc(r.houseLabel)}</b></td>
      <td class="num">${money(r.listPrice)}</td>
      <td class="num">${money(r.paid)}</td>
      <td class="num ok">${money(r.profit)}</td>
      <td class="num ok">${Math.round(r.margin * 100)}%</td>
      <td class="muted">${r.since ? ago(r.since) : "just now"}</td>
    </tr>`).join("");
}
$("#inv-ready-rows").addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-id]");
  if (tr) location.hash = `#/item/${tr.dataset.id}`;
});
function renderInventorySummary() {
  const d = invData;
  $("#inv-hide-ignored").checked = invHideIgnored;
  document.querySelectorAll("#inv-mode button").forEach((b) => b.classList.toggle("active", b.dataset.mode === invMode));
  const bought = invMode === "bought";
  invRows = d.rows.filter((r) => !bought || r.purchasedQty > 0).map((r) => {
    const a = r.houses.find((h) => h.key === "alliance") || {};
    const n = r.houses.find((h) => h.key === "neutral") || {};
    // Items to resell counts only the bought units: farmed or looted ones of the same item are left out.
    const qty = bought ? r.purchasedQty : r.qty;
    const value = r.bestPerUnit ? r.bestPerUnit * qty : null;
    return { ...r, qty, value, a, n, aNow: a.now ?? null, aGet: a.youGet ?? null, nNow: n.now ?? null, nGet: n.youGet ?? null,
      targetPrice: targets.get(r.itemId)?.target ?? null };
  });
  const counted = invRows.filter((r) => !r.ignored);
  const nIgnored = invRows.length - counted.length;
  $("#inv-ignored-count").textContent = nIgnored ? `(${nIgnored} ticked)` : "";
  const box = (label, value) => `<div class="stat"><div class="label">${label}</div><div class="value">${value}</div></div>`;
  const units = counted.reduce((t, r) => t + r.qty, 0);
  const toNeutral = counted.filter((r) => r.bestHouse === "neutral").length;
  const profit = counted.reduce((t, r) => t + (r.profit ?? 0), 0);
  const profitNow = counted.reduce((t, r) => t + (r.profitNow ?? 0), 0);
  const pl = (v) => (v ? `<span class="${v >= 0 ? "ok" : "bad"}">${money(Math.abs(v))}${v < 0 ? " loss" : ""}</span>` : "—");
  $("#inv-summary").innerHTML = [
    box("Items", num(counted.length)),
    box("Units", num(units)),
    box("Worth (best house, after costs)", money(counted.reduce((t, r) => t + (r.value ?? 0), 0))),
    box("Better sold on Neutral", `${toNeutral} item${toNeutral === 1 ? "" : "s"}`),
    box("Bought units: P/L if sold now", pl(profitNow)),
    box("Bought units: profit at target", pl(profit)),
  ].join("");
  $("#inv-chars").textContent = d.characters.length
    ? "Scanned: " + d.characters.map((c) => `${c.character} ${c.location} (${c.units} units, ${ago(c.scannedAt)})`).join(" · ")
    : "Nothing scanned yet: install AH Tracker 1.6, /reload in game, and open your bank once.";
  renderInventory();
}
function renderInventory() {
  const cell = (h) => (h.youGet == null ? `<span class="muted">—</span>` : money(h.youGet));
  const rows = applySort(invRows, invSort, "#inv-head").filter((r) => !(invHideIgnored && r.ignored));
  $("#inv-rows").innerHTML = rows.map((r) => `<tr data-id="${r.itemId}" title="${esc(r.heldBy)}"${r.ignored ? ` class="ignored"` : ""}>
      <td class="tick"><label title="${r.ignored ? "Count this item again" : "Ignore this item"}"><input type="checkbox" data-ignore="${r.itemId}"${r.ignored ? " checked" : ""} aria-label="Ignore ${esc(r.name ?? `item ${r.itemId}`)}"></label></td>
      <td>${itemCell(r)}</td>
      <td class="num">${num(r.qty)}</td>
      <td class="num">${r.soldPerDay == null ? `<span class="muted">—</span>` : `${num(r.soldPerDay, r.soldPerDay < 10 ? 1 : 0)}${r.saleRate == null ? "" : `<div class="why">${Math.round(r.saleRate * 100)}% sell</div>`}`}</td>
      <td class="num">${r.aNow == null ? "—" : money(r.aNow)}</td>
      <td class="num ${r.bestHouse === "alliance" ? "ok" : ""}">${cell(r.a)}</td>
      <td class="num">${r.nNow == null ? "—" : money(r.nNow)}</td>
      <td class="num ${r.bestHouse === "neutral" ? "ok" : ""}">${cell(r.n)}</td>
      <td>${r.bestLabel ? `<b>${esc(r.bestLabel)}</b>${(r.bestHouse === "alliance" ? r.a : r.n).sellHours ? `<div class="why">best around ${hoursText((r.bestHouse === "alliance" ? r.a : r.n).sellHours)}</div>` : ""}` : `<span class="muted">no price data</span>`}</td>
      <td class="num">${r.edgePerUnit == null ? "—" : money(r.edgePerUnit)}</td>
      <td class="num">${r.value == null ? "—" : money(r.value)}</td>
      <td class="num">${r.paidPerUnit == null ? "—" : `${money(r.paidPerUnit)}${invMode === "all" && r.purchasedQty < r.qty ? `<div class="why">${num(r.purchasedQty)} of ${num(r.qty)} bought</div>` : ""}${r.boughtOn ? `<div class="why">on ${esc(houseLabel((housesList.find((h) => h.key === r.boughtOn) || {}).houseId))}</div>` : ""}`}</td>
      <td class="num">${r.profitNow == null ? "—" : `<span class="${r.profitNow >= 0 ? "ok" : "bad"}">${money(Math.abs(r.profitNow))}${r.profitNow < 0 ? " loss" : ""}</span><div class="why">${money(r.nowPerUnit)}/unit after costs, ${esc(r.nowHouse === "alliance" ? "Alliance" : "Neutral")}</div>`}</td>
      <td class="num">${r.profit == null ? "—" : `<span class="${r.profit >= 0 ? "ok" : "bad"}">${money(Math.abs(r.profit))}${r.profit < 0 ? " loss" : ""}</span>`}</td>
    </tr>`).join("") || `<tr><td colspan="14" class="muted">${invRows.length
      ? "Every item is ticked. Untick Hide ticked items to see them."
      : invMode === "bought"
      ? "Nothing you bought on the auction house is in your bags or bank. Items you have listed or mailed are not counted."
      : "No inventory yet. Install AH Tracker 1.6, /reload in game, then click Sync now."}</td></tr>`;
}
sortable("#inv-head", invSort, renderInventory);
$("#inv-mode").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-mode]");
  if (!b || !invData) return;
  invMode = b.dataset.mode;
  try { localStorage.setItem("ah-inv-mode", invMode); } catch { /* storage unavailable */ }
  renderInventorySummary();
});
$("#inv-hide-ignored").addEventListener("change", (e) => {
  invHideIgnored = e.target.checked;
  try { localStorage.setItem("ah-inv-hide-ignored", invHideIgnored ? "1" : "0"); } catch { /* storage unavailable */ }
  renderInventory();
});
$("#inv-rows").addEventListener("change", async (e) => {
  const id = Number(e.target.dataset.ignore);
  if (!id) return;
  const ignored = e.target.checked;
  const res = await fetch("/api/inventory/ignore", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ itemId: id, ignored }) });
  if (!res.ok) { e.target.checked = !ignored; return; }
  const row = invData.rows.find((r) => r.itemId === id);
  if (row) row.ignored = ignored;
  renderInventorySummary();
});
$("#inv-rows").addEventListener("click", (e) => {
  if (e.target.closest(".tick")) return; // the checkbox cell does not open the item
  const tr = e.target.closest("tr[data-id]");
  if (tr) location.hash = `#/item/${tr.dataset.id}`;
});

// ---------- profit calculator ----------
let calcLib = null;
let calcItem = null; // { detail, stats } for the picked item
const moneyGet = (id) => {
  const v = (part) => Math.max(0, Number($(`#${id} [data-part=${part}]`).value) || 0);
  return v("g") * 10000 + v("s") * 100 + v("c");
};
const moneySet = (id, copper) => {
  const c = Math.max(0, Math.round(copper || 0));
  $(`#${id} [data-part=g]`).value = Math.floor(c / 10000) || "";
  $(`#${id} [data-part=s]`).value = Math.floor((c % 10000) / 100) || "";
  $(`#${id} [data-part=c]`).value = c % 100 || "";
};
const calcTarget = () => {
  const s = calcItem?.stats;
  if (!s) return null;
  return s.consistency >= 0.6 && s.patternDays >= 3 ? s.sellPrice : s.median;
};

async function showCalc() {
  if (!calcLib) calcLib = await import("/calc.mjs");
  const settings = await api("/api/settings");
  if ($("#calc-margin").value === "") $("#calc-margin").value = Math.round(settings.minMargin * 100);
  const h = housesList.find((x) => x.key === house);
  if (h && (!calcItem || $("#calc-cut").dataset.house !== house)) {
    $("#calc-cut").value = +(h.cut * 100).toFixed(2);
    $("#calc-cut").dataset.house = house;
  }
  renderCalc();
}

function renderCalc() {
  if (!calcLib) return;
  const { calculate, formatMoney } = calcLib;
  const m = (c) => money(c); // coloured g/s/c
  const p = {
    buy: moneyGet("calc-buy"), sell: moneyGet("calc-sell"),
    quantity: Number($("#calc-qty").value) || 0,
    cut: (Number($("#calc-cut").value) || 0) / 100,
    deposit: moneyGet("calc-deposit"),
    failedListings: Number($("#calc-fails").value) || 0,
    minMargin: (Number($("#calc-margin").value) || 0) / 100,
  };
  if (!p.buy || !p.sell || !p.quantity) {
    $("#calc-results").innerHTML = `<p class="muted">Enter a buy price, a sell price and a quantity to see the outcome.</p>`;
    return;
  }
  const r = calculate(p);
  const verdict = r.profit <= 0 ? ["bad", "Loses money"] : r.meetsMargin ? ["good", `Makes your ${Math.round(p.minMargin * 100)}% margin`] : ["meh", `Profitable, but under your ${Math.round(p.minMargin * 100)}% margin`];
  const row = (label, value, cls = "") => `<tr class="${cls}"><td>${label}</td><td class="num">${value}</td></tr>`;
  $("#calc-results").innerHTML = `
    <span class="verdict ${verdict[0]}">${verdict[1]}</span>
    <div class="headline ${r.profit >= 0 ? "ok" : "bad"}">${r.profit < 0 ? "−" : ""}${m(Math.abs(r.profit))}</div>
    <div class="sub">${r.profit >= 0 ? "profit" : "loss"} on ${p.quantity} units · ${r.profit < 0 ? "−" : ""}${formatMoney(Math.abs(r.profitPerUnit))} per unit · ${(r.margin * 100).toFixed(1)}% margin</div>
    <table>
      ${row("Sale value", m(r.gross))}
      ${row(`AH cut (${(p.cut * 100).toFixed(1)}%)`, `−${m(r.ahCut)}`)}
      ${row(`Deposits lost on expired listings (${p.failedListings} × ${formatMoney(p.deposit)} × ${p.quantity})`, `−${m(r.depositLost)}`)}
      ${row("You receive", m(r.net))}
      ${row(`Purchase (${p.quantity} × ${formatMoney(p.buy)})`, `−${m(r.purchase)}`)}
      ${row("Profit", `${r.profit < 0 ? "−" : ""}${m(Math.abs(r.profit))}`, "total")}
    </table>
    <table>
      ${row("Break-even sell price (per unit)", m(Math.ceil(r.breakEvenSell)))}
      ${row(`Lowest sell price for your ${Math.round(p.minMargin * 100)}% margin`, m(Math.ceil(r.minSellForMargin)))}
      ${row(`Most you can pay at this sell price for ${Math.round(p.minMargin * 100)}%`, r.maxBuyForMargin > 0 ? m(Math.floor(r.maxBuyForMargin)) : "—")}
      ${row("Gold needed up front (purchase + deposits)", m(r.cashNeeded))}
    </table>
    <p class="muted small">The deposit on the listing that sells is refunded; only expired listings cost you. Sale prices are what buyers pay; the AH takes its cut from that.</p>`;
}

for (const sel of ["#calc-qty", "#calc-cut", "#calc-fails", "#calc-margin"]) $(sel).addEventListener("input", renderCalc);
document.querySelectorAll("#view-calc .money-in input").forEach((i) => i.addEventListener("input", renderCalc));

let calcSearchTimer;
$("#calc-item").addEventListener("input", (e) => {
  clearTimeout(calcSearchTimer);
  const q = e.target.value.trim();
  const match = [...$("#calc-items").options].find((o) => o.value === q);
  if (match) return pickCalcItem(Number(match.dataset.id));
  calcSearchTimer = setTimeout(async () => {
    if (q.length < 2) return;
    const rows = await api(`/api/search?q=${encodeURIComponent(q)}`);
    $("#calc-items").innerHTML = rows.map((r) => `<option value="${esc(r.name ?? `Item ${r.itemId}`)}" data-id="${r.itemId}"></option>`).join("");
  }, 200);
});

async function pickCalcItem(id) {
  const [detail, t] = await Promise.all([api(`/api/item/${id}`), api(`/api/item/${id}/stats`)]);
  calcItem = { detail, stats: t.stats };
  const target = calcTarget();
  if (detail.price) moneySet("calc-buy", detail.price);
  if (target) moneySet("calc-sell", target);
  if (detail.depositUnit != null) moneySet("calc-deposit", detail.depositUnit);
  if (detail.saleRate != null) $("#calc-fails").value = calcLib.expectedFailedListings(detail.saleRate).toFixed(2);
  $("#calc-quick").hidden = false;
  $("#calc-item-info").innerHTML = [
    `Current price ${money(detail.price)}`,
    target ? `target sell ${money(target)}` : null,
    detail.saleRate != null ? `EU sale rate ${Math.round(detail.saleRate * 100)}%` : null,
    detail.depositUnit != null ? `deposit ${money(detail.depositUnit)}${detail.depositIsEstimate ? " (estimated)" : ""}` : "deposit unknown until you scan with AH Tracker 1.5",
  ].filter(Boolean).join(" · ");
  renderCalc();
}
$("#calc-quick").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-fill]");
  if (!b || !calcItem) return;
  if (b.dataset.fill === "target" && calcTarget()) moneySet("calc-sell", calcTarget());
  if (b.dataset.fill === "current" && calcItem.detail.price) moneySet("calc-sell", calcItem.detail.price);
  renderCalc();
});

// ---------- browser tab titles ----------
const houseName = () => (housesList.find((h) => h.key === house) || {}).label || "";
function setTitle(...parts) {
  document.title = [...parts.filter(Boolean), "AH Tracker"].join(" · ");
}

// ---------- watchlist: trends rechecked every few hours, notifications when they change ----------
const WATCH_CLASS = { rising: "ok", up: "ok", growing: "bad", falling: "bad", down: "bad", shrinking: "ok" };
const watchLabel = (label, detail) => `<span class="${WATCH_CLASS[label] ?? "muted"}">${esc(label)}</span>${detail ? `<div class="why">${detail}</div>` : ""}`;
// Filters, remembered on this browser.
const wf = { group: "", cat: "", trend: "", model: "", supply: "", buyOnly: false, q: "" };
try { Object.assign(wf, JSON.parse(localStorage.getItem("ah-watch-filters") || "{}")); } catch { /* storage unavailable */ }
const saveWf = () => { try { localStorage.setItem("ah-watch-filters", JSON.stringify(wf)); } catch { /* storage unavailable */ } };
let watchData = null;
const watchGroup = (w) => (w.classId === 7 ? "trade" : w.classId === 0 ? "consumable" : "other");
const watchOk = (w) => {
  const l = w.signals?.labels;
  return (!wf.group || watchGroup(w) === wf.group) && (!wf.cat || w.category === wf.cat)
    && (!wf.trend || l?.trend === wf.trend) && (!wf.model || l?.model === wf.model) && (!wf.supply || l?.supply === wf.supply)
    && (!wf.buyOnly || w.buyBelow) && (!wf.q || w.name.toLowerCase().includes(wf.q.toLowerCase()));
};
function syncWatchFilters() {
  document.querySelectorAll("#watch-group [data-group]").forEach((b) => b.classList.toggle("active", b.dataset.group === wf.group));
  const cats = [...new Set((watchData?.items ?? []).filter((w) => !wf.group || watchGroup(w) === wf.group).map((w) => w.category).filter(Boolean))].sort();
  if (wf.cat && !cats.includes(wf.cat)) wf.cat = "";
  $("#watch-cat").innerHTML = `<option value="">All categories</option>` + cats.map((c) => `<option${c === wf.cat ? " selected" : ""}>${esc(c)}</option>`).join("");
  $("#watch-trend").value = wf.trend; $("#watch-model").value = wf.model; $("#watch-supply").value = wf.supply;
  $("#watch-buyonly").checked = wf.buyOnly; $("#watch-q").value = wf.q;
}
for (const [id, key] of [["#watch-cat", "cat"], ["#watch-trend", "trend"], ["#watch-model", "model"], ["#watch-supply", "supply"]])
  $(id).addEventListener("change", (e) => { wf[key] = e.target.value; saveWf(); renderWatch(); });
$("#watch-buyonly").addEventListener("change", (e) => { wf.buyOnly = e.target.checked; saveWf(); renderWatch(); });
$("#watch-q").addEventListener("input", (e) => { wf.q = e.target.value; saveWf(); renderWatch(); });
$("#watch-group").addEventListener("click", (e) => { const b = e.target.closest("[data-group]"); if (!b) return; wf.group = b.dataset.group; saveWf(); renderWatch(); });
$("#watch-reset").addEventListener("click", () => { Object.assign(wf, { group: "", cat: "", trend: "", model: "", supply: "", buyOnly: false, q: "" }); saveWf(); renderWatch(); });

async function showWatch() {
  watchData = await api("/api/watch");
  renderWatch();
}
function renderWatch() {
  const d = watchData;
  if (!d) return;
  syncWatchFilters();
  const rows = d.items.filter(watchOk);
  $("#watch-count").textContent = `${rows.length} of ${d.items.length} items`;
  $("#watch-intro").textContent = `Rechecked every ${d.hours} hours on ${d.house}. You get a notification when an item's trend, forecast, other realms or supply changes, when its price moves 15%+ since the last alert, or when it drops to your buy price. Items with a buy price are on the [WATCH] Auctionator list (/reload in game).`;
  $("#watch-rows").innerHTML = rows.map((w) => {
    const s = w.signals;
    if (!s) return `<tr data-id="${w.itemId}"><td>${itemCell(w)}</td><td colspan="7" class="muted">not checked yet</td><td><button class="btn small" data-unwatch="${w.itemId}">Remove</button></td></tr>`;
    const m = s.model;
    const under = w.buyBelow && s.price && s.price <= w.buyBelow;
    return `<tr data-id="${w.itemId}">
      <td>${itemCell(w)}</td>
      <td class="num">${money(s.price)}${s.priceTs ? `<div class="why">${num(s.qty)} listed · ${ago(s.priceTs)}</div>` : ""}</td>
      <td class="num">${w.buyBelow ? `${money(w.buyBelow)}${under ? `<div><span class="badge flip">Buy now</span></div>` : s.price ? `<div class="why">${pct(s.price / w.buyBelow - 1, 0)} away</div>` : ""}` : `<span class="muted">—</span>`}</td>
      <td>${watchLabel(s.labels.trend, `${pct(s.trend4)}/day · 7d ${pct(s.trend7)}/day`)}</td>
      <td>${watchLabel(s.labels.supply, `${pct(s.supply7)}/day`)}</td>
      <td>${m ? watchLabel(s.labels.model, `${m.horizon}: ${money(m.q50, { html: false })} (${pct(m.change)}) · ${Math.round(m.pUp * 100)}% up<br>range ${money(m.q10, { html: false })} – ${money(m.q90, { html: false })}`) : `<span class="muted">no forecast</span>`}</td>
      <td>${watchLabel(s.labels.realms, s.realms7 == null ? "" : `${pct(s.realms7)}/day · ${s.realmsCount} realms`)}</td>
      <td class="muted">${ago(w.checkedAt)}</td>
      <td><button class="btn small" data-unwatch="${w.itemId}">Remove</button></td>
    </tr>`;
  }).join("") || `<tr><td colspan="9" class="muted">${d.items.length ? "No watched items match these filters." : "Nothing watched yet."}</td></tr>`;
}
const postWatch = (body) => fetch("/api/watch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
$("#watch-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#watch-item").value.trim(), goldText = $("#watch-gold").value.trim();
  const g = goldText === "" ? null : Number(goldText);
  if (g !== null && (!Number.isFinite(g) || g <= 0)) { $("#watch-msg").textContent = "Use a gold amount, e.g. 8.5"; return; }
  const hits = await api(`/api/search?q=${encodeURIComponent(name)}`);
  const id = (hits.find((h) => h.name?.toLowerCase() === name.toLowerCase()) ?? hits[0])?.itemId;
  if (!id) { $("#watch-msg").textContent = "No item by that name"; return; }
  const res = await postWatch({ itemId: id, buyBelow: g === null ? null : Math.round(g * 10000) });
  $("#watch-msg").textContent = res.ok ? "Saved" : "Could not save";
  if (res.ok) { $("#watch-item").value = ""; $("#watch-gold").value = ""; showWatch(); }
});
$("#watch-item").addEventListener("input", async (e) => {
  const q = e.target.value.trim();
  if (q.length < 3) return;
  const hits = await api(`/api/search?q=${encodeURIComponent(q)}`);
  $("#watch-items").innerHTML = hits.slice(0, 15).map((h) => `<option value="${esc(h.name)}">`).join("");
});
$("#watch-check").addEventListener("click", async () => {
  $("#watch-msg").textContent = "Checking…";
  const r = await postWatch({ check: true }).then((x) => x.json());
  $("#watch-msg").textContent = r.changes?.length ? `${r.changes.length} changed: see Notifications` : "No changes";
  showWatch();
});
$("#watch-rows").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-unwatch]");
  if (b) { await postWatch({ itemId: Number(b.dataset.unwatch), remove: true }); return showWatch(); }
  const tr = e.target.closest("tr[data-id]");
  if (tr) location.hash = `#/item/${tr.dataset.id}`;
});

// ---------- crafting: alchemy and cooking recipes priced from current Alliance prices ----------
const cf = { prof: "", pays: false, transmute: false, minPrice: 0, minSold: 0, priced: true, q: "" };
try { Object.assign(cf, JSON.parse(localStorage.getItem("ah-craft") || "{}")); } catch { /* storage unavailable */ }
const saveCf = () => { try { localStorage.setItem("ah-craft", JSON.stringify(cf)); } catch { /* storage unavailable */ } };
const craftSort = { key: "profit", dir: "desc" };
let craftData = null;
const cooldownText = (s) => (s >= 86400 ? `${Math.round(s / 3600 / 24 * 10) / 10} days` : s >= 3600 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 60)} min`);
async function showCrafting() {
  craftData = await api("/api/crafting");
  $("#craft-intro").innerHTML = `Every WoW Forever alchemy and cooking recipe, priced from ${esc(craftData.house)} now: reagents at what buying them costs (vendor reagents <b>(v)</b> estimated at the vendor), the result at the lower of its cheapest listing and its usual price, profit after the 5% cut and expected lost deposits. <b>Profitable</b> = at least your ${Math.round(craftData.minMargin * 100)}% margin and ${craftData.minSoldPerDay}+ sold a day; you get a notification when a recipe becomes profitable. Recipes: ${esc(craftData.source)}.`;
  renderCrafting();
}
function renderCrafting() {
  if (!craftData) return;
  document.querySelectorAll("#craft-prof [data-prof]").forEach((b) => b.classList.toggle("active", b.dataset.prof === cf.prof));
  $("#craft-pays").checked = cf.pays; $("#craft-transmute").checked = cf.transmute; $("#craft-priced").checked = cf.priced;
  $("#craft-min-price").value = cf.minPrice || ""; $("#craft-min-sold").value = cf.minSold || ""; $("#craft-q").value = cf.q;
  const q = cf.q.trim().toLowerCase();
  const rows = applySort(craftData.rows.filter((r) => (!cf.prof || r.profession === cf.prof) && (!cf.pays || r.pays)
    && (!cf.transmute || r.recipe.startsWith("Transmute")) && (!cf.priced || r.profit !== null)
    && (!cf.minPrice || (r.sellEach ?? 0) >= cf.minPrice * 10000) && (!cf.minSold || r.soldPerDay >= cf.minSold)
    && (!q || r.recipe.toLowerCase().includes(q) || r.name.toLowerCase().includes(q) || r.reagents.some((g) => g.name.toLowerCase().includes(q)))), craftSort, "#craft-head");
  $("#craft-count").textContent = `${rows.length} of ${craftData.rows.length} recipes · ${craftData.rows.filter((r) => r.pays).length} profitable now`;
  $("#craft-rows").innerHTML = rows.map((r) => {
    const reag = r.reagents.map((g) => `<span class="${g.unit === null ? "bad" : ""}" title="${g.unit === null ? "no recent price" : esc(money(g.unit, { html: false })) + " each"}">${g.qty}× ${esc(g.name)}${g.vendor ? " (v)" : ""}</span>`).join(", ");
    const extra = [r.yield !== 1 ? `makes ${r.yield}` : "", r.cooldown ? `${cooldownText(r.cooldown)} cooldown` : ""].filter(Boolean).join(" · ");
    return `<tr data-id="${r.itemId}" class="${r.pays ? "pays" : ""}">
      <td>${itemCell(r)}${r.recipe !== r.name ? `<div class="why">${esc(r.recipe)}</div>` : ""}${extra ? `<div class="why">${esc(extra)}</div>` : ""}</td>
      <td class="num">${r.skill || "—"}</td>
      <td class="small">${reag}</td>
      <td class="num">${r.cost === null ? `<span class="muted">—</span>` : money(r.cost)}</td>
      <td class="num">${r.sellEach === null ? `<span class="muted">no price</span>` : money(r.sellEach)}${r.nowEach !== null && r.nowEach !== r.sellEach ? `<div class="why">now ${money(r.nowEach, { html: false })}</div>` : ""}</td>
      <td class="num">${r.profit === null ? "—" : `<span class="${r.profit >= 0 ? "ok" : "bad"}">${r.profit < 0 ? "−" : "+"}${money(Math.abs(r.profit))}</span>`}</td>
      <td class="num">${r.margin === null ? "—" : `<span class="${r.margin >= 0 ? "ok" : "bad"}">${pct(r.margin, 0)}</span>`}</td>
      <td class="num">${num(r.soldPerDay)}<div class="why">${Math.round(r.saleRate * 100)}% sell${r.listed !== null ? ` · ${num(r.listed)} listed` : ""}</div></td>
      <td class="small muted">${esc(r.source ?? "?")}</td>
    </tr>`;
  }).join("") || `<tr><td colspan="9" class="muted">No recipes match these filters.</td></tr>`;
}
sortable("#craft-head", craftSort, renderCrafting);
$("#craft-prof").addEventListener("click", (e) => { const b = e.target.closest("[data-prof]"); if (!b) return; cf.prof = b.dataset.prof; saveCf(); renderCrafting(); });
for (const [id, key] of [["#craft-pays", "pays"], ["#craft-transmute", "transmute"], ["#craft-priced", "priced"]])
  $(id).addEventListener("change", (e) => { cf[key] = e.target.checked; saveCf(); renderCrafting(); });
$("#craft-min-price").addEventListener("input", (e) => { cf.minPrice = Number(e.target.value) || 0; saveCf(); renderCrafting(); });
$("#craft-min-sold").addEventListener("input", (e) => { cf.minSold = Number(e.target.value) || 0; saveCf(); renderCrafting(); });
$("#craft-q").addEventListener("input", (e) => { cf.q = e.target.value; saveCf(); renderCrafting(); });
$("#craft-reset").addEventListener("click", () => { Object.assign(cf, { prof: "", pays: false, transmute: false, minPrice: 0, minSold: 0, priced: true, q: "" }); saveCf(); renderCrafting(); });
$("#craft-rows").addEventListener("click", (e) => { const tr = e.target.closest("tr[data-id]"); if (tr) location.hash = `#/item/${tr.dataset.id}`; });

// ---------- setup: WoW folder, addon, API keys (saved to .env by the server) ----------
const KEY_INFO = [
  { field: "UNDERMINE_API_KEY", label: "Undermine Exchange API key", url: "https://undermine.exchange/api.html", does: "Hourly prices for every Forever house, plus history backfill." },
  { field: "BLIZZARD_CLIENT_ID", label: "Blizzard client ID", url: "https://develop.battle.net/access/clients", does: "Live auction snapshots from the Blizzard API (needs the ID and the secret)." },
  { field: "BLIZZARD_CLIENT_SECRET", label: "Blizzard client secret", url: "https://develop.battle.net/access/clients", does: "" },
];
let setup = null;
let explorerPath = null;

async function setupPost(path, body) {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function dirStatus(c) {
  if (!c.path) return `<span class="bad">Not set.</span>`;
  if (!c.looksRight) return `<span class="bad">${esc(c.hint)}</span>`;
  const accounts = c.accounts.length ? `${c.accounts.length} WoW account${c.accounts.length > 1 ? "s" : ""} found` : esc(c.hint);
  const auc = c.auctionatorInstalled ? "" : ` · <span class="bad">Auctionator not installed</span>`;
  return `<span class="ok">✓ WoW folder</span> · ${accounts}${auc}`;
}

function renderSetup() {
  const s = setup;
  $("#setup-banner").hidden = Boolean(s.check.looksRight);
  $("#setup-env").textContent = s.envFile;
  if (document.activeElement !== $("#setup-dir")) $("#setup-dir").value = s.wowDir;
  $("#setup-dir-status").innerHTML = s.wowDir ? `Saved: ${dirStatus(s.check)}` : `<span class="bad">No folder saved yet.</span>`;
  $("#setup-found").innerHTML = s.candidates.length
    ? `<p>Found on this computer:</p><ul class="found">${s.candidates.map((p) => `<li><code>${esc(p)}</code> <button class="btn small" data-use="${esc(p)}" type="button">Use this</button></li>`).join("")}</ul>`
    : "";
  $("#setup-install").disabled = !s.check.looksRight;
  $("#setup-install").textContent = s.check.addonInstalled ? "Update addon" : "Install addon";
  $("#setup-addon-status").innerHTML = !s.check.looksRight ? `<span class="muted">Save the WoW folder first.</span>`
    : s.check.addonInstalled ? `<span class="ok">✓ Installed</span>` : `<span class="muted">Not installed yet.</span>`;
  $("#setup-keys").innerHTML = KEY_INFO.map((k) => `
    <div class="key-row">
      <label for="key-${k.field}"><b>${esc(k.label)}</b> ${s.keys[k.field] ? `<span class="ok">✓ saved</span>` : `<span class="muted">not set</span>`}</label>
      <div class="muted small">${esc(k.does)} ${k.does ? `Get one at <a href="${esc(k.url)}" target="_blank" rel="noopener">${esc(new URL(k.url).host)}</a>.` : ""}</div>
      <div class="setup-row">
        <input id="key-${k.field}" type="password" autocomplete="off" spellcheck="false" placeholder="${s.keys[k.field] ? "Saved. Type to replace" : "Paste key"}">
        <button class="btn primary" data-key-save="${k.field}" type="button">Save</button>
        ${s.keys[k.field] ? `<button class="btn" data-key-clear="${k.field}" type="button">Remove</button>` : ""}
      </div>
    </div>`).join("");
}

async function showSetup() {
  setup = await (await fetch("/api/setup")).json();
  renderSetup();
}

async function saveDir(path) {
  try {
    setup = await setupPost("/api/setup", { WOW_FOREVER_DIR: path });
    renderSetup();
    $("#setup-explorer").hidden = true;
    showToast({ href: "#/setup", title: "WoW folder saved", body: setup.check.addonInstalled ? "Scans will be imported within a minute." : "Next: install the addon." });
  } catch (err) {
    $("#setup-dir-status").innerHTML = `<span class="bad">${esc(err.message)}</span>`;
  }
}

async function openExplorer(path) {
  const r = await (await fetch(`/api/setup/dirs?path=${encodeURIComponent(path ?? "")}`)).json();
  explorerPath = r.path;
  $("#setup-explorer").hidden = false;
  $("#explorer-places").innerHTML = r.places.map((p) => `<button class="btn small" data-go="${esc(p.path)}" type="button">${esc(p.label)}</button>`).join("");
  $("#explorer-path").textContent = r.path;
  $("#explorer-up").disabled = !r.parent;
  $("#explorer-up").dataset.go = r.parent ?? "";
  const sep = setup?.platform === "win32" ? "\\" : "/";
  const join = (a, b) => (a.endsWith(sep) ? a + b : a + sep + b);
  $("#explorer-list").innerHTML = r.error ? `<li class="bad">${esc(r.error)}</li>`
    : r.dirs.length ? r.dirs.map((d) => `<li data-go="${esc(join(r.path, d))}"${d === "_forever_" ? ' class="hl"' : ""}>📁 ${esc(d)}</li>`).join("")
    : `<li class="muted">No folders here</li>`;
  const c = await (await fetch(`/api/setup/check?path=${encodeURIComponent(r.path)}`)).json();
  $("#explorer-check").innerHTML = c.looksRight ? `<span class="ok">✓ This is a WoW folder</span>` : esc(c.hint ?? "");
  $("#explorer-pick").disabled = !c.looksRight;
}

$("#setup-browse").addEventListener("click", () => openExplorer($("#setup-dir").value || setup?.wowDir || ""));
$("#setup-dir-save").addEventListener("click", () => saveDir($("#setup-dir").value));
$("#setup-dir").addEventListener("keydown", (e) => { if (e.key === "Enter") saveDir(e.target.value); });
$("#explorer-pick").addEventListener("click", () => saveDir(explorerPath));
$("#setup-explorer").addEventListener("click", (e) => {
  const el = e.target.closest("[data-go]");
  if (el && el.dataset.go) openExplorer(el.dataset.go);
});
$("#setup-found").addEventListener("click", (e) => { const b = e.target.closest("[data-use]"); if (b) saveDir(b.dataset.use); });
$("#setup-install").addEventListener("click", async () => {
  $("#setup-addon-status").textContent = "Installing…";
  try {
    const r = await setupPost("/api/setup/install-addon");
    setup = r.setup;
    renderSetup();
    $("#setup-addon-status").innerHTML = `<span class="ok">✓ Installed to</span> <code>${esc(r.dest)}</code>. Type <code>/reload</code> in game.`;
  } catch (err) {
    $("#setup-addon-status").innerHTML = `<span class="bad">${esc(err.message)}</span>`;
  }
});
$("#setup-keys").addEventListener("click", async (e) => {
  const save = e.target.closest("[data-key-save]"), clear = e.target.closest("[data-key-clear]");
  const field = save?.dataset.keySave ?? clear?.dataset.keyClear;
  if (!field) return;
  const value = save ? $(`#key-${field}`).value.trim() : "";
  if (save && !value) return $(`#key-${field}`).focus();
  try {
    setup = await setupPost("/api/setup", { [field]: value });
    renderSetup();
    showToast({ href: "#/setup", title: save ? "Key saved" : "Key removed", body: "The collector picks it up within a minute." });
  } catch (err) {
    showToast({ href: "#/setup", title: "Could not save", body: err.message });
  }
});
// Show the "finish setup" banner on any page until the WoW folder is set.
fetch("/api/setup").then((r) => r.json()).then((s) => { setup = s; $("#setup-banner").hidden = Boolean(s.check.looksRight); }).catch(() => {});

// ---------- routing ----------
async function route() {
  const hash = location.hash || "#/overview";
  const view = ["notifications", "watch", "crafting", "overview", "flips", "shuffles", "forecasts", "materials", "health", "browse", "opportunities", "anomalies", "calc", "inventory", "setup"].find((v) => hash.startsWith(`#/${v}`)) ?? "items";
  for (const v of ["notifications", "watch", "crafting", "overview", "flips", "shuffles", "forecasts", "materials", "items", "browse", "health", "opportunities", "anomalies", "calc", "inventory", "setup"]) $(`#view-${v}`).hidden = view !== v;
  document.querySelectorAll("nav a").forEach((a) => a.classList.toggle("active", a.dataset.nav === view));
  try {
    if (view === "notifications") { setTitle("Notifications"); return await showNotifications(); }
    if (view === "overview") { setTitle("Overview"); return await showOverview(); }
    if (view === "watch") { setTitle("Watchlist"); return await showWatch(); }
    if (view === "crafting") { setTitle("Crafting"); return await showCrafting(); }
    if (view === "flips") { setTitle("Flips"); return await showFlips(); }
    if (view === "forecasts") { setTitle("Forecasts", houseName()); return await showForecasts(); }
    if (view === "shuffles") { setTitle("Enchanting shuffles"); return await showShuffles(); }
    if (view === "materials") { setTitle("Materials", houseName()); return await showMaterials(); }
    if (view === "health") { setTitle("Data health"); return await showHealth(); }
    if (view === "setup") { setTitle("Setup"); return await showSetup(); }
    if (view === "opportunities") { setTitle(`Opportunities · ${TAB_LABEL[oppKind]}`, oppKind === "cross-house" ? "" : houseName()); return await showOpportunities(); }
    if (view === "anomalies") { setTitle("Anomalies", houseName()); return await showAnomalies(); }
    if (view === "calc") { setTitle("Profit calculator"); return await showCalc(); }
    if (view === "inventory") { setTitle("Inventory"); return await showInventory(); }
    if (view === "browse") { setTitle(`Browse · ${browse.title}`, houseName()); loadCategories(); return await showBrowse(); }
    const m = /^#\/item\/(\d+)/.exec(hash);
    if (m) await showItem(Number(m[1]));
    else await showHome();
  } catch (err) {
    console.error(err);
  }
}
window.addEventListener("hashchange", route);

// ---------- sync ----------
async function showLastUpdate() {
  try {
    const d = await api("/api/last-update");
    $("#last-update").textContent = d.lastSnapshot ? `prices from ${ago(d.lastSnapshot)}` : "";
  } catch { /* dashboard restarting */ }
}
let syncMsgTimer;
function syncMessage(text, bad = false) {
  const el = $("#sync-msg");
  el.textContent = text;
  el.classList.toggle("bad", bad);
  el.hidden = false;
  clearTimeout(syncMsgTimer);
  syncMsgTimer = setTimeout(() => { el.hidden = true; }, 12000);
}
$("#sync-msg").addEventListener("click", () => { $("#sync-msg").hidden = true; });
$("#sync").addEventListener("click", async () => {
  const btn = $("#sync");
  btn.disabled = true;
  btn.textContent = "Syncing…";
  try {
    const res = await fetch("/api/sync", { method: "POST" });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
    // Show the parts people care about: new scans/snapshots, statistics, shopping lists.
    const lines = out.lines.map((l) => l.replace(/ from \/.*AHTracker\.lua/, "")).join("\n");
    syncMessage(`Synced in ${(out.ms / 1000).toFixed(1)} s\n${lines}\nYour own Auctionator scans arrive after /reload in game.`);
    await showLastUpdate();
    route();
  } catch (err) {
    syncMessage(`Sync failed: ${err.message}`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = "Sync now";
  }
});
setInterval(showLastUpdate, 60_000);

(async function init() {
  const houses = await api("/api/houses");
  housesList = houses;
  if (!houses.some((h) => h.key === house)) house = houses[0].key;
  $("#house").innerHTML = houses.map((h) => `<option value="${h.key}"${h.key === house ? " selected" : ""}>${esc(h.label)}</option>`).join("");
  $("#house").addEventListener("change", (e) => {
    house = e.target.value;
    try { localStorage.setItem("ah-house", house); } catch { /* storage unavailable */ }
    runSearch($("#search").value);
    route();
  });
  runSearch("");
  route();
  showLastUpdate();
})();

$("#item-target").addEventListener("change", async (e) => {
  if (!currentItem) return;
  const ok = await setTarget(currentItem, e.target.value);
  $("#item-target-msg").textContent = ok ? (e.target.value.trim() ? " · saved: you will get a desktop notification" : " · removed") : " · use a gold amount, e.g. 20 or 1.5";
});
