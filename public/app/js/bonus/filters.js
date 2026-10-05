// The Bonus Weapon Sellers filters: weapon types, bonuses, rarity, price, stats, sorting.

import { $, el } from "/js/core/dom.js";
import { STORE, save } from "/js/core/storage.js";
import { fromLog, slide, toLog } from "../features/sliders.js";
import { BONUS_NAMES } from "./bonuses.js";
import { render } from "./results.js";
import { bonus } from "./state.js";

const persist = () => save(STORE.bonusFilters, bonus.filters);
const bindSlider = (name, opts = {}) => slide(name, { target: bonus.filters, save: persist, ...opts });

// A group of checkboxes (#id input) kept in an array in the filters.
function bindChecks(id, name) {
  for (const box of document.querySelectorAll(`#${id} input`)) {
    box.checked = bonus.filters[name].includes(box.value);
    box.addEventListener("change", () => {
      bonus.filters[name] = [...document.querySelectorAll(`#${id} input:checked`)].map((b) => b.value);
      persist();
      if (name === "bonuses") $("bonus-count").textContent = bonus.filters.bonuses.length ? `${bonus.filters.bonuses.length} selected` : "any";
    });
  }
}

function bindNumber(name, min, max, fallback) {
  const input = $(name);
  input.value = bonus.filters[name];
  input.addEventListener("input", () => {
    bonus.filters[name] = Math.min(max, Math.max(min, parseInt(input.value, 10) || fallback));
    persist();
  });
}

export function initBonusFilters() {
  const f = bonus.filters;
  $("bonuses").replaceChildren(...BONUS_NAMES.map((n) => el("label", { class: "check" }, el("input", { type: "checkbox", value: n }), ` ${n}`)));
  bindChecks("kinds", "kinds");
  bindChecks("rarities", "rarities");
  bindChecks("bonuses", "bonuses");
  $("bonus-count").textContent = f.bonuses.length ? `${f.bonuses.length} selected` : "any";
  $("bonuses-none").addEventListener("click", () => {
    for (const box of document.querySelectorAll("#bonuses input")) box.checked = false;
    f.bonuses = [];
    persist();
    $("bonus-count").textContent = "any";
  });

  bindSlider("minBonus");
  bindSlider("minPrice", { to: toLog, from: fromLog });
  bindSlider("maxPrice", { to: toLog, from: fromLog });
  bindSlider("minBs", { to: toLog, from: fromLog });
  bindSlider("maxBs", { to: toLog, from: fromLog });
  bindSlider("maxFf");
  bindNumber("pages", 1, 5, 2);
  bindNumber("maxListings", 1, 300, 100);
  const unknown = $("includeUnknown");
  unknown.checked = !!f.includeUnknown;
  unknown.addEventListener("change", () => { f.includeUnknown = unknown.checked; persist(); });

  const sort = $("sort");
  sort.value = `${f.sort}:${f.dir}`;
  if (!sort.value) sort.value = "price:asc";
  sort.addEventListener("change", () => { [f.sort, f.dir] = sort.value.split(":"); persist(); render(); });
}
