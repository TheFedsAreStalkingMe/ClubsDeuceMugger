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

// `pred` is what the page predicted for this player ({ src, mug, cash, networth, score, recent, hosp }); the server
// keeps it next to the real result so the site can learn why a mug took less (or more) than expected.
export function trackAttack(targetId, pred) {
  try {
    const tap = { target: Number(targetId), at: nowSec(), ...(pred ? { pred } : {}) };
    save(STORE.taps, [...recentTaps(), tap].slice(-100));
    pending = Math.max(pending, 1);
    watchUntil = Date.now() + WATCH_FOR; // check your attack log every minute for a while
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

// ---- the watch: while a page is open, your attack log is checked every minute after you tap Attack ----
const WATCH_MS = Math.max(1000, Number(load("cdm.watchMs", 60000)) || 60000); // (the tests shorten it)
const WATCH_FOR = 20 * 60e3; // keep checking for 20 minutes after the last tap
let pending = 0; // taps the server was still waiting on at the last check
let watchUntil = 0;
let lastCheck = 0;
let blockedUntil = 0; // after an error, wait before asking again

export async function syncLeaderboard() {
  try {
    if (!state.keys.torn || Date.now() < blockedUntil) return;
    const waiting = recentTaps().length || (pending > 0 && Date.now() < watchUntil);
    if (!waiting || Date.now() - lastCheck < Math.min(WATCH_MS, 55000)) return;
    lastCheck = Date.now();
    const r = await runLeaderboardCheck(state.keys.torn);
    pending = Math.max(0, (r.taps || 0) - (r.matched || 0));
    if (!watchUntil || pending === 0) watchUntil = pending ? Date.now() + WATCH_FOR : 0;
  } catch {
    blockedUntil = Date.now() + 5 * 60e3; // a key problem would only repeat; the leaderboard page shows it
  }
}

// Called by every page of the finders: checks now and then once a minute, only while the page is visible.
export function startMugWatch() {
  if (recentTaps().length) watchUntil = Date.now() + WATCH_FOR;
  setInterval(() => { if (document.visibilityState === "visible") syncLeaderboard(); }, WATCH_MS);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") syncLeaderboard(); });
  syncLeaderboard();
}
