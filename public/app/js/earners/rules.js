// Pure rules for the Inactive Earners page.

import { remaining } from "../features/rules.js";
import { STORE, load } from "/js/core/storage.js";
import { mugRate } from "../features/mugrate.js";
import { isRecentlyMugged, recentDrain, recentNote } from "../features/recent.js";
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

// (recent-mug logic is shared with the other finders: features/recent.js)
export { recentDrain, recentNote, recovery, hoursSinceMug } from "../features/recent.js";

// `raw` leaves out the correction learned from your real mugs (that is what gets saved with a tap, so the correction
// is always measured against the plain prediction).
export function predictedMug(r, wages = earn.wages, raw = false) {
  const cash = estimateCash(r, wages);
  if (cash == null) return null;
  return cash * mugRate() * (1 - recentDrain(r)) * (raw ? 1 : earn.calibration.factor);
}

// A rough chance of winning the fight, from their estimated stats against yours (set in Settings). null when either is unknown.
// Losing wastes the energy and can cost a hospital stay, so a big mug on someone who is likely to beat you is worth less.
export function winChance(r) {
  const myBs = Number((load(STORE.prefs, {}) || {}).myBs) || 0;
  if (!myBs || r.bs == null) return null;
  const x = r.bs / myBs; // their stats as a share of yours
  const seg = (from, to, a, b) => a + ((x - from) / (to - from)) * (b - a);
  if (x <= 0.3) return 0.98;
  if (x <= 0.7) return seg(0.3, 0.7, 0.98, 0.85);
  if (x <= 1.0) return seg(0.7, 1.0, 0.85, 0.45);
  if (x <= 1.3) return seg(1.0, 1.3, 0.45, 0.15);
  return 0.1;
}

// Predicted mug x win chance (the mug alone when your stats are not set).
export function expectedValue(r) {
  const m = predictedMug(r);
  if (m == null) return null;
  const w = winChance(r);
  return w == null ? m : m * w;
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
    { label: "Inactive", max: 10, v: idle == null ? null : scale(idle, 1, 30), note: idle == null ? "unknown" : `${idle.toFixed(0)} days` },
    // From a mugging guide: a high level for a young account (1 level is about 100 days) tends to carry more cash.
    { label: "Level for age", max: 5, v: r.level && r.age ? scale(r.level / (r.age / 100), 0.5, 1.5) : null, note: r.level && r.age ? `level ${r.level} at ${r.age} days` : "not known" },
    { label: "Company", max: 5, v: r.company ? r.company.stars / 10 : null, note: r.company ? `${r.company.stars} stars` : "unknown" },
  ];
  const known = parts.filter((p) => p.v != null);
  const maxKnown = known.reduce((n, p) => n + p.max, 0);
  const got = known.reduce((n, p) => n + p.v * p.max, 0);
  const drain = recentDrain(r, now);
  const score = maxKnown ? Math.round((got / maxKnown) * 100 * (1 - drain)) : 0; // mugged recently: rated lower
  const label = score >= 75 ? "Excellent" : score >= 55 ? "Good" : score >= 35 ? "Fair" : "Poor";
  return { score, label, drain, drainNote: recentNote(r), parts: parts.map((p) => ({ ...p, points: p.v == null ? null : Math.round(p.v * p.max) })) };
}

// Rows to show: at least the minimum days inactive (a fresh status check can show they came back).
export const visibleRows = () => earn.rows.filter((r) => (daysInactive(r) ?? 0) >= earn.filters.minDays && !isRecentlyMugged(r));

export function sortValue(r, key) {
  switch (key) {
    case "score": return mugScore(r).score;
    case "mug": return predictedMug(r);
    case "ev": return expectedValue(r);
    case "cash": return estimateCash(r);
    case "days": return daysInactive(r);
    case "stats": return r.bs;
    case "hospital": return remaining(r);
    case "age": return r.age;
    default: return null;
  }
}
