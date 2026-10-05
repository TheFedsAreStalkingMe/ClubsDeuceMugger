// Reading Weav3r politely. When it says "busy" (429) every reader waits together, instead of each of the
// parallel reads waiting and retrying on its own (which made scans crawl). After too many busy answers in
// one scan the scan gives up on Weav3r and carries on with what it already read.

import { countdown } from "./ui.js";
import { state } from "../state.js";

const GIVE_UP_AFTER = 8; // busy answers in one scan
const gate = { until: 0, hits: 0 };

export const resetWeav3r = () => { gate.until = 0; gate.hits = 0; };
export const weav3rGaveUp = () => gate.hits >= GIVE_UP_AFTER;

// Calls `path` (a /api/weav3r URL). Throws when cancelled, when Weav3r gives up on us, or on a real error.
export async function weav3rRead(call, path, runId, label = "Weav3r is busy. Waiting") {
  for (let attempt = 0; attempt < 4 && runId === state.runId; attempt++) {
    const wait = gate.until - Date.now();
    if (wait > 0) await countdown(wait / 1000, label, runId);
    if (runId !== state.runId) break;
    if (weav3rGaveUp()) throw new Error("Weav3r keeps saying it is busy");
    try {
      return await call(path);
    } catch (e) {
      if (!e.retryAfter) throw e;
      gate.hits++;
      gate.until = Math.max(gate.until, Date.now() + e.retryAfter * 1000);
    }
  }
  throw new Error(runId === state.runId ? "Weav3r is busy" : "cancelled");
}
