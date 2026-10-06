// How recently a player was mugged, and what that does to the next mug. Shared by every finder.
// From a mugging guide: Torn reduces what a mug takes from a player who was just mugged, and the yield comes back over
// about 15 hours (at 8 to 10 hours you still get 60 to 70% of the best amount). `recovery` is 0.1 right after a mug,
// about 0.7 after 9 hours and 1 after 15. Players mugged several times in a day or week are ones others farm, and
// fights lost to anyone (Torn's stats, `r.history`) count too.
// Rows carry `recent` ({ n24, n7, last }) from our own record of member mugs (/api/targets/recent) and `details` (the
// status text, "Mugged by ..." while in hospital).

const RECOVERY_HOURS = 15;
export const recovery = (hours) => (hours >= RECOVERY_HOURS ? 1 : 0.1 + 0.9 * Math.pow(Math.max(0, hours) / RECOVERY_HOURS, 0.8));

// Hours since the latest mug we know of (a member's, or "Mugged by ..." in the hospital status), or null.
export function hoursSinceMug(r, now = Date.now() / 1000) {
  const rec = r.recent || {};
  let hours = rec.last ? Math.max(0, (now - rec.last) / 3600) : null;
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
