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

const BEFORE_TAP = 300; // seconds an attack may start before the tap was logged (clock differences)
const AFTER_TAP = 3 * 3600; // an attack counts if it starts within 3 hours after the tap

// Says what happened, in plain words, so a check that finds nothing is never a mystery.
function explain({ taps, attacks, mugs, matched, counted }) {
  if (counted) return `Found ${counted} new mug${counted === 1 ? "" : "s"}.`;
  if (!taps) return "No Attack taps in the last 24 hours. Tap Attack on a card here first, then mug them.";
  if (!attacks) return `Torn shows no attacks by you since your last Attack tap here (${taps} tap${taps === 1 ? "" : "s"} waiting).`;
  if (!mugs) return `Torn shows ${attacks} attack${attacks === 1 ? "" : "s"} by you but none were mugs.`;
  if (!matched) return `Torn shows ${mugs} mug${mugs === 1 ? "" : "s"} by you, but none on a player you opened with Attack here in the last 3 hours.`;
  return "Those mugs were already counted.";
}

// Finds the member's recent outgoing mugs on players they opened through the site and records them.
// Amounts come from Torn's own attack log, never from the browser. An Attack tap is only used up once its mug
// is safely recorded, so a Torn hiccup just means the next check tries again.
export async function syncMugs({ request, env, user }) {
  const key = request.headers.get("X-Torn-Key") || "";
  if (!RE.tornKey.test(key)) return fail("Add your Torn key in Settings first.");
  const blocked =
    (await throttle(env, "sync", String(user.id), 40, 3600)) || (await throttle(env, "torn", String(user.id), 70, 60));
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
    const result = { ok: true, linked: basic.profile.name, counted: 0, checked: 0, taps: 0, attacks: 0, mugs: 0, matched: 0 };

    const now = nowSec();
    const { results: clicks } = await env.DB.prepare(
      "SELECT id, target_id, clicked_at FROM clicks WHERE user_id = ? AND matched = 0 AND clicked_at > ? ORDER BY clicked_at ASC LIMIT 300"
    ).bind(user.id, now - 86400).all();
    result.taps = clicks.length;
    if (!clicks.length) return json({ ...result, note: explain(result) });

    const from = Math.max(0, clicks[0].clicked_at - BEFORE_TAP);
    const att = await tornV2(base, "/user/attacks", { filters: "outgoing", limit: "100", sort: "DESC", from: String(from) }, key);
    // A stealthed attack has no attacker listed; it is still yours because we asked for outgoing attacks.
    const outgoing = (att.attacks || []).filter((a) => !a.attacker || a.attacker.id === tornId);
    const mugs = outgoing.filter((a) => a.result === "Mugged" && a.defender).sort((a, b) => a.started - b.started);
    Object.assign(result, { attacks: outgoing.length, mugs: mugs.length });

    const used = new Set();
    for (const a of mugs) {
      // Must follow a tap on Attack for that same player.
      const click = clicks.find((c) => !used.has(c.id) && c.target_id === a.defender.id && a.started >= c.clicked_at - BEFORE_TAP && a.started <= c.clicked_at + AFTER_TAP);
      if (!click) continue;
      result.matched++;
      const known = await env.DB.prepare("SELECT 1 AS x FROM mugs WHERE attack_code = ?").bind(a.code).first();
      if (!known) {
        if (result.checked >= MAX_LOGS_PER_SYNC) break; // keep each check small; the rest wait for the next one
        result.checked++;
        const log = await tornV2(base, "/torn/attacklog", { log: a.code, striptags: "true" }, key);
        await env.DB.prepare("INSERT OR IGNORE INTO mugs (attack_code, user_id, target_id, amount, mugged_at) VALUES (?, ?, ?, ?, ?)")
          .bind(a.code, user.id, a.defender.id, mugAmount(log.attacklog), a.started).run();
        result.counted++;
      }
      used.add(click.id);
      await env.DB.prepare("UPDATE clicks SET matched = 1 WHERE id = ?").bind(click.id).run(); // only now is the tap used up
    }
    return json({ ...result, note: explain(result) });
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
