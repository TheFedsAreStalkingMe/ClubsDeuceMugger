// A Torn call (through our server) that waits for a free slot under the per-minute limit, pacing and
// "slow down" answers included. Torn key errors come back as errors with `.fatal = true`.

import { api } from "/js/core/api.js";
import { acquireTorn } from "./limits.js";
import { countdown } from "./ui.js";
import { state } from "../state.js";

const TORN_KEY_ERRORS = [2, 10, 13, 16];

export async function tornCall(path, runId) {
  for (;;) {
    await acquireTorn(runId);
    try {
      const r = await api(path, { headers: { "X-Torn-Key": state.keys.torn }, signal: state.ctrl.signal });
      if (r.error) {
        if (r.code === 5) { await countdown(30, "Torn says slow down. Waiting", runId); continue; }
        const e = new Error(`Torn: ${r.error}`);
        e.fatal = TORN_KEY_ERRORS.includes(r.code);
        throw e;
      }
      return r;
    } catch (e) {
      if (e.retryAfter) { await countdown(e.retryAfter, "Pacing Torn API calls...", runId); continue; }
      throw e;
    }
  }
}
