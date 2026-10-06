// Pure rules for the Inactive Earners page.

import { remaining } from "../features/rules.js";
import { STORE, load } from "/js/core/storage.js";
import { BASE_MUG, MERIT_BONUS } from "../state.js";
import { WAGE_CAP, earn } from "./state.js";

const DAY = 86400;

export const daysInactive = (r, now = Date.now() / 1000) => (r.last ? Math.max(0, (now - r.last) / DAY) : null);

// The assumed wage per day: your number for the company type, else a share of the company's real daily income
// split between its employees, else the base wage.
export function dailyWage(c, wages = earn.wages) {
  if (wages.types[c.typeId] != null) return wages.types[c.typeId] * (c.stars / 10);
  if (c.income > 0 && c.hired > 0) return Math.min(WAGE_CAP, (c.income * (wages.share ?? 60)) / 100 / c.hired);
  return wages.base * (c.stars / 10);
}

// A ROUGH guess of the cash they have built up: the assumed daily wage x days idle.
// Wages only build up while they are employed, so days in the company caps it.
export function estimateCash(r, wages = earn.wages, now = Date.now() / 1000) {
  const idle = daysInactive(r, now);
  if (idle == null) return null;
  return dailyWage(r.company, wages) * Math.min(Math.floor(idle), r.daysIn ?? Infinity);
}

// The money a mug would take: about 5% of their cash, plus your merits and Plunder (same sum as the bazaar finder).
export function mugRate(f = earn.filters) {
  return BASE_MUG * (1 + (f.merits ? MERIT_BONUS : 0) + (Number(f.plunder) || 0) / 100);
}
export function predictedMug(r, wages = earn.wages) {
  const cash = estimateCash(r, wages);
  return cash == null ? null : cash * mugRate();
}

// How good a mug target they look, 0 to 100, from what the site can see. Each part says why:
//   cash       the estimated wages built up while inactive (more is better)
//   net worth  a high net worth means they have been holding money for a long time (the best sign)
//   age        an old account has had longer to build up (and more working stats)
//   stats      weaker is safer (against your own stats from Settings if you set them)
//   inactive   longer offline means more cash piled up and less chance they are online
//   company    stars of the company they work at
// A part that is not known yet (net worth not read, no stat estimate) is left out and the rest is scaled up.
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const scale = (x, lo, hi) => clamp01((x - lo) / (hi - lo));
const logScale = (x, lo, hi) => (x <= 0 ? 0 : clamp01((Math.log10(x) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo))));

export function mugScore(r, now = Date.now() / 1000) {
  const myBs = Number((load(STORE.prefs, {}) || {}).myBs) || 0;
  const cash = estimateCash(r);
  const idle = daysInactive(r, now);
  const parts = [
    { label: "Est. cash", max: 30, v: cash == null ? null : logScale(cash, 1e6, 1e8), note: cash == null ? "unknown" : `~$${Math.round(cash).toLocaleString("en-US")}` },
    { label: "Net worth", max: 25, v: r.networth == null ? null : logScale(r.networth, 5e7, 2.5e9), note: r.networth == null ? "not known" : `$${Math.round(r.networth).toLocaleString("en-US")}` },
    { label: "Account age", max: 15, v: r.age == null ? null : scale(r.age, 100, 3000), note: r.age == null ? "not known" : `${r.age} days` },
    { label: "Weak stats", max: 15, v: r.bs == null ? null : 1 - (myBs > 0 ? clamp01(r.bs / myBs) : logScale(r.bs, 1e7, 1e10)), note: r.bs == null ? "no estimate" : myBs > 0 ? `${Math.round((r.bs / myBs) * 100)}% of yours` : "est. stats" },
    { label: "Inactive", max: 10, v: idle == null ? null : scale(idle, 7, 60), note: idle == null ? "unknown" : `${idle.toFixed(0)} days` },
    { label: "Company", max: 5, v: r.company ? r.company.stars / 10 : null, note: r.company ? `${r.company.stars} stars` : "unknown" },
  ];
  const known = parts.filter((p) => p.v != null);
  const maxKnown = known.reduce((n, p) => n + p.max, 0);
  const got = known.reduce((n, p) => n + p.v * p.max, 0);
  const score = maxKnown ? Math.round((got / maxKnown) * 100) : 0;
  const label = score >= 75 ? "Excellent" : score >= 55 ? "Good" : score >= 35 ? "Fair" : "Poor";
  return { score, label, parts: parts.map((p) => ({ ...p, points: p.v == null ? null : Math.round(p.v * p.max) })) };
}

// Rows to show: at least the minimum days inactive (a fresh status check can show they came back).
export const visibleRows = () => earn.rows.filter((r) => (daysInactive(r) ?? 0) >= earn.filters.minDays);

export function sortValue(r, key) {
  switch (key) {
    case "score": return mugScore(r).score;
    case "mug": return predictedMug(r);
    case "cash": return estimateCash(r);
    case "days": return daysInactive(r);
    case "stats": return r.bs;
    case "hospital": return remaining(r);
    case "age": return r.age;
    default: return null;
  }
}
