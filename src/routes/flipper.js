// The Flipper API (see src/flipper/*): flips, item detail, watchlist, status. Read-only analysis: it only shows suggestions.

import { upstream } from "../config.js";
import { fail, json, nowSec, readJson, str } from "../lib/http.js";
import { isOwner } from "../lib/auth.js";
import { throttle } from "../lib/ratelimit.js";
import { fetchJson } from "../lib/upstream.js";
import { flipperConfig } from "../flipper/config.js";
import { collectFlipper, kvGet, kvSet } from "../flipper/collect.js";
import { computeFlips, filterFlips, npcFloor, sortFlips, TYPES } from "../flipper/engine.js";
import { parseCoflHistory } from "../flipper/history.js";
import { prettyName } from "../flipper/bazaar.js";
import { acquire } from "../flipper/craft.js";

// ---- loading the stored data (cached for a few seconds in the Worker, so a burst of requests reads the database once) ----

const memo = { at: 0, data: null, recipes: null, flips: new Map() };

async function recipes(env, url) {
  if (memo.recipes) return memo.recipes;
  try {
    const res = await env.ASSETS.fetch(new Request(new URL("/flipper-data/recipes.json", url.origin)));
    memo.recipes = res.ok ? await res.json() : { crafts: {}, npc: {} };
  } catch { memo.recipes = { crafts: {}, npc: {} }; }
  return memo.recipes;
}

async function loadData(env, url) {
  if (memo.data && Date.now() - memo.at < 5000) return memo.data;
  const [bz, items, ah, status] = await Promise.all([kvGet(env, "bz"), kvGet(env, "items"), kvGet(env, "ah"), kvGet(env, "status")]);
  const since = nowSec() - 26 * 3600;
  const { results } = await env.DB.prepare("SELECT product, ts, bid, ask FROM fl_hist WHERE ts >= ? ORDER BY ts").bind(since).all();
  const history = {};
  for (const r of results) (history[r.product] ||= []).push([r.ts, r.bid, r.ask]);
  memo.data = {
    bz: bz ? bz.value.products : {}, bzUpdated: bz ? bz.value.updated : 0, bzFetched: bz ? bz.value.fetched : 0,
    meta: items ? items.value : {}, ah: ah ? ah.value : null, history, status: status ? status.value : null,
    recipes: await recipes(env, url),
  };
  memo.at = Date.now();
  memo.flips.clear();
  return memo.data;
}

// ---- parameters ----

const num = (v) => (v !== null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : 0);
const FILTER_NAMES = ["volume", "thin", "outlier", "spread", "volatility", "trend", "cosmetic"];

function readParams(url) {
  const q = url.searchParams;
  const types = (q.get("type") || "").split(",").filter((t) => TYPES.includes(t));
  // safety filters: `off=outlier,trend` switches those off (they are all on by default)
  const off = new Set((q.get("off") || "").split(","));
  const filters = Object.fromEntries(FILTER_NAMES.map((n) => [n, !off.has(n)]));
  const w = (q.get("weights") || "").split(",").map(Number);
  const weights = w.length === 3 && w.every((x) => Number.isFinite(x) && x >= 0) && w.some((x) => x > 0) ? { margin: w[0], speed: w[1], reliability: w[2] } : null;
  return {
    types, filters, weights,
    purse: num(q.get("purse")), orderSize: Math.floor(num(q.get("orderSize"))), tax: q.get("tax") !== null && q.get("tax") !== "" ? Math.min(0.1, Math.max(0, num(q.get("tax")) / 100)) : undefined,
    f: { minProfit: num(q.get("minProfit")), minRoi: num(q.get("minRoi")), maxCost: num(q.get("maxCost")), minCph: num(q.get("minCph")), minVolume: num(q.get("minVolume")), confidence: ["Low", "Med", "High"].includes(q.get("confidence")) ? q.get("confidence") : "Med", q: (q.get("q") || "").slice(0, 60) },
    sort: ["score", "profit", "roi", "cph", "speed"].includes(q.get("sort")) ? q.get("sort") : "score",
    limit: Math.min(500, Math.max(1, Math.floor(num(q.get("limit")) || 100))),
  };
}

const ages = (d, cfg) => {
  const now = Date.now();
  const bz = d.bzUpdated ? Math.round((now - d.bzUpdated) / 1000) : null;
  const ah = d.ah ? Math.round((now - d.ah.updated) / 1000) : null;
  return { bazaarSeconds: bz, auctionSeconds: ah, bazaarStale: bz == null || bz > cfg.collect.staleAfterSeconds, auctionStale: ah == null || ah > cfg.collect.staleAfterSeconds * 2 };
};

// ---- routes ----

export async function flips({ env, url, user }) {
  const blocked = await throttle(env, "flipper", String(user.id), 120, 60);
  if (blocked) return blocked;
  const cfg = flipperConfig(env);
  const d = await loadData(env, url);
  const p = readParams(url);
  const key = JSON.stringify([p.types, p.filters, p.purse, p.orderSize, p.tax]);
  let all = memo.flips.get(key);
  if (!all) {
    all = computeFlips(d, { types: p.types, filters: p.filters, purse: p.purse, orderSize: p.orderSize, tax: p.tax, now: nowSec() }, cfg);
    memo.flips.set(key, all);
  }
  const shown = filterFlips(all, p.f);
  const sorted = sortFlips(shown, p.sort, p.weights || cfg.weights).slice(0, p.limit);
  return json({
    flips: sorted, total: shown.length, computed: all.length, ages: ages(d, cfg),
    config: { tax: p.tax ?? cfg.bazaar.sellTax, weights: p.weights || cfg.weights, npcLimitStacks: cfg.npc.sellLimitStacks },
    notes: d.status && d.status.auctions && d.status.auctions.partial ? ["Only the newest auction pages are scanned on this server, so auction flips may miss older listings."] : [],
  });
}

export async function status({ env, url }) {
  const cfg = flipperConfig(env);
  const d = await loadData(env, url);
  return json({ ages: ages(d, cfg), status: d.status, products: Object.keys(d.bz).length, recipes: Object.keys(d.recipes.crafts || {}).length, npcShops: Object.keys(d.recipes.npc || {}).length, tax: cfg.bazaar.sellTax });
}

// One item: its book, price history (own samples, topped up from SkyCofl when thin), NPC floor, crafting route, current flips.
export async function item({ env, url, user }) {
  const id = (url.searchParams.get("id") || "").toUpperCase();
  if (!/^[A-Z0-9_:;-]{1,80}$/.test(id)) return fail("Bad item id.");
  const blocked = await throttle(env, "flipperitem", String(user.id), 60, 60);
  if (blocked) return blocked;
  const cfg = flipperConfig(env);
  const d = await loadData(env, url);
  const p = d.bz[id];
  if (!p) return fail("That item is not on the Bazaar.", 404);

  const { results } = await env.DB.prepare("SELECT ts, bid, ask FROM fl_hist WHERE product = ? AND ts >= ? ORDER BY ts").bind(id, nowSec() - 7 * 86400).all();
  let points = results.map((r) => [r.ts, r.bid, r.ask]);
  let source = "own samples";
  if (points.length < 24) {
    // thin own history: top up with SkyCofl's hourly prices for the last day (cached an hour; free, no key)
    const cached = await kvGet(env, `cofl:${id}`);
    let seed = cached && nowSec() - cached.updated < 3600 ? cached.value : null;
    if (!seed) {
      try {
        const { res, data } = await fetchJson(`${cfg.coflBase}/item/price/${encodeURIComponent(id)}/history/day`);
        if (res.ok) { seed = parseCoflHistory(data); await kvSet(env, `cofl:${id}`, seed); }
      } catch { /* the chart just has fewer points */ }
    }
    if (seed && seed.length) { points = [...seed.filter((s) => !points.length || s[0] < points[0][0]), ...points]; source = "SkyCofl hourly averages + own samples"; }
  }
  const ctx = { bz: d.bz, recipes: d.recipes, meta: d.meta, cfg };
  const route = d.recipes.crafts && d.recipes.crafts[id] ? acquire({ ...ctx, memo: new Map() }, id, 0, new Set()) : null;
  const all = computeFlips({ ...d, ah: null }, { types: [], purse: 0, orderSize: 0, filters: {}, now: nowSec() }, cfg).filter((f) => f.id === id);
  const watched = await env.DB.prepare("SELECT 1 FROM fl_watch WHERE user_id = ? AND item = ?").bind(user.id, id).first();
  const floor = npcFloor({ bz: { [id]: p }, meta: d.meta })[0] || null;
  return json({ id, name: (d.meta[id] && d.meta[id].n) || prettyName(id), meta: d.meta[id] || null, book: { ask: p.ask, bid: p.bid, instantBuyWeek: p.instantBuyWeek, instantSellWeek: p.instantSellWeek, askOrders: p.askOrders, bidOrders: p.bidOrders }, history: { points, source }, npc: floor, shopPrice: (d.recipes.npc && d.recipes.npc[id]) || null, craftRoute: route, flips: all, watched: !!watched, ages: ages(d, cfg) });
}

// The NPC price floor for every item NPCs buy that is on the Bazaar: what an NPC pays next to the best Bazaar prices.
export async function floor({ env, url, user }) {
  const blocked = await throttle(env, "flipperfloor", String(user.id), 30, 60);
  if (blocked) return blocked;
  const d = await loadData(env, url);
  const rows = npcFloor({ bz: d.bz, meta: d.meta }).map((r) => ({ ...r, name: (d.meta[r.id] && d.meta[r.id].n) || prettyName(r.id), shopPrice: (d.recipes.npc && d.recipes.npc[r.id] && d.recipes.npc[r.id][0]) || null }));
  const q = (url.searchParams.get("q") || "").toLowerCase();
  const shown = rows.filter((r) => !q || r.name.toLowerCase().includes(q) || r.id.toLowerCase().includes(q)).sort((a, b) => (b.floorVsBidPct ?? -Infinity) - (a.floorVsBidPct ?? -Infinity));
  return json({ rows: shown.slice(0, 300), total: shown.length, belowFloor: shown.filter((r) => r.belowFloor).length, ages: ages(d, flipperConfig(env)) });
}

export async function watchList({ env, user }) {
  const { results } = await env.DB.prepare("SELECT item FROM fl_watch WHERE user_id = ? ORDER BY created_at").bind(user.id).all();
  return json({ items: results.map((r) => r.item) });
}

export async function watchToggle({ request, env, user }) {
  const body = await readJson(request);
  const id = str(body.item).toUpperCase();
  if (!/^[A-Z0-9_:;-]{1,80}$/.test(id)) return fail("Bad item id.");
  if (body.on === false) await env.DB.prepare("DELETE FROM fl_watch WHERE user_id = ? AND item = ?").bind(user.id, id).run();
  else {
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM fl_watch WHERE user_id = ?").bind(user.id).first();
    if (n.n >= 100) return fail("You can watch up to 100 items.");
    await env.DB.prepare("INSERT OR IGNORE INTO fl_watch (user_id, item, created_at) VALUES (?, ?, ?)").bind(user.id, id, nowSec()).run();
  }
  return watchList({ env, user });
}

// The owner can run one collection by hand (the Cron Trigger does it every minute).
export async function refresh({ env, user }) {
  if (!isOwner(env, user.username)) return fail("Only the owner can do that.", 403);
  const blocked = await throttle(env, "flipperrefresh", String(user.id), 6, 3600);
  if (blocked) return blocked;
  memo.data = null;
  const s = await collectFlipper(env, { force: true });
  memo.data = null;
  return json({ ok: true, status: s });
}
