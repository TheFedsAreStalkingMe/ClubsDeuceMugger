// Every Flipper constant lives here. Each one says where it comes from:
//   [verified]        confirmed against live data or the official docs (dates are in SOURCES.md)
//   [VERIFY IN-GAME]  from memory or the community and NOT confirmed here: check it in the game before trusting a profit
//   [tuning]          a choice made by this site (safe to change)
// Environment variables override some of them (see README, "Flipper"): FLIPPER_BAZAAR_TAX, FLIPPER_HYPIXEL_BASE, ...

export const DEFAULTS = {
  // ---- Bazaar ----
  bazaar: {
    // [VERIFY IN-GAME] 1.25% is the base tax on Bazaar sales. Players can lower it with community upgrades (Bazaar Flipper
    // perk), so set FLIPPER_BAZAAR_TAX to yours (0.0125 = 1.25%). NPC sales are NOT taxed.
    sellTax: 0.0125,
    // [verified from live data] prices move in steps of 0.1 coins; to be first in the queue you beat the top order by one step.
    orderUndercut: 0.1,
    // [tuning] a buy order is filled by players who sell instantly, a sell offer by players who buy instantly. The API's
    // sellMovingWeek / buyMovingWeek are the weekly amounts of each. [VERIFY IN-GAME] that this reading matches your fills.
    hoursPerWeek: 168,
    // [tuning] how much slower than the raw flow your order fills, for competing orders and outbidding.
    queuePenalty: 1.5,
    // [tuning] hands-on time per cycle (place the buy order, collect, place the sell offer, collect): a cycle is never faster than this
    cycleOverheadHours: 0.1,
    // [tuning] largest share of a week's instant volume one order should be (bigger orders are capped to this).
    maxShareOfWeekly: 0.02,
    // [tuning] the book levels the API gives are only the top 30 orders (the site keeps 10).
    keepLevels: 10,
    // [tuning] depth-weighted price over this many levels, to spot a lone outlier order at the top of the book.
    depthLevels: 5,
  },

  // ---- safety filters (each can be switched off in the page) ----
  safety: {
    minWeeklyVolume: 5000, // [tuning] items per week on the slower side
    minOrdersPerSide: 3, // [tuning] fewer active orders than this is a thin market
    maxOutlierPct: 4, // [tuning] top order more than this % away from the depth-weighted price = outlier
    maxRoiPct: 150, // [tuning] a spread this wide after tax is almost always a manipulated or broken book
    maxVolatility24hPct: 30, // [tuning] (high - low) / average over 24h
    fallingPct6h: -5, // [tuning] price change over 6h below this = falling fast
    spikePct1h: 10, // [tuning] price change over 1h above this = just spiked
    minHistoryPoints: 8, // [tuning] fewer own samples than this lowers confidence
  },

  // ---- NPC prices ----
  npc: {
    // [VERIFY IN-GAME] I believe an NPC takes about 10 stacks of one item per trip; this could not be confirmed (the wiki is
    // closed and no API lists it). Profit per trip is capped at this many stacks. Change it if you know better.
    sellLimitStacks: 10,
    // [VERIFY IN-GAME] the NPC shop stock per purchase is not in any data source; the same cap is applied to shop buying.
    buyLimitStacks: 10,
    defaultStack: 64, // [verified] most items stack to 64
  },

  // ---- crafting ----
  craft: {
    maxDepth: 4, // [tuning] how many crafting steps deep an ingredient may itself be crafted
    // [tuning] ingredients are bought at the instant-buy price (what you really pay if you buy now)
    ingredientMode: "instant",
  },

  // ---- Auction House ----
  auction: {
    // [VERIFY IN-GAME] BIN listing fee as a share of the starting price (my recollection):
    listingFee: [
      { upTo: 10_000_000, rate: 0.01 },
      { upTo: 100_000_000, rate: 0.02 },
      { upTo: Infinity, rate: 0.025 },
    ],
    // [VERIFY IN-GAME] flat listing fee by duration, in coins (my recollection; 1h / 6h / 12h / 24h / 48h)
    durationFee: { "1h": 20, "6h": 45, "12h": 100, "24h": 350, "48h": 1200 },
    duration: "24h", // [tuning] the duration used in the estimates
    // [VERIFY IN-GAME] the share taken when you claim the coins from a sale (about 1%; may only apply to higher sales)
    claimFee: 0.01,
    claimFeeAbove: 1_000_000, // [VERIFY IN-GAME] the claim fee only applies from this sale price up
    relistUndercutPct: 0.5, // [tuning] you list this % under the next cheapest comparable BIN
    minTrackedPrice: 500_000, // [tuning] sales under this are not stored (keeps the database small, cheap items are low confidence)
    minProfit: 100_000, // [tuning] default minimum net profit for a suggestion
    minComparables: 3, // [tuning] same-variant listings or sales needed for a normal confidence reference price
    sampleSales: 20, // [tuning] sales kept per item variant to take a median from
    sweepEveryMinutes: 2, // [tuning] the full set of auction pages is read every this many minutes (the ended-auction feed, which only keeps 60s, is read every minute); override with FLIPPER_AUCTION_EVERY_MIN
    pagesPerRun: 44, // [verified] the API had 44 pages of 1000 on the verification date; override with FLIPPER_AUCTION_PAGES
  },

  // ---- collecting ----
  collect: {
    bazaarEverySeconds: 30, // [verified] the Bazaar data refreshes about every 20s; Cron runs every minute so it is sampled twice
    auctionsEverySeconds: 60, // [verified] the API says the auctions cache lasts 60s
    historyEveryMinutes: 15, // [tuning] how often a price sample is stored for tracked items
    historyKeepDays: 7, // [tuning]
    salesKeepDays: 7, // [tuning]
    trackedItems: 150, // [tuning] items whose price history is stored (the best current flips plus the watchlist)
    subrequestBudget: 45, // [verified] a free-plan Worker run may make about 50 outside calls; set FLIPPER_SUBREQUEST_BUDGET higher on a paid plan
    staleAfterSeconds: 180, // [tuning] data older than this is shown as stale
  },

  // ---- ranking (the page lets you change the weights) ----
  weights: { margin: 0.35, speed: 0.4, reliability: 0.25 },
};

const num = (v, d) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);

// The config with environment overrides applied. `env` is the Worker env (or {} in tests).
export function flipperConfig(env = {}) {
  const c = structuredClone(DEFAULTS);
  c.bazaar.sellTax = Math.min(0.1, Math.max(0, num(env.FLIPPER_BAZAAR_TAX, c.bazaar.sellTax)));
  c.collect.subrequestBudget = num(env.FLIPPER_SUBREQUEST_BUDGET, c.collect.subrequestBudget);
  c.auction.pagesPerRun = num(env.FLIPPER_AUCTION_PAGES, c.auction.pagesPerRun);
  c.auction.sweepEveryMinutes = Math.max(1, Math.floor(num(env.FLIPPER_AUCTION_EVERY_MIN, c.auction.sweepEveryMinutes)));
  c.auction.duration = Object.hasOwn(c.auction.durationFee, env.FLIPPER_AH_DURATION) ? env.FLIPPER_AH_DURATION : c.auction.duration;
  c.npc.sellLimitStacks = num(env.FLIPPER_NPC_LIMIT_STACKS, c.npc.sellLimitStacks);
  c.npc.buyLimitStacks = num(env.FLIPPER_NPC_LIMIT_STACKS, c.npc.buyLimitStacks);
  c.hypixelBase = env.FLIPPER_HYPIXEL_BASE || "https://api.hypixel.net";
  c.coflBase = env.FLIPPER_COFL_BASE || "https://sky.coflnet.com/api";
  return c;
}
