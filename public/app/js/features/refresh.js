// Keeps the statuses on screen true between scans: re-checks players in the background, most overdue first,
// using spare room under the Torn call limit. Cards update in place.

import { api } from "/js/core/api.js";
import { state } from "../state.js";
import { tryAcquireTorn } from "./limits.js";
import { isMug } from "./rules.js";
import { applyProfile, profiles, recordFrom } from "./status.js";

const EVERY_MS = 2000; // how often it looks for work
const AT_ONCE = 3; // checks per round
const SPARE_LIMIT = 60; // leave 20 of the 80 calls a minute for scans
const KEY_ERRORS = [2, 10, 13, 16];

// How old (seconds) a status may get before it is re-checked.
const MAX_AGE = {
  mug: 15, // okay players who could be mugged right now: they can fly or be hospitalized any second
  okay: 40, // other okay players
  away: 60, // away with no timer (abroad)
  timer: 120, // out with a timer (hospital, traveling): could be released early or sent back
  ended: 0, // their timer ran out: confirm now
};

let pausedUntil = 0;
let stopped = false; // the key is wrong: stop asking

// Player ids that are overdue for a check, most overdue first.
function overdue(now) {
  const worst = new Map(); // id -> how many seconds overdue
  const consider = (r, inFeed) => {
    if (r.state == null) return; // a scan is still working on it
    const age = now - (r.checkedAt || 0) / 1000;
    let limit;
    if (r.state === "Okay") limit = inFeed || isMug(r, now, false) ? MAX_AGE.mug : MAX_AGE.okay;
    else if (!r.until) limit = MAX_AGE.away;
    else limit = r.until <= now ? MAX_AGE.ended : MAX_AGE.timer;
    const late = age - limit;
    if (late >= 0 && late > (worst.get(r.id) ?? -1)) worst.set(r.id, late);
  };
  for (const e of state.feed) consider(e, true);
  for (const r of state.rows) consider(r, false);
  return [...worst].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

async function check(id) {
  try {
    const p = await api(`/api/torn/user?id=${id}`, { headers: { "X-Torn-Key": state.keys.torn } });
    if (p.error) {
      if (p.code === 5) pausedUntil = Date.now() + 30000;
      else if (KEY_ERRORS.includes(p.code)) stopped = true;
      return;
    }
    const rec = recordFrom(p);
    profiles.put(id, rec);
    applyProfile(id, rec);
  } catch (e) {
    if (e.retryAfter) pausedUntil = Date.now() + e.retryAfter * 1000;
  }
}

let busy = false;
let rounds = 0;
async function round() {
  if (busy || stopped || state.scanning || !state.keys.torn || document.visibilityState !== "visible" || Date.now() < pausedUntil) return;
  busy = true;
  try {
    const ids = overdue(Date.now() / 1000).slice(0, AT_ONCE);
    const started = [];
    for (const id of ids) if (tryAcquireTorn(SPARE_LIMIT)) started.push(check(id));
    await Promise.all(started);
    if (started.length && ++rounds % 5 === 0) profiles.flush();
  } finally {
    busy = false;
  }
}

export function startLiveRefresh() {
  setInterval(round, EVERY_MS);
}
