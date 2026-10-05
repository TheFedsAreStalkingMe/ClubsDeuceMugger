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
    if (p === "/weav3r/marketplace") return send({ items: [
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

    // Torn v2 (leaderboard)
    if (p === "/v2/user/basic") return send({ profile: { id: TORN_IDS[key] || 999, name: key.startsWith("DANA") ? "Dana" : "Mugsy" } });
    if (p === "/v2/user/attacks") {
      const t = now() + 5; // after the test's click
      return send({ attacks: [
        { id: 1, code: "AAA", started: t, result: "Mugged", attacker: { id: 555 }, defender: { id: 111 } },
        { id: 2, code: "BBB", started: t, result: "Mugged", attacker: { id: 555 }, defender: { id: 999 } }, // never clicked
        { id: 3, code: "CCC", started: t, result: "Hospitalized", attacker: { id: 555 }, defender: { id: 111 } }, // not a mug
      ] });
    }
    if (p === "/v2/torn/attacklog") return send({ attacklog: { log: [
      { action: "hit", text: "Mugsy hit Rich for 100" },
      { action: "mug", text: "Mugsy mugged Rich and stole $2,500,000" },
    ], summary: [] } });

    // FF Scouter
    if (p === "/ff/get-stats") return send(u.searchParams.get("targets").split(",").map((id) => ({ player_id: Number(id), fair_fight: 1.5, bs_estimate: 2e9 })));
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
