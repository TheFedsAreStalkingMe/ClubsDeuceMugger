// Leaderboard plumbing: remember Attack taps, and check for new mugs.
//
// A tap is saved on the phone the instant it happens, then sent to the server twice over: right away as a quick
// request, and again with the next check. So a tap is never lost, even if the app is suspended as Torn opens.

import { api } from "/js/core/api.js";
import { STORE, load, save } from "/js/core/storage.js";
import { state } from "../state.js";

const DAY = 86400;
const nowSec = () => Math.floor(Date.now() / 1000);
const recentTaps = () => load(STORE.taps, []).filter((t) => nowSec() - t.at < DAY);

export function trackAttack(targetId) {
  try {
    const tap = { target: Number(targetId), at: nowSec() };
    save(STORE.taps, [...recentTaps(), tap].slice(-100));
    fetch("/api/clicks", {
      method: "POST", keepalive: true, credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(tap),
    }).catch(() => {});
  } catch { /* tracking is best effort */ }
}

// Checks Torn for new mugs. Sends the saved taps along; once the server has them they are not kept any more.
export async function runLeaderboardCheck(tornKey) {
  const taps = recentTaps();
  const result = await api("/api/leaderboard/sync", { method: "POST", headers: { "X-Torn-Key": tornKey }, body: { taps } });
  const sent = new Set(taps.map((t) => `${t.target}:${t.at}`));
  save(STORE.taps, recentTaps().filter((t) => !sent.has(`${t.target}:${t.at}`)));
  return result;
}

// Quietly, when you come back to the page: at most every 2 minutes, and only if you have tapped Attack.
let lastCheck = 0;
export async function syncLeaderboard() {
  try {
    if (!state.keys.torn || !recentTaps().length || Date.now() - lastCheck < 120000) return;
    lastCheck = Date.now();
    await runLeaderboardCheck(state.keys.torn);
  } catch { /* the leaderboard page shows problems */ }
}
