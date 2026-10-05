// Pure rules for the Inactive Earners page.

import { remaining } from "../features/rules.js";
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

// Rows to show: at least the minimum days inactive (a fresh status check can show they came back).
export const visibleRows = () => earn.rows.filter((r) => (daysInactive(r) ?? 0) >= earn.filters.minDays);

export function sortValue(r, key) {
  switch (key) {
    case "cash": return estimateCash(r);
    case "days": return daysInactive(r);
    case "stats": return r.bs;
    case "hospital": return remaining(r);
    case "age": return r.age;
    default: return null;
  }
}
