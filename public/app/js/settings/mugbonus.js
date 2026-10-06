// Settings: merits and Plunder, used for every predicted mug (see features/mugrate.js).

import { $, say } from "/js/core/dom.js";
import { STORE, load, save } from "/js/core/storage.js";
import { BASE_MUG } from "../state.js";
import { mugBonus } from "../features/mugrate.js";

const preview = (merits, boost, plunder) => {
  const rate = BASE_MUG * (1 + (merits * boost + plunder) / 100);
  return `A mug would take about ${(rate * 100).toFixed(2)}% of their cash.`;
};

export function initMugBonus() {
  const b = mugBonus();
  $("m-merits").value = b.merits;
  $("m-boost").value = b.boost;
  $("m-plunder").value = b.plunder;
  const read = () => ({
    merits: Math.min(10, Math.max(0, Math.round(parseFloat($("m-merits").value) || 0))),
    meritBoost: Math.min(20, Math.max(0, parseFloat($("m-boost").value) || 0)),
    plunder: Math.min(100, Math.max(0, parseFloat($("m-plunder").value) || 0)),
  });
  const show = () => { const v = read(); $("m-preview").textContent = preview(v.merits, v.meritBoost, v.plunder); };
  for (const id of ["m-merits", "m-boost", "m-plunder"]) $(id).addEventListener("input", show);
  show();
  $("save-mugbonus").addEventListener("click", () => {
    save(STORE.prefs, { ...load(STORE.prefs, {}), ...read() });
    say("mugbonus-msg", "Saved. The finders use it from now on.", "ok");
  });
}
