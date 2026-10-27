// Craft flips: buy the ingredients, craft the product, sell it on the Bazaar. Recipes come from the NotEnoughUpdates repo
// (scripts/flipper-build-data.mjs). Each ingredient is acquired the cheapest way: the Bazaar instant-buy price, an NPC shop,
// or by crafting it from its own ingredients (multi-step crafts, up to config.craft.maxDepth steps).
//
// Limits (shown to the user): collection / level requirements are NOT checked (the recipe's "Requires:" text is shown instead);
// intermediate crafts are priced at the top of the book; Forge, Kat and trade recipes are not crafts here.

import { afterTax, confidenceFrom, fillHours, walkBook } from "./math.js";
import { ALL_FILTERS, bazaarFlags, bestAsk } from "./bazaar.js";
import { priceStats } from "./history.js";

// NEU writes variants as "RAW_FISH-1", the Bazaar as "RAW_FISH:1": try the id as is, then with the last "-" as ":".
export function bazaarId(bz, id) {
  if (bz[id]) return id;
  const alt = id.replace(/-(\d+)$/, ":$1");
  return bz[alt] ? alt : null;
}

// The cheapest way to get ONE unit of `id`: { cost, how: "bazaar" | "npc" | "craft", steps } or null when it cannot be had.
// `ctx` = { bz, recipes: { crafts, npc }, cfg }. Memoised per id for one calculation (ctx.memo).
export function acquire(ctx, id, depth = 0, stack = new Set()) {
  ctx.memo ||= new Map();
  if (ctx.memo.has(id)) return ctx.memo.get(id);
  const options = [];
  const bid = bazaarId(ctx.bz, id);
  const ask = bid ? bestAsk(ctx.bz[bid]) : null;
  if (ask) options.push({ cost: ask, how: "bazaar", id: bid });
  const shop = ctx.recipes.npc && ctx.recipes.npc[id];
  if (shop) options.push({ cost: shop[0], how: "npc", id, npc: shop[1] });
  const alts = ctx.recipes.crafts && ctx.recipes.crafts[id];
  if (alts && depth < ctx.cfg.craft.maxDepth && !stack.has(id)) {
    stack.add(id);
    for (const r of alts) {
      let total = 0, ok = true;
      const steps = [];
      for (const [ing, n] of Object.entries(r.i)) {
        const a = acquire(ctx, ing, depth + 1, stack);
        if (!a) { ok = false; break; }
        total += a.cost * n;
        steps.push({ id: ing, n, how: a.how, unit: a.cost, steps: a.steps, out: a.outputCount });
      }
      if (ok) options.push({ cost: total / r.n, how: "craft", id, steps, outputCount: r.n, req: r.req });
    }
    stack.delete(id);
  }
  const best = options.sort((a, b) => a.cost - b.cost)[0] || null;
  // a result found while a recipe was on the stack may be worse than the real one: only remember top-level answers
  if (depth === 0) ctx.memo.set(id, best);
  return best;
}

// The sources of the base ingredients of a craft (nested crafts are followed down to what is actually bought).
const leafSources = (steps) => steps.flatMap((s) => (s.how === "craft" ? leafSources(s.steps || []) : [s.how]));

// NPC-shop items needed to make ONE unit of the steps' product (nested crafts are followed down).
const npcUnits = (steps) => steps.reduce((n, s) => n + (s.how === "npc" ? s.n : s.how === "craft" ? (s.n * npcUnits(s.steps || [])) / (s.out || 1) : 0), 0);

// Craft flips for every product that is both craftable and sold on the Bazaar. `params` as for the Bazaar flips.
export function craftFlips(ctx, params) {
  const { bz, recipes, cfg } = ctx;
  const out = [];
  for (const [id, alts] of Object.entries(recipes.crafts || {})) {
    const p = bz[id];
    if (!p || !p.ask.length || !p.bid.length) continue;
    const sellAt = +(bestAsk(p) - cfg.bazaar.orderUndercut).toFixed(2);
    const tax = params.tax ?? cfg.bazaar.sellTax;
    let best = null;
    for (const r of alts) {
      // price the recipe directly (not through acquire(), which would return the market price of the product itself)
      let unitCost = 0, ok = true;
      const steps = [];
      for (const [ing, n] of Object.entries(r.i)) {
        const a = acquire({ ...ctx, memo: ctx.memo }, ing, 1, new Set([id]));
        if (!a) { ok = false; break; }
        unitCost += a.cost * n;
        steps.push({ id: ing, n, how: a.how, unit: a.cost, steps: a.steps, out: a.outputCount });
      }
      if (!ok) continue;
      unitCost /= r.n;
      const unit = afterTax(sellAt, tax) - unitCost;
      if (!best || unit > best.unit) best = { r, unitCost, unit, steps };
    }
    if (!best || !(best.unit > 0) || !(sellAt > 0)) continue;

    // how many can be crafted: what you can afford, a share of the sell-side flow, and the depth of every ingredient bought from the Bazaar
    let qty = Math.min(params.orderSize > 0 ? params.orderSize : Infinity, Math.floor(p.instantBuyWeek * cfg.bazaar.maxShareOfWeekly));
    if (params.purse > 0) qty = Math.min(qty, Math.floor(params.purse / best.unitCost));
    let slippage = false;
    for (const s of best.steps) {
      if (s.how !== "bazaar") continue;
      const bid = bazaarId(bz, s.id);
      const perUnit = s.n / best.r.n;
      const depth = bz[bid].ask.reduce((n, l) => n + l[1], 0);
      qty = Math.min(qty, Math.floor(depth / perUnit));
    }
    // NPC shop items (also inside multi-step crafts) are limited per trip (the limit is not verified in-game)
    const npcPerOutput = npcUnits(best.steps) / best.r.n;
    if (npcPerOutput > 0) qty = Math.min(qty, (cfg.npc.buyLimitStacks * cfg.npc.defaultStack) / npcPerOutput);
    qty = Math.floor(qty);
    if (!(qty >= 1)) continue;
    // exact cost for that many (walking the books), so the total profit includes slippage
    let total = 0;
    for (const s of best.steps) {
      const need = (s.n / best.r.n) * qty;
      if (s.how === "bazaar") {
        const w = walkBook(bz[bazaarId(bz, s.id)].ask, need);
        total += w.total;
        if (w.avg > s.unit * 1.02) slippage = true;
      } else total += s.unit * need;
    }
    const unitProfitReal = afterTax(sellAt, tax) - total / qty;
    if (!(unitProfitReal > 0)) continue;
    const roiPct = (unitProfitReal / (total / qty)) * 100;
    const fillSellH = fillHours(qty, p.instantBuyWeek, cfg.bazaar.hoursPerWeek, cfg.bazaar.queuePenalty);
    const cycleHours = fillSellH + cfg.bazaar.cycleOverheadHours;

    const stats = priceStats(params.history && params.history[id], params.now || 0, cfg);
    let flags = bazaarFlags(p, { buyAt: total / qty, sellAt, qty, roiPct }, cfg, stats, params.filters || ALL_FILTERS, params.meta && params.meta[id]);
    // A wide margin is normal for a craft (ingredients are cheap, the product is not): the "too good to be true" check only
    // applies from three times the normal limit, and not at all when every ingredient comes from an NPC shop (fixed prices).
    const leaves = leafSources(best.steps);
    flags = flags.filter((f) => f.filter !== "spread" || (roiPct > cfg.safety.maxRoiPct * 3 && !leaves.every((h) => h === "npc")));
    if (leaves.includes("npc")) flags.push({ filter: "npcstock", level: "warn", text: "Some ingredients come from an NPC shop: its stock and purchase limits are not checked." });
    if (best.r.req) flags.push({ filter: "req", level: "warn", text: `${best.r.req}. Unlock requirements are not checked by the Flipper.` });
    if (slippage) flags.push({ filter: "depth", level: "warn", text: "Buying this many ingredients pushes their price up more than 2%." });
    if (best.steps.some((s) => s.how === "craft")) flags.push({ filter: "multi", level: "warn", text: "Multi-step craft: the intermediate items are priced at the top of the book." });
    const conf = confidenceFrom(flags, { hasHistory: stats.points >= cfg.safety.minHistoryPoints });
    out.push({
      type: "craft", id, buyAt: total / qty, sellAt, unitProfit: unitProfitReal, roiPct, qty, cost: total, totalProfit: unitProfitReal * qty,
      fillBuyHours: 0, fillSellHours: fillSellH, cycleHours, coinsPerHour: (unitProfitReal * qty) / cycleHours,
      volume: p.instantBuyWeek, outputCount: best.r.n, steps: best.steps, req: best.r.req || "",
      flags, confidence: conf.level, reasons: conf.reasons,
    });
  }
  return out;
}
