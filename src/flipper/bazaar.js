// Bazaar data and the two Bazaar flip types (order flips and instant flips).
//
// NAMING: the Hypixel API names are easy to get backwards, so this file renames them once and the rest of the Flipper only
// uses the clear names below. Verified against live data (see SOURCES.md):
//   API buy_summary  = SELL OFFERS (asks). What you pay when you buy instantly. First entry = the lowest = best.
//   API sell_summary = BUY ORDERS (bids).  What you get when you sell instantly. First entry = the highest = best.
//   quick_status.buyPrice / sellPrice follow the same naming (buyPrice is the ask side, sellPrice the bid side).
//   buyMovingWeek  = items bought instantly in a week (these fill sell offers)   -> instantBuyWeek
//   sellMovingWeek = items sold instantly in a week (these fill buy orders)      -> instantSellWeek
// A product: { id, ask: [[price, amount]...], bid: [[price, amount]...], askOrders, bidOrders, askVolume, bidVolume,
//              instantBuyWeek, instantSellWeek, qsAsk, qsBid }

import { afterTax, confidenceFrom, depthWeighted, fillHours, walkBook } from "./math.js";
import { priceStats } from "./history.js";

const lv = (list, keep) => (Array.isArray(list) ? list.slice(0, keep).map((o) => [o.pricePerUnit, o.amount]) : []);

// Raw API answer -> { updated (ms), products: { id: product } } keeping only the best `keep` levels per side.
export function normalizeBazaar(raw, keep = 10) {
  const products = {};
  for (const [id, p] of Object.entries((raw && raw.products) || {})) {
    const q = p.quick_status || {};
    products[id] = {
      id,
      ask: lv(p.buy_summary, keep),
      bid: lv(p.sell_summary, keep),
      askOrders: q.buyOrders || 0,
      bidOrders: q.sellOrders || 0,
      askVolume: q.buyVolume || 0,
      bidVolume: q.sellVolume || 0,
      instantBuyWeek: q.buyMovingWeek || 0,
      instantSellWeek: q.sellMovingWeek || 0,
      qsAsk: q.buyPrice || 0,
      qsBid: q.sellPrice || 0,
    };
  }
  return { updated: (raw && raw.lastUpdated) || 0, products };
}

export const bestAsk = (p) => (p.ask.length ? p.ask[0][0] : null);
export const bestBid = (p) => (p.bid.length ? p.bid[0][0] : null);

// "ENCHANTMENT_ULTIMATE_CROP_FEVER_5" -> "Enchantment Ultimate Crop Fever 5" when the items list has no name for it.
export const prettyName = (id) => id.toLowerCase().split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

const INSTANT_CYCLE_HOURS = 0.02; // an instant flip takes about a minute: two clicks

// The default switches for the safety filters (the page sends its own).
export const ALL_FILTERS = { volume: true, thin: true, outlier: true, spread: true, volatility: true, trend: true, cosmetic: true };

// Checks on one product for a flip that buys at `buyAt` and sells at `sellAt` with orders of `qty`. Returns warnings
// as { filter, level: "bad" | "warn", text }. A "bad" one removes the flip when its filter is switched on.
export function bazaarFlags(p, { buyAt, sellAt, qty, roiPct }, cfg, stats, filters, meta) {
  const s = cfg.safety, flags = [];
  const on = (name) => filters[name] !== false;
  const weekly = Math.min(p.instantBuyWeek, p.instantSellWeek);
  if (on("volume") && weekly < s.minWeeklyVolume) flags.push({ filter: "volume", level: "bad", text: `Only ${Math.round(weekly).toLocaleString("en-US")} items trade per week on the slower side (minimum ${s.minWeeklyVolume.toLocaleString("en-US")}).` });
  if (on("thin")) {
    if (Math.min(p.askOrders, p.bidOrders) < s.minOrdersPerSide) flags.push({ filter: "thin", level: "bad", text: `Thin market: only ${p.askOrders} sell offers and ${p.bidOrders} buy orders.` });
    const topDepth = Math.min(p.ask.slice(0, cfg.bazaar.depthLevels).reduce((n, l) => n + l[1], 0), p.bid.slice(0, cfg.bazaar.depthLevels).reduce((n, l) => n + l[1], 0));
    if (qty > topDepth) flags.push({ filter: "thin", level: "warn", text: `Your order (${qty.toLocaleString("en-US")}) is bigger than the top ${cfg.bazaar.depthLevels} levels of the book (${Math.round(topDepth).toLocaleString("en-US")}).` });
  }
  if (on("outlier")) {
    // top order vs the depth-weighted price over the top levels, and vs the API's own top-2%-by-volume average
    const bidW = depthWeighted(p.bid, cfg.bazaar.depthLevels), askW = depthWeighted(p.ask, cfg.bazaar.depthLevels);
    const dev = (top, ref) => (ref ? (Math.abs(top - ref) / ref) * 100 : 0);
    const worst = Math.max(dev(bestBid(p) ?? 0, bidW), dev(bestAsk(p) ?? 0, askW), p.qsBid ? dev(bestBid(p) ?? 0, p.qsBid) : 0, p.qsAsk ? dev(bestAsk(p) ?? 0, p.qsAsk) : 0);
    if (worst > s.maxOutlierPct) flags.push({ filter: "outlier", level: "bad", text: `The top of the book is ${worst.toFixed(1)}% away from the depth-weighted price: probably one outlier order, not a real spread.` });
  }
  if (on("spread") && roiPct > s.maxRoiPct) flags.push({ filter: "spread", level: "bad", text: `A ${roiPct.toFixed(0)}% return is too good to be real (over ${s.maxRoiPct}%): likely a manipulated or broken book.` });
  if (on("volatility") && stats && stats.volatilityPct != null) {
    if (stats.volatilityPct > s.maxVolatility24hPct * 2) flags.push({ filter: "volatility", level: "bad", text: `The price swung ${stats.volatilityPct.toFixed(0)}% in the last day.` });
    else if (stats.volatilityPct > s.maxVolatility24hPct) flags.push({ filter: "volatility", level: "warn", text: `The price moved ${stats.volatilityPct.toFixed(0)}% in the last day (limit ${s.maxVolatility24hPct}%).` });
  }
  if (on("trend") && stats) {
    if (stats.change6hPct != null && stats.change6hPct < s.fallingPct6h) flags.push({ filter: "trend", level: "warn", text: `The price is falling: ${stats.change6hPct.toFixed(1)}% in 6 hours (you could be flipping into a drop).` });
    if (stats.change1hPct != null && stats.change1hPct > s.spikePct1h) flags.push({ filter: "trend", level: "warn", text: `The price just spiked ${stats.change1hPct.toFixed(1)}% in the last hour.` });
  }
  if (on("cosmetic") && meta && meta.c === "COSMETIC") flags.push({ filter: "cosmetic", level: "bad", text: "Cosmetic item: its price is driven by collectors, not by steady demand." });
  return flags;
}

// A Bazaar order flip: place a buy order just above the best bid, then a sell offer just under the best ask.
// `params`: { purse, orderSize (0 = automatic), tax, filters, history (id -> points) , meta (id -> item info), now (seconds) }
export function orderFlip(p, params, cfg) {
  const bid = bestBid(p), ask = bestAsk(p);
  if (bid == null || ask == null) return null;
  const tax = params.tax ?? cfg.bazaar.sellTax;
  const buyAt = +(bid + cfg.bazaar.orderUndercut).toFixed(2);
  const sellAt = +(ask - cfg.bazaar.orderUndercut).toFixed(2);
  if (!(sellAt > buyAt)) return null; // the spread is too small to undercut on both sides
  const unit = afterTax(sellAt, tax) - buyAt;
  if (!(unit > 0)) return null;
  const roiPct = (unit / buyAt) * 100;

  // order size: what you asked for, what you can afford, and a share of the weekly flow
  const flowCap = Math.floor(Math.min(p.instantBuyWeek, p.instantSellWeek) * cfg.bazaar.maxShareOfWeekly);
  let qty = Math.min(params.orderSize > 0 ? params.orderSize : Infinity, flowCap);
  if (params.purse > 0) qty = Math.min(qty, Math.floor(params.purse / buyAt));
  qty = Math.floor(qty);
  if (!(qty >= 1)) return null;

  const fillBuyH = fillHours(qty, p.instantSellWeek, cfg.bazaar.hoursPerWeek, cfg.bazaar.queuePenalty);
  const fillSellH = fillHours(qty, p.instantBuyWeek, cfg.bazaar.hoursPerWeek, cfg.bazaar.queuePenalty);
  const cycleHours = fillBuyH + fillSellH + cfg.bazaar.cycleOverheadHours;
  if (!Number.isFinite(cycleHours)) return null;

  const stats = priceStats(params.history && params.history[p.id], params.now || 0, cfg);
  const flags = bazaarFlags(p, { buyAt, sellAt, qty, roiPct }, cfg, stats, params.filters || ALL_FILTERS, params.meta && params.meta[p.id]);
  const conf = confidenceFrom(flags, { hasHistory: stats.points >= cfg.safety.minHistoryPoints });
  return {
    type: "bazaar-order", id: p.id,
    buyAt, sellAt, unitProfit: unit, roiPct, qty, cost: buyAt * qty, totalProfit: unit * qty,
    fillBuyHours: fillBuyH, fillSellHours: fillSellH, cycleHours, coinsPerHour: (unit * qty) / cycleHours,
    volume: Math.min(p.instantBuyWeek, p.instantSellWeek),
    flags, confidence: conf.level, reasons: conf.reasons,
  };
}

// A Bazaar instant flip: buy from the sell offers right now and sell into the buy orders right now. After the tax this is
// almost never positive (the spread would have to beat the tax), so it only shows up when the book really is crossed.
export function instantFlip(p, params, cfg) {
  const bid = bestBid(p), ask = bestAsk(p);
  if (bid == null || ask == null) return null;
  const tax = params.tax ?? cfg.bazaar.sellTax;
  if (!(afterTax(bid, tax) > ask)) return null;
  let qty = Math.min(p.ask.reduce((n, l) => n + l[1], 0), p.bid.reduce((n, l) => n + l[1], 0));
  if (params.orderSize > 0) qty = Math.min(qty, params.orderSize);
  if (params.purse > 0) qty = Math.min(qty, Math.floor(params.purse / ask));
  if (!(qty >= 1)) return null;
  const buy = walkBook(p.ask, qty), sell = walkBook(p.bid, qty);
  qty = Math.min(buy.filled, sell.filled);
  const cost = walkBook(p.ask, qty).total, revenue = afterTax(walkBook(p.bid, qty).total, tax);
  if (!(revenue > cost)) return null;
  const roiPct = ((revenue - cost) / cost) * 100;
  const flags = bazaarFlags(p, { buyAt: ask, sellAt: bid, qty, roiPct }, cfg, null, params.filters || ALL_FILTERS, params.meta && params.meta[p.id]);
  // a crossed book that survives the tax is nearly always a stale or manipulated snapshot: never better than Low
  flags.push({ filter: "spread", level: "bad", text: "An instant flip that beats the tax means the order book is crossed: probably stale or manipulated data." });
  const conf = confidenceFrom(flags, { hasHistory: false });
  return {
    type: "bazaar-instant", id: p.id, buyAt: cost / qty, sellAt: revenue / qty, unitProfit: (revenue - cost) / qty, roiPct, qty,
    cost, totalProfit: revenue - cost, fillBuyHours: 0, fillSellHours: 0, cycleHours: INSTANT_CYCLE_HOURS, coinsPerHour: (revenue - cost) / INSTANT_CYCLE_HOURS,
    volume: Math.min(p.instantBuyWeek, p.instantSellWeek), flags, confidence: conf.level, reasons: conf.reasons,
  };
}
