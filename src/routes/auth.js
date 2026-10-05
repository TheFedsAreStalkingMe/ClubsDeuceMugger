// Sign up (by invite), sign in, password recovery.

import { RE, INVITE_SECONDS, APPLY_SESSION_SECONDS, RESET_SECONDS } from "../config.js";
import { burnPasswordTime, checkPassword, hashPassword, randomToken, sha256 } from "../lib/crypto.js";
import { createSession, passwordProblem, validToken } from "../lib/auth.js";
import { isUniqueError } from "../lib/db.js";
import { baseUrl, clientIp, fail, json, nowSec, readJson, str } from "../lib/http.js";
import { sendMail } from "../lib/mail.js";
import { throttle } from "../lib/ratelimit.js";

const BAD_INVITE = "That invite link is invalid, expired, or already used.";
const APPLY_EXPIRED = "Your application session expired. Sign in to continue.";

// A short-lived token that lets an applicant finish step 2 (naming who invited them).
async function newApplySession(env, userId) {
  const token = randomToken();
  await env.DB.prepare("INSERT INTO apply_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(await sha256(token), userId, nowSec() + APPLY_SESSION_SECONDS)
    .run();
  return token;
}

// Step 1: username, email and password, using an invite link.
export async function signup({ request, env }) {
  const blocked = await throttle(env, "signup", clientIp(request), 5, 3600);
  if (blocked) return blocked;

  const body = await readJson(request);
  const username = str(body.username).trim();
  const email = str(body.email).trim().toLowerCase();
  const password = str(body.password);
  const invite = str(body.invite);

  if (!validToken(invite)) return fail("You need an invite link from a member to apply.", 403);
  const inviteHash = await sha256(invite);
  const inviteRow = await env.DB.prepare(
    "SELECT inviter_id FROM invites WHERE token_hash = ? AND used_by IS NULL AND expires_at > ?"
  ).bind(inviteHash, nowSec()).first();
  if (!inviteRow) return fail(BAD_INVITE, 403);

  if (!RE.username.test(username)) return fail("Username must be 3-24 characters: letters, numbers, _ . -");
  const problem = passwordProblem(password, str(body.confirm));
  if (problem) return fail(problem);
  if (!RE.email.test(email) || email.length > 254) return fail("Enter a valid email address.");

  const creds = await hashPassword(password);
  const now = nowSec();

  let userId;
  try {
    const res = await env.DB.prepare(
      "INSERT INTO users (username, email, password_hash, salt, iterations, status, created_at, invited_by) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)"
    )
      .bind(username, email, creds.password_hash, creds.salt, creds.iterations, now, inviteRow.inviter_id)
      .run();
    userId = res.meta.last_row_id;
  } catch (err) {
    if (!isUniqueError(err)) throw err;
    return fail(/email/i.test(err.message) ? "That email is already used by another account." : "That username is taken.", 409);
  }

  // Single use: only one applicant can claim the invite.
  const claim = await env.DB.prepare(
    "UPDATE invites SET used_by = ?, used_at = ? WHERE token_hash = ? AND used_by IS NULL AND expires_at > ?"
  ).bind(userId, now, inviteHash, now).run();
  if (claim.meta.changes !== 1) {
    await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId).run();
    return fail(BAD_INVITE, 403);
  }
  return json({ ok: true, applyToken: await newApplySession(env, userId) });
}

// Step 2: the applicant types the username of the member who invited them. A match grants access.
export async function signupVouch({ request, env, url }) {
  const body = await readJson(request);
  const applyToken = str(body.applyToken);
  const typed = str(body.inviter).trim();
  if (!validToken(applyToken)) return fail(APPLY_EXPIRED);

  const row = await env.DB.prepare(
    `SELECT u.id, u.username, u.email, u.invited_by FROM apply_sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ? AND u.status = 'pending'`
  ).bind(await sha256(applyToken), nowSec()).first();
  if (!row) return fail(APPLY_EXPIRED, 404);

  // Limit guesses per application and per IP.
  const blocked = (await throttle(env, "vouch", String(row.id), 5, 3600)) || (await throttle(env, "vouch-ip", clientIp(request), 15, 3600));
  if (blocked) return blocked;

  const inviter = row.invited_by
    ? await env.DB.prepare("SELECT id, username, email FROM users WHERE id = ? AND status = 'active'").bind(row.invited_by).first()
    : null;
  if (!inviter) return fail("The member who invited you is no longer here.");
  const match = await env.DB.prepare("SELECT id FROM users WHERE username = ? AND status = 'active'").bind(typed).first();
  if (!match || match.id !== inviter.id) return fail("That is not the member who invited you.");

  await env.DB.batch([
    env.DB.prepare("UPDATE users SET status = 'active', approved_at = ? WHERE id = ? AND status = 'pending'").bind(nowSec(), row.id),
    env.DB.prepare("DELETE FROM apply_sessions WHERE user_id = ?").bind(row.id),
  ]);
  const cookie = await createSession(env, row.id);

  // Welcome note to the new member, heads-up to whoever invited them.
  await sendMail(env, row.email, "Welcome to Clubs Deuce Mugger",
    `Your account "${row.username}" is ready. Sign in at ${baseUrl(env, url)}\n\nThis email address is used for account recovery and security notices.`);
  await sendMail(env, inviter.email, `${row.username} joined with your invite`,
    `${row.username} used your invite link to join Clubs Deuce Mugger. If this was not expected, ask the owner to remove the account.`);
  return json({ ok: true }, 200, { "Set-Cookie": cookie });
}

export async function login({ request, env }) {
  const blocked = await throttle(env, "login", clientIp(request), 10, 600);
  if (blocked) return blocked;

  const body = await readJson(request);
  const username = str(body.username).trim();
  const password = str(body.password);
  const wrong = () => fail("Wrong username or password", 401);
  if (!username || !password || password.length > 128 || username.length > 64) return wrong();

  const row = await env.DB.prepare(
    "SELECT id, password_hash, salt, iterations, status FROM users WHERE username = ?"
  ).bind(username).first();
  if (!row) {
    await burnPasswordTime(password);
    return wrong();
  }
  if (!(await checkPassword(password, row))) return wrong();

  if (row.status !== "active") {
    // Applied but never finished naming the member who invited them: let them continue.
    return json({ error: "Account pending approval", applyToken: await newApplySession(env, row.id) }, 403);
  }
  return json({ ok: true }, 200, { "Set-Cookie": await createSession(env, row.id) });
}

// Always answers the same way, so it cannot be used to find out who has an account.
export async function recover({ request, env, url }) {
  const blocked = await throttle(env, "recover", clientIp(request), 5, 3600);
  if (blocked) return blocked;

  const who = str((await readJson(request)).who).trim().toLowerCase();
  const generic = json({ ok: true, message: "If that account has an email on file, a reset link is on its way." });
  if (!who || who.length > 254) return generic;

  const user = await env.DB.prepare(
    "SELECT id, username, email FROM users WHERE status = 'active' AND email IS NOT NULL AND (lower(username) = ? OR lower(email) = ?)"
  ).bind(who, who).first();
  if (!user) return generic;

  const token = randomToken();
  await env.DB.prepare("INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(await sha256(token), user.id, nowSec() + RESET_SECONDS)
    .run();
  await sendMail(env, user.email, "Reset your Clubs Deuce Mugger password",
    `Someone asked to reset the password for "${user.username}". The link works once and lasts 1 hour. If this was not you, ignore this email.`,
    `${baseUrl(env, url)}/reset.html?t=${token}`);
  return generic;
}

export async function resetPassword({ request, env }) {
  const blocked = await throttle(env, "reset", clientIp(request), 10, 3600);
  if (blocked) return blocked;

  const body = await readJson(request);
  const token = str(body.token);
  if (!validToken(token)) return fail("This reset link is invalid or expired.");
  const problem = passwordProblem(str(body.password), str(body.confirm));
  if (problem) return fail(problem);

  // Atomic single use: only one request can delete the row and get the user id back.
  const row = await env.DB.prepare("DELETE FROM password_resets WHERE token_hash = ? AND expires_at > ? RETURNING user_id")
    .bind(await sha256(token), nowSec()).first();
  if (!row) return fail("This reset link is invalid, expired, or already used.", 404);

  const creds = await hashPassword(str(body.password));
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET password_hash = ?, salt = ?, iterations = ? WHERE id = ?").bind(creds.password_hash, creds.salt, creds.iterations, row.user_id),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(row.user_id), // signs out every device
    env.DB.prepare("DELETE FROM password_resets WHERE user_id = ?").bind(row.user_id),
  ]);
  const u = await env.DB.prepare("SELECT username, email FROM users WHERE id = ?").bind(row.user_id).first();
  if (u) await sendMail(env, u.email, "Your password was changed", `The password for "${u.username}" was just changed. If this was not you, contact the site owner.`);
  return json({ ok: true });
}
