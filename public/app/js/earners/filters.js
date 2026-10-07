// The Inactive Earners filters: company types, sliders, sorting.

import { $, el } from "/js/core/dom.js";
import { STORE, save } from "/js/core/storage.js";
import { fromLog, slide, toLog } from "../features/sliders.js";
import { render } from "./results.js";
import { earn } from "./state.js";

// The company types with the highest average income (Tornstats' average weekly income by type, Oct 2026), best first.
// Matched by name against Torn's list.
const SUGGESTED = ["Oil Rig", "Mining Corporation", "Logistics Management", "Television Network", "Private Security Firm"];
const suggestedRank = (t) => SUGGESTED.findIndex((n) => n.toLowerCase() === String(t.name).toLowerCase());

const persist = () => save(STORE.earnFilters, earn.filters);
const bindSlider = (name, opts = {}) => slide(name, { target: earn.filters, save: persist, ...opts });

function bindNumber(name, min, max, fallback) {
  const input = $(name);
  input.value = earn.filters[name];
  input.addEventListener("input", () => {
    const n = parseInt(input.value, 10);
    earn.filters[name] = Math.min(max, Math.max(min, Number.isNaN(n) ? fallback : n)); // 0 is a real choice for some fields
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
  const ordered = [...earn.types].sort((a, b) => {
    const x = suggestedRank(a), y = suggestedRank(b);
    if (x >= 0 || y >= 0) return (x < 0 ? 99 : x) - (y < 0 ? 99 : y); // suggested first, best income first
    return a.name.localeCompare(b.name);
  });
  $("types").replaceChildren(...ordered.map((t) => {
    const box = el("input", { type: "checkbox" });
    box.checked = f.types.includes(t.id);
    box.addEventListener("change", () => {
      f.types = box.checked ? [...new Set([...f.types, t.id])] : f.types.filter((id) => id !== t.id);
      persist();
      $("types-count").textContent = `${f.types.length} selected`;
    });
    return el("label", { class: "check" }, box, ` ${t.name}`, suggestedRank(t) >= 0 ? el("span", { class: "suggested", text: " [ Suggested ]" }) : null);
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
  bindNumber("perType", 100, 2000, 500);
  bindNumber("maxCompanies", 1, 1000, 300);
  bindNumber("maxPlayers", 1, 500, 80);
  bindNumber("historyTop", 0, 50, 10);
  bindNumber("skipSeenHours", 0, 168, 6);
  const unknown = $("includeUnknown");
  unknown.checked = !!f.includeUnknown;
  unknown.addEventListener("change", () => { f.includeUnknown = unknown.checked; persist(); });

  $("types-none").addEventListener("click", () => { f.types = []; persist(); renderTypes(); });

  const sort = $("sort");
  sort.value = `${f.sort}:${f.dir}`;
  if (!sort.value) sort.value = "score:desc";
  sort.addEventListener("change", () => { [f.sort, f.dir] = sort.value.split(":"); persist(); render(); });
}

// The list could not be loaded: say why, inside the list, with a way to try again.
export function showTypesError(message, retry) {
  const again = el("button", { class: "btn small", type: "button", text: "Try again" });
  again.addEventListener("click", retry);
  $("types").replaceChildren(el("span", { class: "msg err", text: `Could not load company types: ${message}` }), again);
  $("types-count").textContent = "";
}
