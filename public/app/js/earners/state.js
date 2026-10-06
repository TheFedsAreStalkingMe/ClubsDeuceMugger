// State of the Inactive Earners page: its filters, the assumed wages, and the players found.
// (Keys, the scan counter and the abort controller live in the shared `state` from ../state.js.)

import { STORE, load } from "/js/core/storage.js";
import { NUM_MAX } from "../state.js";

export const DEFAULT_EARN = {
  types: [], // company type ids to scan
  minStars: 5, // company star rating (1-10)
  minDays: 7, // days since the player last did anything
  minBs: 0,
  maxBs: NUM_MAX,
  maxFf: 10,
  perType: 500, // companies read per type (100 per call)
  maxCompanies: 300, // the most companies whose employees are read in one scan (best stars first)
  maxPlayers: 80, // stop once this many matches are found
  includeUnknown: false, // keep players with no stat estimate
  merits: false, // you have the mugging merits (+10% mug money), used for the predicted mug
  plunder: 0, // percent of Plunder on your weapon, used for the predicted mug
  sort: "score",
  dir: "desc",
};

// Assumed daily wage. Torn does not show wages, so this is a guess you can change in Settings:
//   1. a wage you set for a company type (for a 10 star company; fewer stars scale it down), else
//   2. the company's real daily income x `share` % / employees hired (capped at Torn's $25m a day pay limit), else
//   3. `base` (also for 10 stars) when the company's income is not known.
export const WAGE_CAP = 25000000;
export const DEFAULT_WAGES = { base: 1000000, share: 60, types: {} };

export const earn = {
  firstRun: load(STORE.earnFilters, null) === null, // nothing saved yet
  filters: { ...DEFAULT_EARN, ...load(STORE.earnFilters, {}) },
  wages: { ...DEFAULT_WAGES, ...load(STORE.earnWages, {}) },
  types: [], // [{ id, name }] every company type
  rows: [], // players from the last scan
};

// Older saved settings had smaller limits (60 companies, 200 per type): the scan now keeps going, so use the new ones.
if (earn.filters.maxCompanies === 60) earn.filters.maxCompanies = DEFAULT_EARN.maxCompanies;
if (earn.filters.perType === 200) earn.filters.perType = DEFAULT_EARN.perType;
if (earn.filters.sort === "cash" && earn.filters.dir === "desc") earn.filters.sort = "score"; // the old default; best mug first now
