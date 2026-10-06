// Backend test run: every Worker feature end to end, against fake Torn / Weav3r / FF Scouter.
//
//   node tests/run.mjs                      (Node 20+; fetches wrangler with npx unless WRANGLER is set)
//   WRANGLER="/path/to/wrangler" node tests/run.mjs
//
// Nothing here touches your real Cloudflare account, database or email.

import { BASE, Client, OWNER, check, fail, finish, section, setFakeFlag, startEnvironment, waitForMail } from "./lib/harness.mjs";

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

  section("Saved API key");
  const tablet = new Client("10.0.0.8");
  await tablet.post("/api/login", { username: "bob", password: "newpassword99" }); // signed in before anything is saved
  r = await bob.get("/api/account/key");
  check("nothing saved yet", r.data.saved === false);
  r = await bob.post("/api/account/key", { torn: "short!", password: "newpassword99" });
  check("bad key refused", r.status === 400);
  r = await bob.post("/api/account/key", { torn: KEY, ff: "" });
  check("password is required", r.status === 400);
  r = await bob.post("/api/account/key", { torn: KEY, ff: "", password: "wrong-password" });
  check("wrong password refused", r.status === 403);
  r = await bob.post("/api/account/key", { torn: KEY, ff: "", password: "newpassword99" });
  check("key saved", r.status === 200 && r.data.saved === true);
  r = await bob.get("/api/account/key");
  check("key reads back", r.data.saved && r.data.keys.torn === KEY);
  const phone = new Client("10.0.0.7");
  await phone.post("/api/login", { username: "bob", password: "newpassword99" });
  r = await phone.get("/api/account/key");
  check("key follows the member to another device", r.data.saved && r.data.keys.torn === KEY);
  r = await tablet.get("/api/account/key");
  check("a session from before saving is locked until it signs in again", r.data.saved === true && r.data.locked === true && !r.data.keys);
  await tablet.post("/api/login", { username: "bob", password: "newpassword99" });
  r = await tablet.get("/api/account/key");
  check("signing in again unlocks it", r.data.saved && r.data.keys.torn === KEY);
  // a password reset cannot unlock the old key, so it is cleared
  const before = Date.now();
  await anon.post("/api/recover", { who: "bob" });
  const reset2 = await waitForMail(/reset\.html\?t=/, 5000, before);
  const resetToken2 = reset2.text.match(/reset\.html\?t=([A-Za-z0-9_-]+)/)[1];
  r = await anon.post("/api/reset", { token: resetToken2, password: "thirdpassword77", confirm: "thirdpassword77" });
  check("password reset works", r.status === 200);
  r = await bob.post("/api/login", { username: "bob", password: "thirdpassword77" });
  r = await bob.get("/api/account/key");
  check("a password reset clears the saved key", r.data.saved === false);
  await bob.post("/api/account/key", { torn: KEY, ff: "", password: "thirdpassword77" });
  await bob.post("/api/account/key", { clear: true });
  r = await bob.get("/api/account/key");
  check("key can be removed", r.data.saved === false);

  section("Data sources");
  const K = { "X-Torn-Key": KEY };
  r = await anon.get("/api/weav3r?item=1");
  check("data sources need sign-in", r.status === 401);
  r = await bob.get("/api/weav3r?item=all");
  check("item index drops bundles", r.data.items && r.data.items.length === 3 && r.data.items[0].lowest === 19500000 && r.data.items[1].bazaars === 50);
  r = await bob.get("/api/weav3r?item=1");
  check("bazaar listings trimmed", r.data.listings.length === 6 && r.data.listings[0].content_updated === undefined && r.data.extra === undefined);
  check("listings carry their last-changed time", r.data.listings[0].updated > 0 && r.data.generated_at - r.data.listings[0].updated <= 120);
  await setFakeFlag("weav3rBusy", true);
  r = await bob.get("/api/weav3r?item=all");
  check("a busy Weav3r becomes a short wait, not an error", r.status === 429 && r.data.retryAfter >= 3 && r.data.retryAfter <= 15, JSON.stringify(r.data));
  await setFakeFlag("weav3rBusy", false);
  await setFakeFlag("deep", true);
  r = await bob.get("/api/weav3r?item=5&page=3");
  check("weav3r pages come through with the total", r.data.page === 3 && r.data.total === 250 && r.data.listings.length === 50 && r.data.listings[0].player_name === "PageThree", JSON.stringify(r.data).slice(0, 200));
  r = await bob.get("/api/weav3r?item=5&page=0");
  check("bad page refused", r.status === 400);
  await setFakeFlag("deep", false);
  r = await bob.get("/api/weav3r?item=abc");
  check("bad item id refused", r.status === 400);
  r = await bob.get("/api/torn/company-types", { headers: K });
  check("company types listed (and Torn is not sent a parameter it does not list)", r.data.types && r.data.types.length === 2 && r.data.types[0].name === "Mining Corporation", JSON.stringify(r.data));
  r = await bob.get("/api/torn/companies?type=12", { headers: K });
  check("companies listed with stars", r.data.companies.length === 2 && r.data.companies[0].stars === 10 && r.data.companies[0].typeName === "Mining Corporation" && r.data.total === 2, JSON.stringify(r.data));
  r = await bob.get("/api/torn/employees?id=501", { headers: K });
  check("employees listed with status and last action", r.data.employees.length === 3 && r.data.employees[2].state === "Hospital" && r.data.employees[0].last > 1e9 && r.data.employees[0].days === 100, JSON.stringify(r.data));
  r = await bob.get("/api/torn/employees?id=abc", { headers: K });
  check("bad company id refused", r.status === 400);
  r = await bob.get("/api/torn/companies?type=12");
  check("company calls need a Torn key", r.status === 400);
  r = await bob.get("/api/weav3r/ranked?tab=weapons");
  check("ranked weapons: bazaar listings with sellers only, trimmed", r.data.listings.length === 3 && r.data.read === 4 && r.data.listings[0].sellerId === 51 && r.data.listings[0].bonuses[0].name === "Bloodlust" && r.data.listings[1].rarity === "orange" && r.data.listings[0].damage === 40.5, JSON.stringify(r.data).slice(0, 300));
  r = await bob.get("/api/weav3r/ranked?tab=weapons&weaponType=melee&rarity=red");
  check("ranked weapons: filters reach Weav3r", r.data.listings.length === 1 && r.data.listings[0].name === "Fake Katana");
  r = await bob.get("/api/weav3r/ranked?bonus1=Parry");
  check("ranked weapons: a bonus filter and the default tab work", r.data.listings.length === 1 && r.data.listings[0].sellerName === "Strong");
  r = await bob.get("/api/weav3r/ranked?rarity=purple");
  check("ranked weapons: odd filter values refused", r.status === 400);
  r = await anon.get("/api/weav3r/ranked?tab=weapons");
  check("ranked weapons need sign-in", r.status === 401);
  r = await bob.get("/api/torn/key", { headers: K });
  check("key check lists what the key can use", r.data.type === "Limited Access" && r.data.selections.user.includes("attacks") && r.data.selections.company.includes("employees") && r.data.selections.torn.includes("attacklog"), JSON.stringify(r.data));
  r = await bob.get("/api/torn/networth?id=21", { headers: K });
  check("net worth of a player", r.data.networth === 2100000000, JSON.stringify(r.data));
  r = await bob.get("/api/torn/player?id=21", { headers: K });
  check("one call gives status, age, last action and net worth", r.data.age === 100 && r.data.status.state === "Okay" && r.data.last_action.timestamp === 5 && r.data.networth === 2100000000 && r.data.secret === undefined, JSON.stringify(r.data));
  r = await bob.get("/api/torn/stats?id=23&ago=0", { headers: K });
  const s0 = r.data;
  r = await bob.get("/api/torn/stats?id=23&ago=7", { headers: K });
  check("stats history: defends lost and net worth on two days", s0.defendslost === 50 && r.data.defendslost === 45 && s0.networth === 2300000000 && r.data.networth === 2900000000, JSON.stringify([s0, r.data]));
  r = await bob.get("/api/torn/stats?id=23&ago=99", { headers: K });
  check("stats history refuses a silly number of days", r.status === 400);
  r = await bob.get("/api/torn/player?id=abc", { headers: K });
  check("bad player id refused for the combined call", r.status === 400);
  r = await bob.get("/api/torn/networth?id=abc", { headers: K });
  check("bad player id refused for net worth", r.status === 400);
  r = await bob.get("/api/torn/user?id=7", { headers: K });
  check("Torn profile trimmed", r.data.name === "A" && r.data.secret === undefined && r.data.last_action.timestamp === 5 && r.data.status.state === "Okay");
  r = await bob.get("/api/torn/user?id=7", { headers: { "X-Torn-Key": "BADKEY1234567890" } });
  check("Torn key error passed on", r.data.code === 2);
  r = await bob.get("/api/torn/me", { headers: K });
  check("own battle stats", r.data.total === 10);
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
  const sync = () => bob.post("/api/leaderboard/sync", {}, { headers: K });
  const tap = async (id) => { await bob.post("/api/clicks", { target: id }); await new Promise((s) => setTimeout(s, 1100)); };
  r = await sync();
  check("link before any tap", r.data.linked === "Mugsy" && r.data.counted === 0 && r.data.taps === 0);
  check("explains when there are no taps", /No Attack taps/.test(r.data.note), r.data.note);

  await tap(111);
  await setFakeFlag("attacklogFail", true);
  r = await sync();
  check("a Torn hiccup is reported", r.status >= 400, JSON.stringify(r.data));
  await setFakeFlag("attacklogFail", false);
  r = await sync();
  check("the mug is still counted next time (the tap was not used up)", r.data.counted === 1 && r.data.checked === 1, JSON.stringify(r.data));
  check("only the tapped player's mug counts", r.data.mugs >= 2 && r.data.matched === 1, JSON.stringify(r.data));
  r = await sync();
  check("nothing counts twice", r.data.counted === 0);
  await tap(111);
  r = await sync();
  check("same attack is never re-counted", r.data.counted === 0);
  r = await bob.get("/api/leaderboard?range=all");
  check("board shows the total", r.data.rows.length === 1 && r.data.rows[0].username === "bob" && r.data.rows[0].total === 2500000 && r.data.rows[0].mugs === 1, JSON.stringify(r.data));

  await tap(112);
  r = await sync();
  check("a stealthed attack still counts", r.data.counted === 1, JSON.stringify(r.data));
  await tap(888);
  r = await sync();
  check("explains when mugs were not on tapped players", r.data.counted === 0 && r.data.taps >= 1 && /none on a player you opened/.test(r.data.note), r.data.note);
  r = await bob.get("/api/leaderboard?range=all");
  check("board adds the second mug", r.data.rows[0].total === 5000000 && r.data.rows[0].mugs === 2, JSON.stringify(r.data));
  r = await bob.get("/api/leaderboard?range=day");
  check("24 hour board", r.data.rows.length === 1);
  // a tap carries what the page predicted; the check keeps it next to what was really mugged
  const nowSec = Math.floor(Date.now() / 1000);
  r = await bob.post("/api/clicks", { target: 999, at: nowSec - 2, pred: { src: "earners", mug: 2000000, cash: 40000000, networth: 2500000000, score: 80, recent: 1, hosp: true } });
  check("a tap with a prediction is accepted", r.status === 200);
  // the phone sends its own list of taps with the check, so a lost quick request does not matter
  r = await bob.post("/api/leaderboard/sync", { taps: [{ target: 999, at: Math.floor(Date.now() / 1000) - 2 }, { target: "bad", at: 1 }] }, { headers: K });
  check("taps sent with the check are used", r.data.counted === 1 && r.data.taps >= 1, JSON.stringify(r.data));
  r = await bob.post("/api/leaderboard/sync", { taps: [{ target: 999, at: Math.floor(Date.now() / 1000) - 2 }] }, { headers: K });
  check("the same tap sent twice is one tap", r.data.counted === 0, JSON.stringify(r.data));
  r = await bob.post("/api/leaderboard/sync", { taps: [{ target: 777, at: nowSec - 4 * 3600 }] }, { headers: K });
  check("an old tap with no attack seen is closed", r.status === 200, JSON.stringify(r.data));
  r = await bob.get("/api/mug/outcomes");
  const o999 = r.data.rows.find((x) => x.target_id === 999), o777 = r.data.rows.find((x) => x.target_id === 777);
  check("outcome keeps the prediction next to what was mugged", o999 && o999.matched === 1 && o999.result === "Mugged" && o999.predicted === 2000000 && o999.actual === 2500000 && o999.src === "earners" && o999.score === 80 && o999.hosp === 1 && o999.recent_mugs === 1, JSON.stringify(o999));
  check("a tap that never became an attack is closed with that result", o777 && o777.matched === 2 && o777.result === "No attack seen" && o777.actual === 0, JSON.stringify(o777));
  check("outcomes say how close predictions are", r.data.summary.compared >= 1 && Math.abs(r.data.summary.median - 1.25) < 0.01, JSON.stringify(r.data.summary));
  r = await bob.get("/api/mug/outcomes?src=earners");
  check("outcome summary can be limited to one finder", r.data.summary.compared >= 1, JSON.stringify(r.data.summary));
  r = await bob.get("/api/mug/outcomes?src=bazaar");
  check("a finder with no matched mugs has nothing to compare", r.data.summary.compared === 0 && r.data.summary.median === null, JSON.stringify(r.data.summary));
  r = await bob.get("/api/targets/recent?ids=999,111,5");
  check("recent mugs of players: counts and money in 24h", r.data.recent[999] && r.data.recent[999].n24 >= 1 && r.data.recent[999].n7 >= 1 && r.data.recent[999].sum24 === 2500000 && r.data.recent[5] === undefined, JSON.stringify(r.data));
  r = await bob.get("/api/targets/recent?ids=abc");
  check("bad ids refused for recent mugs", r.status === 400);
  r = await anon.get("/api/mug/outcomes");
  check("outcomes need sign-in", r.status === 401);
  r = await bob.get("/api/me");
  check("me carries a build id for update notices", typeof r.data.build === "string");
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
