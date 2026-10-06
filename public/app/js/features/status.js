// Torn status records (okay, hospital, traveling...) and putting them onto rows, feed entries and cards.

import { state } from "../state.js";
import { refreshStatuses } from "./cards.js";
import { remaining } from "./rules.js";
import { profileFresh, profiles, recordFrom } from "./records.js";
import { scheduleRender } from "./results.js";

export { profileFresh, profiles, recordFrom };

// Writes a record onto every row and feed entry for that player, and updates their cards in place
// (no redraw, so taps on buttons are never lost).
export function applyProfile(id, p) {
  const fields = { state: p.state, until: p.until, desc: p.desc, details: p.details || "", age: p.age, last: p.last, checkedAt: p.t || Date.now() };
  for (const r of state.rows) if (r.id === id) Object.assign(r, fields);
  for (const e of state.feed) if (e.id === id) Object.assign(e, fields);

  for (const s of document.querySelectorAll(`.status[data-pid="${id}"]`)) {
    s.dataset.state = fields.state || "";
    s.dataset.until = fields.until && fields.state !== "Okay" ? fields.until : "";
    s.dataset.known = "1";
  }
  for (const a of document.querySelectorAll(`.ago[data-pid="${id}"]`)) {
    a.dataset.ts = a.dataset.kind === "checked" ? fields.checkedAt / 1000 : fields.last || "";
  }
  refreshStatuses(Date.now() / 1000);
  // With "only Okay" on, someone who just flew or was hospitalized must leave the list.
  if (state.filters.onlyOkay && state.rows.some((r) => r.id === id && remaining(r) !== 0)) scheduleRender();
}
