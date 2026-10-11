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

// What happened to a player's money while they were offline: two snapshots, now and the moment they were last active
// (2 Torn calls, checked for every match as soon as it is found, kept for an hour).
//   nwGain  how much their net worth grew while offline (wages and other income show up here; bazaar sales do not,
//           because an item sold for its market price is just swapped for cash)
//   profit  what their bazaar took in over the same time (public stat), sales the number of sales
// -> { bazaar, profit, sales, nwGain, days } or null when Torn would not say.
export async function readBazaar(id, last, runId) {
  const hit = cached(`b2:${id}:${last}`, HOUR);
  if (hit) return hit.b;
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const at = Math.max(last, nowSec - 360 * 86400); // Torn's history does not go back further than this here
    const now = await tornCall(`/api/torn/stats?id=${id}&ago=0`, runId);
    const then = await tornCall(`/api/torn/stats?id=${id}&at=${at}`, runId);
    const haveBazaar = now.bazaarprofit != null && then.bazaarprofit != null;
    const haveWorth = now.networth != null && then.networth != null;
    if (!haveBazaar && !haveWorth) return null;
    const b = {
      bazaar: haveBazaar,
      profit: haveBazaar ? Math.max(0, now.bazaarprofit - then.bazaarprofit) : 0,
      sales: haveBazaar ? Math.max(0, (now.bazaarsales ?? 0) - (then.bazaarsales ?? 0)) : 0,
      nwGain: haveWorth ? now.networth - then.networth : null,
      days: Math.max(1, Math.round((nowSec - at) / 86400)),
    };
    keep(`b2:${id}:${last}`, { b });
    flushCache();
    return b;
  } catch (e) {
    if (e && e.message === "cancelled") throw e;
    return null;
  }
}
