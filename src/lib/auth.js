// Sessions, the signed-in user and the owner check.

import { SESSION_COOKIE, SESSION_SECONDS, RE } from "../config.js";
import { randomToken, sha256 } from "./crypto.js";
import { nowSec } from "./http.js";

export const isOwner = (env, username) =>
  !!env.OWNER_USERNAME && String(username).toLowerCase() === String(env.OWNER_USERNAME).toLowerCase();

export const sessionCookie = (value, maxAge) =>
  `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;

export const clearCookie = () => sessionCookie("", 0);

// The signed-in, active member for this request, or null.
export async function getUser(request, env) {
  const cookie = request.headers.get("Cookie") || "";
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([A-Za-z0-9_-]{20,100})`));
  if (!m) return null;
  const tokenHash = await sha256(m[1]);
  const row = await env.DB.prepare(
    `SELECT u.id, u.username, u.email FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ? AND u.status = 'active'`
  ).bind(tokenHash, nowSec()).first();
  return row ? { id: row.id, username: row.username, email: row.email, tokenHash } : null;
}

// Starts a session and returns the Set-Cookie value.
export async function createSession(env, userId) {
  const token = randomToken();
  const now = nowSec();
  await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256(token), userId, now, now + SESSION_SECONDS)
    .run();
  return sessionCookie(token, SESSION_SECONDS);
}

// Shared checks for new passwords. Returns an error message or "".
export function passwordProblem(password, confirm) {
  if (password.length < 8 || password.length > 128) return "Password must be 8-128 characters.";
  if (password !== confirm) return "Passwords do not match.";
  return "";
}

export const validToken = (t) => RE.token.test(t);
