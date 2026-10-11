// What a player's bazaar and net worth did while they were offline. Torn has no per-player "bazaar open" flag, cash on hand
// is private, and sales lists are private, but public stat snapshots include bazaar sales and profit and net worth (read
// by history.js). A bazaar sells while its owner is offline and the money just sits in their cash, so it adds to what a
// mug can take; and net worth growth while offline shows what really accumulated (see earners/rules.js cashParts).

const DAY = 86400;

// Two sources: r.bz (the quick check on every match: the whole time they were offline) and r.history (the 3-call attack
// history for the best few: the last 24 hours and week).
const hist = (r) => (r.history && r.history.bazaar ? r.history : null);
const quick = (r) => (r.bz && r.bz.bazaar ? r.bz : null);

// Dollars their bazaar took in since they were last active, or 0 when unknown.
export function bazaarCash(r, now = Date.now() / 1000) {
  if (!r.last) return 0;
  const idle = Math.max(0, (now - r.last) / DAY);
  if (idle < 1) return 0; // active today: they may have spent it already
  const q = quick(r);
  if (q) return q.profit;
  const h = hist(r);
  if (!h) return 0;
  return idle >= 7 ? h.profit7 : Math.max(h.profit24 ?? 0, (h.profit7 * idle) / 7);
}

const money = (n) => (n >= 1e9 ? `$${(n / 1e9).toFixed(1)}b` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}m` : n >= 1e3 ? `$${Math.round(n / 1e3)}k` : `$${n}`);
const sales = (n) => `${n} sale${n === 1 ? "" : "s"}`;

export const bazaarNote = (r) => {
  const h = hist(r), q = quick(r);
  if (!h && !q) return r.history || r.bz === null ? "Torn gave no bazaar numbers" : "not checked";
  if (h) {
    if (!h.sales7) return "no sales in 7 days (bazaar probably closed or empty)";
    const day = h.sales24 == null ? "" : `${sales(h.sales24)} (${money(h.profit24)}) in ~24h, `;
    return `${day}${h.sales7} (${money(h.profit7)}) in ~7 days, about ${money(Math.round(h.profit7 / h.sales7))} each`;
  }
  if (!q.sales) return `no sales in ${q.days} days (bazaar probably closed or empty)`;
  return `${sales(q.sales)} (${money(q.profit)}) in the ${q.days} days they were offline, about ${money(Math.round(q.profit / q.sales))} each`;
};
