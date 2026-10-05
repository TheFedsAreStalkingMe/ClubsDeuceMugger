// One Bonus Weapon Sellers scan, in stages:
//   1 listings   Weav3r's ranked weapons search (bazaar listings name their seller; item market ones do not and are left out)
//   2 estimates  FF Scouter for every seller, then the stat and fair fight filter
//   3 status     Torn status and account age
//
// Searches are kept in the browser for 5 minutes (same question, same answer). Weav3r reads wait together when it
// says "busy" (features/weav3r.js).

import { api } from "/js/core/api.js";
import { pool } from "/js/core/async.js";
import { Cache, STORE } from "/js/core/storage.js";
import { estimateStats } from "../features/estimates.js";
import { explainDrops, statVerdict } from "../features/rules.js";
import { checkStatuses } from "../features/status-stage.js";
import { phase, setProgress, setScanMsg } from "../features/ui.js";
import { resetWeav3r, weav3rGaveUp, weav3rRead } from "../features/weav3r.js";
import { state } from "../state.js";
import { applyRecord, render } from "./results.js";
import { matchBonus, passes, planSearches } from "./rules.js";
import { bonus } from "./state.js";

const TTL = 5 * 60e3;
const READS_AT_ONCE = 2;
const STAGES = { listings: phase(0, 0.4), estimates: phase(0.4, 0.55), status: phase(0.55, 1) };
const isCancel = (e) => e && e.message === "cancelled";
const cache = new Cache(STORE.bonusCache, 24);

class Stop extends Error {
  constructor(message, kind = "info", progress = null) { super(message); Object.assign(this, { kind, progress }); }
}

// Every page (up to f.pages) of one search. Pages come cheapest first, 100 at a time.
async function readSearch(call, search, f, runId) {
  const out = [];
  for (let page = 1; page <= f.pages; page++) {
    const qs = new URLSearchParams({ ...search, page }).toString();
    let hit = cache.get(qs);
    if (!hit || Date.now() - hit.t > TTL) {
      const r = await weav3rRead(call, `/api/weav3r/ranked?${qs}`, runId);
      hit = { t: Date.now(), total: r.total, listings: r.listings };
      cache.put(qs, hit);
    }
    out.push(...hit.listings.map((l) => ({ ...l, kind: search.tab === "armor" ? "Armor" : l.kind })));
    if (!hit.total || page * 100 >= hit.total) break;
  }
  return out;
}

export async function scanBonus() {
  const runId = ++state.runId;
  const f = bonus.filters;
  if (!state.keys.torn) return setScanMsg("Add your Torn key in Settings first.", "err");
  if (!f.kinds.length) return setScanMsg("Tick at least one weapon type.", "err");

  state.ctrl = new AbortController();
  const call = (path, opts = {}) => api(path, { ...opts, signal: state.ctrl.signal });
  state.scanning = true;
  document.getElementById("scan").disabled = true;
  document.getElementById("cancel").hidden = false;
  bonus.rows = [];
  render();
  resetWeav3r();
  setProgress(0);
  setScanMsg("Searching listings...");

  try {
    const searches = planSearches(f);
    if (!searches.length) throw new Stop("Nothing to search: armor has no weapon bonuses, so pick a weapon type or clear the bonus choice.", "err", 0);
    const found = new Map(); // uid -> listing
    let done = 0;
    await pool(searches, READS_AT_ONCE, async (search) => {
      if (runId !== state.runId) return;
      try {
        for (const l of await readSearch(call, search, f, runId)) found.set(l.uid, l);
      } catch (e) {
        if (!isCancel(e) && runId === state.runId && !weav3rGaveUp()) setScanMsg(`Search failed: ${e.message}`, "err");
      }
      STAGES.listings(++done / searches.length);
      if (runId === state.runId) setScanMsg(`Searching listings ${done}/${searches.length}...`);
    });
    if (runId !== state.runId) return;

    const listings = [...found.values()].filter((l) => passes(l, f));
    if (!listings.length) throw new Stop(`No bazaar listings match${weav3rGaveUp() ? " (Weav3r was busy, so some searches were skipped)" : ""}. Item market sellers are anonymous and are left out.`, "info", 1);

    const sellers = [...new Set(listings.map((l) => l.sellerId))];
    const estimates = await estimateStats(call, sellers, runId, STAGES.estimates);
    if (runId !== state.runId) return;
    const why = { noEst: 0, tooStrong: 0, tooWeak: 0, ffHigh: 0 };
    const okSeller = new Map();
    for (const id of sellers) {
      const e = estimates.get(id) || {};
      const verdict = statVerdict(e.bs, e.ff, f);
      if (verdict) why[verdict]++; else okSeller.set(id, e);
    }
    const rows = listings
      .filter((l) => okSeller.has(l.sellerId))
      .map((l) => ({ ...l, id: l.sellerId, best: matchBonus(l, f), bs: okSeller.get(l.sellerId).bs, ff: okSeller.get(l.sellerId).ff, checkedAt: Date.now() }));
    if (!rows.length) throw new Stop(explainDrops(why, sellers.length).replace("sellers", "weapon sellers"), "info", 1);
    rows.sort((a, b) => a.price - b.price);
    bonus.rows = rows.slice(0, f.maxListings);
    render();

    const keyProblem = await checkStatuses(bonus.rows.map((r) => r.id), runId, { apply: applyRecord, progress: STAGES.status, render });
    if (runId === state.runId && !keyProblem) {
      setScanMsg(`Done. ${bonus.rows.length} listing(s) from ${new Set(bonus.rows.map((r) => r.id)).size} seller(s).${weav3rGaveUp() ? " Weav3r was busy, so some searches were skipped." : ""}`, "ok");
      setProgress(1);
    }
    render();
  } catch (e) {
    if (isCancel(e) || runId !== state.runId) return;
    if (e instanceof Stop) {
      setScanMsg(e.message, e.kind);
      if (e.progress != null) setProgress(e.progress);
    } else {
      setScanMsg(e.message, "err");
    }
  } finally {
    cache.flush();
    if (runId === state.runId) {
      state.scanning = false;
      document.getElementById("scan").disabled = false;
      document.getElementById("cancel").hidden = true;
    }
  }
}

export function cancelBonus() {
  state.runId++;
  state.scanning = false;
  if (state.ctrl) state.ctrl.abort();
  document.getElementById("scan").disabled = false;
  document.getElementById("cancel").hidden = true;
  setProgress(0);
  setScanMsg("Scan cancelled.", "info");
}
