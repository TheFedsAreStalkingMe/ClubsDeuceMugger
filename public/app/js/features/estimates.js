// FF Scouter battle stat estimates for a list of players, 200 per request, cached for 6 hours.

import { Cache, STORE } from "/js/core/storage.js";
import { state } from "../state.js";
import { STAGES, setScanMsg } from "./ui.js";

const HOUR = 3600e3;
const isCancel = (e) => e && e.message === "cancelled";

// For EVERY seller (200 per request), so weak players are never skipped before the stat filter.
export async function estimateStats(call, ids, runId, progress = STAGES.estimates) {
  const cache = new Cache(STORE.ff, 8000);
  const need = ids.filter((id) => { const e = cache.get(id); return !e || Date.now() - e.t > 6 * HOUR; });
  setScanMsg(`Estimating stats for ${ids.length} players...`);
  for (let i = 0; i < need.length; i += 200) {
    const batch = need.slice(i, i + 200);
    let data;
    try {
      // One key is enough: FF Scouter accepts your registered Torn key unless you set a separate one.
      data = await call("/api/ffscouter", { method: "POST", headers: { "X-FF-Key": state.keys.ff || state.keys.torn }, body: { targets: batch } });
    } catch (e) {
      if (e.retryAfter || isCancel(e)) throw e;
      state.outcome = "fatal";
      throw new Error(`FF Scouter did not accept the key (${e.message}). Open Settings and tap "Test key with FF Scouter" to register it, or add a separate FF Scouter key there.`);
    }
    const seen = new Set();
    for (const s of Array.isArray(data) ? data : data.data || data.results || []) {
      seen.add(Number(s.player_id));
      cache.put(s.player_id, { t: Date.now(), ff: s.fair_fight ?? null, bs: s.bs_estimate ?? null });
    }
    for (const id of batch) if (!seen.has(id)) cache.put(id, { t: Date.now(), ff: null, bs: null });
    cache.flush();
    if (runId !== state.runId) return cache;
    progress(Math.min(i + 200, need.length) / need.length);
    setScanMsg(`Estimating stats ${Math.min(i + 200, need.length)}/${need.length}...`);
  }
  progress(1);
  return cache;
}

