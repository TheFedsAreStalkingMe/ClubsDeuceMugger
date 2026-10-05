// One scan, in stages:
//   1 choose items  ->  2 read bazaars  ->  3 FF Scouter estimates (every seller)
//   4 stat filter + keep the highest-value sellers  ->  5 Torn status
//
// Every stage checks `runId` so a cancelled scan stops quickly. "cancelled" errors are silent.

import { api } from "/js/core/api.js";
import { pool } from "/js/core/async.js";
import { fmtMoney } from "/js/core/format.js";
import { STORE, save } from "/js/core/storage.js";
import { MIN_PRICE, state } from "../state.js";
import { acquireTorn } from "./limits.js";
import { explainDrops, statVerdict, visibleRows } from "./rules.js";
import { render, scheduleRender, tick } from "./results.js";
import { STAGES, countdown, setProgress, setScanMsg, updateRunButtons } from "./ui.js";
import { estimateStats } from "./estimates.js";
import { resetWeav3r, weav3rGaveUp, weav3rRead } from "./weav3r.js";
import { applyProfile, profileFresh, profiles, recordFrom } from "./status.js";
import { renderWatch } from "./watchlist.js";

const ITEM_READS_AT_ONCE = 6;
const TORN_KEY_ERRORS = [2, 10, 13, 16];
const DONE = Symbol("item skipped"); // thrown to leave one item early
const isCancel = (e) => e && e.message === "cancelled";

// An orderly early finish (nothing to do, nothing matched). Not a crash.
class Stop extends Error {
  constructor(message, kind = "info", outcome = "ok", progress = null) {
    super(message);
    Object.assign(this, { kind, outcome, progress });
  }
}

// The cheapest single item worth looking at: stacks and added-up items can qualify below the minimum price.
function unitFloor(f) {
  if (f.minStack > 0) return MIN_PRICE;
  if (f.minPart > 0) return Math.max(MIN_PRICE, Math.min(f.minPart, f.minPrice));
  return f.minPrice;
}

// ---------------------------------------------------------------- 1. choose items

async function chooseItems(call, f) {
  const targets = new Map(state.watch.map((w) => [w.id, w])); // the watchlist is always scanned
  let indexError = "";
  if (f.autoScan) {
    try {
      const { items } = await weav3rRead(call, "/api/weav3r?item=all", state.runId);
      items
        .map((i) => ({ ...i, floor: i.lowest ?? i.price })) // floor = cheapest bazaar listing
        // With a stack worth or an add-up value set, cheaper items can still qualify, so look lower.
        .filter((i) => (unitFloor(f) < f.minPrice ? i.price >= unitFloor(f) : i.floor >= f.minPrice && i.price >= f.minPrice) && !targets.has(i.id))
        // Busiest first when sorting by trade activity (more bazaars = more traded), otherwise priciest first.
        .sort((a, b) => (f.sort === "activity" ? b.bazaars - a.bazaars || b.floor - a.floor : b.floor - a.floor))
        .slice(0, Math.max(0, f.maxItems - targets.size))
        .forEach((i) => targets.set(i.id, { id: i.id, name: i.name, auto: true, bazaars: i.bazaars }));
    } catch (e) {
      if (isCancel(e)) throw e;
      indexError = e.message;
    }
  }
  const list = [...targets.values()];
  if (list.length) return list;
  if (indexError) throw new Stop(`Could not load the item list from Weav3r: ${indexError}`, "err", "retry");
  if (f.autoScan) throw new Stop(`No items are worth ${fmtMoney(unitFloor(f))} or more. Lower the minimum price.`);
  throw new Stop("Nothing to scan. Turn on auto scan or add an item ID.", "err", "fatal");
}

// ---------------------------------------------------------------- 2. read bazaars

// A listing qualifies as a single item worth at least the minimum price, or (with a stack worth set) as a
// stack of 2+ worth at least that much in total. Returns one row per SELLER, holding every qualifying item:
//   { id, name, items: [{ itemId, itemName, market, price, qty, total, activity, bazaars }], total, topPrice, activity }
async function readBazaars(call, list, f, runId) {
  const sellers = new Map();
  const floor = unitFloor(f); // cheapest item worth looking at
  const part = f.minPart > 0 ? Math.max(MIN_PRICE, Math.min(f.minPart, f.minPrice)) : 0;
  let done = 0;
  await pool(list, ITEM_READS_AT_ONCE, async (w) => {
    if (runId === state.runId) {
      try {
        const data = await weav3rRead(call, `/api/weav3r?item=${w.id}`, runId, "Weav3r is busy. Waiting");
        if (!w.auto && data.item_name) w.name = data.item_name;
        const market = data.market_price || 0;
        if (market < floor) throw DONE; // not worth enough on the market to resell
        // Trade activity: listings that changed in the last hour (a sale, a restock or a price change).
        const asOf = data.generated_at || Date.now() / 1000;
        const activity = data.listings.filter((l) => l.updated && asOf - l.updated <= 3600).length;
        if (activity < f.minActivity) throw DONE; // too quiet to sell quickly
        for (const l of data.listings) {
          const single = l.price >= f.minPrice;
          const stack = f.minStack > 0 && l.quantity >= 2 && l.price >= MIN_PRICE && l.price * l.quantity >= f.minStack;
          const adds = part > 0 && l.price >= part; // counts toward the added-up total
          if (!single && !stack && !adds) continue;
          // only listings priced near what the item really sells for
          if (f.priceTol > 0 && market > 0 && Math.abs(l.price / market - 1) > f.priceTol / 100) continue;

          const seller = sellers.get(l.player_id) || { id: l.player_id, name: l.player_name, items: new Map(), total: 0, topPrice: 0, activity: 0, sure: false, added: 0 };
          const item = seller.items.get(w.id) || { itemId: w.id, itemName: data.item_name || w.name || `#${w.id}`, market, activity, bazaars: w.bazaars ?? null, price: l.price, qty: 0, total: 0 };
          item.price = Math.min(item.price, l.price);
          item.qty += l.quantity;
          item.total += l.price * l.quantity;
          seller.items.set(w.id, item);
          seller.total += l.price * l.quantity;
          if (single || stack) seller.sure = true;
          if (adds) seller.added += l.price * l.quantity;
          seller.topPrice = Math.max(seller.topPrice, l.price);
          seller.activity = Math.max(seller.activity, activity);
          sellers.set(l.player_id, seller);
        }
      } catch (e) {
        if (e !== DONE && runId === state.runId && !weav3rGaveUp()) setScanMsg(`Item ${w.id}: ${e.message}`, "err");
      }
    }
    STAGES.items(++done / list.length);
    if (runId === state.runId) setScanMsg(`Reading bazaars ${done}/${list.length}...`);
  });
  save(STORE.watch, state.watch);
  renderWatch();
  // A seller with only added-up items needs them to reach the minimum price together.
  return [...sellers.values()]
    .filter((s) => s.sure || s.added >= f.minPrice)
    .map((s) => ({ ...s, items: [...s.items.values()].sort((a, b) => b.total - a.total) }))
    .sort((a, b) => b.total - a.total);
}

// (3. FF Scouter estimates live in estimates.js)

// ---------------------------------------------------------------- 5. Torn status, age, last action

export async function fetchStatuses(call, rows, runId) {
  const ids = [...new Set(rows.map((r) => r.id))];
  const todo = [];
  for (const id of ids) {
    const p = profiles.get(id);
    if (profileFresh(p)) applyProfile(id, p); else todo.push(id);
  }
  render();

  let checked = ids.length - todo.length;
  let keyProblem = false;
  STAGES.status(checked / ids.length);
  await pool(todo, 3, async (id) => {
    for (;;) {
      if (runId !== state.runId || keyProblem) return;
      try {
        await acquireTorn(runId);
        const p = await call(`/api/torn/user?id=${id}`, { headers: { "X-Torn-Key": state.keys.torn } });
        if (p.error) {
          if (p.code === 5) { await countdown(30, "Torn says slow down. Waiting", runId); continue; }
          if (TORN_KEY_ERRORS.includes(p.code)) { keyProblem = true; state.outcome = "fatal"; setScanMsg(`Torn key problem: ${p.error}`, "err"); return; }
          applyProfile(id, { state: "Unknown", desc: p.error });
        } else {
          const rec = recordFrom(p);
          profiles.put(id, rec);
          applyProfile(id, rec);
        }
      } catch (e) {
        if (isCancel(e)) return;
        if (e.retryAfter) { await countdown(e.retryAfter, "Pacing Torn API calls...", runId); continue; }
        applyProfile(id, { state: "Unknown", desc: e.message });
      }
      break;
    }
    STAGES.status(++checked / ids.length);
    setScanMsg(`Checking status ${checked}/${ids.length}...`);
    scheduleRender();
  });
  profiles.flush();
  return { sellers: ids.length, keyProblem };
}

// ---------------------------------------------------------------- the scan

export async function scan() {
  const runId = ++state.runId;
  const f = state.filters;
  state.outcome = "retry";
  if (!state.keys.torn) { state.outcome = "fatal"; return setScanMsg("Add your Torn key in Settings first.", "err"); }
  if (!state.watch.length && !f.autoScan) { state.outcome = "fatal"; return setScanMsg("Turn on auto scan or add an item ID to the watchlist.", "err"); }

  state.ctrl = new AbortController();
  const call = (path, opts = {}) => api(path, { ...opts, signal: state.ctrl.signal });
  state.scanning = true;
  document.getElementById("scan").disabled = true;
  updateRunButtons();
  state.rows = [];
  render();
  setProgress(0);
  resetWeav3r();
  setScanMsg("Reading bazaars...");

  try {
    const list = await chooseItems(call, f);
    let rows = await readBazaars(call, list, f, runId);
    if (runId !== state.runId) return;

    // stats for every seller, then drop listings that fail the stat and fair fight limits
    const sellers = rows.length;
    const estimates = await estimateStats(call, rows.map((r) => r.id), runId);
    if (runId !== state.runId) return;

    const why = { noEst: 0, tooStrong: 0, tooWeak: 0, ffHigh: 0 };
    const passes = (r) => {
      const verdict = statVerdict(r.bs, r.ff, f);
      if (verdict) why[verdict]++;
      return !verdict;
    };
    rows = rows.filter((r) => {
      const e = estimates.get(r.id) || {};
      Object.assign(r, { ff: e.ff, bs: e.bs });
      return passes(r);
    });

    // only now limit to the highest-value sellers (the slower status checks come next)
    const keep = new Set();
    for (const r of rows) { if (keep.size >= f.maxSellers && !keep.has(r.id)) continue; keep.add(r.id); }
    rows = rows.filter((r) => keep.has(r.id));

    state.rows = rows;
    render();
    if (!rows.length) throw new Stop(explainDrops(why, sellers), "info", "ok", 1);

    const { sellers: checked, keyProblem } = await fetchStatuses(call, rows, runId);
    if (runId === state.runId && !keyProblem) {
      state.outcome = "ok";
      setScanMsg(`Done. ${visibleRows().length} seller(s) shown.${weav3rGaveUp() ? " Weav3r was busy, so some items were skipped." : ""}`, weav3rGaveUp() ? "info" : "ok");
      setProgress(1);
    }
    render();
    tick(); // alerts and the mug feed update now, not on the next second
  } catch (e) {
    if (isCancel(e) || runId !== state.runId) return;
    if (e instanceof Stop) {
      state.outcome = e.outcome;
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
