// One Inactive Earners scan. It keeps searching until it has found enough matches or run out of companies:
//   1 company lists (by type, stars), best stars first
//   then, ten companies at a time:
//   2 employees of those companies (last action)  ->  3 FF Scouter estimates  ->  4 stat filter
//   5 Torn status and account age for the new matches (they show up as soon as they are found)
//
// Every Torn call waits for a free slot under the per-minute limit. Company lists and employees are cached
// for a few hours (data.js), so a repeat scan only pays for what changed.

import { api } from "/js/core/api.js";
import { pool } from "/js/core/async.js";
import { estimateStats } from "../features/estimates.js";
import { checkStatuses } from "../features/status-stage.js";
import { statVerdict, explainDrops } from "../features/rules.js";
import { phase, setProgress, setScanMsg } from "../features/ui.js";
import { tornCall } from "../features/torncall.js";
import { state } from "../state.js";
import { cached, flushCache, keep, loadTypes } from "./data.js";
import { applyRecord, render } from "./results.js";
import { daysInactive, estimateCash } from "./rules.js";
import { earn } from "./state.js";

const isCancel = (e) => e && e.message === "cancelled";
const BATCH = 10; // companies read before their employees are filtered and shown
const STAGES = { companies: phase(0, 0.1) };

class Stop extends Error {
  constructor(message, kind = "info", progress = null) { super(message); Object.assign(this, { kind, progress }); }
}

// ---------------------------------------------------------------- 1. companies

async function readCompanies(f, runId) {
  const call = (path) => tornCall(path, runId);
  await loadTypes(call);
  const types = f.types.filter((id) => earn.types.some((t) => t.id === id));
  if (!types.length) throw new Stop("Pick at least one company type.", "err", 0);

  const found = [];
  let done = 0;
  const pages = Math.max(1, Math.ceil(f.perType / 100));
  const total = types.length * pages;
  for (const type of types) {
    for (let page = 0; page < pages; page++) {
      if (runId !== state.runId) throw new Error("cancelled");
      const key = `c:${type}:${page}`;
      let list = cached(key);
      if (!list) {
        const r = await tornCall(`/api/torn/companies?type=${type}&offset=${page * 100}`, runId);
        list = { companies: r.companies, total: r.total };
        keep(key, list);
      }
      found.push(...list.companies);
      STAGES.companies(++done / total);
      setScanMsg(`Reading companies ${done}/${total}...`);
      if (list.companies.length < 100) { done += pages - page - 1; break; } // that was the last page of this type
    }
  }
  flushCache();
  const picked = found.filter((c) => c.stars >= f.minStars && c.hired > 0).sort((a, b) => b.stars - a.stars || b.hired - a.hired);
  if (!picked.length) throw new Stop(`${found.length} companies read, none with ${f.minStars} stars or more and employees.`, "info", 1);
  return picked.slice(0, f.maxCompanies);
}

// ---------------------------------------------------------------- 2. employees

// Employees stored compactly: [id, name, position, daysInCompany, lastAction, state, until, description]
async function readEmployees(companies, f, runId) {
  const rows = [];
  const minIdle = f.minDays * 86400;
  const nowSec = Date.now() / 1000;
  await pool(companies, 3, async (c) => {
    if (runId !== state.runId) return;
    const key = `e:${c.id}`;
    let hit = cached(key);
    if (!hit) {
      try {
        const r = await tornCall(`/api/torn/employees?id=${c.id}`, runId);
        hit = { e: r.employees.map((e) => [e.id, e.name, e.position, e.days, e.last, e.state, e.until, e.desc]) };
        keep(key, hit);
      } catch (e) {
        if (isCancel(e) || e.fatal) throw e;
        setScanMsg(`Company ${c.id}: ${e.message}`, "err");
      }
    }
    for (const [id, name, position, daysIn, last, st, until, desc] of hit ? hit.e : []) {
      if (!last || nowSec - last < minIdle) continue; // too recently active
      rows.push({
        id, name, position, daysIn, last, state: st, until, desc, age: null, checkedAt: Date.now(),
        company: { id: c.id, name: c.name, typeId: c.type, typeName: c.typeName, stars: c.stars, income: c.income, hired: c.hired },
      });
    }
  });
  flushCache();
  return rows;
}

// ---------------------------------------------------------------- the scan

export async function scanEarners() {
  const runId = ++state.runId;
  const f = earn.filters;
  if (!state.keys.torn) return setScanMsg("Add your Torn key in Settings first.", "err");

  state.ctrl = new AbortController();
  const call = (path, opts = {}) => api(path, { ...opts, signal: state.ctrl.signal });
  state.scanning = true;
  document.getElementById("scan").disabled = true;
  document.getElementById("cancel").hidden = false;
  earn.rows = [];
  render();
  setProgress(0);
  setScanMsg("Reading companies...");

  try {
    const companies = await readCompanies(f, runId);
    const why = { noEst: 0, tooStrong: 0, tooWeak: 0, ffHigh: 0 };
    const known = new Set(); // players already looked at
    let checked = 0, inactive = 0, keyProblem = false;

    for (let i = 0; i < companies.length && earn.rows.length < f.maxPlayers && !keyProblem; i += BATCH) {
      if (runId !== state.runId) return;
      const batch = companies.slice(i, i + BATCH);
      const rows = (await readEmployees(batch, f, runId)).filter((r) => !known.has(r.id));
      checked += batch.length;
      if (runId !== state.runId) return;
      if (rows.length) {
        for (const r of rows) known.add(r.id);
        inactive += rows.length;
        const estimates = await estimateStats(call, rows.map((r) => r.id), runId, () => {});
        if (runId !== state.runId) return;
        const good = rows.filter((r) => {
          const e = estimates.get(r.id) || {};
          Object.assign(r, { ff: e.ff, bs: e.bs });
          const verdict = statVerdict(r.bs, r.ff, f);
          if (verdict) why[verdict]++;
          return !verdict;
        });
        if (good.length) {
          earn.rows = [...earn.rows, ...good];
          render(); // matches show up as they are found
          keyProblem = await checkStatuses(good.map((r) => r.id), runId, { apply: applyRecord, progress: () => {}, render });
        }
      }
      setProgress(0.1 + 0.9 * (checked / companies.length));
      setScanMsg(`Checked ${checked}/${companies.length} companies, ${earn.rows.length} match(es) so far. Cancel to stop.`);
    }
    if (runId !== state.runId) return;

    earn.rows.sort((a, b) => (estimateCash(b) ?? 0) - (estimateCash(a) ?? 0));
    const full = earn.rows.length >= f.maxPlayers;
    earn.rows = earn.rows.slice(0, f.maxPlayers);
    render();
    if (keyProblem) return;
    if (!earn.rows.length) {
      throw new Stop(inactive ? explainDrops(why, inactive).replace("sellers", "inactive players") : `No one at ${checked} companies has been inactive for ${f.minDays}+ days.`, "info", 1);
    }
    setScanMsg(`Done. ${earn.rows.length} inactive player(s) found${full ? " (stopped at your limit)" : ""} after checking ${checked} of ${companies.length} companies.`, "ok");
    setProgress(1);
  } catch (e) {
    if (isCancel(e) || runId !== state.runId) return;
    if (e instanceof Stop) {
      setScanMsg(e.message, e.kind);
      if (e.progress != null) setProgress(e.progress);
    } else {
      setScanMsg(e.message, "err");
    }
  } finally {
    if (runId === state.runId) {
      state.scanning = false;
      document.getElementById("scan").disabled = false;
      document.getElementById("cancel").hidden = true;
    }
  }
}

export function cancelEarners() {
  state.runId++;
  state.scanning = false;
  if (state.ctrl) state.ctrl.abort();
  document.getElementById("scan").disabled = false;
  document.getElementById("cancel").hidden = true;
  setProgress(0);
  setScanMsg("Scan cancelled.", "info");
}
