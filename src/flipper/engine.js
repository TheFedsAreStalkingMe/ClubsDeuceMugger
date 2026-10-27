// Puts the Flipper together: runs the flip finders over the stored snapshots, joins names and NPC floors, filters, ranks.
// Pure (no network or database): the API route loads the data and passes it in, the tests pass fixtures.

import { instantFlip, orderFlip, prettyName } from "./bazaar.js";
import { craftFlips } from "./craft.js";
import { CONFIDENCE_VALUE, confidenceFrom, liquidityScore, rankScore } from "./math.js";
import { npcFlips, npcFloor } from "./npc.js";

export const TYPES = ["bazaar-order", "bazaar-instant", "craft", "npc-reverse", "npc-sell", "ah-bin"];

// The safety switches also apply to the stored auction flips: a warning whose filter is off is dropped and the confidence redone.
// ("toocheap" belongs to the too-good-spreads switch.)
const SWITCH = { toocheap: "spread" };
function withFilters(f, filters) {
  if (!filters) return f;
  const flags = f.flags.filter((x) => filters[SWITCH[x.filter] || x.filter] !== false);
  if (flags.length === f.flags.length) return f;
  const conf = confidenceFrom(flags, { hasHistory: f.comparables >= 3 });
  return { ...f, flags, confidence: conf.level, reasons: conf.reasons };
}

// All flips of the requested types, joined with names and the NPC floor. `data` = { bz (products), meta, recipes, ah (flips), history }.
// `params` = { types, purse, orderSize, tax, filters, now (seconds) }.
export function computeFlips(data, params, cfg) {
  const types = params.types && params.types.length ? params.types : TYPES;
  const p = { ...params, history: data.history, meta: data.meta };
  const out = [];
  const bz = data.bz || {};
  if (types.includes("bazaar-order")) for (const prod of Object.values(bz)) { const f = orderFlip(prod, p, cfg); if (f) out.push(f); }
  if (types.includes("bazaar-instant")) for (const prod of Object.values(bz)) { const f = instantFlip(prod, p, cfg); if (f) out.push(f); }
  const ctx = { bz, recipes: data.recipes || { crafts: {}, npc: {} }, meta: data.meta || {}, cfg };
  if (types.includes("craft")) out.push(...craftFlips(ctx, p));
  if (types.includes("npc-reverse") || types.includes("npc-sell")) out.push(...npcFlips(ctx, p).filter((f) => types.includes(f.type)));
  if (types.includes("ah-bin")) {
    for (const f of (data.ah && data.ah.flips) || []) {
      if (params.purse > 0 && f.cost > params.purse) continue;
      out.push(withFilters(f, params.filters));
    }
  }
  for (const f of out) {
    const m = data.meta && data.meta[f.id];
    f.name = f.name || (m && m.n) || prettyName(f.id);
    f.liquidity = Math.round(liquidityScore(f.type, f.volume) * 100);
    f.npcFloor = m && m.p > 0 ? m.p : null; // what an NPC pays: the least you would get if you dumped it
  }
  return out;
}

// Filters: { types, minProfit, minRoi, maxCost, minCph, minVolume, confidence ("Low" | "Med" | "High" = the lowest to show), q }
export function filterFlips(flips, f) {
  const need = CONFIDENCE_VALUE[f.confidence || "Med"] ?? CONFIDENCE_VALUE.Med;
  const q = (f.q || "").trim().toLowerCase();
  return flips.filter((x) =>
    (!(f.minProfit > 0) || x.totalProfit >= f.minProfit) &&
    (!(f.minRoi > 0) || x.roiPct >= f.minRoi) &&
    (!(f.maxCost > 0) || x.cost <= f.maxCost) &&
    (!(f.minCph > 0) || (x.coinsPerHour != null && x.coinsPerHour >= f.minCph)) &&
    (!(f.minVolume > 0) || x.volume >= f.minVolume) &&
    (CONFIDENCE_VALUE[x.confidence] ?? 0) >= need &&
    (!q || x.name.toLowerCase().includes(q) || x.id.toLowerCase().includes(q)));
}

// Sort: "score" (the blend of margin, speed and reliability with `weights`), "profit", "roi", "cph", "speed".
export function sortFlips(flips, sort, weights) {
  const key = {
    score: (x) => rankScore(x, weights),
    profit: (x) => x.totalProfit,
    roi: (x) => x.roiPct,
    cph: (x) => x.coinsPerHour ?? -1,
    speed: (x) => (x.cycleHours ? -x.cycleHours : -Infinity),
  }[sort] || ((x) => rankScore(x, weights));
  for (const x of flips) x.score = rankScore(x, weights);
  return [...flips].sort((a, b) => key(b) - key(a));
}

export { npcFloor };
