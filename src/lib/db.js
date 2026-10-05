// Small database helpers.

import { INVITE_SECONDS } from "../config.js";
import { nowSec } from "./http.js";

export const isUniqueError = (err) => String((err && err.message) || "").includes("UNIQUE");

// Run now and then (about 1 in 50 requests) to delete expired rows.
export async function cleanup(env) {
  const now = nowSec();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM rate_limits WHERE expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM password_resets WHERE expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM apply_sessions WHERE expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM clicks WHERE clicked_at < ?").bind(now - 2 * 86400),
    // Applications nobody finished free their username again.
    env.DB.prepare("DELETE FROM users WHERE status = 'pending' AND created_at < ?").bind(now - INVITE_SECONDS),
  ]);
}
