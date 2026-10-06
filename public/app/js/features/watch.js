// Keeps the players in the results checked after the scan is over (shared by the finders).
// Every minute while the page is open: the members' mugs are asked from our server (no Torn calls), and a few players
// get their attack history re-read from Torn's public stat snapshots (3 Torn calls each, through the shared limiter),
// the ones never checked first, then the oldest. A player found to be mugged drops in rating or disappears from the list.

import { api } from "/js/core/api.js";
import { state } from "../state.js";
import { readHistory } from "./history.js";
import { loadRecentMugs } from "./recent.js";

const EVERY = 60e3;
const FRESH = 15 * 60e3; // history older than this is read again
const PER_TICK = 3; // players per minute: 9 Torn calls, well under the limit

export function startRowWatch({ rows, render, score }) {
  let busy = false;
  const tick = async () => {
    if (busy || state.scanning || document.visibilityState !== "visible" || !state.keys.torn) return;
    const list = rows();
    if (!list.length) return;
    busy = true;
    try {
      if (!state.ctrl || state.ctrl.signal.aborted) state.ctrl = new AbortController();
      const runId = state.runId;
      await loadRecentMugs(list, (path) => api(path, { signal: state.ctrl.signal }));
      render();
      const stale = list
        .filter((r) => !r.historyAt || Date.now() - r.historyAt > FRESH)
        .sort((a, b) => (a.historyAt || 0) - (b.historyAt || 0) || (score ? score(b) - score(a) : 0))
        .slice(0, PER_TICK);
      for (const r of stale) {
        if (state.scanning || runId !== state.runId) break;
        const h = await readHistory(r.id, runId, FRESH);
        if (h) { r.history = h; r.historyAt = Date.now(); }
        else r.historyAt = Date.now() - FRESH + 5 * 60e3; // Torn would not say: try again in 5 minutes
      }
      render();
    } catch { /* the next minute tries again */ }
    busy = false;
  };
  setInterval(tick, EVERY);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") tick(); });
}
