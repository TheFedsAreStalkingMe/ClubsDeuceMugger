// The Inactive Earners filters: company types, sliders, sorting.

import { $, el } from "/js/core/dom.js";
import { STORE, save } from "/js/core/storage.js";
import { fromLog, slide, toLog } from "../features/sliders.js";
import { render } from "./results.js";
import { earn } from "./state.js";

const persist = () => save(STORE.earnFilters, earn.filters);
const bindSlider = (name, opts = {}) => slide(name, { target: earn.filters, save: persist, ...opts });

function bindNumber(name, min, max, fallback) {
  const input = $(name);
  input.value = earn.filters[name];
  input.addEventListener("input", () => {
    earn.filters[name] = Math.min(max, Math.max(min, parseInt(input.value, 10) || fallback));
    persist();
  });
}

// The company types as a list of checkboxes. Mining Corporation is ticked the first time.
export function renderTypes() {
  const f = earn.filters;
  if (earn.firstRun) { // first visit: start with Mining Corporation ticked
    earn.firstRun = false;
    const mining = earn.types.find((t) => /mining/i.test(t.name));
    if (mining) { f.types = [mining.id]; persist(); }
  }
  $("types").replaceChildren(...earn.types.map((t) => {
    const box = el("input", { type: "checkbox" });
    box.checked = f.types.includes(t.id);
    box.addEventListener("change", () => {
      f.types = box.checked ? [...new Set([...f.types, t.id])] : f.types.filter((id) => id !== t.id);
      persist();
      $("types-count").textContent = `${f.types.length} selected`;
    });
    return el("label", { class: "check" }, box, ` ${t.name}`);
  }));
  $("types-count").textContent = `${f.types.length} selected`;
}

export function initEarnFilters() {
  const f = earn.filters;
  bindSlider("minStars");
  bindSlider("minDays");
  bindSlider("minBs", { to: toLog, from: fromLog });
  bindSlider("maxBs", { to: toLog, from: fromLog });
  bindSlider("maxFf");
  bindNumber("perType", 100, 1000, 200);
  bindNumber("maxCompanies", 1, 300, 60);
  bindNumber("maxPlayers", 1, 500, 80);
  const unknown = $("includeUnknown");
  unknown.checked = !!f.includeUnknown;
  unknown.addEventListener("change", () => { f.includeUnknown = unknown.checked; persist(); });

  $("types-none").addEventListener("click", () => { f.types = []; persist(); renderTypes(); });

  const sort = $("sort");
  sort.value = `${f.sort}:${f.dir}`;
  if (!sort.value) sort.value = "cash:desc";
  sort.addEventListener("change", () => { [f.sort, f.dir] = sort.value.split(":"); persist(); render(); });
}
