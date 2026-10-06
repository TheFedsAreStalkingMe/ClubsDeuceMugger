// Mugging leaderboard: log Attack taps, verify mugs against Torn's attack log, rank members.

import { RE, upstream } from "../config.js";
import { isUniqueError } from "../lib/db.js";
import { fail, json, nowSec, readJson } from "../lib/http.js";
import { throttle } from "../lib/ratelimit.js";
import { tornV2 } from "../lib/upstream.js";

const TORN_KEY_ERRORS = [2, 10, 13, 16];
const MAX_LOGS_PER_SYNC = 8; // attack logs fetched per check, to keep each sync small

const validTarget = (t) => Number.isInteger(t) && t >= 1 && t <= 9999999999;

// A tap time from the phone is trusted only if it is plausible (in the last day, not in the future).
const tapTime = (at) => (Number.isInteger(at) && at > nowSec() - 86400 && at <= nowSec() + 60 ? at : nowSec());

// What the page predicted for the player when Attack was tapped. Only plain numbers are kept.
const SOURCES = ["bazaar", "earners", "bonus"];
function cleanPrediction(p) {
  const n = (v, max) => (Number.isFinite(v) && v >= 0 && v <= max ? Math.round(v) : null);
  p = p && typeof p === "object" ? p : {};
  return {
    src: SOURCES.includes(p.src) ? p.src : null, predicted: n(p.mug, 1e12), est_cash: n(p.cash, 1e13), networth: n(p.networth, 1e14),
    score: n(p.score, 100), recent: n(p.recent, 1000), hosp: p.hosp ? 1 : 0,
  };
}

// Records an Attack tap unless the same tap (same player, within 5 seconds) is already there. A repeat of the same
// tap fills in the prediction if the first copy had none.
async function addTap(env, userId, target, at, pred) {
  const q = cleanPrediction(pred);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO clicks (user_id, target_id, clicked_at)
       SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM clicks WHERE user_id = ? AND target_id = ? AND clicked_at BETWEEN ? AND ?)`
    ).bind(userId, target, at, userId, target, at - 5, at + 5),
    env.DB.prepare(
      `UPDATE clicks SET src = COALESCE(src, ?), predicted = COALESCE(predicted, ?), est_cash = COALESCE(est_cash, ?), networth = COALESCE(networth, ?),
         score = COALESCE(score, ?), recent_mugs = COALESCE(recent_mugs, ?), hosp = COALESCE(hosp, ?)
       WHERE user_id = ? AND target_id = ? AND clicked_at BETWEEN ? AND ?`
    ).bind(q.src, q.predicted, q.est_cash, q.networth, q.score, q.recent, q.hosp, userId, target, at - 5, at + 5),
  ]);
}

// The member tapped Attack on a player.
export async function recordClick({ request, env, user }) {
  const { target, at, pred } = await readJson(request);
  if (!validTarget(target)) return fail("Bad target.");
  const blocked = await throttle(env, "click", String(user.id), 120, 3600);
  if (blocked) return blocked;
  await addTap(env, user.id, target, tapTime(at), pred);
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
    (await throttle(env, "sync", String(user.id), 100, 3600)) || (await throttle(env, "torn", String(user.id), 70, 60));
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

    // The phone keeps its own list of Attack taps and sends it with every check, so a tap whose request was
    // lost (the app was suspended as Torn opened) still counts.
    const sent = (await readJson(request)).taps;
    for (const t of (Array.isArray(sent) ? sent : []).slice(0, 100)) {
      if (t && validTarget(t.target) && Number.isInteger(t.at)) await addTap(env, user.id, t.target, tapTime(t.at), t.pred);
    }

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

    // Remember every mug this member made (any player), so the site knows how often a player was mugged lately.
    for (const a of mugs) {
      await env.DB.prepare("INSERT OR IGNORE INTO seen_mugs (attack_code, target_id, user_id, mugged_at) VALUES (?, ?, ?, ?)").bind(a.code, a.defender.id, user.id, a.started).run();
    }

    const used = new Set();
    for (const a of mugs) {
      // Must follow a tap on Attack for that same player.
      const click = clicks.find((c) => !used.has(c.id) && c.target_id === a.defender.id && a.started >= c.clicked_at - BEFORE_TAP && a.started <= c.clicked_at + AFTER_TAP);
      if (!click) continue;
      result.matched++;
      const known = await env.DB.prepare("SELECT amount FROM mugs WHERE attack_code = ?").bind(a.code).first();
      let amount = known ? known.amount : 0;
      if (!known) {
        if (result.checked >= MAX_LOGS_PER_SYNC) break; // keep each check small; the rest wait for the next one
        result.checked++;
        const log = await tornV2(base, "/torn/attacklog", { log: a.code, striptags: "true" }, key);
        amount = mugAmount(log.attacklog);
        await env.DB.prepare("INSERT OR IGNORE INTO mugs (attack_code, user_id, target_id, amount, mugged_at) VALUES (?, ?, ?, ?, ?)")
          .bind(a.code, user.id, a.defender.id, amount, a.started).run();
        await env.DB.prepare("UPDATE seen_mugs SET amount = ? WHERE attack_code = ?").bind(amount, a.code).run();
        result.counted++;
      }
      used.add(click.id);
      // only now is the tap used up; it keeps what was predicted next to what was really taken
      await env.DB.prepare("UPDATE clicks SET matched = 1, result = 'Mugged', actual = ?, resolved_at = ? WHERE id = ?").bind(amount, now, click.id).run();
    }

    // Taps older than the window that never turned into a mug are closed with what the attack ended as (or that none was seen).
    for (const c of clicks.filter((x) => !used.has(x.id) && x.clicked_at + AFTER_TAP < now)) {
      const tries = outgoing.filter((a) => a.defender && a.defender.id === c.target_id && a.started >= c.clicked_at - BEFORE_TAP && a.started <= c.clicked_at + AFTER_TAP);
      const last = tries.length ? tries[tries.length - 1].result : "No attack seen";
      await env.DB.prepare("UPDATE clicks SET matched = 2, result = ?, actual = 0, resolved_at = ? WHERE id = ?").bind(String(last).slice(0, 40), now, c.id).run();
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

// The member's latest taps with what was predicted and what happened, plus how close the predictions are.
export async function outcomes({ env, user }) {
  const since = nowSec() - 7 * 86400;
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.target_id, c.clicked_at, c.src, c.predicted, c.est_cash, c.networth, c.score, c.recent_mugs, c.hosp, c.matched, c.result, c.actual,
            (SELECT COUNT(*) FROM seen_mugs s WHERE s.target_id = c.target_id AND s.user_id != c.user_id AND s.mugged_at BETWEEN c.clicked_at - 86400 AND c.clicked_at) AS others_24h
     FROM clicks c WHERE c.user_id = ? AND c.clicked_at > ? ORDER BY c.clicked_at DESC LIMIT 40`
  ).bind(user.id, since).all();
  const ratios = results.filter((r) => r.matched === 1 && r.predicted > 0 && r.actual > 0).map((r) => r.actual / r.predicted).sort((a, b) => a - b);
  const median = ratios.length ? ratios[Math.floor(ratios.length / 2)] : null;
  const mean = ratios.length ? ratios.reduce((n, x) => n + x, 0) / ratios.length : null;
  return json({ rows: results, summary: { compared: ratios.length, median, mean } });
}

// How often the given players were mugged by members lately: { id: { n24, n7, last, sum24 } }.
export async function recentMugs({ env, url, user }) {
  const ids = (url.searchParams.get("ids") || "").split(",").filter(Boolean).map(Number);
  if (!ids.length || ids.length > 100 || !ids.every(validTarget)) return fail("Bad player list (1 to 100 ids).");
  const blocked = await throttle(env, "recent", String(user.id), 60, 60);
  if (blocked) return blocked;
  const now = nowSec();
  const marks = ids.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT target_id, COUNT(*) AS n7, SUM(CASE WHEN mugged_at > ? THEN 1 ELSE 0 END) AS n24, MAX(mugged_at) AS last,
            SUM(CASE WHEN mugged_at > ? THEN COALESCE(amount, 0) ELSE 0 END) AS sum24
     FROM seen_mugs WHERE target_id IN (${marks}) AND mugged_at > ? GROUP BY target_id`
  ).bind(now - 86400, now - 86400, ...ids, now - 7 * 86400).all();
  const out = {};
  for (const r of results) out[r.target_id] = { n24: r.n24, n7: r.n7, last: r.last, sum24: r.sum24 };
  return json({ recent: out });
}
