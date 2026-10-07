// Cash that a player's bazaar took in while they were offline. Torn has no per-player "bazaar open" or sales list, but its
// public stat snapshots include bazaar sales and profit (read with the attack history, see history.js). A bazaar sells
// while its owner is offline and the money just sits in their cash, so it adds to what a mug can take.

const DAY = 86400;

// The bazaar numbers of a row: from the quick bazaar check (r.bz) or the full attack history (r.history).
export const bz = (r) => (r.history && r.history.bazaar ? r.history : r.bz && r.bz.bazaar ? r.bz : null);

// Dollars their bazaar took in since they were last active (about: the last 7 days at most), or 0 when unknown.
export function bazaarCash(r, now = Date.now() / 1000) {
  const h = bz(r);
  if (!h || !r.last) return 0;
  const idle = Math.max(0, (now - r.last) / DAY);
  if (idle >= 7) return h.profit7;
  if (idle >= 1) return Math.max(h.profit24 ?? 0, (h.profit7 * idle) / 7);
  return 0; // active today: they may have spent it already
}

export const bazaarNote = (r) => {
  const h = bz(r);
  if (!h) return r.history || r.bz === null ? "Torn gave no bazaar numbers" : "not checked";
  if (!h.sales7) return "no sales in 7 days (bazaar probably closed or empty)";
  const money = (n) => (n >= 1e9 ? `$${(n / 1e9).toFixed(1)}b` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}m` : n >= 1e3 ? `$${Math.round(n / 1e3)}k` : `$${n}`);
  const day = h.sales24 == null ? "" : `${h.sales24} sale${h.sales24 === 1 ? "" : "s"} (${money(h.profit24)}) in ~24h, `;
  return `${day}${h.sales7} (${money(h.profit7)}) in ~7 days, about ${money(Math.round(h.profit7 / h.sales7))} each`;
};
