// The mug feed: good mugs collected by auto hunt, each with an X to dismiss.

import { $ } from "/js/core/dom.js";
import { STORE, save } from "/js/core/storage.js";
import { state } from "../state.js";
import { card, refreshStatuses } from "./cards.js";
import { isMug, rowKey } from "./rules.js";

const FIELDS = ["id", "name", "itemId", "itemName", "market", "price", "qty", "total", "ff", "bs", "src", "spyTs", "state", "until", "desc", "age", "last"];
const snapshot = (r) => Object.fromEntries(FIELDS.map((k) => [k, r[k]]));
const GONE_AFTER = 20 * 60; // seconds a mug may be missing from the bazaars before it is dropped

const persist = () => { save(STORE.dismissed, state.dismissed); save(STORE.feed, state.feed); };

export function renderFeed() {
  const now = Date.now() / 1000;
  $("feed").hidden = !state.feed.length;
  $("feed-count").textContent = `${state.feed.length} waiting`;
  document.title = `${state.feed.length ? `(${state.feed.length}) ` : ""}Clubs Deuce Mugger | Mug Finder`;
  $("feed-list").replaceChildren(
    ...state.feed.map((e, i) => card(e, i, { found: now - e.found, dismiss: () => dismissOne(e.key) }))
  );
  refreshStatuses(now);
}

// Adds new mugs from the current rows, refreshes ones already in the feed, drops ones long gone.
export function collectMugs(now) {
  if (!state.auto) return;
  let changed = false;
  for (const r of state.rows) {
    const key = rowKey(r);
    const old = state.feed.find((e) => e.key === key);
    if (old) {
      if (r.state != null) Object.assign(old, snapshot(r), { seen: now });
    } else if (!state.dismissed[key] && isMug(r, now, false)) {
      state.feed.unshift({ key, found: now, seen: now, ...snapshot(r) });
      changed = true;
    }
  }
  const before = state.feed.length;
  state.feed = state.feed.filter((e) => now - e.seen < GONE_AFTER);
  if (state.feed.length !== before) changed = true;
  if (changed) { save(STORE.feed, state.feed); renderFeed(); }
}

export function dismissOne(key) {
  state.dismissed[key] = Date.now();
  state.feed = state.feed.filter((e) => e.key !== key);
  persist();
  renderFeed();
}

export function dismissAll() {
  for (const e of state.feed) state.dismissed[e.key] = Date.now();
  state.feed = [];
  persist();
  renderFeed();
}

// A dismissed mug stays hidden for 2 hours.
export function forgetOldDismissals() {
  for (const [key, t] of Object.entries(state.dismissed)) if (Date.now() - t > 2 * 3600e3) delete state.dismissed[key];
  save(STORE.dismissed, state.dismissed);
}
