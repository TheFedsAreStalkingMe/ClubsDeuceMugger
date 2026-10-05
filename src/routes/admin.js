// Owner-only tools: see every account, approve or remove accounts.

import { isOwner } from "../lib/auth.js";
import { fail, json, nowSec, readJson } from "../lib/http.js";

const ownerOnly = (env, user) => (isOwner(env, user.username) ? null : fail("Owner only.", 403));

export async function listUsers({ env, user }) {
  const denied = ownerOnly(env, user);
  if (denied) return denied;
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.username, u.email, u.status, u.created_at, i.username AS invited_by
     FROM users u LEFT JOIN users i ON i.id = u.invited_by
     ORDER BY (u.status = 'pending') DESC, u.created_at DESC LIMIT 2000`
  ).all();
  return json({ users: results.map((r) => ({ ...r, owner: isOwner(env, r.username) })) });
}

export async function userAction({ request, env, user }) {
  const denied = ownerOnly(env, user);
  if (denied) return denied;
  const { id, action } = await readJson(request);
  if (!Number.isInteger(id) || !["approve", "deny", "delete"].includes(action)) return fail("Bad request.");
  const target = await env.DB.prepare("SELECT username FROM users WHERE id = ?").bind(id).first();
  if (!target) return fail("No such account.", 404);
  if (isOwner(env, target.username)) return fail("The owner account cannot be changed here.");

  if (action === "approve") {
    await env.DB.prepare("UPDATE users SET status = 'active', approved_at = ? WHERE id = ? AND status = 'pending'").bind(nowSec(), id).run();
  } else if (action === "deny") {
    await env.DB.prepare("DELETE FROM users WHERE id = ? AND status = 'pending'").bind(id).run();
  } else {
    await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(id).run();
  }
  return json({ ok: true });
}
