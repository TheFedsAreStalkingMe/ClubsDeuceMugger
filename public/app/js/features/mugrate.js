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

// 0.05 with no bonus; 0.065 with 2 merits (+5% each) and 20% Plunder.
export const mugRate = () => BASE_MUG * (1 + mugBonus().extra);
