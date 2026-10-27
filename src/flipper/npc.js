// NPC price flips. An NPC pays or charges a FIXED price, so these are low risk: the NPC price is a floor under the Bazaar.
//   reverse NPC : buy from an NPC shop at a fixed price, sell on the Bazaar (pays the Bazaar tax)
//   NPC sell    : buy on the Bazaar, sell to an NPC at its fixed price (no tax: NPC sales are not taxed)
//   floor       : the NPC sell price next to the Bazaar price for every item
// Data: npc_sell_price from the Hypixel items resource (verified present on 2,441 of 5,680 items); NPC shop buy prices from
// the NEU repo (coin-only shop offers). Items with no NPC price are never suggested.
// Constraints modelled: a per-trip NPC limit (config.npc, NOT verified in-game), and the Bazaar book depth: the suggested
// quantity never exceeds what the book can supply (or absorb) at a profitable price.

import { afterTax, confidenceFrom, profitableDepth, walkBook } from "./math.js";
import { ALL_FILTERS, bazaarFlags, bestAsk, bestBid } from "./bazaar.js";

const TRIP_HOURS = 0.1; // [tuning] about 6 minutes for a trip to the NPC and the Bazaar

// The NPC sell price of an item, or null when NPCs do not buy it.
export const npcSellPrice = (meta, id) => (meta && meta[id] && meta[id].p > 0 ? meta[id].p : null);

export function npcFlips(ctx, params) {
  const { bz, recipes, meta, cfg } = ctx;
  const tax = params.tax ?? cfg.bazaar.sellTax;
  const stack = cfg.npc.defaultStack;
  const out = [];
  for (const p of Object.values(bz)) {
    if (!p.ask.length && !p.bid.length) continue;
    const sellNpc = npcSellPrice(meta, p.id);
    const shop = recipes.npc && recipes.npc[p.id];

    // 1. reverse NPC: NPC shop -> Bazaar (instant sale into the buy orders; the offer price is shown as a bonus)
    if (shop && p.bid.length) {
      const buy = shop[0];
      const depth = profitableDepth(p.bid.map(([pr, a]) => [afterTax(pr, tax), a]), buy, "sell");
      let qty = Math.min(cfg.npc.buyLimitStacks * stack, depth.qty);
      if (params.purse > 0) qty = Math.min(qty, Math.floor(params.purse / buy));
      if (params.orderSize > 0) qty = Math.min(qty, params.orderSize);
      qty = Math.floor(qty);
      if (qty >= 1) {
        const revenue = afterTax(walkBook(p.bid, qty).total, tax);
        const profit = revenue - buy * qty;
        if (profit > 0) {
          const roiPct = (profit / (buy * qty)) * 100;
          const offerNet = bestAsk(p) ? afterTax(bestAsk(p) - cfg.bazaar.orderUndercut, tax) - buy : null;
          out.push(finish(p, "npc-reverse", { npcPrice: buy, bazaarPrice: bestBid(p), qty, cost: buy * qty, profit, roiPct, offerUnitProfit: offerNet, npcName: shop[1], limit: cfg.npc.buyLimitStacks * stack }, params, cfg));
        }
      }
    }

    // 2. NPC sell: Bazaar instant buy -> NPC
    if (sellNpc && p.ask.length) {
      const depth = profitableDepth(p.ask, sellNpc, "buy");
      let qty = Math.min(cfg.npc.sellLimitStacks * stack, depth.qty);
      if (params.purse > 0) qty = Math.min(qty, Math.floor(params.purse / bestAsk(p)));
      if (params.orderSize > 0) qty = Math.min(qty, params.orderSize);
      qty = Math.floor(qty);
      if (qty >= 1) {
        const cost = walkBook(p.ask, qty).total;
        const profit = sellNpc * qty - cost; // no tax on NPC sales
        if (profit > 0) {
          out.push(finish(p, "npc-sell", { npcPrice: sellNpc, bazaarPrice: bestAsk(p), qty, cost, profit, roiPct: (profit / cost) * 100, limit: cfg.npc.sellLimitStacks * stack }, params, cfg));
        }
      }
    }
  }
  return out;
}

function finish(p, type, f, params, cfg) {
  const unit = f.profit / f.qty;
  const flags = bazaarFlags(p, { buyAt: type === "npc-sell" ? f.bazaarPrice : f.npcPrice, sellAt: type === "npc-sell" ? f.npcPrice : f.bazaarPrice, qty: f.qty, roiPct: f.roiPct }, cfg, null, params.filters || ALL_FILTERS, params.meta && params.meta[p.id]);
  // The NPC price is a fixed, guaranteed side of the trade and the Bazaar side is priced by walking the real book (only the
  // levels that are profitable), so the thin-market, outlier and spread checks do not apply: a cheap lone order is the
  // opportunity, not manipulation. Only the cosmetic warning is kept.
  const kept = flags.filter((x) => x.filter === "cosmetic");
  const conf = confidenceFrom(kept, { hasHistory: true });
  if (f.qty >= f.limit) conf.reasons.push(`Capped at the NPC limit of ${f.limit.toLocaleString("en-US")} items per trip (not verified in-game).`);
  return {
    type, id: p.id, buyAt: type === "npc-sell" ? f.bazaarPrice : f.npcPrice, sellAt: type === "npc-sell" ? f.npcPrice : f.bazaarPrice,
    unitProfit: unit, roiPct: f.roiPct, qty: f.qty, cost: f.cost, totalProfit: f.profit,
    npcPrice: f.npcPrice, bazaarPrice: f.bazaarPrice, offerUnitProfit: f.offerUnitProfit ?? null, npcName: f.npcName || "", limit: f.limit,
    fillBuyHours: 0, fillSellHours: 0, cycleHours: TRIP_HOURS, coinsPerHour: f.profit / TRIP_HOURS,
    volume: Math.min(p.instantBuyWeek, p.instantSellWeek), flags: kept, confidence: conf.level, reasons: conf.reasons,
  };
}

// The NPC price as a floor, for every item NPCs buy that is also on the Bazaar.
export function npcFloor(ctx) {
  const rows = [];
  for (const p of Object.values(ctx.bz)) {
    const npc = npcSellPrice(ctx.meta, p.id);
    if (!npc) continue;
    const bid = bestBid(p), ask = bestAsk(p);
    rows.push({ id: p.id, npcPrice: npc, bid, ask, belowFloor: bid != null && bid < npc, floorVsBidPct: bid ? ((npc - bid) / bid) * 100 : null });
  }
  return rows;
}
