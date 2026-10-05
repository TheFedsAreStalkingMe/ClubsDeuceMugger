// Clubs Deuce Mugger Worker entry point.
//
//   /api/*      handled here (see the route table below)
//   everything  else is a static file from /public (via env.ASSETS, run_worker_first);
//               /app/* is only served to signed-in members
//
// Each route handler gets one object: { request, env, url, user }.
// `user` is null on public routes.

import { cleanup } from "./lib/db.js";
import { getUser } from "./lib/auth.js";
import { fail, withSecurityHeaders } from "./lib/http.js";
import * as account from "./routes/account.js";
import * as admin from "./routes/admin.js";
import * as auth from "./routes/auth.js";
import * as invites from "./routes/invites.js";
import * as leaderboard from "./routes/leaderboard.js";
import * as proxies from "./routes/proxies.js";

// [method, path, handler, public?]  Public routes work without signing in.
const ROUTES = [
  // sign up, sign in, recovery
  ["POST", "/api/signup", auth.signup, true],
  ["POST", "/api/signup/vouch", auth.signupVouch, true],
  ["POST", "/api/login", auth.login, true],
  ["POST", "/api/recover", auth.recover, true],
  ["POST", "/api/reset", auth.resetPassword, true],

  // the signed-in member's account
  ["GET", "/api/me", account.me],
  ["POST", "/api/logout", account.logout],
  ["POST", "/api/account/email", account.setEmail],
  ["GET", "/api/account/key", account.getSavedKeys],
  ["POST", "/api/account/key", account.saveKeys],

  // invites and the owner's tools
  ["GET", "/api/invites", invites.listInvites],
  ["POST", "/api/invites", invites.createInvite],
  ["POST", "/api/invites/revoke", invites.revokeInvite],
  ["GET", "/api/admin/users", admin.listUsers],
  ["POST", "/api/admin/users", admin.userAction],

  // mug finder data sources
  ["GET", "/api/weav3r", proxies.weav3r],
  ["GET", "/api/torn/user", proxies.tornProfile],
  ["GET", "/api/torn/me", proxies.tornMe],
  ["GET", "/api/tornstats/spy", proxies.tornStatsSpy],
  ["POST", "/api/ffscouter", proxies.ffStats],
  ["GET", "/api/ffscouter/check", proxies.ffCheck],
  ["POST", "/api/ffscouter/register", proxies.ffRegister],

  // leaderboard
  ["POST", "/api/clicks", leaderboard.recordClick],
  ["GET", "/api/leaderboard", leaderboard.leaderboard],
  ["POST", "/api/leaderboard/sync", leaderboard.syncMugs],
];

const HANDLERS = new Map(ROUTES.map(([method, path, handler, isPublic]) => [`${method} ${path}`, { handler, isPublic: !!isPublic }]));

async function handleApi(request, env, url) {
  const method = request.method;
  // Block cross-site and non-JSON writes.
  if (method !== "GET") {
    const origin = request.headers.get("Origin");
    if (origin && origin !== url.origin) return fail("Bad origin.", 403);
    if (!(request.headers.get("Content-Type") || "").includes("application/json")) return fail("Expected JSON.", 415);
  }
  const route = HANDLERS.get(`${method} ${url.pathname}`);
  if (!route) return fail("Not found.", 404);
  const user = route.isPublic ? null : await getUser(request, env);
  if (!route.isPublic && !user) return fail("Not signed in.", 401);
  return route.handler({ request, env, url, user });
}

async function handlePage(request, env, url) {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
  const path = url.pathname;
  const gated = path === "/app" || path.startsWith("/app/");
  if (gated) {
    if (!(await getUser(request, env))) return Response.redirect(`${url.origin}/`, 302);
  } else if (path === "/" || path === "/index.html") {
    if (await getUser(request, env)) return Response.redirect(`${url.origin}/app/`, 302);
  }
  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (Math.random() < 0.02) ctx.waitUntil(cleanup(env));
    try {
      const response = url.pathname.startsWith("/api/") ? await handleApi(request, env, url) : await handlePage(request, env, url);
      return withSecurityHeaders(response);
    } catch (err) {
      console.error("unhandled", err && err.message);
      return withSecurityHeaders(fail("Something went wrong. Try again.", 500));
    }
  },
};
