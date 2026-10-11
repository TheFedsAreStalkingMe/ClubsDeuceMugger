// What a mug takes: about 5% of the target's cash, plus your Masterful Looting merits and the Plunder on your weapon.
// The numbers come from Settings ("Mugging bonuses"), so every finder uses the same ones.

import { STORE, load } from "/js/core/storage.js";
import { BASE_MUG } from "../state.js";

export function mugBonus() {
  const p = load(STORE.prefs, {}) || {};
  const merits = Math.min(10, Math.max(0, Math.round(Number(p.merits) || 0)));
  const boost = Number.isFinite(Number(p.meritBoost)) && p.meritBoost !== "" && p.meritBoost != null ? Number(p.meritBoost) : 5;
  const plunder = Math.min(100, Math.max(0, Number(p.plunder) || 0));
  return { merits, boost, plunder, extra: (merits * boost + plunder) / 100 };
}

// Mugging is a flat rate (the "Mugging 2.0" sheet): the base is 5% of their cash on hand, then a dice roll adds up to 100%
// (low rolls are far more likely: with full merits, 8 to 11% is the common result), and merits (+5% each) and Plunder add
// on top. ROLL_AVG is that typical roll, so a plain mug is expected to take about 6.3%, not 5%.
export const ROLL_AVG = 1.26;
export const mugRate = () => BASE_MUG * ROLL_AVG * (1 + mugBonus().extra);
// The lowest and highest a single mug can take, as shares of their cash.
export const mugRange = () => [BASE_MUG * (1 + mugBonus().extra), BASE_MUG * 2 * (1 + mugBonus().extra)];
