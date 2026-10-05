// Rate limiting in D1: a sliding window estimated from two fixed windows.

import { nowSec, tooMany } from "./http.js";

export async function rateLimit(env, bucket, id, limit, windowSec) {
  const now = nowSec();
  const start = now - (now % windowSec);
  // One round trip: bump the current window and read the previous one.
  const [cur, prev] = await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO rate_limits (key, count, expires_at) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = count + 1 RETURNING count"
    ).bind(`${bucket}:${id}:${start}`, start + windowSec * 2),
    env.DB.prepare("SELECT count FROM rate_limits WHERE key = ?").bind(`${bucket}:${id}:${start - windowSec}`),
  ]);
  const weight = 1 - (now - start) / windowSec;
  const estimate = cur.results[0].count + (prev.results[0] ? prev.results[0].count : 0) * weight;
  return { ok: estimate <= limit, retryAfter: Math.max(1, start + windowSec - now) };
}

// Returns a 429 Response when over the limit, otherwise null.
//   const blocked = await throttle(env, "login", ip, 10, 600); if (blocked) return blocked;
export async function throttle(env, bucket, id, limit, windowSec) {
  const rl = await rateLimit(env, bucket, id, limit, windowSec);
  return rl.ok ? null : tooMany(rl.retryAfter);
}
