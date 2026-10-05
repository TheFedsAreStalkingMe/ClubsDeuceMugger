// Clubs Deuce Mugger Worker: auth, account approval, and API proxies.
// Static files in /public are served through env.ASSETS (run_worker_first),
// and everything under /app is only served to signed-in users.

const SESSION_COOKIE = "__Host-session";
const SESSION_SECONDS = 7 * 24 * 3600;
const APPROVAL_SECONDS = 7 * 24 * 3600;
// Workers' Web Crypto caps PBKDF2 at 100,000 iterations.
const PBKDF2_ITERATIONS = 100000;
const USERNAME_RE = /^[A-Za-z0-9_.-]{3,24}$/;
const KEY_RE = /^[A-Za-z0-9]{8,64}$/;

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
  if (path === "/api/login" && method === "POST") return login(request, env);
  if (path === "/api/approval/preview" && method === "POST") return approvalPreview(request, env);
  if (path === "/api/approval/confirm" && method === "POST") return approvalConfirm(request, env);

  // ---- signed-in endpoints ----
  const user = await getUser(request, env);
  if (!user) return json({ error: "Not signed in." }, 401);

  if (path === "/api/me" && method === "GET") return json({ username: user.username });
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

  if (!USERNAME_RE.test(username)) {
    return json({ error: "Username must be 3-24 characters: letters, numbers, _ . -" }, 400);
  }
  if (password.length < 8 || password.length > 128) {
    return json({ error: "Password must be 8-128 characters." }, 400);
  }
  if (password !== confirm) return json({ error: "Passwords do not match." }, 400);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  const now = nowSec();

  let userId;
  try {
    const res = await env.DB.prepare(
      "INSERT INTO users (username, password_hash, salt, iterations, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)"
    )
      .bind(username, b64(hash), b64(salt), PBKDF2_ITERATIONS, now)
      .run();
    userId = res.meta.last_row_id;
  } catch (err) {
    if (String(err && err.message).includes("UNIQUE")) {
      return json({ error: "That username is taken or already has an application." }, 409);
    }
    throw err;
  }

  const approveToken = randomToken();
  const denyToken = randomToken();
  const expires = now + APPROVAL_SECONDS;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO approval_tokens (token_hash, user_id, action, expires_at) VALUES (?, ?, 'approve', ?)")
      .bind(await sha256(approveToken), userId, expires),
    env.DB.prepare("INSERT INTO approval_tokens (token_hash, user_id, action, expires_at) VALUES (?, ?, 'deny', ?)")
      .bind(await sha256(denyToken), userId, expires),
  ]);

  const base = (env.APP_URL || new URL(request.url).origin).replace(/\/$/, "");
  const approveUrl = `${base}/approve.html?t=${approveToken}`;
  const denyUrl = `${base}/approve.html?t=${denyToken}`;

  try {
    await env.EMAIL.send({
      to: env.ADMIN_EMAIL,
      from: env.FROM_EMAIL,
      subject: `Clubs Deuce Mugger: application from ${username}`,
      text:
        `New application: ${username}\n\n` +
        `Approve: ${approveUrl}\n` +
        `Deny: ${denyUrl}\n\n` +
        `Links work once and expire in 7 days.`,
      html:
        `<div style="font-family:Arial,sans-serif;background:#0b0b0e;color:#eee;padding:24px">` +
        `<h2 style="color:#b983e8;margin:0 0 12px">&#9827; Clubs Deuce Mugger</h2>` +
        `<p>New application from <b>${escapeHtml(username)}</b></p>` +
        `<p><a href="${approveUrl}" style="background:#2fbf5b;color:#06210f;padding:12px 22px;border-radius:6px;text-decoration:none;font-weight:bold">Approve</a> &nbsp; ` +
        `<a href="${denyUrl}" style="background:#7b3fa0;color:#fff;padding:12px 22px;border-radius:6px;text-decoration:none;font-weight:bold">Deny</a></p>` +
        `<p style="color:#999;font-size:12px">Links work once and expire in 7 days.</p></div>`,
    });
  } catch (err) {
    console.error("email failed", err && err.message);
    await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId).run();
    return json({ error: "Could not send your application. Please try again later." }, 502);
  }

  return json({ ok: true, message: "Application sent, waiting for approval" });
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
    "SELECT id, password_hash, salt, iterations, status FROM users WHERE username = ?"
  ).bind(username).first();

  if (!row) {
    // Burn the same time as a real check so usernames can't be probed by timing.
    await pbkdf2(password, new Uint8Array(16), PBKDF2_ITERATIONS);
    return wrong();
  }

  const hash = await pbkdf2(password, unb64(row.salt), row.iterations);
  if (!timingSafeEqual(hash, unb64(row.password_hash))) return wrong();
  if (row.status !== "active") return json({ error: "Account pending approval" }, 403);

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
    `SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ? AND u.status = 'active'`
  ).bind(tokenHash, nowSec()).first();
  return row ? { id: row.id, username: row.username, tokenHash } : null;
}

function sessionCookie(value, maxAge) {
  return `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
}

// ---------------------------------------------------------------- approval

async function approvalPreview(request, env) {
  const rl = await rateLimit(env, "approval", clientIp(request), 30, 600);
  if (!rl.ok) return tooMany(rl);
  const { token } = await readJson(request);
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{20,100}$/.test(token)) return json({ error: "Invalid link." }, 400);
  const row = await env.DB.prepare(
    `SELECT t.action, u.username FROM approval_tokens t JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = ? AND t.expires_at > ? AND u.status = 'pending'`
  ).bind(await sha256(token), nowSec()).first();
  if (!row) return json({ error: "This link is invalid, expired, or already used." }, 404);
  return json({ action: row.action, username: row.username });
}

async function approvalConfirm(request, env) {
  const rl = await rateLimit(env, "approval", clientIp(request), 30, 600);
  if (!rl.ok) return tooMany(rl);
  const { token } = await readJson(request);
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{20,100}$/.test(token)) return json({ error: "Invalid link." }, 400);

  // Atomic single-use: only one request can delete the row and get RETURNING data.
  const row = await env.DB.prepare(
    "DELETE FROM approval_tokens WHERE token_hash = ? AND expires_at > ? RETURNING user_id, action"
  ).bind(await sha256(token), nowSec()).first();
  if (!row) return json({ error: "This link is invalid, expired, or already used." }, 404);

  await env.DB.batch([
    row.action === "approve"
      ? env.DB.prepare("UPDATE users SET status = 'active', approved_at = ? WHERE id = ? AND status = 'pending'").bind(nowSec(), row.user_id)
      : env.DB.prepare("DELETE FROM users WHERE id = ? AND status = 'pending'").bind(row.user_id),
    env.DB.prepare("DELETE FROM approval_tokens WHERE user_id = ?").bind(row.user_id),
  ]);
  return json({ ok: true, action: row.action });
}

// ---------------------------------------------------------------- proxies

async function proxyWeav3r(env, user, url) {
  const item = url.searchParams.get("item") || "";
  if (!/^\d{1,7}$/.test(item)) return json({ error: "Bad item ID." }, 400);
  const rl = await rateLimit(env, "weav3r", String(user.id), 60, 60);
  if (!rl.ok) return tooMany(rl);
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
    status: data.status && {
      state: data.status.state,
      description: data.status.description,
      until: data.status.until,
    },
  });
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
    env.DB.prepare("DELETE FROM approval_tokens WHERE expires_at < ?").bind(now),
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
