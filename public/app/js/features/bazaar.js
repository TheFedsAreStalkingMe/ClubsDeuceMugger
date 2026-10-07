// Cash that a player's bazaar took in while they were offline. Torn has no per-player "bazaar open" or sales list, but its
// public stat snapshots include bazaar sales and profit (read with the attack history, see history.js). A bazaar sells
// while its owner is offline and the money just sits in their cash, so it adds to what a mug can take.

const DAY = 86400;

// Dollars their bazaar took in since they were last active (about: the last 7 days at most), or 0 when unknown.
export function bazaarCash(r, now = Date.now() / 1000) {
  const h = r.history;
  if (!h || !h.bazaar || !r.last) return 0;
  const idle = Math.max(0, (now - r.last) / DAY);
  if (idle >= 7) return h.profit7;
  if (idle >= 1) return Math.max(h.profit24, (h.profit7 * idle) / 7);
  return 0; // active today: they may have spent it already
}

export const bazaarNote = (r) => {
  const h = r.history;
  if (!h) return "not checked";
  if (!h.bazaar) return "Torn gave no bazaar numbers";
  if (!h.sales7) return "no sales in 7 days (bazaar probably closed or empty)";
  const money = (n) => (n >= 1e9 ? `$${(n / 1e9).toFixed(1)}b` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}m` : n >= 1e3 ? `$${Math.round(n / 1e3)}k` : `$${n}`);
  return `${h.sales24} sale${h.sales24 === 1 ? "" : "s"} (${money(h.profit24)}) in ~24h, ${h.sales7} (${money(h.profit7)}) in ~7 days, about ${money(Math.round(h.profit7 / h.sales7))} each`;
};
