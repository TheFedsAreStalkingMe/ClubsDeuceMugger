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
import { profileFresh, profiles, recordFrom } from "../features/records.js";
import { statVerdict, explainDrops } from "../features/rules.js";
import { phase, setProgress, setScanMsg } from "../features/ui.js";
import { tornCall } from "../features/torncall.js";
import { state } from "../state.js";
import { cached, flushCache, keep, loadTypes } from "./data.js";
import { readHistory } from "./history.js";
import { applyRecord, render } from "./results.js";
import { daysInactive, estimateCash, mugScore } from "./rules.js";
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
async function readEmployees(companies, f, runId, stop = { v: false }) {
  const rows = [];
  const minIdle = f.minDays * 86400;
  const nowSec = Date.now() / 1000;
  await pool(companies, 5, async (c) => {
    if (runId !== state.runId || stop.v) return;
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

// ---------------------------------------------------------------- status, age and net worth (one call each)

// Torn lets selections be combined, so ONE call per new match gives status, age, last action and net worth
// (half the calls of asking for each). If the key may not read personal stats, it falls back to the profile alone.
let networthDenied = false;
let combinedOk = true;
const DAY_MS = 24 * 3600e3;

async function checkPlayers(rows, runId) {
  const ids = [...new Set(rows.map((r) => r.id))];
  const setWorth = (id, w) => { for (const r of earn.rows) if (r.id === id) r.networth = w; };
  const todo = [];
  for (const id of ids) {
    const p = profiles.get(id), n = cached(`n:${id}`, DAY_MS);
    if (profileFresh(p) && p.age != null && n) { applyRecord(id, p); setWorth(id, n.w); } else todo.push(id);
  }
  let done = ids.length - todo.length, keyProblem = false;
  await pool(todo, 5, async (id) => {
    if (runId !== state.runId || keyProblem) return;
    try {
      let p = null;
      if (combinedOk) {
        try {
          p = await tornCall(`/api/torn/player?id=${id}`, runId);
        } catch (e) {
          if (isCancel(e)) throw e;
          if (e.fatal && /access level/i.test(e.message)) { combinedOk = false; networthDenied = true; } else throw e; // no personal stats on this key: profile only
        }
      }
      if (!p) p = await tornCall(`/api/torn/user?id=${id}`, runId);
      const rec = recordFrom(p);
      profiles.put(id, rec);
      applyRecord(id, rec);
      if (p.networth !== undefined) { keep(`n:${id}`, { w: p.networth }); setWorth(id, p.networth); }
    } catch (e) {
      if (isCancel(e)) return;
      if (e.fatal) { keyProblem = true; setScanMsg(e.message, "err"); return; }
    }
    setScanMsg(`Checking players ${++done}/${ids.length}...`);
  });
  profiles.flush();
  flushCache();
  return keyProblem;
}

// ---------------------------------------------------------------- recently mugged

// How often members mugged these players lately (from our own record; no Torn calls). Feeds the rating.
async function loadRecent(rows, call) {
  const ids = [...new Set(rows.map((r) => r.id))];
  for (let i = 0; i < ids.length; i += 100) {
    try {
      const { recent } = await call(`/api/targets/recent?ids=${ids.slice(i, i + 100).join(",")}`);
      for (const r of rows) r.recent = recent[r.id] || { n24: 0, n7: 0, last: 0, sum24: 0 };
    } catch { /* the rating just goes without it */ }
  }
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
    networthDenied = false;
    combinedOk = true;
    const stop = { v: false };
    let checked = 0, inactive = 0, keyProblem = false;

    const batches = [];
    for (let i = 0; i < companies.length; i += BATCH) batches.push(companies.slice(i, i + BATCH));
    const read = (n) => { const pr = n < batches.length ? readEmployees(batches[n], f, runId, stop) : null; if (pr) pr.catch(() => {}); return pr; };
    let upcoming = read(0);
    for (let b = 0; b < batches.length && earn.rows.length < f.maxPlayers && !keyProblem; b++) {
      const raw = await upcoming;
      upcoming = read(b + 1); // the next ten companies are read while this batch is filtered and checked
      if (runId !== state.runId) return;
      const rows = raw.filter((r) => !known.has(r.id));
      checked += batches[b].length;
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
          keyProblem = await checkPlayers(good, runId);
          await loadRecent(good, call);
          render();
        }
      }
      setProgress(0.1 + 0.9 * (checked / companies.length));
      setScanMsg(`Checked ${checked}/${companies.length} companies, ${earn.rows.length} match(es) so far. Cancel to stop.`);
    }
    stop.v = true; // no more companies are started once the scan is over
    if (runId !== state.runId) return;

    earn.rows.sort((a, b) => (estimateCash(b) ?? 0) - (estimateCash(a) ?? 0));
    const full = earn.rows.length >= f.maxPlayers;
    earn.rows = earn.rows.slice(0, f.maxPlayers);
    render();
    if (keyProblem) return;
    // How often were the best matches attacked lately by anyone (Torn's daily stat snapshots)? Lowers their rating.
    const top = [...earn.rows].sort((a, b) => mugScore(b).score - mugScore(a).score).slice(0, f.historyTop || 0);
    for (let i = 0; i < top.length && runId === state.runId; i++) {
      setScanMsg(`Reading recent attacks on the best matches ${i + 1}/${top.length} (3 Torn calls each)...`);
      top[i].history = await readHistory(top[i].id, runId);
      render();
    }
    if (runId !== state.runId) return;
    if (!earn.rows.length) {
      throw new Stop(inactive ? explainDrops(why, inactive).replace("sellers", "inactive players") : `No one at ${checked} companies has been inactive for ${f.minDays}+ days.`, "info", 1);
    }
    setScanMsg(`Done. ${earn.rows.length} inactive player(s) found${full ? " (stopped at your limit)" : ""} after checking ${checked} of ${companies.length} companies.${networthDenied ? " Net worth could not be read: your key may need the personalstats permission (Settings, Check my key)." : ""}`, networthDenied ? "info" : "ok");
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
