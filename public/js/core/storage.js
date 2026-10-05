// localStorage with safe reads and writes. API keys live here and nowhere else (unless saved to the account).

export const STORE = {
  keys: "cdm.keys",
  prefs: "cdm.prefs",
  filters: "cdm.filters",
  watch: "cdm.watch",
  feed: "cdm.feed",
  dismissed: "cdm.dismissed",
  profiles: "cdm.profiles", // Torn status cache
  ff: "cdm.ff", // FF Scouter estimate cache
  tornCalls: "cdm.calls", // timestamps of recent Torn calls (rate limiter)
  taps: "cdm.taps", // Attack taps not yet confirmed by a leaderboard check: [{ target, at }]
  lastSync: "cdm.lastSync",
  items: "cdm.items", // weapon and armor ids from Torn (Buymugging)
  earnFilters: "cdm.earn.filters", // Inactive Earners: filters
  earnWages: "cdm.earn.wages", // Inactive Earners: assumed daily wages
  earnCache: "cdm.earn.cache", // Inactive Earners: company lists and employees, kept for a few hours
};

export function load(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}

export function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

export function remove(key) {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

// The stored API keys, always with both fields.
export const loadKeys = () => ({ torn: "", ff: "", ...load(STORE.keys, {}) });

// A cache kept in memory and written to localStorage in one go (not on every change).
// Entries look like { t: savedAtMs, ... }. The oldest are dropped past `max`.
export class Cache {
  constructor(key, max) {
    this.key = key;
    this.max = max;
    this.map = load(key, {});
  }
  get(id) { return this.map[id] || null; }
  put(id, value) { this.map[id] = value; }
  flush() {
    const ids = Object.keys(this.map);
    if (ids.length > this.max) {
      ids.sort((a, b) => (this.map[a].t || 0) - (this.map[b].t || 0))
        .slice(0, ids.length - Math.floor(this.max * 0.75))
        .forEach((k) => delete this.map[k]);
    }
    save(this.key, this.map);
  }
}
