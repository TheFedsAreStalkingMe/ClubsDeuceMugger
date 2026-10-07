// The background Inactive Earners search. It runs from a Cron Trigger while the member's page is closed, in small steps
// (a few Torn calls each, remembered in bg_hunts.state), and emails the best targets it finds.
//
// This is the same search as the Earners page (public/app/js/earners/*), trimmed to what can run on a schedule:
//   companies (by type, stars)  ->  employees idle for N days  ->  FF Scouter stat estimate  ->  status and net worth
//   ->  bazaar takings  ->  predicted mug  ->  email.
// A Worker may only make so many outside calls per run, so every step spends from a budget and carries on next time.

import { upstream } from "../config.js";
import { nowSec } from "./http.js";
import { openWithSecret } from "./crypto.js";
import { sendMail } from "./mail.js";
import { fetchJson, tornV2 } from "./upstream.js";

const DAY = 86400;
const LIST_REFRESH = 6 * 3600; // company lists are read again after a full pass, at most this often
const MAIL_EVERY = 1800; // at most one email per half hour
const RE_MAIL = 24 * 3600; // a target is not emailed again within a day
const MAX_CANDS = 300;
const TORN_KEY_ERRORS = [2, 10, 13, 16];
const WAGE_CAP = 25000000;

class OutOfBudget extends Error {}

export const DEFAULT_CONFIG = {
  types: [], minStars: 5, minDays: 7, minBs: 0, maxBs: 1e12, maxFf: 10, maxCompanies: 300, includeUnknown: false,
  wages: { base: 1000000, share: 60, types: {} },
  merits: 0, meritBoost: 5, plunder: 0,
  minMug: 1000000, // email targets whose predicted mug is at least this much
  hideHours: 12, // skip players mugged in the last N hours
};

const num = (v, lo, hi, d) => (v !== "" && v !== null && v !== undefined && Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);

// Whatever the browser sends becomes a clean config (numbers clamped, unknown fields dropped).
export function cleanConfig(c = {}) {
  const w = c.wages || {};
  const types = {};
  for (const [k, v] of Object.entries(w.types || {})) if (/^\d{1,3}$/.test(k) && Number.isFinite(Number(v))) types[k] = Math.max(0, Number(v));
  const d = DEFAULT_CONFIG;
  return {
    types: [...new Set((Array.isArray(c.types) ? c.types : []).map(Number).filter((n) => Number.isInteger(n) && n > 0 && n < 1000))].slice(0, 60),
    minStars: num(c.minStars, 1, 10, d.minStars), minDays: num(c.minDays, 1, 365, d.minDays),
    minBs: num(c.minBs, 0, 1e13, d.minBs), maxBs: num(c.maxBs, 0, 1e13, d.maxBs), maxFf: num(c.maxFf, 1, 10, d.maxFf),
    maxCompanies: num(c.maxCompanies, 1, 1000, d.maxCompanies), includeUnknown: !!c.includeUnknown,
    wages: { base: num(w.base, 0, 1e9, d.wages.base), share: num(w.share, 0, 100, d.wages.share), types },
    merits: num(c.merits, 0, 10, 0), meritBoost: num(c.meritBoost, 0, 50, 5), plunder: num(c.plunder, 0, 500, 0),
    minMug: num(c.minMug, 0, 1e12, d.minMug), hideHours: num(c.hideHours, 0, 168, d.hideHours),
  };
}

// ---------------------------------------------------------------- the same maths as the page

export const mugRate = (c) => 0.05 * (1 + (c.merits * c.meritBoost) / 100 + c.plunder / 100);
const recovery = (h) => (h >= 15 ? 1 : 0.1 + 0.9 * Math.pow(Math.max(0, h) / 15, 0.8));

function dailyWage(co, w) {
  if (w.types[co.type] != null) return w.types[co.type] * (co.stars / 10);
  if (co.income > 0 && co.hired > 0) return Math.min(WAGE_CAP, (co.income * w.share) / 100 / co.hired);
  return w.base * (co.stars / 10);
}

// Money their bazaar took in while they were offline (see public/app/js/features/bazaar.js).
function bazaarCash(c, idle) {
  if (!c.bz || idle < 1) return 0;
  return idle >= 7 ? c.bz.profit7 : (c.bz.profit7 * idle) / 7;
}

export function estimateCash(c, cfg, now) {
  const idle = (now - c.last) / DAY;
  return dailyWage(c.company, cfg.wages) * Math.min(Math.floor(idle), c.daysIn ?? Infinity) + bazaarCash(c, idle);
}

// Lower for players mugged recently (members' mugs from our own record): same rules as the page.
export function drain(rec, hospMugged, now) {
  rec = rec || {};
  let hours = rec.last ? Math.max(0, (now - rec.last) / 3600) : null;
  if (hospMugged) hours = hours == null ? 0.5 : Math.min(hours, 0.5);
  const keep = hours == null ? 1 : recovery(hours);
  const extra = Math.min(0.5, 0.1 * Math.max(0, (rec.n24 || 0) - 1)) + Math.min(0.15, 0.03 * Math.max(0, (rec.n7 || 0) - (rec.n24 || 0)));
  return { drain: Math.min(0.9, 1 - keep * (1 - Math.min(0.9, extra))), hours };
}

const money = (n) => (n >= 1e9 ? `$${(n / 1e9).toFixed(2)}b` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}m` : `$${Math.round(n / 1e3)}k`);

// ---------------------------------------------------------------- one run for one member

export async function runHunt(env, row, budgetObj) {
  const cfg = cleanConfig(JSON.parse(row.config));
  const state = JSON.parse(row.state || "{}");
  state.cands ||= [];
  state.alerted ||= {};
  state.pending ||= [];
  state.seen ||= {};
  state.pos ||= 0;
  const now = nowSec();
  const base = upstream(env);
  const keys = await openWithSecret(env.BG_SECRET, row.user_id, row.key_enc);
  const take = () => { if (budgetObj.left <= 0) throw new OutOfBudget(); budgetObj.left--; };
  const torn = async (path, params) => { take(); return tornV2(base.tornV2, path, params, keys.torn); };
  let msg = "";
  let stopped = null; // a key problem: the search switches itself off

  try {
    if (!cfg.types.length) throw new Error("No company types chosen.");

    for (;;) {
      // 1. the company list. Read once in full (page by page, kept for LIST_REFRESH), then each pass takes the next
      //    `maxCompanies` of it, carrying on where the last pass stopped, so the search moves on to NEW companies
      //    instead of reading the same top ones again and again.
      if (!state.companies || state.nextPass) {
        if (!state.all || now - (state.allAt || 0) > LIST_REFRESH) {
          const b = (state.build ||= { found: [], t: 0, page: 0 });
          while (b.t < cfg.types.length) {
            const type = cfg.types[b.t];
            const r = await torn(`/company/${type}/companies`, { limit: "100", offset: String(b.page * 100) });
            const list = (r.companies || []).map((c) => ({ id: c.id, name: c.name, type: c.type?.id ?? type, typeName: c.type?.name || "", stars: c.rating, hired: c.employees?.hired ?? 0, income: c.income?.daily ?? 0 }));
            b.found.push(...list);
            if (list.length < 100) { b.t++; b.page = 0; } else b.page++;
          }
          state.all = b.found.filter((c) => c.stars >= cfg.minStars && c.hired > 0).sort((a, c) => c.stars - a.stars || c.hired - a.hired || a.id - c.id).slice(0, 2500);
          state.allAt = now;
          delete state.build;
        }
        const total = state.all.length;
        const start = total ? (state.cursor || 0) % total : 0;
        state.companies = state.all.slice(start).concat(state.all.slice(0, start)).slice(0, cfg.maxCompanies);
        state.cursor = total ? (start + state.companies.length) % total : 0;
        state.passStart = start;
        state.pos = 0;
        state.nextPass = false;
      }

      // 2. estimate stats for new candidates (one FF Scouter call for up to 200)
      const fresh = state.cands.filter((c) => c.stage === 0);
      if (fresh.length >= 20 || (fresh.length && state.pos >= state.companies.length)) {
        const batch = fresh.slice(0, 200);
        take();
        const { res, data } = await fetchJson(`${base.ffScouter}/get-stats?key=${keys.ff || keys.torn}&targets=${batch.map((c) => c.id).join(",")}`);
        if (!res.ok || !Array.isArray(data)) throw new Error("FF Scouter did not answer (is the key registered with it?).");
        const byId = new Map(data.map((s) => [Number(s.player_id), s]));
        for (const c of batch) {
          const e = byId.get(c.id) || {};
          c.ff = e.fair_fight ?? null;
          c.bs = e.bs_estimate ?? null;
          const bad =
            (c.ff != null && c.ff > cfg.maxFf) ||
            (c.bs == null ? (cfg.minBs > 0 || cfg.maxBs < 1e12) && !cfg.includeUnknown : c.bs < cfg.minBs || c.bs > cfg.maxBs);
          c.stage = bad ? -1 : 1;
        }
        state.cands = state.cands.filter((c) => c.stage !== -1);
        continue;
      }

      // 3. the best-looking candidate: status and net worth (1 call), then its bazaar (2 calls), then rate it
      const ready = state.cands.filter((c) => c.stage >= 1).sort((a, b) => b.stage - a.stage || estimateCash(b, cfg, now) - estimateCash(a, cfg, now));
      if (ready.length) {
        const c = ready[0];
        if (c.stage === 1) {
          const r = await torn("/user", { selections: "profile,personalstats", id: String(c.id), cat: "networth" });
          const p = r.profile || {};
          c.state = p.status?.state || "Okay";
          c.details = p.status?.details || "";
          if (p.last_action?.timestamp) c.last = Math.max(c.last, p.last_action.timestamp);
          c.networth = r.personalstats?.networth?.total ?? null;
          c.stage = 2;
          // came back online, or cannot be attacked right now (travelling, jail, hospital): not a target at the moment
          if (now - c.last < cfg.minDays * DAY || (c.state !== "Okay" && !(c.state === "Hospital" && /mugged/i.test(c.details)))) {
            state.cands = state.cands.filter((x) => x !== c);
            state.seen[c.id] = now;
          }
          continue;
        }
        if (c.stage === 2) {
          const stat = async (ago) => {
            const r = await torn(`/user/${c.id}/personalstats`, { stat: "bazaarprofit,bazaarsales", timestamp: String(now - Math.max(3600, ago * DAY)) });
            const o = {};
            for (const s of Array.isArray(r.personalstats) ? r.personalstats : []) o[s.name] = s.value;
            return o;
          };
          const nowS = await stat(0);
          const weekS = await stat(7);
          c.bz = nowS.bazaarprofit != null && weekS.bazaarprofit != null
            ? { profit7: Math.max(0, nowS.bazaarprofit - weekS.bazaarprofit), sales7: Math.max(0, (nowS.bazaarsales ?? 0) - (weekS.bazaarsales ?? 0)) }
            : null;
          c.stage = 3;
          continue;
        }
        // stage 3: rate it
        state.cands = state.cands.filter((x) => x !== c);
        state.seen[c.id] = now;
        const { results } = await env.DB.prepare(
          "SELECT COUNT(*) AS n7, SUM(CASE WHEN mugged_at > ? THEN 1 ELSE 0 END) AS n24, MAX(mugged_at) AS last FROM seen_mugs WHERE target_id = ? AND mugged_at > ?"
        ).bind(now - DAY, c.id, now - 7 * DAY).all();
        const rec = results[0] && results[0].n7 ? results[0] : null;
        const d = drain(rec, /mugged/i.test(c.details || ""), now);
        if (cfg.hideHours > 0 && d.hours != null && d.hours < cfg.hideHours) continue;
        const cash = estimateCash(c, cfg, now);
        const mug = cash * mugRate(cfg) * (1 - d.drain);
        if (mug >= cfg.minMug && !(state.alerted[c.id] > now - RE_MAIL) && !state.pending.some((p) => p.id === c.id)) {
          state.pending.push({ id: c.id, name: c.name, position: c.position, company: c.company.name, stars: c.company.stars, idle: Math.round((now - c.last) / DAY), cash: Math.round(cash), mug: Math.round(mug), bz: c.bz ? Math.round(c.bz.profit7) : null, bs: c.bs, networth: c.networth, drain: Math.round(d.drain * 100) });
        }
        continue;
      }

      // 4. read the employees of the next company
      if (state.pos < state.companies.length) {
        const co = state.companies[state.pos];
        const r = await torn(`/company/${co.id}/employees`, {});
        state.pos++;
        for (const e of r.employees || []) {
          const last = e.last_action?.timestamp || 0;
          if (!last || now - last < cfg.minDays * DAY) continue;
          if (state.cands.some((c) => c.id === e.id) || state.seen[e.id] > now - 2 * 3600) continue;
          if (state.cands.length >= MAX_CANDS) break;
          state.cands.push({ id: e.id, name: e.name, position: e.position?.name || "", daysIn: e.days_in_company ?? 0, last, stage: 0, company: co });
        }
        continue;
      }
      state.nextPass = true; // a pass is done: the next run starts the next slice of the list
      break;
    }
    msg = `Pass complete: ${state.companies.length} companies read (from company ${(state.passStart || 0) + 1} of ${(state.all || []).length}). The next pass carries on from there.`;
  } catch (e) {
    if (e instanceof OutOfBudget) msg = "";
    else if (e.code && TORN_KEY_ERRORS.includes(e.code)) { stopped = e.message; msg = `Stopped: ${e.message}`; }
    else msg = `Paused: ${e.message}`;
  }
  for (const k of Object.keys(state.seen)) if (state.seen[k] < now - 6 * 3600) delete state.seen[k];

  // 5. email what was found (one message per half hour at most)
  let mailed = 0;
  for (const k of Object.keys(state.alerted)) if (state.alerted[k] < now - RE_MAIL) delete state.alerted[k];
  if (state.pending.length && now - (state.lastMail || 0) >= MAIL_EVERY && row.email) {
    const top = [...state.pending].sort((a, b) => b.mug - a.mug).slice(0, 10);
    const lines = top.map((t) =>
      `${t.name} [${t.id}], ${t.position} at ${t.company} (${t.stars} stars)\n  predicted mug ~${money(t.mug)} (est. cash ${money(t.cash)}${t.bz ? `, bazaar took ${money(t.bz)} in a week` : ""}), offline ${t.idle} days${t.bs ? `, est. stats ${money(t.bs).replace("$", "")}` : ""}${t.drain ? `, recently mugged -${t.drain}%` : ""}\n  Attack: https://www.torn.com/page.php?sid=attack&user2ID=${t.id}`);
    const ok = await sendMail(env, row.email, `${top.length} mug target${top.length === 1 ? "" : "s"} found`, `Your background search found:\n\n${lines.join("\n\n")}\n\nThese are rough guesses. Check them before you attack. Turn the search off in Settings.`);
    if (ok) {
      for (const t of top) state.alerted[t.id] = now;
      state.pending = state.pending.filter((p) => !top.includes(p));
      state.lastMail = now;
      mailed = top.length;
    }
  }
  if (stopped && row.email) {
    await sendMail(env, row.email, "Your background search stopped", `Torn did not accept your key (${stopped}). The background search is off and your key was deleted from the site. Turn it on again in Settings with a working key.`);
  }

  if (!msg) msg = `Working: ${state.pos}/${(state.companies || []).length} companies read, ${state.cands.length} candidate(s) waiting.`;
  if (mailed) msg += ` Emailed ${mailed} target${mailed === 1 ? "" : "s"}.`;
  else if (state.pending.length) msg += ` ${state.pending.length} target(s) waiting to be emailed.`;
  return { state, msg, stopped, mailed };
}

// ---------------------------------------------------------------- the scheduled job

// Runs every member's search that is due, sharing one budget of outside calls (a Worker may only make so many per run;
// set HUNT_BUDGET higher on a paid plan). The member who waited longest goes first.
export async function runAllHunts(env, only = null) {
  if (!env.BG_SECRET) return [];
  const budget = { left: Number(env.HUNT_BUDGET) || 40 };
  const sql = `SELECT h.*, u.email FROM bg_hunts h JOIN users u ON u.id = h.user_id WHERE h.enabled = 1 ${only ? "AND h.user_id = ?" : ""} ORDER BY h.last_run ASC LIMIT 20`;
  const { results } = await (only ? env.DB.prepare(sql).bind(only) : env.DB.prepare(sql)).all();
  const out = [];
  for (const row of results) {
    if (budget.left <= 0) break;
    let r;
    try {
      r = await runHunt(env, row, budget);
    } catch (e) {
      console.error("hunt failed", row.user_id, e && e.message);
      r = { state: JSON.parse(row.state || "{}"), msg: `Error: ${e && e.message}`, stopped: null };
    }
    await env.DB.prepare("UPDATE bg_hunts SET state = ?, last_run = ?, last_msg = ?, enabled = ?, key_enc = CASE WHEN ? THEN '' ELSE key_enc END WHERE user_id = ?")
      .bind(JSON.stringify(r.state), nowSec(), r.msg.slice(0, 300), r.stopped ? 0 : 1, r.stopped ? 1 : 0, row.user_id).run();
    out.push({ userId: row.user_id, msg: r.msg });
  }
  return out;
}
