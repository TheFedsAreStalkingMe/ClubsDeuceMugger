// The background search (see lib/hunt.js): turn it on or off, see how it is doing, run a step now.
// Turning it on stores the member's Torn key on the server (sealed with the BG_SECRET Worker secret) so the scheduled job
// can use it; turning it off deletes the key. Needs the member's password and an email address to send results to.

import { RE } from "../config.js";
import { checkPassword, sealWithSecret } from "../lib/crypto.js";
import { fail, json, nowSec, readJson, str } from "../lib/http.js";
import { cleanConfig, runAllHunts } from "../lib/hunt.js";
import { throttle } from "../lib/ratelimit.js";
import { tornV2 } from "../lib/upstream.js";
import { upstream } from "../config.js";

const view = (row) => ({
  enabled: !!(row && row.enabled),
  config: row ? JSON.parse(row.config) : null,
  lastRun: row ? row.last_run : 0,
  lastMsg: row ? row.last_msg : "",
});

export async function status({ env, user }) {
  const row = await env.DB.prepare("SELECT enabled, config, last_run, last_msg FROM bg_hunts WHERE user_id = ?").bind(user.id).first();
  const me = await env.DB.prepare("SELECT email FROM users WHERE id = ?").bind(user.id).first();
  return json({ available: !!env.BG_SECRET, hasEmail: !!(me && me.email), ...view(row) });
}

export async function enable({ request, env, user }) {
  if (!env.BG_SECRET) return fail("The site owner has not set up the background search yet (a Worker secret called BG_SECRET is needed).", 503);
  const blocked = await throttle(env, "hunt", String(user.id), 10, 3600);
  if (blocked) return blocked;
  const body = await readJson(request);
  const torn = str(body.tornKey).trim();
  const ff = str(body.ffKey).trim();
  if (!RE.tornKey.test(torn)) return fail("Enter your Torn API key.");
  if (ff && !RE.tornKey.test(ff)) return fail("The FF Scouter key looks wrong.");
  const password = str(body.password);
  if (!password || password.length > 128) return fail("Enter your password to save your key on the server.");

  const me = await env.DB.prepare("SELECT password_hash, salt, iterations, email FROM users WHERE id = ?").bind(user.id).first();
  if (!(await checkPassword(password, me))) return fail("Wrong password.", 403);
  if (!me.email) return fail("Add an email address in Settings first: that is where the results are sent.");

  const config = cleanConfig(body.config);
  if (!config.types.length) return fail("Pick at least one company type on the Inactive Earners page first.");
  try {
    await tornV2(upstream(env).tornV2, "/key/info", {}, torn); // is the key accepted at all?
  } catch (e) {
    return fail(`Torn did not accept that key: ${e.message}`);
  }

  const sealed = await sealWithSecret(env.BG_SECRET, user.id, { torn, ff: ff || null });
  await env.DB.prepare(
    `INSERT INTO bg_hunts (user_id, enabled, key_enc, config, state, last_run, last_msg, created_at) VALUES (?, 1, ?, ?, '{}', 0, 'Starting at the next run.', ?)
     ON CONFLICT(user_id) DO UPDATE SET enabled = 1, key_enc = excluded.key_enc, config = excluded.config, state = '{}', last_msg = 'Starting at the next run.'`
  ).bind(user.id, sealed, JSON.stringify(config), nowSec()).run();
  return json({ ok: true });
}

// Off: the key is deleted along with everything the search remembered.
export async function disable({ env, user }) {
  await env.DB.prepare("DELETE FROM bg_hunts WHERE user_id = ?").bind(user.id).run();
  return json({ ok: true });
}

// "Run a step now": the same as one scheduled run, for this member only.
export async function runNow({ env, user }) {
  const blocked = await throttle(env, "huntnow", String(user.id), 12, 3600);
  if (blocked) return blocked;
  const out = await runAllHunts(env, user.id);
  const row = await env.DB.prepare("SELECT enabled, config, last_run, last_msg FROM bg_hunts WHERE user_id = ?").bind(user.id).first();
  return json({ ran: out.length > 0, ...view(row) });
}
