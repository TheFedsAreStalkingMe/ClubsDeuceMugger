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
  perType: 200, // companies read per type (100 per call)
  maxCompanies: 60, // companies whose employees are read per scan
  maxPlayers: 80, // players who get the slower status checks
  includeUnknown: false, // keep players with no stat estimate
  sort: "cash",
  dir: "desc",
};

// Assumed daily wage. Torn does not show wages, so this is a guess you can change in Settings.
// `base` is the wage at 10 stars for any type without its own number; fewer stars scale it down.
export const DEFAULT_WAGES = { base: 500000, types: {} };

export const earn = {
  firstRun: load(STORE.earnFilters, null) === null, // nothing saved yet
  filters: { ...DEFAULT_EARN, ...load(STORE.earnFilters, {}) },
  wages: { ...DEFAULT_WAGES, ...load(STORE.earnWages, {}) },
  types: [], // [{ id, name }] every company type
  rows: [], // players from the last scan
};
