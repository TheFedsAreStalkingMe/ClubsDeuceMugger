// Torn status records (shared by the bazaar finder and the inactive earner finder). No page access here.

import { Cache, STORE } from "/js/core/storage.js";

// One cache for the page, shared by scans and the live refresher: player id -> record.
export const profiles = new Cache(STORE.profiles, 3000);

// A record from Torn's profile answer.
export const recordFrom = (p) => ({
  t: Date.now(),
  state: p.status?.state || "Okay",
  until: p.status?.until || 0,
  desc: p.status?.description || "",
  details: p.status?.details || "", // for example "Mugged by X" while in hospital
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
