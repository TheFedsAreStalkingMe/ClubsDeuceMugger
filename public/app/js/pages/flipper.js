// The Flipper page (/app/flipper.html): filters, the flips table, the detail panel, the watchlist and notifications.
// All the maths happens on the server (src/flipper/*); this page asks for the flips with the chosen filters and shows them.

import { api } from "/js/core/api.js";
import { $, el } from "/js/core/dom.js";
import { STORE, load, save } from "/js/core/storage.js";
import { watchForUpdates } from "/js/core/update.js";
import { fmtAge, fmtCoins, fmtPct, parseCoins } from "../flipper/format.js";
import { COLUMNS, TYPE_LABEL, fillAuctionDetail, fillDetail, flipRow, renderHead } from "../flipper/view.js";

const TYPES = ["bazaar-order", "craft", "npc-reverse", "npc-sell", "ah-bin", "bazaar-instant"];
const SAFETY = [["volume", "Minimum volume"], ["thin", "Thin markets"], ["outlier", "Outlier orders"], ["spread", "Too-good spreads"], ["volatility", "Volatility"], ["trend", "Falling / spiking prices"], ["cosmetic", "Cosmetic items"]];
const TEXT_FIELDS = ["purse", "minProfit", "maxCost", "minCph", "minVolume", "q"];
const NUM_FIELDS = ["orderSize", "minRoi", "tax"];

const defaults = {
  types: ["bazaar-order", "craft", "npc-reverse", "npc-sell", "ah-bin"], purse: "", orderSize: "", minProfit: "10k", minRoi: "", maxCost: "", minCph: "", minVolume: "", tax: "", q: "",
  confidence: "Med", sort: "score", weights: { margin: 4, speed: 4, reliability: 3 }, off: [], auto: true, watchOnly: false, notify: false,
};
const prefs = { ...defaults, ...load(STORE.flipper, {}) };
prefs.weights = { ...defaults.weights, ...(prefs.weights || {}) };
const persist = () => save(STORE.flipper, prefs);

let watched = new Set();
let lastIds = null; // flips seen on the previous refresh (for notifications)
let timer = null;
let busy = false;
let again = false; // a refresh was asked for while one was running: run once more when it ends
let lastData = null; // the last answer, so the watchlist star can redraw without asking again
let openItem = null;

// ---------------------------------------------------------------- controls

function buildControls() {
  $("fl-types").replaceChildren(...TYPES.map((t) => {
    const box = el("input", { type: "checkbox" });
    box.checked = prefs.types.includes(t);
    box.addEventListener("change", () => { prefs.types = box.checked ? [...new Set([...prefs.types, t])] : prefs.types.filter((x) => x !== t); persist(); refresh(); });
    return el("label", { class: "check" }, box, ` ${TYPE_LABEL[t]}`);
  }));
  $("fl-safety").replaceChildren(...SAFETY.map(([key, label]) => {
    const box = el("input", { type: "checkbox" });
    box.checked = !prefs.off.includes(key);
    box.addEventListener("change", () => { prefs.off = box.checked ? prefs.off.filter((x) => x !== key) : [...new Set([...prefs.off, key])]; persist(); refresh(); });
    return el("label", { class: "check" }, box, ` ${label}`);
  }));
  for (const f of [...TEXT_FIELDS, ...NUM_FIELDS]) {
    const input = $(`f-${f}`);
    input.value = prefs[f] ?? "";
    input.addEventListener("input", () => { prefs[f] = input.value; persist(); debounced(); });
  }
  for (const f of ["confidence", "sort"]) {
    const sel = $(`f-${f}`);
    sel.value = prefs[f];
    sel.addEventListener("change", () => { prefs[f] = sel.value; persist(); refresh(); });
  }
  for (const w of ["margin", "speed", "reliability"]) {
    const r = $(`w-${w}`);
    r.value = prefs.weights[w];
    r.addEventListener("input", () => { prefs.weights[w] = Number(r.value); persist(); debounced(); });
  }
  for (const [id, key] of [["f-auto", "auto"], ["f-watchonly", "watchOnly"], ["f-notify", "notify"]]) {
    const box = $(id);
    box.checked = !!prefs[key];
    box.addEventListener("change", async () => {
      prefs[key] = box.checked;
      if (key === "notify" && box.checked) {
        if (!("Notification" in window)) { box.checked = prefs.notify = false; message("This browser does not support notifications.", "err"); }
        else if (Notification.permission !== "granted" && (await Notification.requestPermission()) !== "granted") { box.checked = prefs.notify = false; message("Notifications were not allowed in this browser.", "err"); }
      }
      persist();
      schedule();
      if (key === "watchOnly") refresh();
    });
  }
  $("fl-refresh").addEventListener("click", () => refresh());
}

let debounceTimer = null;
const debounced = () => { clearTimeout(debounceTimer); debounceTimer = setTimeout(refresh, 400); };

function query() {
  const q = new URLSearchParams();
  q.set("type", prefs.types.join(","));
  q.set("sort", prefs.sort);
  q.set("confidence", prefs.confidence);
  q.set("limit", prefs.watchOnly ? "500" : "150");
  const money = { purse: parseCoins(prefs.purse), minProfit: parseCoins(prefs.minProfit), maxCost: parseCoins(prefs.maxCost), minCph: parseCoins(prefs.minCph), minVolume: parseCoins(prefs.minVolume) };
  for (const [k, v] of Object.entries(money)) if (v > 0) q.set(k, String(v));
  if (Number(prefs.orderSize) > 0) q.set("orderSize", String(Math.floor(Number(prefs.orderSize))));
  if (Number(prefs.minRoi) > 0) q.set("minRoi", String(prefs.minRoi));
  if (prefs.tax !== "" && Number.isFinite(Number(prefs.tax))) q.set("tax", String(prefs.tax));
  if (prefs.q) q.set("q", prefs.q);
  if (prefs.off.length) q.set("off", prefs.off.join(","));
  const w = prefs.weights;
  if (w.margin + w.speed + w.reliability > 0) q.set("weights", `${w.margin},${w.speed},${w.reliability}`);
  return q.toString();
}

// ---------------------------------------------------------------- the table

const message = (text, kind = "info") => { const m = $("fl-msg"); m.className = `msg ${kind}`; m.textContent = text; };

function showAges(ages) {
  const set = (id, label, seconds, stale) => { const e = $(id); e.textContent = `${label}: ${seconds == null ? "no data" : `${fmtAge(seconds)} old`}`; e.className = `fl-age ${seconds == null || stale ? "stale" : "fresh"}`; };
  set("age-bz", "Bazaar", ages.bazaarSeconds, ages.bazaarStale);
  set("age-ah", "Auctions", ages.auctionSeconds, ages.auctionStale);
  $("fl-updated").textContent = `Updated: ${new Date().toLocaleTimeString()}`;
}

function draw(data) {
  let rows = data.flips;
  if (prefs.watchOnly) rows = rows.filter((f) => watched.has(f.id));
  renderHead($("fl-head"), prefs.sort, (key) => { prefs.sort = key; $("f-sort").value = key; persist(); refresh(); });
  $("fl-body").replaceChildren(...rows.map((f) => flipRow(f, watched, { open: openDetail, star: toggleWatch })));
  $("fl-count").textContent = rows.length
    ? `Showing ${rows.length} of ${data.total} flips (${data.computed} found before your filters). Bazaar tax ${(data.config.tax * 100).toFixed(2)}%.`
    : "No flips match your filters right now. Try a lower confidence level, a smaller minimum profit or more flip types.";
  if (!rows.length) $("fl-body").replaceChildren(el("tr", {}, el("td", { colspan: String(COLUMNS.length), class: "hint", text: "No flips to show." })));
}

function notifyNew(flips) {
  const ids = new Set(flips.map((f) => `${f.type}:${f.id}:${f.uuid || ""}`));
  if (lastIds && prefs.notify && "Notification" in window && Notification.permission === "granted") {
    const fresh = flips.filter((f) => !lastIds.has(`${f.type}:${f.id}:${f.uuid || ""}`)).slice(0, 3);
    for (const f of fresh) new Notification(`Flip: ${f.name}`, { body: `${TYPE_LABEL[f.type]} - net ${Math.round(f.totalProfit).toLocaleString("en-US")} coins (${f.roiPct.toFixed(1)}% ROI, ${f.confidence} confidence)` });
  }
  lastIds = ids;
}

async function refresh() {
  if (busy) { again = true; return; }
  busy = true;
  try {
    const data = await api(`/api/flipper/flips?${query()}`);
    lastData = data;
    showAges(data.ages);
    draw(data);
    notifyNew(data.flips);
    const stale = data.ages.bazaarStale ? "The Bazaar data is stale: the collector may be paused or Hypixel is down. These prices may be out of date." : "";
    message([stale, ...data.notes].filter(Boolean).join(" "), stale ? "err" : "info");
  } catch (e) {
    message(`Could not load flips: ${e.message}`, "err");
  } finally {
    busy = false;
    if (again) { again = false; refresh(); }
  }
}

function schedule() {
  clearInterval(timer);
  if (prefs.auto) timer = setInterval(() => { if (document.visibilityState === "visible") refresh(); }, 20000);
}

// ---------------------------------------------------------------- watchlist and detail

async function loadWatch() {
  try { watched = new Set((await api("/api/flipper/watch")).items); } catch { /* the table still works */ }
}

async function toggleWatch(f) {
  const on = !watched.has(f.id);
  try { watched = new Set((await api("/api/flipper/watch", { method: "POST", body: { item: f.id, on } })).items); } catch (e) { return message(e.message, "err"); }
  if (lastData) draw(lastData);
  if (prefs.watchOnly) refresh();
  if (openItem === f.id) $("d-watch").textContent = watched.has(f.id) ? "Unwatch" : "Watch";
}

async function openDetail(f) {
  const parts = { title: $("d-title"), sub: $("d-sub"), chart: $("d-chart"), source: $("d-source"), ask: $("d-ask"), bid: $("d-bid"), notes: $("d-notes") };
  if (f.type === "ah-bin") {
    openItem = null;
    fillAuctionDetail(f, parts);
    $("d-watch").hidden = true;
    $("fl-detail").hidden = false;
    $("fl-detail").scrollIntoView({ block: "nearest" });
    return;
  }
  $("d-watch").hidden = false;
  openItem = f.id;
  try {
    const d = await api(`/api/flipper/item?id=${encodeURIComponent(f.id)}`);
    fillDetail(d, parts);
    $("d-watch").textContent = d.watched ? "Unwatch" : "Watch";
    $("fl-detail").hidden = false;
    $("fl-detail").scrollIntoView({ block: "nearest" });
  } catch (e) { message(e.message, "err"); }
}

// ---------------------------------------------------------------- the NPC price floor

async function loadFloor() {
  try {
    const d = await api("/api/flipper/floor");
    $("fl-floor-body").replaceChildren(...d.rows.slice(0, 150).map((r) => el("tr", { class: r.belowFloor ? "fl-below" : "" },
      el("td", { text: r.name }), el("td", { text: fmtCoins(r.npcPrice) }), el("td", { text: r.bid == null ? "-" : fmtCoins(r.bid) }), el("td", { text: r.ask == null ? "-" : fmtCoins(r.ask) }),
      el("td", { text: r.shopPrice ? fmtCoins(r.shopPrice) : "-" }), el("td", { text: r.floorVsBidPct == null ? "-" : `${r.floorVsBidPct >= 0 ? "+" : ""}${fmtPct(r.floorVsBidPct)}${r.belowFloor ? " (below floor)" : ""}` }))));
    $("fl-floor-count").textContent = `${d.total} items NPCs buy are on the Bazaar; ${d.belowFloor} have a best buy order under the NPC price (showing the first ${Math.min(150, d.rows.length)}).`;
  } catch (e) { $("fl-floor-count").textContent = e.message; }
}

// ---------------------------------------------------------------- start

async function boot() {
  try { $("who").textContent = (await api("/api/me")).username; } catch { return; }
  buildControls();
  $("d-close").addEventListener("click", () => { $("fl-detail").hidden = true; openItem = null; });
  $("d-watch").addEventListener("click", () => openItem && toggleWatch({ id: openItem }));
  $("logout").addEventListener("click", async () => {
    try { await api("/api/logout", { method: "POST", body: {} }); } catch { /* sign out anyway */ }
    location.href = "/";
  });
  $("fl-floor").addEventListener("toggle", () => { if ($("fl-floor").open) loadFloor(); });
  await loadWatch();
  await refresh();
  schedule();
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refresh(); });
  watchForUpdates();
}

boot();
