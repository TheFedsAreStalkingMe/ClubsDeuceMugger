// Mugging leaderboard: log Attack taps, verify mugs against Torn's attack log, rank members.

import { RE, upstream } from "../config.js";
import { isUniqueError } from "../lib/db.js";
import { fail, json, nowSec, readJson } from "../lib/http.js";
import { throttle } from "../lib/ratelimit.js";
import { tornV2 } from "../lib/upstream.js";

const TORN_KEY_ERRORS = [2, 10, 13, 16];
const MAX_LOGS_PER_SYNC = 8; // attack logs fetched per check, to keep each sync small

// The member tapped Attack on a player.
export async function recordClick({ request, env, user }) {
  const { target } = await readJson(request);
  if (!Number.isInteger(target) || target < 1 || target > 9999999999) return fail("Bad target.");
  const blocked = await throttle(env, "click", String(user.id), 120, 3600);
  if (blocked) return blocked;
  await env.DB.prepare("INSERT INTO clicks (user_id, target_id, clicked_at) VALUES (?, ?, ?)").bind(user.id, target, nowSec()).run();
  return json({ ok: true });
}

// Money in a mug entry, for example "... mugged X and stole $1,234,567". Takes the largest $ amount in the mug lines.
function mugAmount(attacklog) {
  let best = 0;
  for (const entry of (attacklog && attacklog.log) || []) {
    if (entry.action !== "mug") continue;
    for (const m of String(entry.text || "").matchAll(/\$\s?([\d,]+)/g)) {
      best = Math.max(best, parseInt(m[1].replace(/,/g, ""), 10) || 0);
    }
  }
  return best;
}

// Finds the member's recent outgoing mugs on players they opened through the site and records them.
// Amounts come from Torn's own attack log, never from the browser.
export async function syncMugs({ request, env, user }) {
  const key = request.headers.get("X-Torn-Key") || "";
  if (!RE.tornKey.test(key)) return fail("Add your Torn key in Settings first.");
  const blocked =
    (await throttle(env, "sync", String(user.id), 12, 3600)) || (await throttle(env, "torn", String(user.id), 70, 60));
  if (blocked) return blocked;

  const base = upstream(env).tornV2;
  try {
    // Prove who the key belongs to, and link it to the member (one Torn player per member).
    const basic = await tornV2(base, "/user/basic", {}, key);
    const tornId = basic.profile && basic.profile.id;
    if (!tornId) return fail("Could not read your Torn profile.", 502);
    try {
      await env.DB.prepare("UPDATE users SET torn_id = ?, torn_name = ? WHERE id = ?").bind(tornId, basic.profile.name, user.id).run();
    } catch (err) {
      if (isUniqueError(err)) return fail("That Torn player is already linked to another member.", 409);
      throw err;
    }

    const now = nowSec();
    const { results: clicks } = await env.DB.prepare(
      "SELECT id, target_id, clicked_at FROM clicks WHERE user_id = ? AND matched = 0 AND clicked_at > ? ORDER BY clicked_at ASC LIMIT 300"
    ).bind(user.id, now - 86400).all();
    if (!clicks.length) return json({ ok: true, linked: basic.profile.name, counted: 0, checked: 0 });

    const from = Math.max(0, clicks[0].clicked_at - 120);
    const att = await tornV2(base, "/user/attacks", { filters: "outgoing", limit: "100", sort: "DESC", from: String(from) }, key);
    const mugs = (att.attacks || [])
      .filter((a) => a.result === "Mugged" && a.defender && a.attacker && a.attacker.id === tornId)
      .sort((a, b) => a.started - b.started);

    let counted = 0;
    let checked = 0;
    const used = new Set();
    for (const a of mugs) {
      if (checked >= MAX_LOGS_PER_SYNC) break;
      // Must follow a tap on Attack for that same player, within an hour.
      const click = clicks.find((c) => !used.has(c.id) && c.target_id === a.defender.id && a.started >= c.clicked_at - 120 && a.started <= c.clicked_at + 3600);
      if (!click) continue;
      used.add(click.id);
      const known = await env.DB.prepare("SELECT 1 AS x FROM mugs WHERE attack_code = ?").bind(a.code).first();
      await env.DB.prepare("UPDATE clicks SET matched = 1 WHERE id = ?").bind(click.id).run();
      if (known) continue;
      checked++;
      const log = await tornV2(base, "/torn/attacklog", { log: a.code, striptags: "true" }, key);
      await env.DB.prepare("INSERT OR IGNORE INTO mugs (attack_code, user_id, target_id, amount, mugged_at) VALUES (?, ?, ?, ?, ?)")
        .bind(a.code, user.id, a.defender.id, mugAmount(log.attacklog), a.started).run();
      counted++;
    }
    return json({ ok: true, linked: basic.profile.name, counted, checked });
  } catch (err) {
    if (TORN_KEY_ERRORS.includes(err.code)) return fail(`Torn key problem: ${err.message}. The key needs the "attacks" permission.`);
    if (err.code === 5) return fail("Torn says slow down. Try again in a minute.", 429);
    return fail(err.message || "Sync failed.", 502);
  }
}

export async function leaderboard({ env, url, user }) {
  const range = url.searchParams.get("range") || "all";
  const since = range === "day" ? nowSec() - 86400 : range === "week" ? nowSec() - 7 * 86400 : 0;
  const [board, me] = await env.DB.batch([
    env.DB.prepare(
      `SELECT u.username, u.torn_name, SUM(m.amount) AS total, COUNT(*) AS mugs, MAX(m.amount) AS biggest
       FROM mugs m JOIN users u ON u.id = m.user_id
       WHERE m.mugged_at >= ?
       GROUP BY u.id ORDER BY total DESC, mugs DESC LIMIT 50`
    ).bind(since),
    env.DB.prepare("SELECT torn_name FROM users WHERE id = ?").bind(user.id),
  ]);
  const linked = me.results[0] && me.results[0].torn_name;
  return json({ range, me: user.username, linked: linked || null, rows: board.results });
}
