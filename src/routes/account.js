// The signed-in member's own account: profile, email, saved API keys, sign out.

import { RE } from "../config.js";
import { checkPassword } from "../lib/crypto.js";
import { clearCookie, isOwner } from "../lib/auth.js";
import { isUniqueError } from "../lib/db.js";
import { fail, json, readJson, str } from "../lib/http.js";
import { open, seal, vaultAvailable } from "../lib/crypto.js";
import { sendMail } from "../lib/mail.js";
import { throttle } from "../lib/ratelimit.js";

export const me = ({ env, user }) =>
  json({ username: user.username, email: user.email || "", isOwner: isOwner(env, user.username) });

export async function logout({ env, user }) {
  await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(user.tokenHash).run();
  return json({ ok: true }, 200, { "Set-Cookie": clearCookie() });
}

// Changing the email needs the current password, and both addresses are told.
export async function setEmail({ request, env, user }) {
  const blocked = await throttle(env, "email", String(user.id), 5, 3600);
  if (blocked) return blocked;

  const body = await readJson(request);
  const email = str(body.email).trim().toLowerCase();
  const password = str(body.password);
  if (!RE.email.test(email) || email.length > 254) return fail("Enter a valid email address.");
  if (!password || password.length > 128) return fail("Enter your current password to change your email.");

  const row = await env.DB.prepare("SELECT password_hash, salt, iterations, email FROM users WHERE id = ?").bind(user.id).first();
  if (!(await checkPassword(password, row))) return fail("Wrong password.", 403);
  if (row.email && row.email.toLowerCase() === email) return json({ ok: true, email });

  try {
    await env.DB.prepare("UPDATE users SET email = ? WHERE id = ?").bind(email, user.id).run();
  } catch (err) {
    if (isUniqueError(err)) return fail("That email is already used by another account.", 409);
    throw err;
  }
  if (row.email) {
    await sendMail(env, row.email, "Your email was changed", `The email on "${user.username}" was changed to ${email}. If this was not you, contact the site owner right away.`);
  }
  await sendMail(env, email, "Email added to your account", `This address is now the contact email for "${user.username}" on Clubs Deuce Mugger.`);
  return json({ ok: true, email });
}

// ---- optional: API keys saved to the account, encrypted with the KEY_SECRET secret ----

export async function getSavedKeys({ env, user }) {
  if (!vaultAvailable(env)) return json({ available: false, saved: false });
  const row = await env.DB.prepare("SELECT key_enc FROM users WHERE id = ?").bind(user.id).first();
  if (!row || !row.key_enc) return json({ available: true, saved: false });
  try {
    return json({ available: true, saved: true, keys: await open(env, user.id, row.key_enc) });
  } catch {
    return json({ available: true, saved: false }); // secret changed or data unreadable
  }
}

export async function saveKeys({ request, env, user }) {
  if (!vaultAvailable(env)) {
    return fail("Saving keys to your account is not set up yet. The site owner needs to add the KEY_SECRET secret.", 503);
  }
  const blocked = await throttle(env, "savekey", String(user.id), 20, 3600);
  if (blocked) return blocked;

  const body = await readJson(request);
  if (body.clear) {
    await env.DB.prepare("UPDATE users SET key_enc = NULL WHERE id = ?").bind(user.id).run();
    return json({ ok: true, saved: false });
  }
  const torn = str(body.torn).trim();
  const ff = str(body.ff).trim();
  const ts = str(body.ts).trim();
  if (!RE.tornKey.test(torn) || (ff && !RE.tornKey.test(ff)) || (ts && !RE.tornStatsKey.test(ts))) {
    return fail("Keys should be letters and numbers only.");
  }
  await env.DB.prepare("UPDATE users SET key_enc = ? WHERE id = ?").bind(await seal(env, user.id, { torn, ff, ts }), user.id).run();
  return json({ ok: true, saved: true });
}
