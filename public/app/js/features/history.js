// (shared by all three finders)
// How often a player was attacked lately by ANYONE, not just site members: Torn keeps daily snapshots of public stats,
// so the number of defends they lost (and their net worth) now, a day ago and a week ago show it. Three Torn calls per
// player, so it is only done for the best few matches and kept for an hour.

import { cached, flushCache, keep } from "../earners/data.js";
import { tornCall } from "./torncall.js";

const HOUR = 3600e3;

// -> { lost24, lost7, drop24, profit24, profit7, sales24, sales7, bazaar } or null when Torn would not say.
export async function readHistory(id, runId, ttl = HOUR) {
  const hit = cached(`h:${id}`, ttl);
  if (hit) return hit.h;
  try {
    const now = await tornCall(`/api/torn/stats?id=${id}&ago=0`, runId);
    const day = await tornCall(`/api/torn/stats?id=${id}&ago=1`, runId);
    const week = await tornCall(`/api/torn/stats?id=${id}&ago=7`, runId);
    if ([now, day, week].some((s) => s.defendslost == null)) return null;
    const h = {
      lost24: Math.max(0, now.defendslost - day.defendslost), // fights they lost as the defender since yesterday's snapshot
      lost7: Math.max(0, now.defendslost - week.defendslost),
      // Bazaar: money their bazaar took in since the snapshot (it sells while they are offline, and it all stays as cash).
      profit24: Math.max(0, (now.bazaarprofit ?? 0) - (day.bazaarprofit ?? 0)),
      profit7: Math.max(0, (now.bazaarprofit ?? 0) - (week.bazaarprofit ?? 0)),
      sales24: Math.max(0, (now.bazaarsales ?? 0) - (day.bazaarsales ?? 0)),
      sales7: Math.max(0, (now.bazaarsales ?? 0) - (week.bazaarsales ?? 0)),
      bazaar: now.bazaarprofit != null && week.bazaarprofit != null, // false when Torn gave no bazaar numbers
      drop24: day.networth > 0 && now.networth != null ? Math.max(0, 1 - now.networth / day.networth) : 0, // net worth fall since yesterday
    };
    keep(`h:${id}`, { h });
    flushCache();
    return h;
  } catch (e) {
    if (e && e.message === "cancelled") throw e;
    return null;
  }
}

// Just the bazaar numbers (2 Torn calls: now and a week ago), for every match as soon as it is found.
// -> { bazaar: true, profit7, sales7 } or null when Torn would not say.
export async function readBazaar(id, runId) {
  const hit = cached(`b:${id}`, HOUR);
  if (hit) return hit.b;
  try {
    const now = await tornCall(`/api/torn/stats?id=${id}&ago=0`, runId);
    const week = await tornCall(`/api/torn/stats?id=${id}&ago=7`, runId);
    if (now.bazaarprofit == null || week.bazaarprofit == null) return null;
    const b = {
      bazaar: true,
      profit7: Math.max(0, now.bazaarprofit - week.bazaarprofit),
      sales7: Math.max(0, (now.bazaarsales ?? 0) - (week.bazaarsales ?? 0)),
    };
    keep(`b:${id}`, { b });
    flushCache();
    return b;
  } catch (e) {
    if (e && e.message === "cancelled") throw e;
    return null;
  }
}
