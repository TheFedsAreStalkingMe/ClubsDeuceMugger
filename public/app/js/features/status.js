// Torn status records (okay, hospital, traveling...) and putting them onto rows, feed entries and cards.

import { Cache, STORE } from "/js/core/storage.js";
import { state } from "../state.js";
import { refreshStatuses } from "./cards.js";
import { remaining } from "./rules.js";
import { scheduleRender } from "./results.js";

// One cache for the page, shared by scans and the live refresher: player id -> record.
export const profiles = new Cache(STORE.profiles, 3000);

// A record from Torn's profile answer.
export const recordFrom = (p) => ({
  t: Date.now(),
  state: p.status?.state || "Okay",
  until: p.status?.until || 0,
  desc: p.status?.description || "",
  age: p.age,
  last: p.last_action?.timestamp || 0,
});

// Okay players are trusted for 15 s (they can flip any moment). Players who are out are trusted until
// their timer ends, at most 2 minutes, in case they were released early or sent back.
export function profileFresh(p) {
  if (!p) return false;
  const now = Date.now();
  if (p.state === "Okay") return now - p.t < 15000;
  if (p.until) return now < Math.min(p.until * 1000, p.t + 2 * 60000);
  return now - p.t < 60000; // away with no timer (abroad)
}

// Writes a record onto every row and feed entry for that player, and updates their cards in place
// (no redraw, so taps on buttons are never lost).
export function applyProfile(id, p) {
  const fields = { state: p.state, until: p.until, desc: p.desc, age: p.age, last: p.last, checkedAt: p.t || Date.now() };
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
