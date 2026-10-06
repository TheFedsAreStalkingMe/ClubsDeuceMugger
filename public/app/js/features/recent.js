// How recently a player was mugged, and what that does to the next mug. Shared by every finder.
// From a mugging guide: Torn reduces what a mug takes from a player who was just mugged, and the yield comes back over
// about 15 hours (at 8 to 10 hours you still get 60 to 70% of the best amount). `recovery` is 0.1 right after a mug,
// about 0.7 after 9 hours and 1 after 15. Players mugged several times in a day or week are ones others farm, and
// fights lost to anyone (Torn's stats, `r.history`) count too.
// Rows carry `recent` ({ n24, n7, last }) from our own record of member mugs (/api/targets/recent) and `details` (the
// status text, "Mugged by ..." while in hospital).

import { STORE, load, save } from "/js/core/storage.js";

const RECOVERY_HOURS = 15;
const LOCAL_MUGS = "cdm.muggedLocal"; // players you marked as mugged by hand: { id: seconds }
export const recovery = (hours) => (hours >= RECOVERY_HOURS ? 1 : 0.1 + 0.9 * Math.pow(Math.max(0, hours) / RECOVERY_HOURS, 0.8));

// You can mark a player as mugged by hand (for a mug the site cannot see); it counts like any other mug for a day.
export function markMugged(id) {
  const now = Math.floor(Date.now() / 1000);
  const marks = Object.fromEntries(Object.entries(load(LOCAL_MUGS, {})).filter(([, t]) => now - t < 86400));
  marks[id] = now;
  save(LOCAL_MUGS, marks);
}
const localMugAt = (id) => Number((load(LOCAL_MUGS, {}) || {})[id]) || 0;

// Players mugged within this many hours are hidden (Settings, "Hide players mugged in the last"). 0 = show everyone.
export function hideHours() {
  const v = (load(STORE.prefs, {}) || {}).hideMuggedHours;
  return v === undefined || v === null || v === "" || !Number.isFinite(Number(v)) ? 12 : Math.max(0, Number(v));
}
export function isRecentlyMugged(r, now = Date.now() / 1000) {
  const hide = hideHours();
  const hours = hoursSinceMug(r, now);
  return hide > 0 && hours != null && hours < hide;
}
export const hiddenNote = (rows) => {
  const n = rows.filter((r) => isRecentlyMugged(r)).length;
  return n ? `${n} hidden: mugged in the last ${hideHours()} hours (change this in Settings).` : "";
};
// Has a mug in the last 15 hours (when the yield is still reduced): shown with a red edge on the card.
export function recentlyMuggedClass(r) {
  const hours = hoursSinceMug(r);
  return hours != null && hours < RECOVERY_HOURS ? "recent-mug" : "";
}

// Hours since the latest mug we know of (a member's, one you marked, or "Mugged by ..." in the hospital status), or null.
export function hoursSinceMug(r, now = Date.now() / 1000) {
  const rec = r.recent || {};
  const last = Math.max(rec.last || 0, localMugAt(r.id));
  let hours = last ? Math.max(0, (now - last) / 3600) : null;
  if (/mugged/i.test(r.details || "")) hours = hours == null ? 0.5 : Math.min(hours, 0.5);
  return hours;
}

export function recentDrain(r, now = Date.now() / 1000) {
  const rec = r.recent || {};
  const hours = hoursSinceMug(r, now);
  let keep = hours == null ? 1 : recovery(hours);
  let extra = Math.min(0.5, 0.1 * Math.max(0, (rec.n24 || 0) - 1)); // the second and later mugs in a day: a shared target
  extra += Math.min(0.15, 0.03 * Math.max(0, (rec.n7 || 0) - (rec.n24 || 0)));
  const h = r.history;
  if (h) {
    const outside = Math.max(0, h.lost24 - (rec.n24 || 0)); // fights lost beyond the members' mugs
    extra += Math.min(0.3, 0.1 * outside);
    extra += Math.min(0.1, 0.02 * Math.max(0, h.lost7 - h.lost24 - Math.max(0, (rec.n7 || 0) - (rec.n24 || 0))));
    if (h.drop24 >= 0.2) extra += 0.1; // net worth fell a fifth in a day: money left
    if (hours == null && outside > 0) keep *= 0.85; // attacked lately, but we do not know when
  }
  return Math.min(0.9, 1 - keep * (1 - Math.min(0.9, extra)));
}
export const recentNote = (r) => {
  const rec = r.recent || {};
  const bits = [];
  const hours = hoursSinceMug(r);
  if (rec.n24) bits.push(`${rec.n24} mug${rec.n24 === 1 ? "" : "s"} in 24h (last ${hours < 1 ? "<1" : hours.toFixed(0)}h ago)`);
  else if (hours != null && !/mugged/i.test(r.details || "")) bits.push(`last mug ${hours.toFixed(0)}h ago`);
  if ((rec.n7 || 0) > (rec.n24 || 0)) bits.push(`${rec.n7 - (rec.n24 || 0)} earlier this week`);
  if (/mugged/i.test(r.details || "")) bits.push("in hospital after a mug");
  const h = r.history;
  if (h && (h.lost24 || h.lost7)) bits.push(`Torn stats: ${h.lost24} fight${h.lost24 === 1 ? "" : "s"} lost in ~24h, ${h.lost7} in ~7 days (anyone)`);
  if (h && h.drop24 >= 0.2) bits.push(`net worth down ${Math.round(h.drop24 * 100)}% since yesterday`);
  return bits.length ? bits.join(", ") : r.recent || r.history ? "none known" : "not checked";
};


// Asks our server how often members mugged these players lately (no Torn calls) and puts it on the rows.
export async function loadRecentMugs(rows, call) {
  const ids = [...new Set(rows.map((r) => r.id))];
  for (let i = 0; i < ids.length; i += 100) {
    try {
      const { recent } = await call(`/api/targets/recent?ids=${ids.slice(i, i + 100).join(",")}`);
      for (const r of rows) r.recent = recent[r.id] || { n24: 0, n7: 0, last: 0, sum24: 0 };
    } catch { /* the rating just goes without it */ }
  }
}
