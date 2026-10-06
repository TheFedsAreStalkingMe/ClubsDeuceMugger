// Pure rules about a listing row. No page access here.

import { NUM_MAX, state } from "../state.js";
import { mugRate } from "./mugrate.js";

// A row is one seller with everything of theirs that qualifies: { id, name, items: [...], total, topPrice, activity, ... }
export const rowKey = (r) => String(r.id);

// Seconds until the player can be attacked: 0 = now, null = not known, Infinity = away with no timer
// (abroad, for example).
export function remaining(r) {
  if (r.state == null || r.state === "Unknown") return null;
  if (r.state === "Okay") return 0;
  if (!r.until) return Infinity;
  return Math.max(0, r.until - Date.now() / 1000);
}

// The rows to show. With "only Okay", players who are out are hidden (players not checked yet stay until they are).
export const visibleRows = () => (state.filters.onlyOkay ? state.rows.filter((r) => r.state == null || remaining(r) === 0) : state.rows);

export function sortValue(r, key) {
  switch (key) {
    case "stats": return r.bs;
    case "hospital": return remaining(r);
    case "age": return r.age;
    case "activity": return r.activity;
    case "profit": return mugOutlook(r).profit;
    default: return r.total; // price: the value of everything they sell that qualifies
  }
}

// A good mug: weaker than you, attackable soon, and offline long enough (rules from Settings).
// With `jackpot`, the item must also be worth the jackpot amount.
export function isMug(r, now, jackpot) {
  const pf = state.prefs;
  if (r.bs == null) return false;
  if (pf.myBs && r.bs >= pf.myBs) return false;
  const rem = remaining(r);
  if (rem == null || rem > pf.outMinutes * 60) return false;
  if (state.filters.onlyOkay && rem !== 0) return false;
  if (!r.last || (now - r.last) / 60 < pf.offlineMinutes) return false;
  if (jackpot && r.topPrice < pf.minJackpot) return false;
  return true;
}

// Why a listing is filtered out by the battle stat and fair fight limits, or null if it passes.
// Returns "ffHigh" | "noEst" | "tooWeak" | "tooStrong" | null.
export function statVerdict(bs, ff, f) {
  if (ff != null && ff > f.maxFf) return "ffHigh";
  if (bs == null) return (f.minBs > 0 || f.maxBs < NUM_MAX) && !f.includeUnknown ? "noEst" : null;
  if (bs < f.minBs) return "tooWeak";
  if (bs > f.maxBs) return "tooStrong";
  return null;
}

// "412 sellers checked: 380 listings are over your max stats, ..." for an empty result.
export function explainDrops(why, sellers) {
  const parts = [];
  if (why.noEst) parts.push(`${why.noEst} have no stat estimate`);
  if (why.tooStrong) parts.push(`${why.tooStrong} are over your max stats`);
  if (why.tooWeak) parts.push(`${why.tooWeak} are under your min stats`);
  if (why.ffHigh) parts.push(`${why.ffHigh} are over your max fair fight`);
  return `No targets match your filters. ${sellers} sellers checked${parts.length ? `: ${parts.join(", ")}` : ""}.`;
}

// Expected profit if you buy everything this seller lists and then mug them.
//   resale  = what the items are worth on the market minus what you pay (negative if overpriced)
//   mug     = the cash they hold after your purchase (what you paid) x 5% x (1 + merits + plunder), the bonuses from Settings
// Rating: bad if you lose money, good if the profit is at least 5% of what you spend (and $500k), else mediocre.
export function mugOutlook(r, f = state.filters) {
  const spend = r.total;
  const resale = r.items.reduce((sum, i) => sum + (i.market ? (i.market - i.price) * i.qty : 0), 0);
  const rate = mugRate();
  const mug = spend * rate;
  const profit = resale + mug;
  const rating = profit <= 0 ? "bad" : profit >= 500000 && profit >= spend * 0.05 ? "good" : "mediocre";
  return { resale, mug, rate, profit, rating };
}
