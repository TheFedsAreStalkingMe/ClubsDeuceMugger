// The Filters panel: sliders with number boxes, and the other scan options.

import { $ } from "/js/core/dom.js";
import { STORE, save } from "/js/core/storage.js";
import { MIN_PRICE, state } from "../state.js";
import { render } from "./results.js";

const persist = () => save(STORE.filters, state.filters);

// Log-scale sliders so one slider covers 0 to 10 billion.
const toLog = (n) => (n <= 1 ? 0 : Math.round(Math.log10(n) * 100));
const fromLog = (v) => (v <= 0 ? 0 : Math.round(10 ** (v / 100)));
const same = (n) => n;

// A slider (id + "-r") kept in step with a number box (id). The number box is exact; `floor` is a minimum.
function bindSlider(name, { to = same, from = same, floor } = {}) {
  const num = $(name);
  const range = $(`${name}-r`);
  const set = (v, source) => {
    if (floor != null && v < floor) v = floor;
    state.filters[name] = v;
    if (source !== "num") num.value = v;
    if (source !== "range") range.value = to(v);
    persist();
  };
  num.addEventListener("input", () => {
    const v = parseFloat(num.value);
    if (!Number.isNaN(v) && (floor == null || v >= floor)) set(v, "num");
  });
  num.addEventListener("change", () => { // fix an empty or too-small box when you leave it
    const v = parseFloat(num.value);
    set(Number.isNaN(v) ? floor ?? 0 : v);
  });
  range.addEventListener("input", () => set(from(+range.value), "range"));
  set(state.filters[name]);
}

// A whole-number box with limits.
function bindNumber(name, min, max, fallback) {
  const input = $(name);
  input.value = state.filters[name];
  input.addEventListener("input", () => {
    state.filters[name] = Math.min(max, Math.max(min, parseInt(input.value, 10) || fallback));
    persist();
  });
}

function bindCheckbox(name) {
  const box = $(name);
  box.checked = !!state.filters[name];
  box.addEventListener("change", () => { state.filters[name] = box.checked; persist(); });
}

export function initFilters() {
  // Minimum price starts at $1m, then moves in $5m steps (5m, 10m ... 500m).
  bindSlider("minPrice", {
    floor: MIN_PRICE,
    to: (n) => (n <= MIN_PRICE ? 0 : Math.min(100, Math.round(n / 5e6))),
    from: (v) => (v <= 0 ? MIN_PRICE : v * 5e6),
  });
  bindSlider("minBs", { to: toLog, from: fromLog });
  bindSlider("maxBs", { to: toLog, from: fromLog });
  bindSlider("maxFf");
  bindSlider("priceTol");

  bindCheckbox("autoScan");
  bindCheckbox("includeUnknown");
  bindNumber("minActivity", 0, 100, 0);
  bindNumber("maxItems", 1, 150, 40);
  bindNumber("autoEvery", 30, 3600, 120);
  bindNumber("maxSellers", 1, 500, 80);

  for (const id of ["sort", "dir"]) {
    $(id).value = state.filters[id];
    $(id).addEventListener("change", () => { state.filters[id] = $(id).value; persist(); render(); });
  }
}
