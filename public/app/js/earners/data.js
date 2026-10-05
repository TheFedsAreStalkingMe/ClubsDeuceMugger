// Company data from Torn, kept in the browser for a few hours so repeat scans are fast.

import { Cache, STORE } from "/js/core/storage.js";
import { earn } from "./state.js";

export const TTL = 3 * 3600e3; // company lists and employees
const TYPES_TTL = 24 * 3600e3;

const cache = new Cache(STORE.earnCache, 600);
export const cached = (key, ttl = TTL) => { const e = cache.get(key); return e && Date.now() - e.t < ttl ? e : null; };
export const keep = (key, value) => cache.put(key, { t: Date.now(), ...value });
export const flushCache = () => cache.flush();

// Every company type. `call(path)` asks the server (it counts as one Torn call, only when the list is not cached).
export async function loadTypes(call) {
  const hit = cached("types", TYPES_TTL);
  if (hit) return (earn.types = hit.types);
  const r = await call("/api/torn/company-types");
  if (r.error) throw new Error(r.error);
  keep("types", { types: r.types });
  flushCache();
  return (earn.types = r.types);
}
