// Keeps us under the Torn call limit, even across tabs and reloads.

import { sleep } from "/js/core/async.js";
import { STORE, load, save } from "/js/core/storage.js";
import { state } from "../state.js";
import { setScanMsg } from "./ui.js";

const WINDOW_MS = 60000;
const TORN_PER_MIN = 82; // Torn's ceiling is 85 (the server backstop allows 84)

// Waits until a call is allowed, then records it. Throws "cancelled" if the scan was cancelled.
async function acquire(storeKey, limit, label, runId) {
  for (;;) {
    if (runId !== state.runId) throw new Error("cancelled");
    const now = Date.now();
    const calls = load(storeKey, []).filter((t) => now - t < WINDOW_MS);
    if (calls.length < limit) {
      calls.push(now);
      save(storeKey, calls);
      return;
    }
    const wait = WINDOW_MS - (now - calls[0]) + 50;
    setScanMsg(`Pacing ${label} API calls... ${Math.ceil(wait / 1000)}s`);
    await sleep(Math.min(wait, 1000));
  }
}

// For background work: takes a slot only if one is free (keeping room for scans), never waits.
export function tryAcquireTorn(max) {
  const now = Date.now();
  const calls = load(STORE.tornCalls, []).filter((t) => now - t < WINDOW_MS);
  if (calls.length >= max) return false;
  calls.push(now);
  save(STORE.tornCalls, calls);
  return true;
}

export const acquireTorn = (runId) => acquire(STORE.tornCalls, TORN_PER_MIN, "Torn", runId);
