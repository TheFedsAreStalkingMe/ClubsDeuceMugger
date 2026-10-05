// Invite links, and the owner's account list.

import { INVITE_SECONDS } from "../config.js";
import { randomToken, sha256 } from "../lib/crypto.js";
import { isOwner } from "../lib/auth.js";
import { baseUrl, fail, json, nowSec, readJson } from "../lib/http.js";
import { throttle } from "../lib/ratelimit.js";

// Members can have one open invite at a time. The owner has no limit.
export async function createInvite({ env, url, user }) {
  const blocked = await throttle(env, "invite", String(user.id), 10, 3600);
  if (blocked) return blocked;
  if (!isOwner(env, user.username)) {
    const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM invites WHERE inviter_id = ? AND used_by IS NULL AND expires_at > ?")
      .bind(user.id, nowSec()).first();
    if (open.n >= 1) return fail("You already have an unused invite. Wait for it to be used or expire, or close it with the X first.", 429);
  }
  const token = randomToken();
  const tokenHash = await sha256(token);
  const now = nowSec();
  await env.DB.prepare("INSERT INTO invites (token_hash, inviter_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(tokenHash, user.id, now, now + INVITE_SECONDS)
    .run();
  const made = await env.DB.prepare("SELECT rowid AS id FROM invites WHERE token_hash = ?").bind(tokenHash).first();
  return json({ ok: true, id: made.id, link: `${baseUrl(env, url)}/?invite=${token}`, expires_at: now + INVITE_SECONDS });
}

export async function listInvites({ env, user }) {
  const { results } = await env.DB.prepare(
    `SELECT i.rowid AS id, i.created_at, i.expires_at, i.used_at, u.username AS used_by_name
     FROM invites i LEFT JOIN users u ON u.id = i.used_by
     WHERE i.inviter_id = ? ORDER BY i.created_at DESC LIMIT 30`
  ).bind(user.id).all();
  return json({ invites: results });
}

// Only your own invites, and only ones nobody has used yet.
export async function revokeInvite({ request, env, user }) {
  const { id } = await readJson(request);
  if (!Number.isInteger(id)) return fail("Bad request.");
  await env.DB.prepare("DELETE FROM invites WHERE rowid = ? AND inviter_id = ? AND used_by IS NULL").bind(id, user.id).run();
  return json({ ok: true });
}
