// Pure rules for the Bonus Weapon Sellers page.

import { remaining } from "../features/rules.js";
import { NUM_MAX } from "../state.js";
import { KINDS, RARITIES, bonus } from "./state.js";

const MAX_SEARCHES = 24;

// The searches to send to Weav3r (it takes one weapon type, one rarity and one bonus per search), so a choice of
// several becomes several searches. Armor has its own bonuses, so a weapon bonus choice leaves armor out.
export function planSearches(f) {
  const weapons = KINDS.filter((k) => k !== "Armor" && f.kinds.includes(k));
  const tabs = [];
  if (weapons.length === 3) tabs.push({ tab: "weapons" });
  else for (const k of weapons) tabs.push({ tab: "weapons", weaponType: k.toLowerCase() });
  if (f.kinds.includes("Armor") && !f.bonuses.length) tabs.push({ tab: "armor" });
  const rarities = f.rarities.length === RARITIES.length || !f.rarities.length ? [null] : f.rarities;
  const bonuses = f.bonuses.length ? f.bonuses : [null];
  const out = [];
  for (const t of tabs) for (const b of bonuses) for (const r of rarities) {
    const q = { ...t };
    if (r) q.rarity = r;
    if (b) { q.bonus1 = b; if (f.minBonus > 0) q.minBonus1Value = f.minBonus; }
    if (f.minPrice > 0) q.minPrice = f.minPrice;
    if (f.maxPrice < NUM_MAX) q.maxPrice = f.maxPrice;
    out.push(q);
  }
  return out.slice(0, MAX_SEARCHES);
}

// Does a listing pass the filters? Also returns its best matching bonus value (for sorting), or null.
export function matchBonus(l, f) {
  const wanted = f.bonuses.map((b) => b.toLowerCase());
  const hits = l.bonuses.filter((b) => (!wanted.length || wanted.includes(String(b.name).toLowerCase())) && b.value >= f.minBonus);
  return hits.length ? Math.max(...hits.map((b) => b.value)) : null;
}

export const passes = (l, f) =>
  f.rarities.includes(l.rarity) && l.price >= f.minPrice && l.price <= f.maxPrice && matchBonus(l, f) != null;

export function sortValue(r, key) {
  switch (key) {
    case "price": return r.price;
    case "bonus": return r.best;
    case "stats": return r.bs;
    case "hospital": return remaining(r);
    case "age": return r.age;
    default: return null;
  }
}

export const visibleRows = () => bonus.rows;
