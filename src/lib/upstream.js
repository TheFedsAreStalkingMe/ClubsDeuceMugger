// Calls to outside services (Torn, Weav3r, FF Scouter, TornStats).

import { USER_AGENT } from "../config.js";

// Fetch JSON. `data` is null when the reply is not JSON.
export async function fetchJson(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { Accept: "application/json", "User-Agent": USER_AGENT, ...(init.headers || {}) },
  });
  return { res, data: await res.json().catch(() => null) };
}

// Torn API v2 with the member's own key (passed through, never stored). Throws with .code on Torn errors.
export async function tornV2(base, path, params, key) {
  const qs = new URLSearchParams({ ...params, key, comment: "ClubsDeuceMugger" });
  const { data } = await fetchJson(`${base}${path}?${qs}`);
  if (!data) throw new Error("Torn sent bad data.");
  if (data.error) {
    const e = new Error(data.error.error || "Torn error");
    e.code = data.error.code;
    throw e;
  }
  return data;
}
