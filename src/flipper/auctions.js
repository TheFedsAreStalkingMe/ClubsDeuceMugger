// Auction House BIN flips: a Buy-It-Now listing priced well below what the SAME variant of the item resells for.
//
// Method (built so one run stays cheap: decoding every auction's NBT would take ~40s of CPU, decoding a few hundred takes ~0.3s):
//   1. Pre-screen with data that needs no decoding: group the active BINs by cleaned item name + tier; the cheapest listing of a
//      group whose next listing is much dearer is a candidate (so is a lone listing of a high-value item, if budget remains).
//   2. Decode only the candidates (and the few listings next to them) to get the real item id and modifiers (nbt.js, variant.js).
//   3. Reference price = what the SAME variant (same `full` key) lists or sold for: the second-cheapest comparable BIN, and the
//      median of recent sales this site recorded from auctions_ended. If there are too few like-for-like prices the flip is
//      marked Low confidence (or dropped); a price is never invented.
//   4. Profit after the listing, duration and claim fees (config.js, NOT verified in-game). Sell time from how often the variant
//      sold per day and how many comparable listings are cheaper than yours.

import { confidenceFrom, ahNetProfit } from "./math.js";
import { decodeItem } from "./nbt.js";
import { variantOf } from "./variant.js";

export const cleanName = (s) => String(s || "").replace(/§./g, "").replace(/[✪➊➋➌➍➎✿⚚◆✦]/g, "").replace(/\s+/g, " ").trim();
const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : null; };
// Skins, hats, dyes: the item's last lore line says COSMETIC, or the id is a skin or dye.
export const isCosmetic = (dec) => {
  const last = [...(dec.lore || [])].map((l) => cleanName(l)).filter(Boolean).at(-1) || "";
  return /\bCOSMETIC\b/i.test(last) || /(^|_)SKIN(_|$)|^PET_SKIN|^DYE_|_DYE$/.test(dec.id || "");
};
const OVERHEAD_HOURS = 0.1; // [tuning] hands-on time: buy, relist

// Active BINs only: unclaimed, not ended, with a price.
export const activeBins = (listings, nowMs) => listings.filter((a) => a.bin && !a.claimed && a.end > nowMs && a.starting_bid > 0);

// Step 1. -> candidates [{ a, group }] (group = the group's listings, cheapest first), best potential first, at most `limit`.
export function preScreen(bins, cfg, { minPrice = 100000, minGap = 0.1, limit = 250 } = {}) {
  const groups = new Map();
  for (const a of bins) {
    const key = `${cleanName(a.item_name)}|${a.tier}`;
    (groups.get(key) || groups.set(key, []).get(key)).push(a);
  }
  const strong = [], singles = [];
  for (const group of groups.values()) {
    group.sort((x, y) => x.starting_bid - y.starting_bid);
    const [a, b] = group;
    if (a.starting_bid < minPrice) continue;
    if (b) {
      const gap = b.starting_bid - a.starting_bid;
      const rough = b.starting_bid * 0.96 - a.starting_bid; // a rough fee allowance, the real fees come after decoding
      if (gap / a.starting_bid >= minGap && rough >= cfg.auction.minProfit * 0.5) strong.push({ a, group, potential: rough });
    } else if (a.starting_bid >= Math.max(minPrice, cfg.auction.minTrackedPrice)) {
      singles.push({ a, group, potential: 0 });
    }
  }
  strong.sort((x, y) => y.potential - x.potential);
  singles.sort((x, y) => y.a.starting_bid - x.a.starting_bid);
  return [...strong, ...singles].slice(0, limit);
}

// The recent-sales lookup. `rows` = [{ core, full, ts (seconds), price }]. -> { forFull(key), forCore(key) } each returning
// { prices (newest first, at most `sample`), perDay (sales in the last 24h) }.
export function salesIndex(rows, nowSec, cfg) {
  const byFull = new Map(), byCore = new Map();
  for (const r of [...rows].sort((a, b) => b.ts - a.ts)) {
    (byFull.get(r.full) || byFull.set(r.full, []).get(r.full)).push(r);
    (byCore.get(r.core) || byCore.set(r.core, []).get(r.core)).push(r);
  }
  const stat = (list) => list ? { prices: list.slice(0, cfg.auction.sampleSales).map((r) => r.price), perDay: list.filter((r) => r.ts >= nowSec - 86400).length, n: list.length } : { prices: [], perDay: 0, n: 0 };
  return { forFull: (k) => stat(byFull.get(k)), forCore: (k) => stat(byCore.get(k)) };
}

// Steps 2-4. `ctx` = { cfg, loadSales(coreKeys) -> salesIndex (async: reads the stored sales of just these items), nowMs },
// `params` = { purse, minProfit, minRoiPct }. -> flips (best first).
export async function binFlips(candidates, ctx, params = {}) {
  const { cfg } = ctx;
  const minProfit = params.minProfit ?? cfg.auction.minProfit;
  const out = [];

  // step 2: decode the candidates and the cheapest listings next to them (each listing is decoded once)
  const cache = new Map();
  const cosmetics = new Set(); // uuids of cosmetic items (skins, hats, dyes): collectors' prices, not steady demand
  const variant = async (x) => {
    if (!cache.has(x.uuid)) {
      const d = await decodeItem(x.item_bytes);
      cache.set(x.uuid, d ? variantOf(d.attrs, d.name) : null);
      if (d && isCosmetic(d)) cosmetics.add(x.uuid);
    }
    return cache.get(x.uuid);
  };
  const prepared = [];
  for (const { a, group } of candidates) {
    if (params.purse > 0 && a.starting_bid > params.purse) continue;
    const v = await variant(a);
    if (!v) continue;
    const comps = { full: [], core: [] };
    for (const o of group.filter((x) => x !== a).slice(0, 8)) {
      const ov = await variant(o);
      if (!ov) continue;
      if (ov.full === v.full) comps.full.push(o.starting_bid);
      if (ov.core === v.core) comps.core.push(o.starting_bid);
    }
    prepared.push({ a, v, comps });
  }
  const sales = await ctx.loadSales([...new Set(prepared.map((p) => p.v.core))]);

  // steps 3-4: reference price, profit, sell time, confidence
  for (const { a, v, comps } of prepared) {
    const sFull = sales.forFull(v.full), sCore = sales.forCore(v.core);

    // the reference price: what it resells for. Prefer a like-for-like (full key) reference; fall back to the core key with a warning.
    const flags = [];
    let ref = null, evidence = 0, level = "full";
    const refFrom = (compList, sale) => {
      const parts = [];
      if (compList.length) parts.push(Math.min(...compList) * (1 - cfg.auction.relistUndercutPct / 100));
      if (sale.prices.length >= 2) parts.push(median(sale.prices));
      return parts.length ? Math.min(...parts) : null;
    };
    ref = refFrom(comps.full, sFull);
    evidence = comps.full.length + Math.min(sFull.prices.length, 99);
    if (ref == null || evidence < cfg.auction.minComparables) {
      const coreRef = refFrom(comps.core, sCore);
      if (coreRef != null && (ref == null || comps.core.length + sCore.prices.length > evidence)) {
        ref = coreRef;
        evidence = comps.core.length + sCore.prices.length;
        level = "core";
        flags.push({ filter: "variant", level: "bad", text: `Same item but not the same variant (reforge, enchants, potato books or gems differ): compared on ${v.label || "the item id"} only.` });
      }
    }
    if (ref == null) continue; // nothing like-for-like to price it against: not invented
    if (evidence < 2) flags.push({ filter: "comparables", level: "bad", text: "Only one comparable listing or sale to price it against: not enough to trust the reference price." });
    else if (evidence < cfg.auction.minComparables) flags.push({ filter: "comparables", level: "warn", text: `Only ${evidence} comparable listings or sales to price it against (want ${cfg.auction.minComparables}).` });

    const { net, fees } = ahNetProfit(a.starting_bid, Math.round(ref), cfg);
    if (!(net >= minProfit)) continue;
    const roiPct = (net / a.starting_bid) * 100;
    if (params.minRoiPct && roiPct < params.minRoiPct) continue;
    if (a.starting_bid < ref * 0.33) flags.push({ filter: "toocheap", level: "bad", text: "Listed at under a third of the reference price: almost certainly a difference the comparison cannot see (a missing enchant, part or stat), not a real bargain." });
    else if (a.starting_bid < ref * 0.5) flags.push({ filter: "toocheap", level: "warn", text: "Listed at less than half the reference price: check the item for something the comparison cannot see (a missing enchant or stat)." });

    if (cosmetics.has(a.uuid)) flags.push({ filter: "cosmetic", level: "bad", text: "Cosmetic item (skin, hat or dye): its price is driven by collectors, not by steady demand." });
    const stat = level === "full" ? sFull : sCore;
    const perDay = stat.perDay;
    const cheaper = (level === "full" ? comps.full : comps.core).filter((p) => p <= ref).length;
    const hoursToSell = perDay > 0 ? (24 * (cheaper + 1)) / perDay : null;
    if (hoursToSell == null) flags.push({ filter: "nosales", level: "warn", text: "No recorded sales of this variant yet: the time to sell is unknown." });
    else if (perDay < 1) flags.push({ filter: "slow", level: "warn", text: `Sells less than once a day (${perDay} in the last 24h).` });

    const conf = confidenceFrom(flags, { hasHistory: stat.n >= cfg.auction.minComparables });
    const cycleHours = hoursToSell == null ? null : hoursToSell + OVERHEAD_HOURS;
    out.push({
      type: "ah-bin", id: v.id, uuid: a.uuid, name: cleanName(a.item_name), tier: a.tier,
      variant: v.label, buyAt: a.starting_bid, sellAt: Math.round(ref), unitProfit: net, roiPct, qty: 1, cost: a.starting_bid, totalProfit: net, fees,
      fillBuyHours: 0, fillSellHours: hoursToSell, cycleHours, coinsPerHour: cycleHours ? net / cycleHours : null,
      volume: perDay, competitors: cheaper, comparables: evidence, endsAt: a.end,
      command: `/viewauction ${a.uuid}`, flags, confidence: conf.level, reasons: conf.reasons,
    });
  }
  return out.sort((x, y) => y.unitProfit - x.unitProfit);
}

// auctions_ended -> sales rows to store: only BIN sales of at least config.auction.minTrackedPrice, decoded to variant keys.
export async function salesFromEnded(ended, cfg) {
  const rows = [];
  for (const e of ended) {
    if (!e.bin || e.price < cfg.auction.minTrackedPrice) continue;
    const d = await decodeItem(e.item_bytes);
    const v = d && variantOf(d.attrs, d.name);
    if (!v) continue;
    rows.push({ id: e.auction_id, item: v.id, core: v.core, full: v.full, ts: Math.floor(e.timestamp / 1000), price: e.price });
  }
  return rows;
}
