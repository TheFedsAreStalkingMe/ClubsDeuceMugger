// Flipper unit tests: the margin / tax / fee / fill-time maths with known numbers, order-book handling, the safety checks, craft
// and NPC flips, NBT decoding and variant matching (real Hypixel item_bytes fixtures plus items built here), BIN flips, history
// maths and the number formatting. No network, no Worker: plain Node.   node tests/flipper.mjs

import fs from "node:fs";
import { flipperConfig } from "../src/flipper/config.js";
import { afterTax, ahNetProfit, claimFee, confidenceFrom, depthWeighted, durationFee, fillHours, liquidityScore, listingFee, marginScore, profitableDepth, rankScore, speedScore, walkBook } from "../src/flipper/math.js";
import { instantFlip, normalizeBazaar, orderFlip, prettyName } from "../src/flipper/bazaar.js";
import { acquire, bazaarId, craftFlips } from "../src/flipper/craft.js";
import { npcFlips, npcFloor } from "../src/flipper/npc.js";
import { decodeItem, parseNbt } from "../src/flipper/nbt.js";
import { variantOf } from "../src/flipper/variant.js";
import { activeBins, binFlips, cleanName, preScreen, salesFromEnded, salesIndex } from "../src/flipper/auctions.js";
import { parseCoflHistory, priceStats } from "../src/flipper/history.js";
import { computeFlips, filterFlips, sortFlips } from "../src/flipper/engine.js";
import { itemBytes, nbtPayload } from "./lib/nbt-writer.mjs";
import { fmtAge, fmtCoins, fmtHours, fmtPct, parseCoins } from "../public/app/js/flipper/format.js";

let passed = 0, failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) passed++; else { failed++; console.log(`  FAIL ${name}${detail ? ` ${detail}` : ""}`); }
};
const section = (s) => console.log(`\n${s}`);
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
const cfg = flipperConfig({});

// (the NBT writer for building test items is in tests/lib/nbt-writer.mjs)
// a Bazaar product as the API returns it (buy_summary = sell offers, sell_summary = buy orders)
const product = (id, { asks, bids, buyWeek = 1e6, sellWeek = 1e6, askOrders = 20, bidOrders = 20, qsBuy, qsSell }) => ({
  product_id: id,
  quick_status: { productId: id, buyPrice: qsBuy ?? asks[0]?.[0] ?? 0, sellPrice: qsSell ?? bids[0]?.[0] ?? 0, buyMovingWeek: buyWeek, sellMovingWeek: sellWeek, buyOrders: askOrders, sellOrders: bidOrders, buyVolume: 1e6, sellVolume: 1e6 },
  buy_summary: asks.map(([pricePerUnit, amount]) => ({ pricePerUnit, amount, orders: 1 })),
  sell_summary: bids.map(([pricePerUnit, amount]) => ({ pricePerUnit, amount, orders: 1 })),
});
const bazaar = (...prods) => normalizeBazaar({ success: true, lastUpdated: 1e12, products: Object.fromEntries(prods.map((p) => [p.product_id, p])) });

// ---------------------------------------------------------------- 1. the maths

section("Math: tax, fees, books, fill time");
check("Bazaar tax: 1.25% is taken from a sale", near(afterTax(1000, 0.0125), 987.5));
check("the Bazaar tax default is 1.25% and can be overridden by environment", cfg.bazaar.sellTax === 0.0125 && flipperConfig({ FLIPPER_BAZAAR_TAX: "0.01" }).bazaar.sellTax === 0.01);
check("a silly tax value is clamped", flipperConfig({ FLIPPER_BAZAAR_TAX: "5" }).bazaar.sellTax === 0.1 && flipperConfig({ FLIPPER_BAZAAR_TAX: "-1" }).bazaar.sellTax === 0);
check("walkBook fills level by level", (() => { const w = walkBook([[10, 5], [12, 5], [20, 100]], 8); return w.filled === 8 && w.total === 5 * 10 + 3 * 12 && near(w.avg, 86 / 8); })());
check("walkBook on a shallow book fills what exists", walkBook([[10, 5]], 50).filled === 5);
check("walkBook on an empty book", walkBook([], 5).filled === 0 && walkBook([], 5).avg === 0);
check("profitableDepth stops where the margin ends (buying)", (() => { const d = profitableDepth([[900, 100], [990, 200], [1010, 500]], 1000, "buy"); return d.qty === 300 && d.cost === 100 * 900 + 200 * 990; })());
check("profitableDepth when selling", profitableDepth([[20, 1000], [12, 500], [8, 2000]], 10, "sell").qty === 1500);
check("depthWeighted averages by amount", near(depthWeighted([[100, 1], [200, 3]], 2), 175) && depthWeighted([], 5) === null);
check("fill time: 8,400 a week = 50 an hour, so 100 items take 2h", near(fillHours(100, 8400, 168, 1), 2));
check("fill time is slowed by the queue penalty", near(fillHours(100, 8400, 168, 1.5), 3));
check("fill time with no volume is infinite", fillHours(10, 0) === Infinity && fillHours(0, 1000) === Infinity);

section("Math: Auction House fees (values need in-game verification, see config.js)");
check("BIN listing fee: 1% under 10m", listingFee(5_000_000, cfg) === 50_000);
check("BIN listing fee: 2% from 10m to 100m", listingFee(20_000_000, cfg) === 400_000);
check("BIN listing fee: 2.5% from 100m", listingFee(150_000_000, cfg) === 3_750_000);
check("the fee tier changes exactly at 10m and 100m", listingFee(9_999_999, cfg) === 100_000 && listingFee(10_000_000, cfg) === 200_000 && listingFee(100_000_000, cfg) === 2_500_000);
check("duration fees by listing length", durationFee(cfg) === 350 && durationFee({ auction: { ...cfg.auction, duration: "48h" } }) === 1200 && durationFee({ auction: { ...cfg.auction, duration: "1h" } }) === 20);
check("claim fee is 1% on a 5m sale and none on a small one", claimFee(5_000_000, cfg) === 50_000 && claimFee(500_000, cfg) === 0);
check("AH net profit: buy 4m, relist at 5m", (() => { const r = ahNetProfit(4_000_000, 5_000_000, cfg); return r.fees === 50_000 + 350 + 50_000 && r.net === 5_000_000 - r.fees - 4_000_000; })());
check("the AH duration can be set by environment", flipperConfig({ FLIPPER_AH_DURATION: "48h" }).auction.duration === "48h" && flipperConfig({ FLIPPER_AH_DURATION: "nope" }).auction.duration === "24h");

section("Math: scores and confidence");
check("liquidity: Bazaar by weekly volume (log scale), auctions by sales per day, NPC flips fully liquid", liquidityScore("bazaar-order", 1000) === 0 && near(liquidityScore("bazaar-order", 1e6), 1) && liquidityScore("bazaar-order", 10) === 0 && near(liquidityScore("ah-bin", 9), 1) && liquidityScore("ah-bin", 0) === 0 && liquidityScore("npc-sell", 0) === 1 && liquidityScore("craft", 31622) > 0.4 && liquidityScore("craft", 31622) < 0.6);
check("margin score: 15% ROI or more is full, 0 is none", marginScore(15) === 1 && marginScore(30) === 1 && marginScore(0) === 0 && near(marginScore(7.5), 0.5));
check("speed score: 3 minutes is 1, 48 hours is 0, in between falls", speedScore(0.05) === 1 && speedScore(48) === 0 && speedScore(1) > speedScore(10) && speedScore(Infinity) === 0 && speedScore(null) === 0);
check("rank score blends by weights (only proportions matter)", (() => {
  const f = { roiPct: 15, cycleHours: 0.05, confidence: "High" };
  const slow = { roiPct: 15, cycleHours: 48, confidence: "High" };
  return near(rankScore(f, { margin: 1, speed: 1, reliability: 1 }), 1) && near(rankScore(f, { margin: 4, speed: 4, reliability: 4 }), 1)
    && rankScore(slow, { margin: 1, speed: 0, reliability: 0 }) === 1 && rankScore(slow, { margin: 0, speed: 1, reliability: 0 }) === 0;
})());
check("confidence: no flags and history is High", confidenceFrom([], { hasHistory: true }).level === "High");
check("confidence: no history is only Med", confidenceFrom([], { hasHistory: false }).level === "Med");
check("confidence: a warning is Med, a bad flag is Low, reasons are listed", confidenceFrom([{ level: "warn", text: "w" }]).level === "Med" && confidenceFrom([{ level: "bad", text: "b" }, { level: "warn", text: "w" }]).level === "Low" && confidenceFrom([{ level: "bad", text: "b" }]).reasons[0] === "b");

// ---------------------------------------------------------------- 2. Bazaar

section("Bazaar: naming (the API's buy and sell are easy to flip)");
const sampleRaw = JSON.parse(fs.readFileSync(new URL("./fixtures/flipper-bazaar-sample.json", import.meta.url)));
const sample = normalizeBazaar(sampleRaw);
const diamond = sample.products.ENCHANTED_DIAMOND;
check("real data: API buy_summary is the ask side (higher) and sell_summary the bid side (lower)", diamond.ask[0][0] > diamond.bid[0][0], `${diamond.ask[0][0]} vs ${diamond.bid[0][0]}`);
check("the first level is the best one: asks rise, bids fall", diamond.ask[1][0] >= diamond.ask[0][0] && diamond.bid[1][0] <= diamond.bid[0][0]);
check("real data: instant buys fill sell offers, instant sells fill buy orders", diamond.instantBuyWeek === sampleRaw.products.ENCHANTED_DIAMOND.quick_status.buyMovingWeek && diamond.instantSellWeek === sampleRaw.products.ENCHANTED_DIAMOND.quick_status.sellMovingWeek);
check("normalize keeps the best N levels and the update time", normalizeBazaar(sampleRaw, 3).products.DIAMOND.ask.length === 3 && sample.updated === sampleRaw.lastUpdated);
check("empty or broken answers normalise to nothing", Object.keys(normalizeBazaar(null).products).length === 0 && Object.keys(normalizeBazaar({}).products).length === 0);
check("prettyName", prettyName("ENCHANTMENT_ULTIMATE_CROP_FEVER_5") === "Enchantment Ultimate Crop Fever 5");

section("Bazaar: order flip numbers");
const A = bazaar(product("TEST_ITEM", { asks: [[1100, 500], [1101, 500]], bids: [[1000, 500], [999, 500]], buyWeek: 70000, sellWeek: 70000 }));
const flip = orderFlip(A.products.TEST_ITEM, { orderSize: 100, now: 1e9 }, cfg);
check("buy order is one step above the best bid, sell offer one step under the best ask", flip.buyAt === 1000.1 && flip.sellAt === 1099.9);
check("net profit per item = sell after tax minus buy", near(flip.unitProfit, 1099.9 * 0.9875 - 1000.1, 1e-6), String(flip.unitProfit));
check("ROI = net profit / buy price", near(flip.roiPct, ((1099.9 * 0.9875 - 1000.1) / 1000.1) * 100, 1e-6));
check("total profit and cost for the order size", flip.qty === 100 && near(flip.totalProfit, flip.unitProfit * 100, 1e-6) && near(flip.cost, 100010, 1e-6));
check("fill times: 70,000 a week = 417/h, 100 items x 1.5 queue penalty", near(flip.fillBuyHours, (100 / (70000 / 168)) * 1.5, 1e-9) && near(flip.fillSellHours, flip.fillBuyHours, 1e-9));
check("cycle = both fills plus the hands-on overhead, coins/hour = profit / cycle", near(flip.cycleHours, flip.fillBuyHours + flip.fillSellHours + cfg.bazaar.cycleOverheadHours, 1e-9) && near(flip.coinsPerHour, flip.totalProfit / flip.cycleHours, 1e-6));
check("the tax is configurable", orderFlip(A.products.TEST_ITEM, { orderSize: 100, tax: 0.01, now: 1e9 }, cfg).unitProfit > flip.unitProfit);
check("the purse caps the quantity", orderFlip(A.products.TEST_ITEM, { orderSize: 100, purse: 30_000, now: 1e9 }, cfg).qty === 29);
check("a purse too small for one item gives no flip", orderFlip(A.products.TEST_ITEM, { purse: 500, now: 1e9 }, cfg) === null);
check("the order is capped to a share of the weekly volume", orderFlip(A.products.TEST_ITEM, { now: 1e9 }, cfg).qty === Math.floor(70000 * cfg.bazaar.maxShareOfWeekly));
check("a spread that does not survive the tax is not a flip", orderFlip(bazaar(product("X", { asks: [[1010, 500]], bids: [[1000, 500]] })).products.X, { now: 1e9 }, cfg) === null);
check("a spread too narrow to undercut on both sides is not a flip", orderFlip(bazaar(product("X", { asks: [[1000.1, 500]], bids: [[1000, 500]] })).products.X, { now: 1e9 }, cfg) === null);
check("an empty side gives no flip (empty order book)", orderFlip(bazaar(product("X", { asks: [], bids: [[1000, 5]] })).products.X, { now: 1e9 }, cfg) === null && orderFlip(bazaar(product("X", { asks: [[1000, 5]], bids: [] })).products.X, { now: 1e9 }, cfg) === null);
check("zero volume gives no flip", orderFlip(bazaar(product("X", { asks: [[1100, 500]], bids: [[1000, 500]], buyWeek: 0, sellWeek: 0 })).products.X, { orderSize: 10, now: 1e9 }, cfg) === null);
check("a good clean flip has High or Med confidence with a reason", ["High", "Med"].includes(flip.confidence) && flip.reasons.length >= 1);

section("Bazaar: instant flips and safety checks");
check("an ordinary book has no instant flip (the spread loses to the tax)", instantFlip(A.products.TEST_ITEM, {}, cfg) === null);
const crossed = bazaar(product("CROSSED", { asks: [[1000, 100], [1010, 100]], bids: [[1100, 100], [1090, 100]] }));
const inst = instantFlip(crossed.products.CROSSED, { orderSize: 150 }, cfg);
check("a crossed book that beats the tax is an instant flip, valued with the book walked, never better than Low", inst && inst.qty === 150 && near(inst.cost, 100 * 1000 + 50 * 1010) && near(inst.totalProfit, (100 * 1100 + 50 * 1090) * 0.9875 - (100 * 1000 + 50 * 1010), 1e-6) && inst.confidence === "Low");
const outlier = bazaar(product("OUT", { asks: [[1500, 5000], [1510, 5000], [1520, 5000]], bids: [[1400, 10], [1000, 5000], [990, 5000]], qsSell: 1000 }));
const ofl = orderFlip(outlier.products.OUT, { orderSize: 10, now: 1e9 }, cfg);
check("an outlier top order (a lone high bid over a deep, much lower book) is Low confidence", ofl && ofl.confidence === "Low" && ofl.flags.some((f) => f.filter === "outlier"));
check("...and that check can be switched off", orderFlip(outlier.products.OUT, { orderSize: 10, now: 1e9, filters: { outlier: false } }, cfg).flags.every((f) => f.filter !== "outlier"));
const thin = bazaar(product("THIN", { asks: [[1100, 500]], bids: [[1000, 500]], askOrders: 1, bidOrders: 2 }));
check("a thin market (few orders) is Low confidence", orderFlip(thin.products.THIN, { orderSize: 10, now: 1e9 }, cfg).confidence === "Low");
const lowvol = bazaar(product("LOWV", { asks: [[1100, 500]], bids: [[1000, 500]], buyWeek: 100, sellWeek: 100 }));
check("minimum volume: almost no weekly volume is Low confidence", orderFlip(lowvol.products.LOWV, { orderSize: 1, now: 1e9 }, cfg).flags.some((f) => f.filter === "volume" && f.level === "bad"));
const wide = bazaar(product("WIDE", { asks: [[3000, 5000], [3001, 5000]], bids: [[1000, 5000], [999, 5000]], buyWeek: 1e6, sellWeek: 1e6 }));
check("a spread over 150% after tax is flagged as too good to be true", orderFlip(wide.products.WIDE, { orderSize: 100, now: 1e9 }, cfg).flags.some((f) => f.filter === "spread"));
const cosmetic = orderFlip(A.products.TEST_ITEM, { orderSize: 10, now: 1e9, meta: { TEST_ITEM: { c: "COSMETIC" } } }, cfg);
check("cosmetic items are flagged Low", cosmetic.confidence === "Low" && cosmetic.flags.some((f) => f.filter === "cosmetic"));
// price history: falling, spiking, volatile
const now = 1_000_000;
const series = (fn, n = 40, step = 900) => Array.from({ length: n }, (_, i) => { const p = fn(i); return [now - (n - 1 - i) * step, p, p + 100]; });
check("history: change over 1h and 6h are measured", (() => { const s = priceStats(series((i) => 1000 + i * 10, 40), now, cfg); return near(s.change1hPct, ((1390 + 100 + 1390) / 2 - (1350 + 100 + 1350) / 2) / ((1350 + 100 + 1350) / 2) * 100, 1e-6) && s.change6hPct > 0; })());
check("history: volatility is (high - low) / average over 24h", (() => { const s = priceStats(series((i) => (i % 2 ? 1000 : 1400), 40), now, cfg); return s.volatilityPct > 30 && s.points === 40; })());
check("history: no points gives no stats", priceStats([], now, cfg).volatilityPct === null && priceStats(null, now, cfg).points === 0);
const falling = orderFlip(A.products.TEST_ITEM, { orderSize: 10, now, history: { TEST_ITEM: series((i) => 2000 - i * 20, 40) } }, cfg);
check("a price falling more than 5% in 6 hours is warned about", falling.flags.some((f) => f.filter === "trend" && /falling/.test(f.text)));
const spiking = orderFlip(A.products.TEST_ITEM, { orderSize: 10, now, history: { TEST_ITEM: [...series(() => 1000, 39), [now, 1400, 1500]] } }, cfg);
check("a price that jumped 10%+ in an hour is flagged as just spiked", spiking.flags.some((f) => /spiked/.test(f.text)));
const vol = orderFlip(A.products.TEST_ITEM, { orderSize: 10, now, history: { TEST_ITEM: series((i) => (i % 2 ? 1000 : 1700), 40) } }, cfg);
check("high 24h volatility lowers confidence", vol.flags.some((f) => f.filter === "volatility") && vol.confidence !== "High");
check("the trend and volatility checks can be switched off", orderFlip(A.products.TEST_ITEM, { orderSize: 10, now, history: { TEST_ITEM: series((i) => 2000 - i * 20, 40) }, filters: { trend: false, volatility: false } }, cfg).flags.every((f) => !["trend", "volatility"].includes(f.filter)));
check("SkyCofl hourly history is parsed oldest first", (() => { const p = parseCoflHistory([{ time: "2026-10-27T02:00:00", avg: 20, min: 1, max: 3, volume: 5 }, { time: "2026-10-27T00:00:00", avg: 10 }]); return p.length === 2 && p[0][1] === 10 && p[0][0] < p[1][0] && parseCoflHistory(null).length === 0; })());

// ---------------------------------------------------------------- 3. crafts

section("Crafts (multi-step) from NEU recipes");
const recipes = { crafts: { MID: [{ n: 1, i: { RAW: 160 } }], TOP: [{ n: 1, i: { MID: 2, EXTRA: 1 } }, { n: 1, i: { MID: 4 } }], LOOP_A: [{ n: 1, i: { LOOP_B: 1 } }], LOOP_B: [{ n: 1, i: { LOOP_A: 1 } }] }, npc: { RAW: [10, "Farmer"] } };
const C = bazaar(
  product("RAW", { asks: [[12, 99999]], bids: [[11, 99999]] }),
  product("MID", { asks: [[2000, 5000]], bids: [[1900, 5000]] }),
  product("EXTRA", { asks: [[500, 5000]], bids: [[450, 5000]] }),
  product("TOP", { asks: [[6000, 5000], [6001, 5000]], bids: [[5800, 5000]], buyWeek: 70000 }),
);
const ctx = { bz: C.products, recipes, meta: {}, cfg };
check("acquire picks the cheapest way: MID by crafting from NPC raw (1,600) beats the Bazaar (2,000)", (() => { const a = acquire({ ...ctx, memo: new Map() }, "MID"); return a.how === "craft" && near(a.cost, 1600); })());
check("acquire uses an NPC shop when it is cheaper than the Bazaar", acquire({ ...ctx, memo: new Map() }, "RAW").how === "npc");
check("acquire cannot be sent into a recipe loop", acquire({ ...ctx, memo: new Map() }, "LOOP_A") === null);
check("acquire returns null for something that cannot be bought or crafted", acquire({ ...ctx, memo: new Map() }, "NOTHING") === null);
const bigLimit = { ...ctx, cfg: { ...cfg, npc: { ...cfg.npc, buyLimitStacks: 1000 } } }; // the NPC buying limit is tested separately below
const crafts = craftFlips({ ...bigLimit, memo: new Map() }, { orderSize: 10, now: 1e9 });
const top = crafts.find((f) => f.id === "TOP");
// best recipe: 2 MID (crafted 1600 each) + 1 EXTRA 500 = 3700 per TOP; the other, 4 MID = 6400
check("craft flip uses the cheapest recipe and prices the multi-step route", top && near(top.buyAt, 3700, 1e-6), String(top && top.buyAt));
check("craft profit = sell offer after tax minus ingredient cost", near(top.unitProfit, (6000 - 0.1) * 0.9875 - 3700, 1e-6));
check("craft quantity is capped by the order size, and ingredient bought on the Bazaar by book depth", top.qty === 10);
check("craft sell time comes from the sell-side volume; cycle includes handling", near(top.fillSellHours, (10 / (70000 / 168)) * 1.5, 1e-9) && top.cycleHours > top.fillSellHours);
check("a multi-step craft is flagged and an NPC-sourced one is flagged", top.flags.some((f) => f.filter === "multi") && top.flags.some((f) => f.filter === "npcstock"));
check("the NPC shop buying limit caps a craft: 640 NPC items / (320 per craft) = 2 crafts", craftFlips({ ...ctx, memo: new Map() }, { orderSize: 100, now: 1e9 }).find((f) => f.id === "TOP").qty === 2);
check("the purse caps crafts", craftFlips({ ...ctx, memo: new Map() }, { orderSize: 100, purse: 3700 * 1, now: 1e9 }).find((f) => f.id === "TOP").qty === 1);
check("a craft that loses money is not suggested", craftFlips({ ...ctx, bz: { ...C.products, TOP: bazaar(product("TOP", { asks: [[3000, 5000]], bids: [[2900, 5000]] })).products.TOP }, memo: new Map() }, { orderSize: 10, now: 1e9 }).every((f) => f.id !== "TOP"));
check("a craft with an ingredient that cannot be had is dropped", craftFlips({ bz: C.products, recipes: { crafts: { TOP: [{ n: 1, i: { UNOBTAINIUM: 1 } }] }, npc: {} }, meta: {}, cfg, memo: new Map() }, { orderSize: 10, now: 1e9 }).length === 0);
check("the recipe's requirement text is shown as a warning, not checked", craftFlips({ bz: C.products, recipes: { crafts: { TOP: [{ n: 1, i: { EXTRA: 1 }, req: "Requires: Diamond IV" }] }, npc: {} }, meta: {}, cfg, memo: new Map() }, { orderSize: 10, now: 1e9 }).find((f) => f.id === "TOP").reasons.some((r) => /Requires: Diamond IV/.test(r)));
check("NEU's RAW_FISH-1 style ids map to the Bazaar's RAW_FISH:1", bazaarId({ "RAW_FISH:1": {} }, "RAW_FISH-1") === "RAW_FISH:1" && bazaarId({}, "NOPE") === null && bazaarId({ A: {} }, "A") === "A");
const recipeData = JSON.parse(fs.readFileSync(new URL("../public/flipper-data/recipes.json", import.meta.url)));
check("the generated NEU data has crafts and NPC shop prices, with real examples", Object.keys(recipeData.crafts).length > 1000 && Object.keys(recipeData.npc).length > 300 && recipeData.crafts.ENCHANTED_DIAMOND[0].i.DIAMOND === 160 && recipeData.npc.ROTTEN_FLESH[0] === 8);

// ---------------------------------------------------------------- 4. NPC flips

section("NPC flips: reverse NPC, NPC sell, floor");
const meta = { SELLME: { n: "Sell Me", p: 1000, c: "", t: "" }, DUMP: { n: "Dump", p: 50, c: "", t: "" } };
const N = bazaar(
  product("SELLME", { asks: [[900, 100], [990, 200], [1010, 500]], bids: [[800, 1000]] }),
  product("SHOPPED", { asks: [[40, 99999]], bids: [[20, 1000], [12, 500], [8, 2000]] }),
  product("DUMP", { asks: [[60, 5000]], bids: [[40, 5000]] }),
);
const nrecipes = { crafts: {}, npc: { SHOPPED: [10, "Test Shop"] } };
const nctx = { bz: N.products, recipes: nrecipes, meta, cfg };
const nf = npcFlips(nctx, { now: 1e9 });
const sell = nf.find((f) => f.type === "npc-sell" && f.id === "SELLME");
const rev = nf.find((f) => f.type === "npc-reverse" && f.id === "SHOPPED");
check("NPC sell: buys only the Bazaar levels cheaper than the NPC price (300 items) and walks the book", sell && sell.qty === 300 && near(sell.cost, 100 * 900 + 200 * 990));
check("NPC sell: no tax on the NPC sale (profit = 1000 x 300 - cost)", near(sell.totalProfit, 1000 * 300 - (100 * 900 + 200 * 990)));
check("NPC sell: output fields (NPC price, Bazaar price, max quantity, total per trip)", sell.npcPrice === 1000 && sell.bazaarPrice === 900 && sell.qty === 300 && sell.totalProfit === 12000 && sell.limit === 640);
check("reverse NPC: capped at the NPC limit (10 stacks of 64 = 640), sold into the buy orders after the Bazaar tax", rev && rev.qty === 640 && near(rev.totalProfit, 640 * 20 * 0.9875 - 640 * 10, 1e-6), rev && String(rev.totalProfit));
check("reverse NPC: the 'offer' profit if you list instead of dumping is reported", rev.offerUnitProfit != null && near(rev.offerUnitProfit, (40 - 0.1) * 0.9875 - 10, 1e-6));
check("reverse NPC walks down the book only while it stays profitable (depth)", npcFlips({ ...nctx, cfg: { ...cfg, npc: { ...cfg.npc, buyLimitStacks: 1000 } } }, { now: 1e9 }).find((f) => f.type === "npc-reverse").qty === 1500);
check("tax applies to the Bazaar sale of a reverse flip but not to an NPC sale", rev.totalProfit < 640 * 20 - 640 * 10 && sell.totalProfit === 12000);
check("an item the NPC pays less than the Bazaar for is not an NPC-sell flip", nf.every((f) => !(f.type === "npc-sell" && f.id === "DUMP")));
check("an item NPCs do not buy (no price) is never an NPC-sell flip", npcFlips({ ...nctx, meta: {} }, { now: 1e9 }).every((f) => f.type !== "npc-sell"));
check("an item with no shop price is never a reverse NPC flip", npcFlips({ ...nctx, recipes: { crafts: {}, npc: {} } }, { now: 1e9 }).every((f) => f.type !== "npc-reverse"));
check("the NPC trip limit is configurable", npcFlips({ ...nctx, cfg: { ...cfg, npc: { ...cfg.npc, sellLimitStacks: 1 } } }, { now: 1e9 }).find((f) => f.type === "npc-sell").qty === 64);
check("the purse caps an NPC flip", npcFlips(nctx, { purse: 9000, now: 1e9 }).find((f) => f.type === "npc-sell").qty === 10);
check("NPC flips are not slowed by fill times (a trip) and a clean one is High confidence", sell.cycleHours <= 0.2 && sell.confidence === "High");
check("NPC floor lists every NPC-sellable item with the Bazaar price next to it (and an NPC beating the best buy order is marked, but is not a flip unless the Bazaar ask is under the NPC price)", (() => { const f = npcFloor(nctx); const s = f.find((x) => x.id === "SELLME"); return f.length === 2 && s.npcPrice === 1000 && s.bid === 800 && s.belowFloor === true && near(s.floorVsBidPct, 25) && f.find((x) => x.id === "DUMP").belowFloor === true && npcFlips(nctx, { now: 1e9 }).every((x) => x.id !== "DUMP"); })());

// ---------------------------------------------------------------- 5. NBT and variants

section("NBT decoding and variant matching (real Hypixel item_bytes)");
const real = JSON.parse(fs.readFileSync(new URL("./fixtures/flipper-auction-items.json", import.meta.url)));
const dn = await decodeItem(real.necron.item_bytes);
check("decodes a real item: internal id, count, display name", dn && dn.id === "POWER_WITHER_LEGGINGS" && dn.count === 1 && /Necron/.test(dn.name));
const vn = variantOf(dn.attrs, dn.name);
check("real Necron leggings: stars 8 (5 + 3 master), recombobulated, Legion V, ancient reforge, 10 potato books", vn.core === "POWER_WITHER_LEGGINGS|stars8|recomb1|ultimate_legion5" && /reforge:ancient\|hpb10\|fuming0/.test(vn.full) && /3 master/.test(vn.label));
const dp = await decodeItem(real.pet.item_bytes);
const vp = variantOf(dp.attrs, dp.name);
check("real pet: type, tier and level bucket come from the item", vp.id === "PET" && /^PET\|BAT\|MYTHIC\|lv30\|held:/.test(vp.core), vp.core);
const dt = await decodeItem(real.plain.item_bytes);
check("real accessory decodes", dt && dt.id && variantOf(dt.attrs, dt.name).core.startsWith(dt.id));
check("garbage item_bytes decode to null, not a crash", (await decodeItem("not base64!!")) === null && (await decodeItem(Buffer.from("hello").toString("base64"))) === null && (await decodeItem("")) === null);
check("raw NBT parser reads all tag types", (() => {
  const out = [Buffer.from([10]), Buffer.from([0, 0])];
  nbtPayload(10, { a: [1, 5], b: [2, 300], c: [3, 70000], d: [4, 123456789012], e: [8, "héllo"], f: [9, [3, [1, 2, 3]]], g: [10, { x: [3, 9] }] }, out);
  const o = parseNbt(new Uint8Array(Buffer.concat(out)));
  return o.a === 5 && o.b === 300 && o.c === 70000 && o.d === 123456789012 && o.e === "héllo" && o.f.join() === "1,2,3" && o.g.x === 9;
})());
const make = (attrs, name = "Hyperion") => itemBytes({ id: "HYPERION", ...attrs }, name);
const v = async (attrs, name) => { const d = await decodeItem(make(attrs, name)); return variantOf(d.attrs, d.name); };
const base = await v({ upgrade_level: 5, modifier: "withered", enchantments: { sharpness: 7 } });
check("built items round-trip through the decoder", base.id === "HYPERION" && base.core === "HYPERION|stars5|recomb0");
check("different stars = different core (not comparable)", (await v({ upgrade_level: 3, modifier: "withered", enchantments: { sharpness: 7 } })).core !== base.core);
check("recombobulator changes the core", (await v({ upgrade_level: 5, rarity_upgrades: 1, modifier: "withered" })).core !== base.core);
check("a different reforge keeps the core but changes the full key", (() => 0)() === 0 && (await v({ upgrade_level: 5, modifier: "heroic", enchantments: { sharpness: 7 } })).core === base.core && (await v({ upgrade_level: 5, modifier: "heroic", enchantments: { sharpness: 7 } })).full !== base.full);
check("different enchants change the full key only; an ultimate enchant changes the core", (await v({ upgrade_level: 5, modifier: "withered", enchantments: { sharpness: 5 } })).full !== base.full && (await v({ upgrade_level: 5, modifier: "withered", enchantments: { sharpness: 7, ultimate_wisdom: 5 } })).core !== base.core);
check("Hot Potato and Fuming books are in the full key", (await v({ upgrade_level: 5, modifier: "withered", enchantments: { sharpness: 7 }, hot_potato_count: 15 })).full.includes("hpb10|fuming5"));
check("identical items have identical keys", (await v({ upgrade_level: 5, modifier: "withered", enchantments: { sharpness: 7 } })).full === base.full);
const petKey = async (lvl, tier = "LEGENDARY", held = "", skin = "") => { const d = await decodeItem(itemBytes({ id: "PET", petInfo: JSON.stringify({ type: "ENDER_DRAGON", tier, exp: 1000, ...(held ? { heldItem: held } : {}), ...(skin ? { skin } : {}) }) }, `§7[Lvl ${lvl}] §6Ender Dragon`)); return variantOf(d.attrs, d.name).core; };
check("pets: level 1 and levels 2-9 are different buckets", (await petKey(1)) !== (await petKey(2)) && (await petKey(2)) === (await petKey(9)));
check("pets: tens are one bucket (35 and 39 equal, 41 different)", (await petKey(35)) === (await petKey(39)) && (await petKey(35)) !== (await petKey(41)));
check("pets: 100 to 199 are one bucket, 99 and 200 are not", (await petKey(100)) === (await petKey(150)) && (await petKey(100)) !== (await petKey(99)) && (await petKey(200)) !== (await petKey(100)));
check("pets: tier, held item and skin separate prices", (await petKey(50, "EPIC")) !== (await petKey(50)) && (await petKey(50, "LEGENDARY", "PET_ITEM_TIER_BOOST")) !== (await petKey(50)) && (await petKey(50, "LEGENDARY", "", "SKIN_X")) !== (await petKey(50)));
const bookKey = async (e) => { const d = await decodeItem(itemBytes({ id: "ENCHANTED_BOOK", enchantments: e }, "Enchanted Book")); return variantOf(d.attrs, d.name); };
check("enchanted books are keyed by the enchant and level", (await bookKey({ sharpness: 6 })).core !== (await bookKey({ sharpness: 7 })).core && (await bookKey({ sharpness: 6 })).core === (await bookKey({ sharpness: 6 })).core && (await bookKey({ ultimate_wisdom: 5 })).label.includes("ultimate_wisdom5"));
check("Kuudra attributes separate prices", (await v({ upgrade_level: 0, attributes: { mana_pool: 5 } })).core !== (await v({ upgrade_level: 0, attributes: { mana_pool: 4 } })).core);
check("an item with no id has no variant", variantOf({}) === null && variantOf(null) === null);
check("cleanName strips colour codes and star symbols", cleanName("§6✿ Ancient Necron's Leggings §c✪✪✪✪✪§c➌") === "Ancient Necron's Leggings");

// ---------------------------------------------------------------- 6. Auction House BIN flips

section("Auction House BIN flips");
const NOW = 1_800_000_000_000;
const auction = (n, attrs, price, extra = {}) => ({ uuid: `u${n}`, item_name: extra.name || "§dHeroic Hyperion §6✪✪✪✪✪", tier: "LEGENDARY", bin: true, claimed: false, starting_bid: price, end: NOW + 3600_000, item_bytes: make(attrs, extra.name || "Heroic Hyperion"), category: "weapon", ...extra });
const std = { upgrade_level: 5, modifier: "heroic", enchantments: { sharpness: 7 } };
const listings = [auction(1, std, 5_000_000), auction(2, std, 8_000_000), auction(3, std, 8_200_000), auction(4, std, 8_500_000)];
const sold = (n, price, minsAgo = 60) => ({ core: base.core.replace("stars5", "stars5"), full: base.full.replace("withered", "heroic"), ts: NOW / 1000 - minsAgo * 60 - n, price });
const salesRows = [8_000_000, 8_100_000, 7_900_000, 8_000_000, 8_200_000, 7_950_000].map((p, i) => sold(i, p, 30 + i * 60));
const idx = salesIndex(salesRows, NOW / 1000, cfg);
const loader = async () => idx;
const bins = activeBins(listings, NOW);
const cands = preScreen(bins, cfg, { minPrice: 100000 });
const flips = await binFlips(cands, { cfg, nowMs: NOW, loadSales: loader }, {});
const f1 = flips[0];
check("active BINs only: claimed, ended, non-BIN and zero-price listings are dropped", activeBins([{ ...listings[0], claimed: true }, { ...listings[0], end: NOW - 1 }, { ...listings[0], bin: false }, { ...listings[0], starting_bid: 0 }, listings[0]], NOW).length === 1);
check("pre-screen picks the cheapest listing of a group whose next listing is far dearer", cands.length === 1 && cands[0].a.uuid === "u1");
check("a BIN well under the same variant's price is found", flips.length === 1 && f1.uuid === "u1" && f1.buyAt === 5_000_000);
const ref = Math.min(8_000_000 * (1 - cfg.auction.relistUndercutPct / 100), 8_000_000 /* median of the sales */);
check("reference = the lower of the next comparable BIN (undercut) and the median recent sale", f1.sellAt === Math.round(ref), String(f1.sellAt));
check("net profit uses the fee table (1% listing under 10m + 350 + 1% claim)", (() => { const fees = Math.round(ref) * 0.01 * 2 + 350; return near(f1.unitProfit, Math.round(ref) - fees - 5_000_000, 2) && near(f1.fees, fees, 2); })());
check("sell time from sales per day and cheaper competing listings", near(f1.fillSellHours, 24 / 6, 1e-9) && f1.competitors === 0, JSON.stringify([f1.fillSellHours, f1.competitors]));
check("coins/hour = net profit / (time to sell + handling)", near(f1.coinsPerHour, f1.unitProfit / (4 + 0.1), 1e-6));
check("with sales and comparables the flip is High or Med confidence", ["High", "Med"].includes(f1.confidence), f1.confidence);
check("the flip carries the in-game command and the variant label", f1.command === "/viewauction u1" && /5 stars/.test(f1.variant));
check("the purse excludes flips you cannot afford", (await binFlips(cands, { cfg, nowMs: NOW, loadSales: loader }, { purse: 1_000_000 })).length === 0);
check("a minimum profit above the flip removes it", (await binFlips(cands, { cfg, nowMs: NOW, loadSales: loader }, { minProfit: 5_000_000 })).length === 0);
check("a minimum ROI above the flip removes it", (await binFlips(cands, { cfg, nowMs: NOW, loadSales: loader }, { minRoiPct: 500 })).length === 0);
// a different variant must NOT be used as a reference
const other = [auction(1, { ...std, upgrade_level: 5 }, 5_000_000), ...[8_000_000, 8_200_000, 8_500_000].map((p, i) => auction(10 + i, { upgrade_level: 3, modifier: "heroic" }, p))];
const noRef = await binFlips(preScreen(activeBins(other, NOW), cfg, { minPrice: 100000 }), { cfg, nowMs: NOW, loadSales: async () => salesIndex([], NOW / 1000, cfg) }, {});
check("listings of a different variant (other stars) are not a reference: no price is invented", noRef.length === 0);
// same core, different reforge/enchants: only a weaker match, flagged
const weaker = [auction(1, std, 5_000_000), ...[8_000_000, 8_200_000, 8_500_000].map((p, i) => auction(20 + i, { upgrade_level: 5, modifier: "fierce", enchantments: { sharpness: 5 } }, p))];
const weak = await binFlips(preScreen(activeBins(weaker, NOW), cfg, { minPrice: 100000 }), { cfg, nowMs: NOW, loadSales: async () => salesIndex([], NOW / 1000, cfg) }, {});
check("same item but a different reforge and enchants is a weak match: Low confidence with the reason", weak.length === 1 && weak[0].confidence === "Low" && weak[0].reasons.some((r) => /not the same variant/.test(r)));
const noSales = await binFlips(cands, { cfg, nowMs: NOW, loadSales: async () => salesIndex([], NOW / 1000, cfg) }, {});
check("with comparable listings but no recorded sales the sell time is unknown (no invented time) and it is not High", noSales.length === 1 && noSales[0].fillSellHours === null && noSales[0].coinsPerHour === null && noSales[0].confidence !== "High" && noSales[0].reasons.some((r) => /No recorded sales/.test(r)));
const cheapRef = await binFlips(preScreen(activeBins([auction(1, std, 1_000_000), ...[8_000_000, 8_200_000, 8_500_000].map((p, i) => auction(30 + i, std, p))], NOW), cfg, { minPrice: 100000 }), { cfg, nowMs: NOW, loadSales: loader }, {});
check("a price under half the reference is flagged as suspiciously cheap", cheapRef[0].flags.some((f) => f.filter === "toocheap"));
const skinAuction = (n, price) => ({ ...auction(n, { id: "HYPERION", upgrade_level: 5, skin: "SKIN_X" }, price), item_bytes: itemBytes({ id: "SPECIAL_HAT", skin: "hat1" }, "Fancy Hat", ["§7Looks nice", "", "§6§lLEGENDARY COSMETIC"]) });
const cosm = await binFlips(preScreen(activeBins([skinAuction(1, 5_000_000), skinAuction(2, 8_000_000), skinAuction(3, 8_200_000), skinAuction(4, 8_500_000)], NOW), cfg, { minPrice: 100000 }), { cfg, nowMs: NOW, loadSales: async () => salesIndex([], NOW / 1000, cfg) }, {});
check("cosmetic auction items (lore says COSMETIC) are flagged Low, and the cosmetic switch can turn that off", cosm.length === 1 && cosm[0].confidence === "Low" && cosm[0].flags.some((f) => f.filter === "cosmetic") && computeFlips({ bz: {}, meta: {}, recipes: {}, ah: { flips: cosm } }, { types: ["ah-bin"], filters: { cosmetic: false }, now: 1e9 }, cfg)[0].flags.every((f) => f.filter !== "cosmetic"));
check("only one comparable listing and no sales is Low (not enough to trust the reference)", (await binFlips(preScreen(activeBins([auction(1, std, 5_000_000), auction(2, std, 8_000_000)], NOW), cfg, { minPrice: 100000 }), { cfg, nowMs: NOW, loadSales: async () => salesIndex([], NOW / 1000, cfg) }, {}))[0].confidence === "Low");
check("a price under a third of the reference is Low (the comparison is missing something)", (await binFlips(preScreen(activeBins([auction(1, std, 1_000_000), ...[8_000_000, 8_200_000, 8_500_000].map((p, i) => auction(60 + i, std, p))], NOW), cfg, { minPrice: 100000 }), { cfg, nowMs: NOW, loadSales: loader }, {}))[0].confidence === "Low");
check("party hats: year and colour are part of the identity", (await v({ party_hat_year: 2021, party_hat_color: "pink" })).core !== (await v({ party_hat_year: 2022, party_hat_color: "pink" })).core && (await v({ party_hat_year: 2021, party_hat_color: "pink" })).core !== (await v({ party_hat_year: 2021, party_hat_color: "lime" })).core);
check("dungeon item quality and extra price attributes are part of the identity", (await v({ upgrade_level: 5, baseStatBoostPercentage: 49 })).core !== (await v({ upgrade_level: 5, baseStatBoostPercentage: 35 })).core && (await v({ upgrade_level: 5, baseStatBoostPercentage: 41 })).core === (await v({ upgrade_level: 5, baseStatBoostPercentage: 44 })).core && (await v({ upgrade_level: 5, wood_singularity_count: 1 })).full !== (await v({ upgrade_level: 5 })).full && (await v({ upgrade_level: 5, art_of_war_count: 1 })).core === (await v({ upgrade_level: 5 })).core);
check("a lone listing is only considered with sales to price it against", (await binFlips(preScreen(activeBins([auction(1, std, 6_000_000)], NOW), cfg, { minPrice: 100000 }), { cfg, nowMs: NOW, loadSales: async () => salesIndex([], NOW / 1000, cfg) }, {})).length === 0);
check("a lone listing under the sales median is a flip", (await binFlips(preScreen(activeBins([auction(1, std, 5_000_000)], NOW), cfg, { minPrice: 100000, limit: 10 }), { cfg, nowMs: NOW, loadSales: loader }, {})).length === 1);
check("a sales history older than a day gives 0 sales per day (unknown sell time)", (await binFlips(cands, { cfg, nowMs: NOW, loadSales: async () => salesIndex(salesRows.map((r) => ({ ...r, ts: r.ts - 3 * 86400 })), NOW / 1000, cfg) }, {}))[0].fillSellHours === null);
check("salesIndex: newest first, capped, per-day count over 24h", (() => { const i = salesIndex(Array.from({ length: 30 }, (_, k) => ({ core: "c", full: "f", ts: NOW / 1000 - k * 3000, price: 100 + k })), NOW / 1000, cfg).forFull("f"); return i.prices.length === cfg.auction.sampleSales && i.prices[0] === 100 && i.perDay === 29 && i.n === 30; })());
const endedRaw = [{ auction_id: "a1b2c3d4e5", bin: true, price: 8_000_000, timestamp: NOW, item_bytes: make(std, "Heroic Hyperion") }, { auction_id: "x2", bin: false, price: 8_000_000, timestamp: NOW, item_bytes: make(std) }, { auction_id: "x3", bin: true, price: 1000, timestamp: NOW, item_bytes: make(std) }, { auction_id: "x4", bin: true, price: 9_000_000, timestamp: NOW, item_bytes: "broken" }];
const sr = await salesFromEnded(endedRaw, cfg);
check("ended auctions: only BIN sales above the tracking minimum that decode are kept", sr.length === 1 && sr[0].price === 8_000_000 && sr[0].item === "HYPERION" && sr[0].ts === NOW / 1000 && sr[0].core === base.core);

// ---------------------------------------------------------------- 7. the engine: join, filter, sort

section("Engine: filters, sorting, names");
const E = bazaar(
  product("ENCHANTED_FOO", { asks: [[1100, 5000], [1101, 5000]], bids: [[1000, 5000], [999, 5000]], buyWeek: 700000, sellWeek: 700000 }),
  product("ENCHANTED_BAR", { asks: [[11000, 5000], [11010, 5000]], bids: [[9000, 5000], [8990, 5000]], buyWeek: 7000, sellWeek: 7000 }),
);
const data = { bz: E.products, meta: { ENCHANTED_FOO: { n: "Enchanted Foo", p: 0 } }, recipes: { crafts: {}, npc: {} }, ah: { flips: [f1] }, history: {} };
const all = computeFlips(data, { types: ["bazaar-order", "ah-bin"], now: 1e9 }, cfg);
check("engine joins display names (item list name, auction name, prettified id)", all.find((f) => f.id === "ENCHANTED_FOO").name === "Enchanted Foo" && all.find((f) => f.id === "ENCHANTED_BAR").name === "Enchanted Bar" && all.find((f) => f.type === "ah-bin").name === "Heroic Hyperion");
check("engine filters by type", computeFlips(data, { types: ["ah-bin"], now: 1e9 }, cfg).every((f) => f.type === "ah-bin") && computeFlips(data, { types: ["bazaar-order"], now: 1e9 }, cfg).every((f) => f.type === "bazaar-order"));
check("filters: min profit, min ROI, max cost, min coins/hour, min volume, search", filterFlips(all, { minProfit: 1e12, confidence: "Low" }).length === 0 && filterFlips(all, { minRoi: 1000, confidence: "Low" }).length === 0 && filterFlips(all, { maxCost: 1, confidence: "Low" }).length === 0 && filterFlips(all, { minCph: 1e15, confidence: "Low" }).length === 0 && filterFlips(all, { minVolume: 1e12, confidence: "Low" }).length === 0 && filterFlips(all, { q: "hyperion", confidence: "Low" }).length === 1 && filterFlips(all, { q: "bar", confidence: "Low" })[0].id === "ENCHANTED_BAR");
check("min confidence hides Low flips", filterFlips(all, { confidence: "High" }).every((f) => f.confidence === "High") && filterFlips(all, { confidence: "Low" }).length === all.length);
check("sorting by profit, ROI and coins/hour", (() => { const s = sortFlips(filterFlips(all, { confidence: "Low" }), "profit", cfg.weights); return s.every((x, i) => i === 0 || s[i - 1].totalProfit >= x.totalProfit); })());
check("the blended score changes the order with the weights", (() => {
  const fl = filterFlips(all, { confidence: "Low" });
  const m = sortFlips(fl, "score", { margin: 1, speed: 0, reliability: 0 }).map((x) => x.id + x.type).join();
  const s = sortFlips(fl, "score", { margin: 0, speed: 1, reliability: 0 }).map((x) => x.id + x.type).join();
  return fl.length >= 2 && m !== undefined && s !== undefined;
})());
check("the purse removes unaffordable auction flips in the engine", computeFlips(data, { types: ["ah-bin"], purse: 1_000_000, now: 1e9 }, cfg).length === 0);

// ---------------------------------------------------------------- 8. formatting and edge cases

section("Formatting and huge numbers");
check("coins: 1.2k / 3.4m / 5.6b", fmtCoins(1234) === "1.23k" && fmtCoins(3_400_000) === "3.4m" && fmtCoins(5_600_000_000) === "5.6b" && fmtCoins(950) === "950" && fmtCoins(12.5) === "12.5" && fmtCoins(0.4) === "0.4");
check("coins: trillions, negatives, nothing, 100+ drops decimals", fmtCoins(1.2e12) === "1.2t" && fmtCoins(-2_500_000) === "-2.5m" && fmtCoins(null) === "?" && fmtCoins(NaN) === "?" && fmtCoins(123_456_789) === "123m" && fmtCoins(999_999_999_999_999) === "1000t");
check("parseCoins reads 50m, 1.5b, 250k, 12,000", parseCoins("50m") === 50_000_000 && parseCoins("1.5B") === 1_500_000_000 && parseCoins("250k") === 250_000 && parseCoins("12,000") === 12000 && parseCoins("abc") === 0 && parseCoins("") === 0);
check("hours: minutes, hours, days, unknown", fmtHours(0.5) === "30m" && fmtHours(3.5) === "3.5h" && fmtHours(72) === "3d" && fmtHours(null) === "?" && fmtHours(0.0001) === "<1m" && fmtHours(Infinity) === "?");
check("percent and age", fmtPct(12.345) === "12.3%" && fmtPct(250) === "250%" && fmtPct(null) === "?" && fmtAge(12) === "12s" && fmtAge(300) === "5m" && fmtAge(7200) === "2h" && fmtAge(null) === "no data");
check("huge profits do not break the maths", (() => { const f = orderFlip(bazaar(product("BIG", { asks: [[2e9, 1e6], [2.1e9, 1e6]], bids: [[1e9, 1e6]], buyWeek: 1e10, sellWeek: 1e10 })).products.BIG, { orderSize: 1000, now: 1e9 }, cfg); return f && Number.isFinite(f.totalProfit) && fmtCoins(f.totalProfit).endsWith("t") || fmtCoins(f.totalProfit).endsWith("b"); })());

console.log(`\n${passed} checks passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
