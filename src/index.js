// Clubs Deuce Mugger Worker: auth, invites, recovery, and API proxies.
// Static files in /public are served through env.ASSETS (run_worker_first),
// and everything under /app is only served to signed-in users.

const SESSION_COOKIE = "__Host-session";
const SESSION_SECONDS = 7 * 24 * 3600;
const APPROVAL_SECONDS = 7 * 24 * 3600;
// Workers' Web Crypto caps PBKDF2 at 100,000 iterations.
const PBKDF2_ITERATIONS = 100000;
const USERNAME_RE = /^[A-Za-z0-9_.-]{3,24}$/;
const KEY_RE = /^[A-Za-z0-9]{8,64}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{20,100}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const enc = new TextEncoder();

export default {
  async fetch(request, env, ctx) {
    let response;
    try {
      response = await route(request, env, ctx);
    } catch (err) {
      console.error("unhandled", err && err.message);
      response = json({ error: "Something went wrong. Try again." }, 500);
    }
    return withSecurityHeaders(response);
  },
};

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (Math.random() < 0.02) ctx.waitUntil(cleanup(env));

  if (path.startsWith("/api/")) {
    if (method === "POST" || method === "PUT" || method === "DELETE") {
      const origin = request.headers.get("Origin");
      if (origin && origin !== url.origin) return json({ error: "Bad origin." }, 403);
      if (!(request.headers.get("Content-Type") || "").includes("application/json")) {
        return json({ error: "Expected JSON." }, 415);
      }
    }
    return api(request, env, url, path, method);
  }

  // Static assets
  if (method !== "GET" && method !== "HEAD") return new Response("Method not allowed", { status: 405 });

  const gated = path === "/app" || path.startsWith("/app/");
  if (gated) {
    const user = await getUser(request, env);
    if (!user) return Response.redirect(url.origin + "/", 302);
  } else if (path === "/" || path === "/index.html") {
    const user = await getUser(request, env);
    if (user) return Response.redirect(url.origin + "/app/", 302);
  }
  return env.ASSETS.fetch(request);
}

async function api(request, env, url, path, method) {
  // ---- public endpoints ----
  if (path === "/api/signup" && method === "POST") return signup(request, env);
  if (path === "/api/signup/vouch" && method === "POST") return signupVouch(request, env);
  if (path === "/api/recover" && method === "POST") return recover(request, env);
  if (path === "/api/reset" && method === "POST") return resetPassword(request, env);
  if (path === "/api/login" && method === "POST") return login(request, env);

  // ---- signed-in endpoints ----
  const user = await getUser(request, env);
  if (!user) return json({ error: "Not signed in." }, 401);

  if (path === "/api/me" && method === "GET") {
    return json({ username: user.username, email: user.email || "", isOwner: isOwner(env, user.username) });
  }
  if (path === "/api/account/email" && method === "POST") return setEmail(request, env, user);
  if (path === "/api/invites" && method === "POST") return createInvite(env, user, url);
  if (path === "/api/invites" && method === "GET") return listInvites(env, user);
  if (path === "/api/invites/revoke" && method === "POST") return revokeInvite(request, env, user);
  if (path === "/api/admin/users" && method === "GET") return adminList(env, user);
  if (path === "/api/admin/users" && method === "POST") return adminAction(request, env, user);
  if (path === "/api/torn/me" && method === "GET") return proxyTornMe(request, env, user);
  if (path === "/api/logout" && method === "POST") {
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(user.tokenHash).run();
    return json({ ok: true }, 200, { "Set-Cookie": sessionCookie("", 0) });
  }
  if (path === "/api/weav3r" && method === "GET") return proxyWeav3r(env, user, url);
  if (path === "/api/torn/user" && method === "GET") return proxyTorn(request, env, user, url);
  if (path === "/api/ffscouter" && method === "POST") return proxyFF(request, env, user);

  return json({ error: "Not found." }, 404);
}

// ---------------------------------------------------------------- auth

async function signup(request, env) {
  const ip = clientIp(request);
  const rl = await rateLimit(env, "signup", ip, 5, 3600);
  if (!rl.ok) return tooMany(rl);

  const body = await readJson(request);
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const confirm = typeof body.confirm === "string" ? body.confirm : "";
  const invite = typeof body.invite === "string" ? body.invite : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";

  if (!TOKEN_RE.test(invite)) return json({ error: "You need an invite link from a member to apply." }, 403);
  const inviteHash = await sha256(invite);
  const inviteRow = await env.DB.prepare(
    "SELECT inviter_id FROM invites WHERE token_hash = ? AND used_by IS NULL AND expires_at > ?"
  ).bind(inviteHash, nowSec()).first();
  if (!inviteRow) return json({ error: "That invite link is invalid, expired, or already used." }, 403);

  if (!USERNAME_RE.test(username)) {
    return json({ error: "Username must be 3-24 characters: letters, numbers, _ . -" }, 400);
  }
  if (password.length < 8 || password.length > 128) {
    return json({ error: "Password must be 8-128 characters." }, 400);
  }
  if (password !== confirm) return json({ error: "Passwords do not match." }, 400);
  if (!EMAIL_RE.test(email) || email.length > 254) return json({ error: "Enter a valid email address." }, 400);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  const now = nowSec();

  let userId;
  try {
    const res = await env.DB.prepare(
      "INSERT INTO users (username, email, password_hash, salt, iterations, status, created_at, invited_by) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)"
    )
      .bind(username, email, b64(hash), b64(salt), PBKDF2_ITERATIONS, now, inviteRow.inviter_id)
      .run();
    userId = res.meta.last_row_id;
  } catch (err) {
    if (String(err && err.message).includes("UNIQUE")) {
      const msg = String(err.message);
      return json({ error: /email/i.test(msg) ? "That email is already used by another account." : "That username is taken." }, 409);
    }
    throw err;
  }

  // Single-use: only one applicant can claim the invite.
  const claim = await env.DB.prepare(
    "UPDATE invites SET used_by = ?, used_at = ? WHERE token_hash = ? AND used_by IS NULL AND expires_at > ?"
  ).bind(userId, now, inviteHash, now).run();
  if (claim.meta.changes !== 1) {
    await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId).run();
    return json({ error: "That invite link is invalid, expired, or already used." }, 403);
  }

  const applyToken = await newApplySession(env, userId);
  return json({ ok: true, applyToken });
}

async function newApplySession(env, userId) {
  const token = randomToken();
  await env.DB.prepare("INSERT INTO apply_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(await sha256(token), userId, nowSec() + 24 * 3600)
    .run();
  return token;
}

// Step 2: the applicant types the username of the member who invited them. A match grants access.
async function signupVouch(request, env) {
  const body = await readJson(request);
  const applyToken = typeof body.applyToken === "string" ? body.applyToken : "";
  const typed = typeof body.inviter === "string" ? body.inviter.trim() : "";
  if (!TOKEN_RE.test(applyToken)) return json({ error: "Your application session expired. Sign in to continue." }, 400);

  const row = await env.DB.prepare(
    `SELECT u.id, u.username, u.email, u.invited_by FROM apply_sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ? AND u.status = 'pending'`
  ).bind(await sha256(applyToken), nowSec()).first();
  if (!row) return json({ error: "Your application session expired. Sign in to continue." }, 404);

  // Limit guesses per application (and per IP).
  const rl = await rateLimit(env, "vouch", String(row.id), 5, 3600);
  const rlIp = await rateLimit(env, "vouch-ip", clientIp(request), 15, 3600);
  if (!rl.ok || !rlIp.ok) return tooMany(rl.ok ? rlIp : rl);

  const inviter = row.invited_by
    ? await env.DB.prepare("SELECT id, username, email FROM users WHERE id = ? AND status = 'active'").bind(row.invited_by).first()
    : null;
  if (!inviter) return json({ error: "The member who invited you is no longer here." }, 400);
  const match = await env.DB.prepare("SELECT id FROM users WHERE username = ? AND status = 'active'").bind(typed).first();
  if (!match || match.id !== inviter.id) return json({ error: "That is not the member who invited you." }, 400);

  const now = nowSec();
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET status = 'active', approved_at = ? WHERE id = ? AND status = 'pending'").bind(now, row.id),
    env.DB.prepare("DELETE FROM apply_sessions WHERE user_id = ?").bind(row.id),
  ]);

  const token = randomToken();
  await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256(token), row.id, now, now + SESSION_SECONDS)
    .run();

  // Welcome notice to the new member; a heads-up to whoever invited them.
  const base = (env.APP_URL || new URL(request.url).origin).replace(/\/$/, "");
  await sendMail(env, row.email, "Welcome to Clubs Deuce Mugger",
    `Your account "${row.username}" is ready. Sign in at ${base}\n\nThis email address is used for account recovery and security notices.`);
  if (inviter.email) {
    await sendMail(env, inviter.email, `${row.username} joined with your invite`,
      `${row.username} used your invite link to join Clubs Deuce Mugger. If this was not expected, ask the owner to remove the account.`);
  }
  return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(token, SESSION_SECONDS) });
}

// ---- email helpers

async function sendMail(env, to, subject, text, link) {
  if (!to) return false;
  const safe = escapeHtml(text).replace(/\n/g, "<br>");
  const button = link
    ? `<p><a href="${link}" style="background:#3ddc7a;color:#000;padding:12px 22px;text-decoration:none;font-weight:bold">Open link</a></p>`
    : "";
  try {
    await env.EMAIL.send({
      to,
      from: env.FROM_EMAIL,
      subject,
      text: link ? `${text}\n\n${link}` : text,
      html:
        `<div style="font-family:Courier New,monospace;background:#000;color:#eee;padding:24px">` +
        `<h2 style="color:#b983e8;margin:0 0 12px">&#9827; Clubs Deuce Mugger</h2><p>${safe}</p>${button}</div>`,
    });
    return true;
  } catch (err) {
    console.error("email failed", err && err.message);
    return false;
  }
}

// ---- password recovery

async function recover(request, env) {
  const rl = await rateLimit(env, "recover", clientIp(request), 5, 3600);
  if (!rl.ok) return tooMany(rl);
  const body = await readJson(request);
  const who = typeof body.who === "string" ? body.who.trim().toLowerCase() : "";
  const generic = json({ ok: true, message: "If that account has an email on file, a reset link is on its way." });
  if (!who || who.length > 254) return generic;

  const user = await env.DB.prepare(
    "SELECT id, username, email FROM users WHERE status = 'active' AND email IS NOT NULL AND (lower(username) = ? OR lower(email) = ?)"
  ).bind(who, who).first();
  if (!user) return generic;

  const token = randomToken();
  await env.DB.prepare("INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(await sha256(token), user.id, nowSec() + 3600)
    .run();
  const base = (env.APP_URL || new URL(request.url).origin).replace(/\/$/, "");
  await sendMail(env, user.email, "Reset your Clubs Deuce Mugger password",
    `Someone asked to reset the password for "${user.username}". The link works once and lasts 1 hour. If this was not you, ignore this email.`,
    `${base}/reset.html?t=${token}`);
  return generic;
}

async function resetPassword(request, env) {
  const rl = await rateLimit(env, "reset", clientIp(request), 10, 3600);
  if (!rl.ok) return tooMany(rl);
  const body = await readJson(request);
  const token = typeof body.token === "string" ? body.token : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!TOKEN_RE.test(token)) return json({ error: "This reset link is invalid or expired." }, 400);
  if (password.length < 8 || password.length > 128) return json({ error: "Password must be 8-128 characters." }, 400);
  if (password !== body.confirm) return json({ error: "Passwords do not match." }, 400);

  const row = await env.DB.prepare("DELETE FROM password_resets WHERE token_hash = ? AND expires_at > ? RETURNING user_id")
    .bind(await sha256(token), nowSec()).first();
  if (!row) return json({ error: "This reset link is invalid, expired, or already used." }, 404);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET password_hash = ?, salt = ?, iterations = ? WHERE id = ?").bind(b64(hash), b64(salt), PBKDF2_ITERATIONS, row.user_id),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(row.user_id),
    env.DB.prepare("DELETE FROM password_resets WHERE user_id = ?").bind(row.user_id),
  ]);
  const u = await env.DB.prepare("SELECT username, email FROM users WHERE id = ?").bind(row.user_id).first();
  if (u) await sendMail(env, u.email, "Your password was changed", `The password for "${u.username}" was just changed. If this was not you, contact the site owner.`);
  return json({ ok: true });
}

async function login(request, env) {
  const ip = clientIp(request);
  const rl = await rateLimit(env, "login", ip, 10, 600);
  if (!rl.ok) return tooMany(rl);

  const body = await readJson(request);
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const wrong = () => json({ error: "Wrong username or password" }, 401);
  if (!username || !password || password.length > 128 || username.length > 64) return wrong();

  const row = await env.DB.prepare(
    "SELECT id, password_hash, salt, iterations, status, approval_sent FROM users WHERE username = ?"
  ).bind(username).first();

  if (!row) {
    // Burn the same time as a real check so usernames can't be probed by timing.
    await pbkdf2(password, new Uint8Array(16), PBKDF2_ITERATIONS);
    return wrong();
  }

  const hash = await pbkdf2(password, unb64(row.salt), row.iterations);
  if (!timingSafeEqual(hash, unb64(row.password_hash))) return wrong();
  if (row.status !== "active") {
    // Applied but never finished naming the member who invited them: let them continue.
    return json({ error: "Account pending approval", applyToken: await newApplySession(env, row.id) }, 403);
  }

  const token = randomToken();
  const now = nowSec();
  await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256(token), row.id, now, now + SESSION_SECONDS)
    .run();
  return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(token, SESSION_SECONDS) });
}

async function getUser(request, env) {
  const cookie = request.headers.get("Cookie") || "";
  const m = cookie.match(/(?:^|;\s*)__Host-session=([A-Za-z0-9_-]{20,100})/);
  if (!m) return null;
  const tokenHash = await sha256(m[1]);
  const row = await env.DB.prepare(
    `SELECT u.id, u.username, u.email FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ? AND u.status = 'active'`
  ).bind(tokenHash, nowSec()).first();
  return row ? { id: row.id, username: row.username, email: row.email, tokenHash } : null;
}

function sessionCookie(value, maxAge) {
  return `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
}

// ---------------------------------------------------------------- members, invites, owner

function isOwner(env, username) {
  return !!env.OWNER_USERNAME && String(username).toLowerCase() === String(env.OWNER_USERNAME).toLowerCase();
}

async function setEmail(request, env, user) {
  const rl = await rateLimit(env, "email", String(user.id), 5, 3600);
  if (!rl.ok) return tooMany(rl);
  const { email, password } = await readJson(request);
  const value = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(value) || value.length > 254) return json({ error: "Enter a valid email address." }, 400);
  if (typeof password !== "string" || !password || password.length > 128) return json({ error: "Enter your current password to change your email." }, 400);

  const row = await env.DB.prepare("SELECT password_hash, salt, iterations, email FROM users WHERE id = ?").bind(user.id).first();
  const hash = await pbkdf2(password, unb64(row.salt), row.iterations);
  if (!timingSafeEqual(hash, unb64(row.password_hash))) return json({ error: "Wrong password." }, 403);
  if (row.email && row.email.toLowerCase() === value) return json({ ok: true, email: value });

  try {
    await env.DB.prepare("UPDATE users SET email = ? WHERE id = ?").bind(value, user.id).run();
  } catch (err) {
    if (String(err && err.message).includes("UNIQUE")) return json({ error: "That email is already used by another account." }, 409);
    throw err;
  }
  if (row.email) {
    await sendMail(env, row.email, "Your email was changed", `The email on "${user.username}" was changed to ${value}. If this was not you, contact the site owner right away.`);
  }
  await sendMail(env, value, "Email added to your account", `This address is now the contact email for "${user.username}" on Clubs Deuce Mugger.`);
  return json({ ok: true, email: value });
}

async function createInvite(env, user, url) {
  const owner = isOwner(env, user.username);
  const rl = await rateLimit(env, "invite", String(user.id), 10, 3600);
  if (!rl.ok) return tooMany(rl);
  if (!owner) {
    const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM invites WHERE inviter_id = ? AND used_by IS NULL AND expires_at > ?")
      .bind(user.id, nowSec()).first();
    if (open.n >= 1) return json({ error: "You already have an unused invite. Wait for it to be used or expire, or close it with the X first." }, 429);
  }
  const token = randomToken();
  const now = nowSec();
  await env.DB.prepare("INSERT INTO invites (token_hash, inviter_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256(token), user.id, now, now + APPROVAL_SECONDS)
    .run();
  const base = (env.APP_URL || url.origin).replace(/\/$/, "");
  const made = await env.DB.prepare("SELECT rowid AS id FROM invites WHERE token_hash = ?").bind(await sha256(token)).first();
  return json({ ok: true, id: made.id, link: `${base}/?invite=${token}`, expires_at: now + APPROVAL_SECONDS });
}

async function listInvites(env, user) {
  const { results } = await env.DB.prepare(
    `SELECT i.rowid AS id, i.created_at, i.expires_at, i.used_at, u.username AS used_by_name
     FROM invites i LEFT JOIN users u ON u.id = i.used_by
     WHERE i.inviter_id = ? ORDER BY i.created_at DESC LIMIT 30`
  ).bind(user.id).all();
  return json({ invites: results });
}

async function revokeInvite(request, env, user) {
  const { id } = await readJson(request);
  if (!Number.isInteger(id)) return json({ error: "Bad request." }, 400);
  // Only your own invites, and only ones nobody has used yet.
  await env.DB.prepare("DELETE FROM invites WHERE rowid = ? AND inviter_id = ? AND used_by IS NULL").bind(id, user.id).run();
  return json({ ok: true });
}

async function adminList(env, user) {
  if (!isOwner(env, user.username)) return json({ error: "Owner only." }, 403);
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.username, u.email, u.status, u.created_at, i.username AS invited_by
     FROM users u LEFT JOIN users i ON i.id = u.invited_by
     ORDER BY (u.status = 'pending') DESC, u.created_at DESC LIMIT 2000`
  ).all();
  return json({ users: results.map((r) => ({ ...r, owner: isOwner(env, r.username) })) });
}

async function adminAction(request, env, user) {
  if (!isOwner(env, user.username)) return json({ error: "Owner only." }, 403);
  const { id, action } = await readJson(request);
  if (!Number.isInteger(id) || !["approve", "deny", "delete"].includes(action)) return json({ error: "Bad request." }, 400);
  const target = await env.DB.prepare("SELECT id, username, status FROM users WHERE id = ?").bind(id).first();
  if (!target) return json({ error: "No such account." }, 404);
  if (isOwner(env, target.username)) return json({ error: "The owner account cannot be changed here." }, 400);
  if (action === "approve") {
    await env.DB.prepare("UPDATE users SET status = 'active', approved_at = ? WHERE id = ? AND status = 'pending'").bind(nowSec(), id).run();
  } else if (action === "deny") {
    await env.DB.prepare("DELETE FROM users WHERE id = ? AND status = 'pending'").bind(id).run();
  } else {
    await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(id).run();
  }
  return json({ ok: true });
}

// ---------------------------------------------------------------- proxies

async function proxyWeav3r(env, user, url) {
  const item = url.searchParams.get("item") || "";
  if (item !== "all" && !/^\d{1,7}$/.test(item)) return json({ error: "Bad item ID." }, 400);
  const rl = await rateLimit(env, "weav3r", String(user.id), 75, 60);
  if (!rl.ok) return tooMany(rl);

  // Index of every item that has bazaar listings, so the site can pick what to scan.
  if (item === "all") {
    const res = await fetch("https://weav3r.dev/api/marketplace", {
      headers: { Accept: "application/json", "User-Agent": "ClubsDeuceMugger/1.0" },
      cf: { cacheTtl: 60, cacheEverything: true },
    });
    if (!res.ok) return json({ error: `Weav3r returned ${res.status}` }, 502);
    const data = await res.json().catch(() => null);
    if (!data || !Array.isArray(data.items)) return json({ error: "Weav3r sent bad data." }, 502);
    return json({
      items: data.items
        .filter((i) => i.item_id > 0 && i.total_bazaars > 0 && i.market_price > 0)
        .map((i) => ({ id: i.item_id, name: i.item_name, price: i.market_price, lowest: i.lowest_price, bazaars: i.total_bazaars })),
    });
  }
  const res = await fetch(`https://weav3r.dev/api/marketplace/${item}`, {
    headers: { Accept: "application/json", "User-Agent": "ClubsDeuceMugger/1.0" },
    cf: { cacheTtl: 30, cacheEverything: true },
  });
  if (!res.ok) return json({ error: `Weav3r returned ${res.status}` }, 502);
  const data = await res.json().catch(() => null);
  if (!data) return json({ error: "Weav3r sent bad data." }, 502);
  return json({
    item_id: data.item_id,
    item_name: data.item_name,
    market_price: data.market_price,
    generated_at: data.generated_at,
    listings: (data.listings || []).map((l) => ({
      player_id: l.player_id,
      player_name: l.player_name,
      quantity: l.quantity,
      price: l.price,
    })),
  });
}

async function proxyTorn(request, env, user, url) {
  const id = url.searchParams.get("id") || "";
  const key = request.headers.get("X-Torn-Key") || "";
  if (!/^\d{1,10}$/.test(id)) return json({ error: "Bad player ID." }, 400);
  if (!KEY_RE.test(key)) return json({ error: "Missing or malformed Torn API key." }, 400);
  // Backstop for the browser-side limiter: stay under 85 calls/min per user.
  const rl = await rateLimit(env, "torn", String(user.id), 84, 60);
  if (!rl.ok) return tooMany(rl);

  const res = await fetch(`https://api.torn.com/user/${id}?selections=profile&key=${key}&comment=ClubsDeuceMugger`, {
    headers: { Accept: "application/json" },
  });
  const data = await res.json().catch(() => null);
  if (!data) return json({ error: "Torn sent bad data." }, 502);
  if (data.error) return json({ error: data.error.error || "Torn error", code: data.error.code }, 200);
  return json({
    player_id: data.player_id,
    name: data.name,
    age: data.age,
    last_action: data.last_action && { timestamp: data.last_action.timestamp, status: data.last_action.status },
    status: data.status && {
      state: data.status.state,
      description: data.status.description,
      until: data.status.until,
    },
  });
}

async function proxyTornMe(request, env, user) {
  const key = request.headers.get("X-Torn-Key") || "";
  if (!KEY_RE.test(key)) return json({ error: "Missing or malformed Torn API key." }, 400);
  const rl = await rateLimit(env, "torn", String(user.id), 84, 60);
  if (!rl.ok) return tooMany(rl);
  const res = await fetch(`https://api.torn.com/user/?selections=battlestats&key=${key}&comment=ClubsDeuceMugger`, {
    headers: { Accept: "application/json" },
  });
  const data = await res.json().catch(() => null);
  if (!data) return json({ error: "Torn sent bad data." }, 502);
  if (data.error) return json({ error: data.error.error || "Torn error", code: data.error.code }, 200);
  const total = Number(data.total) || ["strength", "defense", "speed", "dexterity"].reduce((n, k) => n + (Number(data[k]) || 0), 0);
  return json({ total });
}

async function proxyFF(request, env, user) {
  const key = request.headers.get("X-FF-Key") || "";
  if (!KEY_RE.test(key)) return json({ error: "Missing or malformed FF Scouter key." }, 400);
  const body = await readJson(request);
  const targets = Array.isArray(body.targets) ? body.targets : [];
  if (!targets.length || targets.length > 205 || !targets.every((t) => Number.isInteger(t) && t > 0)) {
    return json({ error: "Bad targets list." }, 400);
  }
  const rl = await rateLimit(env, "ff", String(user.id), 30, 60);
  if (!rl.ok) return tooMany(rl);

  const res = await fetch(
    `https://ffscouter.com/api/v1/get-stats?key=${key}&targets=${targets.join(",")}`,
    { headers: { Accept: "application/json", "User-Agent": "ClubsDeuceMugger/1.0" } }
  );
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) {
    return json({ error: (data && (data.error || data.message)) || `FF Scouter returned ${res.status}` }, res.status === 429 ? 429 : 502);
  }
  return json(data);
}

// ---------------------------------------------------------------- rate limiting & cleanup

// Sliding-window estimate built from two fixed windows.
async function rateLimit(env, bucket, id, limit, windowSec) {
  const now = nowSec();
  const start = now - (now % windowSec);
  const cur = await env.DB.prepare(
    "INSERT INTO rate_limits (key, count, expires_at) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = count + 1 RETURNING count"
  ).bind(`${bucket}:${id}:${start}`, start + windowSec * 2).first();
  const prev = await env.DB.prepare("SELECT count FROM rate_limits WHERE key = ?")
    .bind(`${bucket}:${id}:${start - windowSec}`).first();
  const weight = 1 - (now - start) / windowSec;
  const estimate = cur.count + (prev ? prev.count : 0) * weight;
  return { ok: estimate <= limit, retryAfter: Math.max(1, start + windowSec - now) };
}

function tooMany(rl) {
  return json({ error: "Too many attempts. Slow down and try again soon.", retryAfter: rl.retryAfter }, 429, {
    "Retry-After": String(rl.retryAfter),
  });
}

async function cleanup(env) {
  const now = nowSec();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM rate_limits WHERE expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM password_resets WHERE expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM apply_sessions WHERE expires_at < ?").bind(now),
    // Stale applications nobody acted on free their username again.
    env.DB.prepare("DELETE FROM users WHERE status = 'pending' AND created_at < ?").bind(now - APPROVAL_SECONDS),
  ]);
}

// ---------------------------------------------------------------- helpers

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") || "local";
}

async function readJson(request) {
  try {
    const data = await request.json();
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

function withSecurityHeaders(response) {
  const res = new Response(response.body, response);
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("Referrer-Policy", "no-referrer");
  res.headers.set(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; " +
      "font-src 'self'; img-src 'self' data:; connect-src 'self'; " +
      "frame-ancestors 'none'; form-action 'self'; base-uri 'none'"
  );
  if (res.headers.get("Content-Type")?.includes("text/html") && !res.headers.has("Cache-Control")) {
    res.headers.set("Cache-Control", "no-store");
  }
  return res;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function unb64(str) {
  return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
