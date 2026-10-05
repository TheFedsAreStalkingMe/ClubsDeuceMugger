// The one shared state object for the Mug Finder page, plus its defaults.

import { STORE, load, loadKeys } from "/js/core/storage.js";

export const NUM_MAX = 1e10; // "no limit" for the battle stat sliders
export const MIN_PRICE = 1000000; // mugs below $1m are not worth the effort
export const BASE_MUG = 0.05; // a mug takes about 5% of the target's cash
export const MERIT_BONUS = 0.10; // Masterful Looting merits: +10% more mug money

export const DEFAULT_FILTERS = {
  minPrice: MIN_PRICE,
  minBs: 0,
  maxBs: NUM_MAX,
  maxFf: 10,
  priceTol: 10, // listing price must be within this % of market value (0 = off)
  minActivity: 0, // only items with at least this many listings changed in the last hour (0 = off)
  minPart: 0, // also add up items worth at least this much; a seller counts when they add up to minPrice (0 = off)
  merits: false, // you have the mugging merits (+10% mug money)
  plunder: 0, // percent of Plunder on your weapon (extra mug money)
  minStack: 0, // also count stacks of 2+ worth at least this much, even if each item is under minPrice (0 = off)
  maxSellers: 80, // sellers who get the slower status checks
  maxItems: 40, // items read per scan
  autoScan: true, // read every item whose cheapest listing is above the minimum
  includeUnknown: false, // keep players that have no stat estimate
  onlyOkay: false, // hide players who are in hospital, traveling, abroad or in jail
  autoEvery: 120, // seconds between auto hunt scans
  bmMinPrice: 5000000, // buymugging: only listings priced at least this much
  bmBonus: "", // buymugging: only bonuses whose name contains one of these words (comma separated, empty = any)
  bmCats: ["Primary", "Secondary", "Melee", "Armor"], // buymugging: which kinds of items to read
  bmItems: 60, // buymugging: weapons and armor read per scan
  bmChecks: 100, // buymugging: items whose bonuses are looked up per scan
  sort: "stats",
  dir: "desc",
};

export const DEFAULT_PREFS = {
  notify: true,
  minJackpot: 10000000,
  myBs: 0, // your own total battle stats
  outMinutes: 5,
  offlineMinutes: 35,
};

export const state = {
  keys: loadKeys(),
  watch: load(STORE.watch, []), // [{ id, name? }]
  filters: { ...DEFAULT_FILTERS, ...load(STORE.filters, {}) },
  prefs: { ...DEFAULT_PREFS, ...load(STORE.prefs, {}) },
  rows: [], // listings from the last scan
  feed: load(STORE.feed, []).filter((e) => Array.isArray(e.items)), // mugs found by auto hunt (older shapes dropped)
  dismissed: load(STORE.dismissed, {}), // key -> time dismissed

  runId: 0, // changes on every scan start and cancel; old work checks it and stops
  ctrl: null, // AbortController for the running scan
  scanning: false,
  mode: "hunt", // which scan is running: hunt (bazaar finder) or buymug
  auto: false, // auto hunt on
  outcome: "retry", // how the last scan ended: ok | retry | fatal
};

if (state.filters.maxFf === 3) state.filters.maxFf = 10; // 3 used to be the top of the slider
