// Backend test run: every Worker feature end to end, against fake Torn / Weav3r / FF Scouter / TornStats.
//
//   node tests/run.mjs                      (Node 20+; fetches wrangler with npx unless WRANGLER is set)
//   WRANGLER="/path/to/wrangler" node tests/run.mjs
//
// Nothing here touches your real Cloudflare account, database or email.

import { BASE, Client, OWNER, check, fail, finish, section, startEnvironment, waitForMail } from "./lib/harness.mjs";

async function runChecks() {
  const anon = new Client("10.0.0.1");
  const owner = new Client("10.0.0.2");
  const bob = new Client("10.0.0.3");
  const KEY = "abcdefgh12345678";

  section("Pages and security");
  let r = await anon.get("/app/");
  check("/app/ redirects when signed out", r.status === 302 && r.res.headers.get("location").endsWith("/"));
  r = await anon.get("/api/me");
  check("/api/me needs sign-in", r.status === 401);
  r = await anon.get("/manifest.webmanifest");
  check("manifest is public", r.status === 200);
  r = await anon.get("/");
  check("security headers set", r.res.headers.get("x-frame-options") === "DENY" && /default-src 'self'/.test(r.res.headers.get("content-security-policy")));
  r = await anon.get("/api/nope");
  check("unknown API route is 404", r.status === 404);
  r = await anon.post("/api/login", { username: "x", password: "y" }, { headers: { Origin: "https://evil.example" } });
  check("cross-site POST refused", r.status === 403);
  r = await anon.call("POST", "/api/login", { headers: { "Content-Type": "text/plain" }, body: undefined });
  check("non-JSON POST refused", r.status === 415);

  section("Sign in and rate limit");
  r = await owner.post("/api/login", { username: OWNER.name, password: "wrong" });
  check("wrong password message", r.status === 401 && r.data.error === "Wrong username or password");
  r = await owner.post("/api/login", { username: "nobody", password: "whatever12" });
  check("unknown user gets the same message", r.status === 401 && r.data.error === "Wrong username or password");
  r = await owner.post("/api/login", { username: OWNER.name, password: OWNER.pass });
  const cookie = r.res.headers.get("set-cookie") || "";
  check("owner signs in", r.status === 200);
  check("session cookie is secure", /__Host-session=/.test(cookie) && /HttpOnly/.test(cookie) && /Secure/.test(cookie) && /SameSite=Strict/.test(cookie));
  r = await owner.get("/api/me");
  check("owner flag", r.data.username === OWNER.name && r.data.isOwner === true);
  r = await owner.get("/app/");
  check("/app/ served when signed in", r.status === 200 || r.status === 307);
  const flood = new Client("10.0.9.9");
  let last;
  for (let i = 0; i < 12; i++) last = await flood.post("/api/login", { username: "x", password: "y" });
  check("login rate limit", last.status === 429);

  section("Invites and sign up");
  r = await anon.post("/api/signup", { username: "bob", email: "bob@example.com", password: "hunter2hunter2", confirm: "hunter2hunter2" });
  check("sign up needs an invite", r.status === 403);
  r = await owner.post("/api/invites");
  check("owner makes an invite", r.status === 200 && /invite=/.test(r.data.link));
  const invite1 = r.data.link.split("invite=")[1];
  r = await owner.post("/api/invites");
  check("owner has no invite limit", r.status === 200);
  const signup = (c, name, email, invite) => c.post("/api/signup", { username: name, email, password: "hunter2hunter2", confirm: "hunter2hunter2", invite });
  r = await signup(anon, "bob", "not-an-email", invite1);
  check("email is validated", r.status === 400);
  r = await signup(anon, "bob", "bob@example.com", invite1);
  check("sign up step 1", r.status === 200 && !!r.data.applyToken);
  const applyToken = r.data.applyToken;
  r = await signup(anon, "carl", "carl@example.com", invite1);
  check("invite works once", r.status === 403);
  r = await bob.post("/api/login", { username: "bob", password: "hunter2hunter2" });
  check("pending account can continue", r.status === 403 && !!r.data.applyToken);
  r = await anon.post("/api/signup/vouch", { applyToken, inviter: "nobody" });
  check("wrong inviter refused", r.status === 400);
  r = await bob.post("/api/signup/vouch", { applyToken, inviter: OWNER.name.toLowerCase() });
  check("right inviter lets them in", r.status === 200);
  r = await bob.get("/api/me");
  check("new member is signed in", r.data.username === "bob" && r.data.isOwner === false);
  check("welcome email sent", !!(await waitForMail(/Your account "bob" is ready/)));

  section("Member invite limit");
  r = await bob.post("/api/invites");
  check("member makes an invite", r.status === 200);
  const bobInvite = r.data;
  r = await bob.post("/api/invites");
  check("member limited to one open invite", r.status === 429);
  r = await bob.post("/api/invites/revoke", { id: bobInvite.id });
  check("invite can be closed", r.status === 200);
  r = await bob.get("/api/invites");
  check("closed invite is gone", r.data.invites.length === 0);
  r = await bob.post("/api/invites");
  check("new invite allowed after closing", r.status === 200);
  const tryOwnerInvite = (await owner.get("/api/invites")).data.invites[0];
  await bob.post("/api/invites/revoke", { id: tryOwnerInvite.id });
  check("cannot close someone else's invite", (await owner.get("/api/invites")).data.invites.some((i) => i.id === tryOwnerInvite.id));

  section("Owner tools");
  r = await bob.get("/api/admin/users");
  check("members cannot use owner tools", r.status === 403);
  r = await owner.get("/api/admin/users");
  const bobRow = (r.data.users || []).find((u) => u.username === "bob");
  check("owner sees every account", r.status === 200 && !!bobRow && bobRow.invited_by === OWNER.name && bobRow.email === "bob@example.com");
  r = await owner.post("/api/admin/users", { id: (r.data.users.find((u) => u.owner) || {}).id, action: "delete" });
  check("owner account is protected", r.status === 400);
  // a throwaway member the owner removes
  const carl = new Client("10.0.0.4");
  const inv = (await owner.post("/api/invites")).data.link.split("invite=")[1];
  const carlSignup = await signup(carl, "carl", "carl@example.com", inv);
  await carl.post("/api/signup/vouch", { applyToken: carlSignup.data.applyToken, inviter: OWNER.name });
  const carlId = (await owner.get("/api/admin/users")).data.users.find((u) => u.username === "carl").id;
  r = await owner.post("/api/admin/users", { id: carlId, action: "delete" });
  check("owner removes an account", r.status === 200);
  r = await new Client("10.0.0.5").post("/api/login", { username: "carl", password: "hunter2hunter2" });
  check("removed account cannot sign in", r.status === 401);

  section("Email and recovery");
  r = await bob.post("/api/account/email", { email: "new@example.com", password: "bad-password" });
  check("email change needs the password", r.status === 403);
  r = await bob.post("/api/account/email", { email: "new@example.com", password: "hunter2hunter2" });
  check("email changed", r.status === 200 && r.data.email === "new@example.com");
  check("email-change notices sent", !!(await waitForMail(/was changed to new@example\.com/)) && !!(await waitForMail(/is now the contact email/)));
  r = await anon.post("/api/recover", { who: "nobody-here" });
  const generic = r.data.message;
  r = await anon.post("/api/recover", { who: "bob" });
  check("recovery answer never reveals accounts", r.status === 200 && r.data.message === generic);
  const reset = await waitForMail(/reset\.html\?t=/);
  check("recovery email sent", !!reset);
  const resetToken = reset.text.match(/reset\.html\?t=([A-Za-z0-9_-]+)/)[1];
  r = await anon.post("/api/reset", { token: resetToken, password: "short", confirm: "short" });
  check("reset checks the new password", r.status === 400);
  r = await anon.post("/api/reset", { token: resetToken, password: "newpassword99", confirm: "newpassword99" });
  check("password reset", r.status === 200);
  r = await anon.post("/api/reset", { token: resetToken, password: "another12345", confirm: "another12345" });
  check("reset link works once", r.status === 404);
  r = await bob.get("/api/me");
  check("reset signs out other devices", r.status === 401);
  r = await bob.post("/api/login", { username: "bob", password: "newpassword99" });
  check("sign in with the new password", r.status === 200);

  section("Saved API keys");
  r = await bob.get("/api/account/key");
  check("nothing saved yet", r.data.available === true && r.data.saved === false);
  r = await bob.post("/api/account/key", { torn: "short!" });
  check("bad key refused", r.status === 400);
  r = await bob.post("/api/account/key", { torn: KEY, ff: "", ts: "TS_goodkey12345" });
  check("key saved", r.status === 200 && r.data.saved === true);
  r = await bob.get("/api/account/key");
  check("key reads back", r.data.saved && r.data.keys.torn === KEY && r.data.keys.ts === "TS_goodkey12345");
  r = await bob.post("/api/account/key", { clear: true });
  r = await bob.get("/api/account/key");
  check("key cleared", r.data.saved === false);

  section("Data sources");
  const K = { "X-Torn-Key": KEY };
  r = await anon.get("/api/weav3r?item=1");
  check("data sources need sign-in", r.status === 401);
  r = await bob.get("/api/weav3r?item=all");
  check("item index drops bundles", r.data.items && r.data.items.length === 2 && r.data.items[0].lowest === 19000000 && r.data.items[1].bazaars === 50);
  r = await bob.get("/api/weav3r?item=1");
  check("bazaar listings trimmed", r.data.listings.length === 2 && r.data.listings[0].uid === undefined && r.data.extra === undefined);
  check("listings carry their last-changed time", r.data.listings[0].updated > 0 && r.data.generated_at - r.data.listings[0].updated <= 120);
  r = await bob.get("/api/weav3r?item=abc");
  check("bad item id refused", r.status === 400);
  r = await bob.get("/api/torn/user?id=7", { headers: K });
  check("Torn profile trimmed", r.data.name === "A" && r.data.secret === undefined && r.data.last_action.timestamp === 5 && r.data.status.state === "Okay");
  r = await bob.get("/api/torn/user?id=7", { headers: { "X-Torn-Key": "BADKEY1234567890" } });
  check("Torn key error passed on", r.data.code === 2);
  r = await bob.get("/api/torn/me", { headers: K });
  check("own battle stats", r.data.total === 10);
  r = await bob.get("/api/tornstats/spy?id=2", { headers: { "X-TS-Key": "TS_goodkey12345" } });
  check("TornStats spy found", r.data.found === true && r.data.total === 1e10);
  r = await bob.get("/api/tornstats/spy?id=3", { headers: { "X-TS-Key": "TS_goodkey12345" } });
  check("TornStats no spy", r.data.found === false);
  r = await bob.get("/api/tornstats/spy?id=2", { headers: { "X-TS-Key": "BADKEY123456" } });
  check("TornStats key error", /key/i.test(r.data.error || ""));
  r = await bob.get("/api/tornstats/spy?id=2", { headers: { "X-TS-Key": "no!" } });
  check("TornStats key format checked", r.status === 400);
  r = await bob.post("/api/ffscouter", { targets: [1, 2, 3] }, { headers: { "X-FF-Key": KEY } });
  check("FF Scouter estimates", Array.isArray(r.data) && r.data.length === 3 && r.data[0].bs_estimate === 2e9);
  r = await bob.post("/api/ffscouter", { targets: ["x"] }, { headers: { "X-FF-Key": KEY } });
  check("FF targets validated", r.status === 400);
  r = await bob.get("/api/ffscouter/check", { headers: { "X-FF-Key": "REGISTEREDKEY123" } });
  check("FF key check (registered)", r.data.registered === true);
  r = await bob.get("/api/ffscouter/check", { headers: { "X-FF-Key": KEY } });
  check("FF key check (not registered)", r.data.registered === false);
  r = await bob.post("/api/ffscouter/register", {}, { headers: { "X-FF-Key": KEY } });
  check("FF register needs consent", r.status === 400);
  r = await bob.post("/api/ffscouter/register", { agree: true }, { headers: { "X-FF-Key": KEY } });
  check("FF register with consent", r.data.ok === true);

  section("Leaderboard");
  r = await bob.post("/api/clicks", { target: "x" });
  check("bad click refused", r.status === 400);
  r = await bob.post("/api/leaderboard/sync", {}, { headers: K });
  check("link before any click", r.data.linked === "Mugsy" && r.data.counted === 0);
  await bob.post("/api/clicks", { target: 111 });
  await new Promise((s) => setTimeout(s, 1100));
  r = await bob.post("/api/leaderboard/sync", {}, { headers: K });
  check("only the clicked mug counts", r.data.counted === 1 && r.data.checked === 1, JSON.stringify(r.data));
  r = await bob.post("/api/leaderboard/sync", {}, { headers: K });
  check("nothing counts twice", r.data.counted === 0);
  await bob.post("/api/clicks", { target: 111 });
  await new Promise((s) => setTimeout(s, 1100));
  r = await bob.post("/api/leaderboard/sync", {}, { headers: K });
  check("same attack is never re-counted", r.data.counted === 0);
  r = await bob.get("/api/leaderboard?range=all");
  check("board shows the total", r.data.rows.length === 1 && r.data.rows[0].username === "bob" && r.data.rows[0].total === 2500000 && r.data.rows[0].mugs === 1, JSON.stringify(r.data));
  r = await bob.get("/api/leaderboard?range=day");
  check("24 hour board", r.data.rows.length === 1);
  r = await anon.get("/api/leaderboard");
  check("board needs sign-in", r.status === 401);
  // a second member cannot claim the same Torn player
  const dana = new Client("10.0.0.6");
  const dInv = (await owner.post("/api/invites")).data.link.split("invite=")[1];
  const dSignup = await signup(dana, "dana", "dana@example.com", dInv);
  await dana.post("/api/signup/vouch", { applyToken: dSignup.data.applyToken, inviter: OWNER.name });
  r = await dana.post("/api/leaderboard/sync", {}, { headers: { "X-Torn-Key": "DANAKEY12345678" } });
  check("one Torn player per member", r.status === 409);

  section("Bazaar read limit");
  // 330 quick reads against a limit of 300 a minute: some must be refused, with a short retry hint.
  const results = [];
  for (let i = 0; i < 330; i += 30) {
    results.push(...(await Promise.all(Array.from({ length: 30 }, () => bob.get("/api/weav3r?item=1")))));
  }
  const refused = results.filter((x) => x.status === 429);
  const allowed = results.length - refused.length;
  check("reads over the limit are refused", refused.length >= 20, `${refused.length} refused`);
  check("most reads are allowed (limit is generous)", allowed >= 280, `${allowed} allowed`);
  check("retry hint is short", refused.length > 0 && refused.every((x) => x.data.retryAfter <= 5 && Number(x.res.headers.get("retry-after")) <= 5));
}


// ------------------------------------------------------------------ main

try {
  await startEnvironment();
  await runChecks();
} catch (err) {
  fail(err);
}
finish();
