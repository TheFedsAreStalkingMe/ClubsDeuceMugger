// The Inactive Earners results grid, and putting fresh Torn status onto players.

import { $, el } from "/js/core/dom.js";
import { refreshStatuses } from "../features/cards.js";
import { earnCard } from "./cards.js";
import { sortValue, visibleRows } from "./rules.js";
import { earn } from "./state.js";

export function render() {
  const box = $("results");
  const shown = visibleRows();
  if (!shown.length) {
    box.replaceChildren(el("p", { class: "empty", text: "Nothing on the table yet. Hit Scan." }));
    return;
  }
  const { sort, dir } = earn.filters;
  const mul = dir === "asc" ? 1 : -1;
  const rows = [...shown].sort((a, b) => {
    const x = sortValue(a, sort), y = sortValue(b, sort);
    if (x == null && y == null) return 0;
    if (x == null) return 1; // unknowns always last
    if (y == null) return -1;
    return (x - y) * mul;
  });
  box.replaceChildren(...rows.map((r, i) => earnCard(r, i)));
  refreshStatuses(Date.now() / 1000);
}

// A fresh Torn record for a player: write it on their row and their card (in place, so button taps are not lost).
export function applyRecord(id, p) {
  const fields = { state: p.state, until: p.until, desc: p.desc, details: p.details || "", age: p.age, checkedAt: p.t || Date.now() };
  for (const r of earn.rows) {
    if (r.id !== id) continue;
    Object.assign(r, fields);
    if (p.last > r.last) r.last = p.last; // they may have been active since the company list was cached
  }
  for (const s of document.querySelectorAll(`.status[data-pid="${id}"]`)) {
    s.dataset.state = fields.state || "";
    s.dataset.until = fields.until && fields.state !== "Okay" ? fields.until : "";
    s.dataset.known = "1";
  }
  for (const a of document.querySelectorAll(`.ago[data-pid="${id}"]`)) {
    if (a.dataset.kind === "checked") a.dataset.ts = fields.checkedAt / 1000;
  }
  refreshStatuses(Date.now() / 1000);
}
