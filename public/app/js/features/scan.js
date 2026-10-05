// One scan, in stages:
//   1 choose items  ->  2 read bazaars  ->  3 FF Scouter estimates (every seller)
//   4 stat filter + keep the highest-value sellers  ->  5 TornStats spies  ->  6 Torn status
//
// Every stage checks `runId` so a cancelled scan stops quickly. "cancelled" errors are silent.

import { api } from "/js/core/api.js";
import { pool } from "/js/core/async.js";
import { fmtMoney } from "/js/core/format.js";
import { Cache, STORE, save } from "/js/core/storage.js";
import { state } from "../state.js";
import { acquireTorn, acquireTornStats } from "./limits.js";
import { explainDrops, statVerdict } from "./rules.js";
import { render, scheduleRender, tick } from "./results.js";
import { STAGES, countdown, setProgress, setScanMsg, updateRunButtons } from "./ui.js";
import { applyProfile, profileFresh, profiles, recordFrom } from "./status.js";
import { renderWatch } from "./watchlist.js";

const HOUR = 3600e3;
const ITEM_READS_AT_ONCE = 6;
const TORN_KEY_ERRORS = [2, 10, 13, 16];
const isCancel = (e) => e && e.message === "cancelled";

// An orderly early finish (nothing to do, nothing matched). Not a crash.
class Stop extends Error {
  constructor(message, kind = "info", outcome = "ok", progress = null) {
    super(message);
    Object.assign(this, { kind, outcome, progress });
  }
}

// ---------------------------------------------------------------- 1. choose items

async function chooseItems(call, f) {
  const targets = new Map(state.watch.map((w) => [w.id, w])); // the watchlist is always scanned
  let indexError = "";
  if (f.autoScan) {
    try {
      const { items } = await call("/api/weav3r?item=all");
      items
        .map((i) => ({ ...i, floor: i.lowest ?? i.price })) // floor = cheapest bazaar listing
        .filter((i) => i.floor >= f.minPrice && i.price >= f.minPrice && !targets.has(i.id))
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
  if (f.autoScan) throw new Stop(`No items have a cheapest listing and market value of at least ${fmtMoney(f.minPrice)}. Lower the minimum price.`);
  throw new Stop("Nothing to scan. Turn on auto scan or add an item ID.", "err", "fatal");
}

// ---------------------------------------------------------------- 2. read bazaars

// Returns one row per seller and item: { id, name, itemId, itemName, market, price, qty, total }.
async function readBazaars(call, list, f, runId) {
  const rows = new Map();
  let done = 0;
  await pool(list, ITEM_READS_AT_ONCE, async (w) => {
    for (let attempt = 0; attempt < 6 && runId === state.runId; attempt++) {
      try {
        const data = await call(`/api/weav3r?item=${w.id}`);
        if (!w.auto && data.item_name) w.name = data.item_name;
        const market = data.market_price || 0;
        if (market < f.minPrice) break; // not worth enough on the market to resell
        // Trade activity: listings that changed in the last hour (a sale, a restock or a price change).
        const asOf = data.generated_at || Date.now() / 1000;
        const activity = data.listings.filter((l) => l.updated && asOf - l.updated <= 3600).length;
        if (activity < f.minActivity) break; // too quiet to sell quickly
        for (const l of data.listings) {
          if (l.price < f.minPrice) continue;
          // only listings priced near what the item really sells for
          if (f.priceTol > 0 && market > 0 && Math.abs(l.price / market - 1) > f.priceTol / 100) continue;
          const key = `${l.player_id}:${w.id}`;
          const row = rows.get(key) || { id: l.player_id, name: l.player_name, itemId: w.id, itemName: data.item_name || w.name || `#${w.id}`, market, activity, bazaars: w.bazaars ?? null, price: l.price, qty: 0, total: 0 };
          row.price = Math.min(row.price, l.price);
          row.qty += l.quantity;
          row.total += l.price * l.quantity;
          rows.set(key, row);
        }
        break;
      } catch (e) {
        if (e.retryAfter && attempt < 5) { await countdown(e.retryAfter, "Pacing item reads...", runId); continue; }
        if (runId === state.runId) setScanMsg(`Item ${w.id}: ${e.message}`, "err");
        break;
      }
    }
    STAGES.items(++done / list.length);
    if (runId === state.runId) setScanMsg(`Reading bazaars ${done}/${list.length}...`);
  });
  save(STORE.watch, state.watch);
  renderWatch();
  return [...rows.values()].sort((a, b) => b.total - a.total);
}

// ---------------------------------------------------------------- 3. FF Scouter estimates

// For EVERY seller (200 per request), so weak players are never skipped before the stat filter.
async function estimateStats(call, ids, runId) {
  const cache = new Cache(STORE.ff, 8000);
  const need = ids.filter((id) => { const e = cache.get(id); return !e || Date.now() - e.t > 6 * HOUR; });
  setScanMsg(`Estimating stats for ${ids.length} sellers...`);
  for (let i = 0; i < need.length; i += 200) {
    const batch = need.slice(i, i + 200);
    let data;
    try {
      // One key is enough: FF Scouter accepts your registered Torn key unless you set a separate one.
      data = await call("/api/ffscouter", { method: "POST", headers: { "X-FF-Key": state.keys.ff || state.keys.torn }, body: { targets: batch } });
    } catch (e) {
      if (e.retryAfter || isCancel(e)) throw e;
      state.outcome = "fatal";
      throw new Error(`FF Scouter did not accept the key (${e.message}). Open Settings and tap "Test key with FF Scouter" to register it, or add a separate FF Scouter key there.`);
    }
    const seen = new Set();
    for (const s of Array.isArray(data) ? data : data.data || data.results || []) {
      seen.add(Number(s.player_id));
      cache.put(s.player_id, { t: Date.now(), ff: s.fair_fight ?? null, bs: s.bs_estimate ?? null });
    }
    for (const id of batch) if (!seen.has(id)) cache.put(id, { t: Date.now(), ff: null, bs: null });
    cache.flush();
    if (runId !== state.runId) return cache;
    STAGES.estimates(Math.min(i + 200, need.length) / need.length);
    setScanMsg(`Estimating stats ${Math.min(i + 200, need.length)}/${need.length}...`);
  }
  STAGES.estimates(1);
  return cache;
}

// ---------------------------------------------------------------- 5. TornStats spies

// A real spy beats an estimate. Returns the spy cache (found spies have .found true).
async function fetchSpies(call, ids, runId) {
  const cache = new Cache(STORE.spies, 4000);
  const fresh = (e) => e && Date.now() - e.t < (e.found ? 6 * HOUR : HOUR);
  const todo = ids.filter((id) => !fresh(cache.get(id)));
  let done = 0;
  let failed = false;
  await pool(todo, 3, async (id) => {
    if (failed || runId !== state.runId) return;
    try {
      await acquireTornStats(runId);
      const r = await call(`/api/tornstats/spy?id=${id}`, { headers: { "X-TS-Key": state.keys.ts } });
      if (r.error) { failed = true; setScanMsg(`TornStats key problem: ${r.error}. Using FF Scouter estimates.`, "err"); return; }
      cache.put(id, { t: Date.now(), found: !!r.found, total: r.total || 0, ts: r.timestamp || 0 });
    } catch (e) {
      if (!isCancel(e) && e.retryAfter) await countdown(e.retryAfter, "Pacing TornStats calls...", runId);
      return; // skip this one, the estimate is used
    }
    STAGES.spies(++done / todo.length);
    setScanMsg(`Checking TornStats spies ${done}/${todo.length}...`);
  });
  cache.flush();
  return cache;
}

// ---------------------------------------------------------------- 6. Torn status, age, last action

async function fetchStatuses(call, rows, runId) {
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
  setScanMsg("Reading bazaars...");

  try {
    const list = await chooseItems(call, f);
    let rows = await readBazaars(call, list, f, runId);
    if (runId !== state.runId) return;

    // stats for every seller, then drop listings that fail the stat and fair fight limits
    const sellers = new Set(rows.map((r) => r.id)).size;
    const estimates = await estimateStats(call, [...new Set(rows.map((r) => r.id))], runId);
    if (runId !== state.runId) return;

    const why = { noEst: 0, tooStrong: 0, tooWeak: 0, ffHigh: 0 };
    const passes = (r) => {
      const verdict = statVerdict(r.bs, r.ff, f);
      if (verdict) why[verdict]++;
      return !verdict;
    };
    rows = rows.filter((r) => {
      const e = estimates.get(r.id) || {};
      Object.assign(r, { ff: e.ff, bs: e.bs, src: "Est.", spyTs: 0 });
      return passes(r);
    });

    // only now limit to the highest-value sellers (the slower status checks come next)
    const keep = new Set();
    for (const r of rows) { if (keep.size >= f.maxSellers && !keep.has(r.id)) continue; keep.add(r.id); }
    rows = rows.filter((r) => keep.has(r.id));

    if (state.keys.ts && keep.size) {
      const spies = await fetchSpies(call, [...keep], runId);
      if (runId !== state.runId) return;
      // a real spy replaces the estimate, so check the limits again with it
      rows = rows.filter((r) => {
        const spy = spies.get(r.id);
        if (spy && spy.found) Object.assign(r, { bs: spy.total, src: "Spy", spyTs: spy.ts });
        return passes(r);
      });
    }

    state.rows = rows;
    render();
    if (!rows.length) throw new Stop(explainDrops(why, sellers), "info", "ok", 1);

    const { sellers: checked, keyProblem } = await fetchStatuses(call, rows, runId);
    if (runId === state.runId && !keyProblem) {
      state.outcome = "ok";
      setScanMsg(`Done. ${state.rows.length} listing(s) from ${checked} seller(s).`, "ok");
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
