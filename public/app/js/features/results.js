// The results grid, and the once-a-second tick that keeps it live.

import { $, el } from "/js/core/dom.js";
import { state } from "../state.js";
import { updateAlerts } from "./alerts.js";
import { card, refreshStatuses } from "./cards.js";
import { collectMugs } from "./feed.js";
import { hiddenNote } from "./recent.js";
import { sortValue, visibleRows } from "./rules.js";

export function render() {
  const box = $("results");
  const shown = visibleRows();
  if (!shown.length) {
    const hidden = state.rows.length - shown.length;
    box.replaceChildren(el("p", { class: "empty", text: hidden ? `${hidden} player${hidden === 1 ? " is" : "s are"} hidden (not Okay, or mugged lately: see Settings).` : "Nothing on the table yet. Hit Scan." }));
    $("hidden-note").textContent = hiddenNote(state.rows);
    return;
  }
  $("hidden-note").textContent = hiddenNote(state.rows);
  const { sort, dir } = state.filters;
  const mul = dir === "asc" ? 1 : -1;
  const rows = [...shown].sort((a, b) => {
    const x = sortValue(a, sort), y = sortValue(b, sort);
    if (x == null && y == null) return 0;
    if (x == null) return 1; // unknowns always last
    if (y == null) return -1;
    return (x - y) * mul;
  });
  box.replaceChildren(...rows.map((r, i) => card(r, i)));
  refreshStatuses(Date.now() / 1000);
}

// Many updates arrive during a scan; redraw at most once per 300 ms.
let timer = 0;
export function scheduleRender() {
  clearTimeout(timer);
  timer = setTimeout(render, 300);
}

// No network here, only local work: countdown text, alerts, new mugs for the feed.
export function tick() {
  const now = Date.now() / 1000;
  updateAlerts(now);
  collectMugs(now);
  refreshStatuses(now);
}

// Marking a player as mugged by hand (a card button) redraws the list.
document.addEventListener("cdm:mugged", render);
