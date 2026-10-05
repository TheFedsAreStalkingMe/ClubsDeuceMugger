// Buymugging: weapons and armor in bazaars that carry a BONUS (Plunder, Quicken...), sold by weaker players.
// You buy the item, the price lands in their cash, then you mug them. Bonus items sell far above the plain
// market price, so they are found differently from the bazaar finder:
//
//   1 pick items   Torn's weapon and armor lists (cached a day, kinds you ticked) + Weav3r's index; the priciest bazaar averages first
//   2 read bazaars Weav3r lists cheapest first, so the LAST page holds the expensive listings (bonus items are there)
//   3 estimates    FF Scouter for every seller of a listing at/above your minimum price, then the stat filter
//   4 bonuses      Torn's item details (25 per call) for the weak sellers' items only; keep items with a bonus
//   5 status       Torn status and account age, as in the bazaar finder
//
// Results use the same seller cards (one per seller, listing their bonus items), so alerts, sorting and live
// status checks all work on them.

import { api } from "/js/core/api.js";
import { pool } from "/js/core/async.js";
import { Cache, STORE } from "/js/core/storage.js";
import { MIN_PRICE, state } from "../state.js";
import { estimateStats } from "./estimates.js";
import { explainDrops, statVerdict, visibleRows } from "./rules.js";
import { render, tick } from "./results.js";
import { fetchStatuses } from "./scan.js";
import { tornCall } from "./torncall.js";
import { phase, setProgress, setScanMsg, updateRunButtons } from "./ui.js";
import { resetWeav3r, weav3rGaveUp, weav3rRead } from "./weav3r.js";

const STAGES = { items: phase(0, 0.1), bazaars: phase(0.1, 0.45), estimates: phase(0.45, 0.55), bonuses: phase(0.55, 0.7), status: phase(0.7, 1) };
const isCancel = (e) => e && e.message === "cancelled";
const DAY = 24 * 3600e3;
const READS_AT_ONCE = 4;

class Stop extends Error {
  constructor(message, kind = "info", progress = null) { super(message); Object.assign(this, { kind, progress }); }
}

// ---------------------------------------------------------------- 1. pick items

// Weapon and armor ids with their kind (Primary, Secondary, Melee, Armor) from Torn, remembered for a day.
// Temporary weapons are left out by the server: they cannot carry bonuses.
async function itemKinds(runId) {
  const cache = new Cache(STORE.items, 20);
  const hit = cache.get("kinds");
  if (hit && Date.now() - hit.t < DAY) return hit.kinds;
  const kinds = {};
  for (const cat of ["Weapon", "Armor"]) {
    const r = await tornCall(`/api/torn/itemlist?cat=${cat}`, runId);
    for (const i of r.items) kinds[i.id] = i.cat;
  }
  cache.put("kinds", { t: Date.now(), kinds });
  cache.flush();
  return kinds;
}

async function pickItems(call, f, runId) {
  const kinds = await itemKinds(runId);
  const { items } = await weav3rRead(call, "/api/weav3r?item=all", runId);
  const picked = items
    .filter((i) => f.bmCats.includes(kinds[i.id]) && i.bazaars > 0)
    .sort((a, b) => (b.average || b.price) - (a.average || a.price)) // bonus items pull the bazaar average up
    .slice(0, f.bmItems);
  if (!picked.length) throw new Stop("No weapons or armor are listed in bazaars right now.", "info", 1);
  return picked;
}

// ---------------------------------------------------------------- 2. read the expensive end of each bazaar list

// Listings at or above the minimum price, one item each (bonus items are unique: quantity 1 with an id).
async function readExpensive(call, items, f, runId) {
  const found = []; // { itemId, itemName, market, listing }
  let done = 0;
  const take = (item, data) => {
    for (const l of data.listings) {
      if (l.uid && l.quantity === 1 && l.price >= f.bmMinPrice) found.push({ itemId: item.id, itemName: data.item_name || item.name, market: data.market_price || item.price, listing: l });
    }
  };
  await pool(items, READS_AT_ONCE, async (item) => {
    if (runId !== state.runId) return;
    try {
      const first = await weav3rRead(call, `/api/weav3r?item=${item.id}`, runId);
      const pages = Math.ceil((first.total || first.listings.length) / 100);
      if (pages <= 1) take(item, first);
      else {
        const last = await weav3rRead(call, `/api/weav3r?item=${item.id}&page=${pages}`, runId);
        take(item, last);
        if (last.listings.length < 40 && pages > 2) take(item, await weav3rRead(call, `/api/weav3r?item=${item.id}&page=${pages - 1}`, runId)); // the last page was short
      }
    } catch (e) {
      if (!isCancel(e) && runId === state.runId && !weav3rGaveUp()) setScanMsg(`Item ${item.id}: ${e.message}`, "err");
    }
    STAGES.bazaars(++done / items.length);
    if (runId === state.runId) setScanMsg(`Reading bazaars ${done}/${items.length}...`);
  });
  return found;
}

// ---------------------------------------------------------------- 4. bonuses

async function bonusesOf(uids, runId) {
  const out = new Map(); // uid -> { bonuses, rarity }
  let done = 0;
  const batches = [];
  for (let i = 0; i < uids.length; i += 25) batches.push(uids.slice(i, i + 25));
  for (const batch of batches) {
    if (runId !== state.runId) throw new Error("cancelled");
    const r = await tornCall(`/api/torn/itemdetails?uids=${batch.join(",")}`, runId);
    for (const d of r.items) out.set(String(d.uid), d);
    STAGES.bonuses(++done / batches.length);
    setScanMsg(`Checking bonuses ${done}/${batches.length}...`);
  }
  return out;
}

// ---------------------------------------------------------------- the scan

export async function scanBuymug() {
  const runId = ++state.runId;
  const f = state.filters;
  state.mode = "buymug";
  state.outcome = "retry";
  if (!state.keys.torn) { state.mode = "hunt"; return setScanMsg("Add your Torn key in Settings first.", "err"); }

  state.ctrl = new AbortController();
  const call = (path, opts = {}) => api(path, { ...opts, signal: state.ctrl.signal });
  state.scanning = true;
  document.getElementById("scan").disabled = true;
  updateRunButtons();
  state.rows = [];
  render();
  resetWeav3r();
  setProgress(0);
  setScanMsg("Picking weapons and armor...");

  try {
    const items = await pickItems(call, f, runId);
    STAGES.items(1);
    const listings = await readExpensive(call, items, f, runId);
    if (runId !== state.runId) return;
    if (!listings.length) throw new Stop(`No weapon or armor listings at ${Math.round(f.bmMinPrice / 1e5) / 10}m or more in ${items.length} items.${weav3rGaveUp() ? " Weav3r was busy, so some were skipped." : ""}`, "info", 1);

    // sellers, then stats for all of them and the stat filter
    const bySeller = new Map();
    for (const l of listings) {
      const s = bySeller.get(l.listing.player_id) || { id: l.listing.player_id, name: l.listing.player_name, found: [] };
      s.found.push(l);
      bySeller.set(s.id, s);
    }
    const estimates = await estimateStats(call, [...bySeller.keys()], runId, STAGES.estimates);
    if (runId !== state.runId) return;
    const why = { noEst: 0, tooStrong: 0, tooWeak: 0, ffHigh: 0 };
    const sellers = [...bySeller.values()].filter((s) => {
      const e = estimates.get(s.id) || {};
      Object.assign(s, { ff: e.ff, bs: e.bs });
      const verdict = statVerdict(s.bs, s.ff, f);
      if (verdict) why[verdict]++;
      return !verdict;
    });
    if (!sellers.length) throw new Stop(explainDrops(why, bySeller.size), "info", 1);

    // bonuses, only for the weak sellers' items, priciest first
    const candidates = sellers.flatMap((s) => s.found).sort((a, b) => b.listing.price - a.listing.price).slice(0, f.bmChecks);
    const details = await bonusesOf([...new Set(candidates.map((c) => c.listing.uid))], runId);
    const words = f.bmBonus.split(",").map((w) => w.trim().toLowerCase()).filter(Boolean);
    const wanted = (d) => d && d.bonuses.length && (!words.length || d.bonuses.some((b) => words.some((w) => b.title.toLowerCase().includes(w))));

    const rows = [];
    for (const s of sellers) {
      const items = s.found
        .filter((c) => wanted(details.get(c.listing.uid)))
        .map((c) => ({
          itemId: c.itemId, itemName: c.itemName, market: c.market, price: c.listing.price, qty: 1, total: c.listing.price,
          activity: null, bazaars: null, bonus: true,
          bonuses: details.get(c.listing.uid).bonuses.map((b) => ({ title: b.title, value: b.value })),
        }))
        .sort((a, b) => b.total - a.total);
      if (!items.length) continue;
      rows.push({ id: s.id, name: s.name, ff: s.ff, bs: s.bs, items, total: items.reduce((n, i) => n + i.total, 0), topPrice: items[0].price, activity: 0 });
    }
    rows.sort((a, b) => b.total - a.total);
    state.rows = rows.slice(0, f.maxSellers);
    render();
    if (!state.rows.length) throw new Stop(`${candidates.length} item(s) from ${sellers.length} weaker seller(s) checked, none with ${words.length ? "that" : "a"} bonus.`, "info", 1);

    const { keyProblem } = await fetchStatuses(call, state.rows, runId);
    if (runId === state.runId && !keyProblem) {
      state.outcome = "ok";
      setScanMsg(`Done. ${visibleRows().length} seller(s) with bonus items.${weav3rGaveUp() ? " Weav3r was busy, so some items were skipped." : ""}`, "ok");
      setProgress(1);
    }
    render();
    tick();
  } catch (e) {
    if (isCancel(e) || runId !== state.runId) return;
    if (e instanceof Stop) {
      state.outcome = "ok";
      setScanMsg(e.message, e.kind);
      if (e.progress != null) setProgress(e.progress);
    } else {
      setScanMsg(e.message, "err");
    }
  } finally {
    if (runId === state.runId) {
      state.scanning = false;
      document.getElementById("scan").disabled = false;
      updateRunButtons();
    }
  }
}
