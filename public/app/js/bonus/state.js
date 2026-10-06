// State of the Bonus Weapon Sellers page: its filters and the listings found.
// (Keys, the scan counter and the abort controller live in the shared `state` from ../state.js.)

import { STORE, load } from "/js/core/storage.js";
import { NUM_MAX } from "../state.js";

export const KINDS = ["Primary", "Secondary", "Melee", "Armor"];
export const RARITIES = ["yellow", "orange", "red"];

export const DEFAULT_BONUS = {
  kinds: [...KINDS], // weapon types (and armor) to look at
  bonuses: [], // bonus names; empty = any bonus
  minBonus: 0, // smallest bonus value (the % on the weapon)
  rarities: [...RARITIES],
  minPrice: 0,
  maxPrice: NUM_MAX, // NUM_MAX = no limit
  minBs: 0,
  maxBs: NUM_MAX,
  maxFf: 10,
  includeUnknown: false,
  historyTop: 8, // read the attack history (3 Torn calls each) of this many sellers at the end (0 = off)
  pages: 2, // pages of 100 read per search
  maxListings: 100, // listings kept after the stat filter
  sort: "price",
  dir: "asc",
};

export const bonus = {
  filters: { ...DEFAULT_BONUS, ...load(STORE.bonusFilters, {}) },
  rows: [], // one per listing: { id: sellerId, uid, name, ... }
};
