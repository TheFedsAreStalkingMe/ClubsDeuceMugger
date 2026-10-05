// Rate limiting in D1: a sliding window estimated from two fixed windows.

import { nowSec, tooMany } from "./http.js";

export async function rateLimit(env, bucket, id, limit, windowSec) {
  const now = nowSec();
  const start = now - (now % windowSec);
  const key = `${bucket}:${id}:${start}`;
  // One round trip: count this request in the current window and read the previous window.
  const [cur, prev] = await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO rate_limits (key, count, expires_at) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = count + 1 RETURNING count"
    ).bind(key, start + windowSec * 2),
    env.DB.prepare("SELECT count FROM rate_limits WHERE key = ?").bind(`${bucket}:${id}:${start - windowSec}`),
  ]);
  const weight = 1 - (now - start) / windowSec;
  const estimate = cur.results[0].count + (prev.results[0] ? prev.results[0].count : 0) * weight;
  const ok = estimate <= limit;
  // A rejected request must not use up allowance, or retrying makes the block last longer and longer.
  if (!ok) await env.DB.prepare("UPDATE rate_limits SET count = count - 1 WHERE key = ?").bind(key).run();
  return { ok, retryAfter: Math.max(1, start + windowSec - now) };
}

// Returns a 429 Response when over the limit, otherwise null.
//   const blocked = await throttle(env, "login", ip, 10, 600); if (blocked) return blocked;
// maxRetry caps the "try again in N seconds" hint, for limits where capacity returns gradually.
export async function throttle(env, bucket, id, limit, windowSec, { maxRetry } = {}) {
  const rl = await rateLimit(env, bucket, id, limit, windowSec);
  return rl.ok ? null : tooMany(maxRetry ? Math.min(rl.retryAfter, maxRetry) : rl.retryAfter);
}
