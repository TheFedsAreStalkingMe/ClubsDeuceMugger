// Leaderboard plumbing: log Attack taps, and quietly check for new mugs on return.

import { api } from "/js/core/api.js";
import { STORE, save } from "/js/core/storage.js";
import { state } from "../state.js";

// Tell the server which player you opened, so the leaderboard can match it to a mug later.
export function trackAttack(targetId) {
  try {
    fetch("/api/clicks", {
      method: "POST", keepalive: true, credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: Number(targetId) }),
    }).catch(() => {});
    save(STORE.lastClick, Date.now());
  } catch { /* tracking is best effort */ }
}

// At most every 2 minutes, and only if you have tapped Attack.
export async function syncLeaderboard() {
  try {
    if (!state.keys.torn || !localStorage.getItem(STORE.lastClick)) return;
    if (Date.now() - Number(localStorage.getItem(STORE.lastSync) || 0) < 120000) return;
    save(STORE.lastSync, Date.now());
    await api("/api/leaderboard/sync", { method: "POST", headers: { "X-Torn-Key": state.keys.torn }, body: {} });
  } catch { /* the leaderboard page shows sync problems */ }
}
