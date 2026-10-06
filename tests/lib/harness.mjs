// Test harness shared by tests/run.mjs (backend) and tests/ui.mjs (browser).
// Starts fake Torn / Weav3r / FF Scouter servers and a local copy of the Worker with a
// local database. Nothing here touches your real Cloudflare account, database or email.

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TMP = path.join(ROOT, ".test-tmp");
const PORT = 8799;
const FAKE_PORT = 8801;
export const BASE = `http://localhost:${PORT}`;
const WRANGLER = process.env.WRANGLER ? process.env.WRANGLER.split(" ") : ["npx", "--yes", "wrangler"];
export const OWNER = { name: "TheFedsAreStalkingMe", pass: "ownerpass123" };

// ------------------------------------------------------------------ tiny test framework

let passed = 0;
const failures = [];
export function check(name, ok, detail = "") {
  if (ok) passed++;
  else { failures.push(`${name} ${detail}`); console.log(`  FAIL ${name} ${detail}`); }
}
export const section = (title) => console.log(`\n${title}`);

// ------------------------------------------------------------------ fake outside services

const now = () => Math.floor(Date.now() / 1000);
// Test control: statuses the fake Torn reports, by player id. Change them with setFakeStatus().
const statusOverride = {};
const flags = { attacklogFail: false, weav3rBusy: false, deep: false, typesFail: false, manyCompanies: false, keyLimited: false, combinedFail: false, attacksDenied: false };
export async function setFakeFlag(name, on) {
  await fetch(`http://localhost:${FAKE_PORT}/__flag?name=${name}&on=${on ? 1 : 0}`);
}
export async function setFakeStatus(id, state, mins = 30) {
  await fetch(`http://localhost:${FAKE_PORT}/__status?id=${id}&state=${state}&mins=${mins}`);
}
const TORN_IDS = { abcdefgh12345678: 555, DANAKEY12345678: 555, OTHERKEY1234567: 556 }; // DANA shares 555 on purpose

function fakeServer() {
  return http.createServer((req, res) => {
    const u = new URL(req.url, `http://localhost:${FAKE_PORT}`);
    const send = (obj, status = 200) => { res.statusCode = status; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(obj)); };
    const p = u.pathname;
    const key = u.searchParams.get("key") || "";

    // Weav3r: three items.
    //   Gold Bar $20m, busy (5 listings changed a minute ago): Alpha has five stacks of 2 at $19.5m, Bravo one at $20.5m.
    //   Silver Bar $20m, quiet: Charlie one at $20m, Alpha one at $20m.
    //   Emerald $8m: Delta a stack of 5 ($40m), Echo a single, Foxtrot a stack of 2 ($16m).
    if (p === "/weav3r/marketplace" && flags.weav3rBusy) { res.setHeader("Retry-After", "2"); return send({ error: "slow down" }, 429); }
    // Deep bazaar lists (only while the "deep" flag is on): item 5 "Big Item" $30m has 250 listings over 3 pages.
    //   page 1 PageOne $29.5m (100), page 2 PageTwo $30.5m (100), page 3 PageThree $31m (49) and Far $45m (1, above the price band)
    if (p === "/weav3r/marketplace/5") {
      const page = Number(u.searchParams.get("page") || 1);
      const mk = (n, id, name, price) => Array.from({ length: n }, () => ({ player_id: id, player_name: name, quantity: 1, price, uid: "x", content_updated: now() - 86400 }));
      const pages = { 1: mk(100, 61, "PageOne", 29500000), 2: mk(100, 62, "PageTwo", 30500000), 3: [...mk(49, 63, "PageThree", 31000000), ...mk(1, 64, "Far", 45000000)] };
      return send({ item_id: 5, item_name: "Big Item", market_price: 30000000, generated_at: now(), page, total_count: 250, has_more: page < 3, listings: pages[page] || [] });
    }
    // Weav3r ranked weapons (Bonus Weapon Sellers). Bazaar: Weak (51) Bloodlust 40 yellow $30m, Strong (52) Parry 25 orange $80m
    // (strong), Boss (53) Expose 12 red $300m. One item market listing (anonymous) and a Plunder bazaar listing for page 2.
    if (p === "/weav3r/ranked-weapons") {
      const q = u.searchParams;
      if (![...q.keys()].some((k) => k !== "limit")) return send({ error: "Missing filter parameters" }, 400);
      if (flags.deep && q.get("rarity") === "yellow") { // 350 yellow weapons, one bazaar listing per page: Seller 1..4
        const page = Number(q.get("page") || 1);
        const one = { uid: `80${page}`, itemId: 30, itemName: "Deep Gun", weaponType: "Primary", rarity: "yellow", damage: "40", accuracy: "40", quality: "40", bonuses: { 0: { bonus: "Plunder", value: 30, description: "30% Plunder" } }, price: page * 10000000, playerId: 70 + page, playerName: `Seller ${page}`, quantity: 1, lastUpdated: "2026-10-05T20:00:00Z", source: "bazaar" };
        return send({ total_count: 350, weapons: page <= 4 ? [one] : [], response_time_ms: 1 });
      }
      const b = (name, value) => ({ 0: { bonus: name, value, description: `${value}% ${name}` } });
      const all = [
        { uid: "7001", itemId: 20, itemName: "Fake Magnum", weaponType: "Secondary", rarity: "yellow", damage: "40.5", accuracy: "50.1", quality: "60.2", bonuses: b("Bloodlust", 40), price: 30000000, playerId: 51, playerName: "Weak", quantity: 1, marketPrice: 1000, lastUpdated: "2026-10-05T20:00:00Z", source: "bazaar" },
        { uid: "7002", itemId: 21, itemName: "Fake Rifle", weaponType: "Primary", rarity: "Orange", damage: "55", accuracy: "45", quality: "70", bonuses: b("Parry", 25), price: 80000000, playerId: 52, playerName: "Strong", quantity: 1, marketPrice: 1000, lastUpdated: "2026-10-05T20:00:00Z", source: "bazaar" },
        { uid: "7003", itemId: 22, itemName: "Fake Katana", weaponType: "Melee", rarity: "red", damage: "60", accuracy: "50", quality: "80", bonuses: b("Expose", 12), price: 300000000, playerId: 53, playerName: "Boss", quantity: 1, marketPrice: 1000, lastUpdated: "2026-10-05T20:00:00Z", source: "bazaar" },
        { uid: "7004", itemId: 23, itemName: "Fake Anon", weaponType: "Primary", rarity: "red", damage: "60", accuracy: "50", quality: "80", bonuses: b("Plunder", 49), price: 90000000, playerId: null, playerName: null, quantity: 1, marketPrice: 90000000, lastUpdated: "2026-10-05T20:00:00Z", source: "market" },
      ];
      const type = q.get("weaponType"), rar = q.get("rarity"), bonus = q.get("bonus1"), maxPrice = Number(q.get("maxPrice") || Infinity), minPrice = Number(q.get("minPrice") || 0);
      const hit = all.filter((w) => (!type || w.weaponType.toLowerCase() === type) && (!rar || w.rarity.toLowerCase() === rar) && (!bonus || w.bonuses[0].bonus === bonus) && w.price <= maxPrice && w.price >= minPrice);
      const limit = Number(q.get("limit") || 20), page = Number(q.get("page") || 1);
      return send({ total_count: hit.length, weapons: q.get("tab") === "armor" ? [] : hit.slice((page - 1) * limit, page * limit), response_time_ms: 1 });
    }

    if (p === "/weav3r/marketplace") return send({ items: [
      ...(flags.deep ? [{ item_id: 5, item_name: "Big Item", market_price: 30000000, lowest_price: 29500000, bazaar_average: 30000000, total_bazaars: 100 }] : []),
      { item_id: 1, item_name: "Gold Bar", market_price: 20000000, lowest_price: 19500000, bazaar_average: 20000000, total_bazaars: 5 },
      { item_id: 2, item_name: "Silver Bar", market_price: 20000000, lowest_price: 20000000, bazaar_average: 20000000, total_bazaars: 50 },
      { item_id: 3, item_name: "Emerald", market_price: 8000000, lowest_price: 8000000, bazaar_average: 8000000, total_bazaars: 20 },
      { item_id: -1, item_name: "Bundle", market_price: 5, lowest_price: null, total_bazaars: 0 },
    ] });
    const old = () => now() - 2 * 86400;
    if (p === "/weav3r/marketplace/1") return send({ item_id: 1, item_name: "Gold Bar", market_price: 20000000, generated_at: now(), extra: "dropped",
      listings: [
        ...Array.from({ length: 5 }, () => ({ player_id: 7, player_name: "Alpha", quantity: 2, price: 19500000, uid: "x", content_updated: now() - 60 })),
        { player_id: 8, player_name: "Bravo", quantity: 1, price: 20500000, uid: "y", content_updated: old() },
      ] });
    if (p === "/weav3r/marketplace/2") return send({ item_id: 2, item_name: "Silver Bar", market_price: 20000000, generated_at: now(),
      listings: [
        { player_id: 9, player_name: "Charlie", quantity: 1, price: 20000000, content_updated: old() },
        { player_id: 7, player_name: "Alpha", quantity: 1, price: 20000000, content_updated: old() },
      ] });
    if (p === "/weav3r/marketplace/3") return send({ item_id: 3, item_name: "Emerald", market_price: 8000000, generated_at: now(),
      listings: [
        { player_id: 10, player_name: "Delta", quantity: 5, price: 8000000, content_updated: old() },
        { player_id: 11, player_name: "Echo", quantity: 1, price: 8000000, content_updated: old() },
        { player_id: 12, player_name: "Foxtrot", quantity: 2, price: 8000000, content_updated: old() },
      ] });

    // Test control: /__flag?name=attacklogFail&on=1 makes Torn's attack log fail
    if (p === "/__flag") { flags[u.searchParams.get("name")] = u.searchParams.get("on") === "1"; return send({ ok: true }); }
    // Test control: /__status?id=7&state=Hospital&mins=30 (state=Okay clears it)
    if (p === "/__status") {
      const id = u.searchParams.get("id"), st = u.searchParams.get("state");
      if (st === "Okay") delete statusOverride[id];
      else statusOverride[id] = { state: st, until: now() + Number(u.searchParams.get("mins")) * 60 };
      return send({ ok: true });
    }

    // Torn v1 (status, own stats)
    if (p.startsWith("/tornv1/user")) {
      if (key === "BADKEY1234567890") return send({ error: { code: 2, error: "Incorrect key" } });
      if (u.searchParams.get("selections") === "battlestats") return send({ strength: 1, defense: 2, speed: 3, dexterity: 4, total: 10 });
      const id = p.split("/").pop();
      const o = statusOverride[id];
      const status = o ? { state: o.state, until: o.state === "Abroad" ? 0 : o.until, description: o.state } : { state: "Okay", until: 0, description: "Okay" };
      return send({ player_id: Number(id) || 7, name: "A", age: 100, secret: "dropped", last_action: { timestamp: 5, status: "Offline", relative: "x" }, status });
    }

    // Torn v2: profile and personal stats combined in one call
    if (p === "/v2/user" && u.searchParams.get("selections") === "profile,personalstats") {
      if (flags.combinedFail) return send({ error: { code: 16, error: "Access level of this key is not high enough" } });
      const id = u.searchParams.get("id");
      const o = statusOverride[id];
      const status = o ? { state: o.state, until: o.state === "Abroad" ? 0 : o.until, description: o.state } : { state: "Okay", until: 0, description: "Okay" };
      return send({ profile: { id: Number(id), name: "A", age: 100, last_action: { timestamp: 5, status: "Offline", relative: "x" }, status }, personalstats: { networth: { total: Number(id) * 100000000 } } });
    }

    // Torn v2 (leaderboard)
    if (p === "/v2/user/basic") return send({ profile: { id: TORN_IDS[key] || 999, name: key.startsWith("DANA") ? "Dana" : "Mugsy" } });
    if (p === "/v2/user/attacks" && flags.attacksDenied) return send({ error: { code: 16, error: "Access level of this key is not high enough" } });
    if (p === "/v2/user/attacks") {
      const t = now() + 5; // after the test's click
      return send({ attacks: [
        { id: 5, code: "EEE", started: t, result: "Mugged", attacker: { id: 555 }, defender: { id: 23 } }, // Rex, never tapped by the test: counts as a recent mug of him
        { id: 1, code: "AAA", started: t, result: "Mugged", attacker: { id: 555 }, defender: { id: 111 } },
        { id: 2, code: "BBB", started: t, result: "Mugged", attacker: { id: 555 }, defender: { id: 999 } }, // never clicked
        { id: 3, code: "CCC", started: t, result: "Hospitalized", attacker: { id: 555 }, defender: { id: 111 } }, // not a mug
        { id: 4, code: "DDD", started: t, result: "Mugged", attacker: null, defender: { id: 112 } }, // stealthed: no attacker listed
      ] });
    }
    if (p === "/v2/torn/attacklog" && flags.attacklogFail) return send({ error: { code: 17, error: "Backend error" } });
    if (p === "/v2/torn/attacklog") return send({ attacklog: { log: [
      { action: "hit", text: "Mugsy hit Rich for 100" },
      { action: "mug", text: "Mugsy mugged Rich and stole $2,500,000" },
    ], summary: [] } });

    // Torn key info and net worth
    if (p === "/v2/key/info") {
      const all = { user: ["basic", "profile", "battlestats", "attacks", "personalstats"], company: ["companies", "employees", "profile"], torn: ["attacklog", "companies"], market: [], faction: [], property: [], racing: [], forum: [], key: ["info"] };
      if (flags.keyLimited) all.user = ["basic", "profile"], all.torn = [];
      return send({ info: { selections: all, user: { id: 555, faction_id: null, company_id: null }, access: { level: 3, type: flags.keyLimited ? "Custom" : "Limited Access", faction: false, company: false } } });
    }
    const nw = p.match(/^\/v2\/user\/(\d+)\/personalstats$/);
    if (nw) return send({ personalstats: { networth: { total: Number(nw[1]) * 100000000 } } });

    // Torn companies (inactive earners): types 12 Mining Corporation and 5 Flower Shop
    //   501 Deep Co (10 stars): Pia 10 days idle, Quin 2 days idle, Rex 30 days idle and in hospital
    //   502 Shallow Co (4 stars): Sam 20 days idle        601 Petals (5 stars, Flower Shop): Tess 15 days idle
    if (p === "/v2/torn/companies" && (flags.typesFail || u.searchParams.has("striptags"))) return send({ error: { code: flags.typesFail ? 16 : 23, error: flags.typesFail ? "Access level of this key is not high enough" : "Unknown parameter" } });
    if (p === "/v2/torn/companies") return send({ companies: [{ id: 12, name: "Mining Corporation", cost: 1, employees: 10 }, { id: 5, name: "Flower Shop", cost: 1, employees: 10 }] });
    let m;
    if ((m = p.match(/^\/v2\/company\/(\d+)\/companies$/))) {
      const co = (id, name, type, typeName, rating, hired) => ({ id, name, type: { id: type, name: typeName }, rating, employees: { hired, capacity: 10 }, income: { daily: 1000000 } });
      const many = flags.manyCompanies && m[1] === "12" ? Array.from({ length: 25 }, (_, i) => co(700 + i, `Mass ${i}`, 12, "Mining Corporation", 10, 1)) : [];
      const list = m[1] === "12" ? [...many, co(501, "Deep Co", 12, "Mining Corporation", 10, 3), co(502, "Shallow Co", 12, "Mining Corporation", 4, 1)] : [co(601, "Petals", 5, "Flower Shop", 5, 1)];
      return send({ companies: list, _metadata: { total: list.length, links: { next: null, prev: null } } });
    }
    if ((m = p.match(/^\/v2\/company\/(\d+)\/employees$/))) {
      const day = 86400;
      const emp = (id, name, days, idle, state = "Okay", until = null) => ({ id, name, position: { id: 1, name: "Miner" }, days_in_company: days, status: { description: state, details: null, state, color: "green", until }, last_action: { status: "Offline", timestamp: now() - idle * day, relative: "x" } });
      if (Number(m[1]) >= 700) return send({ employees: [emp(900 + Number(m[1]) - 700, `Mass Emp ${Number(m[1]) - 700}`, 100, 10 + (Number(m[1]) % 5))] });
      const by = { 501: [emp(21, "Pia", 100, 10), emp(22, "Quin", 100, 2), emp(23, "Rex", 100, 30, "Hospital", now() + 3600)], 502: [emp(24, "Sam", 100, 20)], 601: [emp(25, "Tess", 8, 15)] };
      return send({ employees: by[m[1]] || [] });
    }

    // FF Scouter
    if (p === "/ff/get-stats") return send(u.searchParams.get("targets").split(",").map((id) => ({ player_id: Number(id), fair_fight: 1.5, bs_estimate: Number(id) === 52 ? 9e9 : 2e9 })));
    if (p === "/ff/check-key") return send({ is_registered: key === "REGISTEREDKEY123", is_premium: false, last_used: null });
    if (p === "/ff/register") return send({ success: true, message: "API key successfully registered." });
    send({ error: "not found" }, 404);
  });
}

// ------------------------------------------------------------------ setup: config, database, Worker

function sh(args, opts = {}) {
  const r = spawnSync(args[0], args.slice(1), { cwd: ROOT, encoding: "utf8", ...opts });
  if (r.status !== 0) throw new Error(`${args.join(" ")}\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

// wrangler.jsonc may contain // comments (but "//" inside a string, like https://, must stay).
function stripJsonComments(text) {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i];
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else {
      out += c;
    }
  }
  return out;
}

function writeConfig() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const cfg = JSON.parse(stripJsonComments(fs.readFileSync(path.join(ROOT, "wrangler.jsonc"), "utf8")));
  cfg.main = "../src/index.js";
  cfg.assets.directory = "../public";
  cfg.d1_databases[0].migrations_dir = "../migrations";
  cfg.send_email = [{ name: "EMAIL", remote: false }]; // local mail goes to files
  const f = `http://localhost:${FAKE_PORT}`;
  Object.assign(cfg.vars, {
    WEAV3R_API_BASE: `${f}/weav3r`, TORN_V1_API_BASE: `${f}/tornv1`, TORN_API_BASE: `${f}/v2`,
    FFSCOUTER_API_BASE: `${f}/ff`,
  });
  fs.writeFileSync(path.join(TMP, "wrangler.jsonc"), JSON.stringify(cfg, null, 2));
}

const wr = (...args) => sh([...WRANGLER, ...args, "-c", ".test-tmp/wrangler.jsonc", "--persist-to", ".test-tmp/state"]);

function seedOwner() {
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(OWNER.pass, salt, 100000, 32, "sha256");
  wr("d1", "execute", "deucemugger", "--local", "--command",
    `INSERT INTO users (username, password_hash, salt, iterations, status, created_at) VALUES ('${OWNER.name}', '${hash.toString("base64")}', '${salt.toString("base64")}', 100000, 'active', 1)`);
}

async function startWorker() {
  const log = fs.openSync(path.join(TMP, "dev.log"), "w");
  const child = spawn(WRANGLER[0], [...WRANGLER.slice(1), "dev", "-c", ".test-tmp/wrangler.jsonc", "--port", String(PORT), "--local", "--persist-to", ".test-tmp/state"],
    { cwd: ROOT, detached: true, stdio: ["ignore", log, log] });
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try { if ((await fetch(`${BASE}/favicon.svg`)).ok) return child; } catch { /* not up yet */ }
  }
  throw new Error("Worker did not start. See .test-tmp/dev.log");
}

// ------------------------------------------------------------------ HTTP helper with a cookie jar and fake IPs

export class Client {
  constructor(ip) { this.ip = ip; this.cookie = ""; }
  async call(method, url, { body, headers = {}, raw = false } = {}) {
    const res = await fetch(BASE + url, {
      method, redirect: "manual",
      headers: { "CF-Connecting-IP": this.ip, ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(this.cookie ? { Cookie: this.cookie } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get("set-cookie");
    if (set) this.cookie = set.startsWith("__Host-session=;") || set.includes("Max-Age=0") ? "" : set.split(";")[0];
    const text = await res.text();
    let data = {};
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, data, res, text };
  }
  get = (u, o) => this.call("GET", u, o);
  post = (u, body = {}, o = {}) => this.call("POST", u, { body, ...o });
}

function emailFiles() {
  const out = [];
  const walk = (d) => { if (!fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : out.push(p); } };
  walk(path.join(ROOT, ".wrangler")); walk(TMP);
  return out.filter((p) => p.endsWith(".txt") && p.includes("email")).map((p) => ({ p, t: fs.statSync(p).mtimeMs, text: fs.readFileSync(p, "utf8") })).sort((a, b) => a.t - b.t);
}
// Local mail is saved as body-text files (the subject is not in them). Waits briefly for the file to appear.
export async function waitForMail(re, ms = 5000, since = 0) {
  for (let waited = 0; waited <= ms; waited += 250) {
    const found = emailFiles().reverse().find((f) => re.test(f.text) && f.t >= since);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}


// ------------------------------------------------------------------ start and stop everything

let worker;
const fake = fakeServer();

export function stop() {
  try { if (worker) process.kill(-worker.pid, "SIGKILL"); } catch { /* already gone */ }
  fake.close();
}
process.on("exit", stop);

// Config, fake services, database with an owner account, and the Worker on http://localhost:8799.
export async function startEnvironment() {
  console.log("Preparing...");
  writeConfig();
  await new Promise((r) => fake.listen(FAKE_PORT, r));
  wr("d1", "migrations", "apply", "deucemugger", "--local");
  seedOwner();
  console.log("Starting the Worker...");
  worker = await startWorker();
}

// Prints the summary and exits. Removes the temp folder when everything passed.
export function finish() {
  stop();
  console.log(`\n${passed} checks passed, ${failures.length} failed.`);
  if (!failures.length) fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failures.length ? 1 : 0);
}

export function fail(err) {
  console.error(err);
  failures.push(String(err));
}
