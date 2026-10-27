// Builds the Flipper's recipe and NPC shop data from a local clone of the NotEnoughUpdates item repo (MIT licence).
//
//   git clone --depth 1 https://github.com/NotEnoughUpdates/NotEnoughUpdates-REPO /tmp/neu
//   node scripts/flipper-build-data.mjs /tmp/neu            -> public/flipper-data/recipes.json
//
// The Worker cannot read 9,000 repo files at run time, so this compact file is generated here and served as a static asset.
// Re-run it when the NEU repo changes (new items and recipes appear with game updates). Crafting recipes come from the grid
// recipes ("recipe" and "recipes" of type "crafting"); NPC shop buy prices come from "npc_shop" recipes that cost only coins.
// Forge, Kat upgrades, trades and mob drops are NOT crafts here (they take time or luck).

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const dir = process.argv[2];
if (!dir || !fs.existsSync(path.join(dir, "items"))) {
  console.error("Usage: node scripts/flipper-build-data.mjs <path to a NotEnoughUpdates-REPO clone>");
  process.exit(1);
}
const out = process.argv[3] || path.join(path.dirname(new URL(import.meta.url).pathname), "..", "public", "flipper-data", "recipes.json");

const SLOTS = ["A1", "A2", "A3", "B1", "B2", "B3", "C1", "C2", "C3"];
const strip = (s) => String(s || "").replace(/§./g, "").replace(/\\u00a7./g, "").trim();

// "ENCHANTED_DIAMOND:32" -> ["ENCHANTED_DIAMOND", 32]
const part = (s) => {
  const [id, n] = String(s).split(":");
  return [id, Number(n) || 1];
};

function grid(r) {
  const ing = {};
  for (const slot of SLOTS) {
    if (!r[slot]) continue;
    const [id, n] = part(r[slot]);
    ing[id] = (ing[id] || 0) + n;
  }
  return Object.keys(ing).length ? ing : null;
}

const crafts = {}, npc = {};
let files = 0;
for (const f of fs.readdirSync(path.join(dir, "items"))) {
  if (!f.endsWith(".json")) continue;
  let d;
  try { d = JSON.parse(fs.readFileSync(path.join(dir, "items", f), "utf8")); } catch { continue; }
  files++;
  const id = d.internalname;
  const req = strip(d.crafttext || "");
  const add = (outId, ing, n) => {
    if (!ing) return;
    (crafts[outId] ||= []).push({ n: n || 1, i: ing, ...(req ? { req } : {}) });
  };
  if (d.recipe) add(id, grid(d.recipe), d.recipe.count);
  for (const r of d.recipes || []) {
    if (r.type === "crafting") add(r.overrideOutputId || id, grid(r), r.count);
    if (r.type === "npc_shop" && Array.isArray(r.cost) && r.cost.length === 1 && String(r.cost[0]).startsWith("SKYBLOCK_COIN:")) {
      const price = Number(String(r.cost[0]).split(":")[1]);
      const [rid, n] = part(r.result);
      const unit = price / n;
      if (!(unit > 0)) continue;
      if (!npc[rid] || unit < npc[rid][0]) npc[rid] = [unit, strip(d.displayname)];
    }
  }
}

// drop duplicate alternatives of one item
for (const [id, list] of Object.entries(crafts)) {
  const seen = new Set();
  crafts[id] = list.filter((r) => { const k = JSON.stringify([r.n, r.i]); if (seen.has(k)) return false; seen.add(k); return true; });
}

let commit = "unknown";
try { commit = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"]).toString().trim(); } catch { /* not a git clone */ }
const data = { generated: new Date().toISOString().slice(0, 10), source: "NotEnoughUpdates/NotEnoughUpdates-REPO (MIT)", neuCommit: commit, crafts, npc };
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(data));
console.log(`${files} NEU items read -> ${Object.keys(crafts).length} craftable items, ${Object.keys(npc).length} NPC shop items -> ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
