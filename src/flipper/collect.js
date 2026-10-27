// The Flipper collector. Runs from the every-minute Cron Trigger (src/index.js `scheduled`) or from the owner's "Refresh" button.
// Each run: Bazaar sample, Auction House pages, recently ended auctions (sales), a second Bazaar sample ~30s after the first,
// price history every 15 minutes, pruning. It only READS Hypixel's keyless public endpoints at their cache rhythm (never faster
// than the verified windows in SOURCES.md), and every outside call and database query spends from a budget (a free-plan Worker
// run may make about 50), so a run degrades (fewer auction pages) instead of failing.
// Outages and partial data never break the page: the last good snapshot stays, with its age, and the error is shown in /status.

import { flipperConfig } from "./config.js";
import { activeBins, binFlips, preScreen, salesFromEnded, salesIndex } from "./auctions.js";
import { normalizeBazaar, orderFlip } from "./bazaar.js";
import { fetchJson } from "../lib/upstream.js";

const nowSec = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chunks = (list, n) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n));

export async function kvGet(env, k) {
  const r = await env.DB.prepare("SELECT v, updated FROM fl_kv WHERE k = ?").bind(k).first();
  return r ? { value: JSON.parse(r.v), updated: r.updated } : null;
}
export const kvSet = (env, k, v) =>
  env.DB.prepare("INSERT INTO fl_kv (k, v, updated) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated = excluded.updated").bind(k, JSON.stringify(v), nowSec()).run();

async function hypixel(cfg, path) {
  const { res, data } = await fetchJson(`${cfg.hypixelBase}${path}`);
  if (!res.ok || !data || data.success === false) throw new Error(`Hypixel ${path}: ${res.status}${data && data.cause ? ` ${data.cause}` : ""}`);
  return data;
}

// ---- Bazaar ----

// Item names, tiers, categories and NPC sell prices for the items on the Bazaar (the items resource is cached a week by Hypixel).
async function ensureMeta(env, cfg, products, budget) {
  const have = await kvGet(env, "items");
  budget.left -= 1;
  if (have && nowSec() - have.updated < 7 * 86400) return have.value;
  const data = await hypixel(cfg, "/v2/resources/skyblock/items");
  budget.left -= 1;
  const meta = {};
  for (const it of data.items || []) if (products[it.id]) meta[it.id] = { n: it.name, c: it.category || "", t: it.tier || "", p: it.npc_sell_price > 0 ? it.npc_sell_price : 0 };
  await kvSet(env, "items", meta);
  budget.left -= 1;
  return meta;
}

async function sampleBazaar(env, cfg, budget, status) {
  const raw = await hypixel(cfg, "/v2/skyblock/bazaar");
  budget.left -= 1;
  const bz = normalizeBazaar(raw, cfg.bazaar.keepLevels);
  if (!Object.keys(bz.products).length) throw new Error("Hypixel sent a Bazaar answer with no products");
  if (bz.updated !== (status.bazaar && status.bazaar.updated)) {
    await kvSet(env, "bz", { updated: bz.updated, fetched: Date.now(), products: bz.products });
    budget.left -= 1;
  }
  status.bazaar = { updated: bz.updated, fetched: Date.now(), products: Object.keys(bz.products).length };
  return bz;
}

// Price history of the tracked items: the best current order flips plus every watched item.
async function writeHistory(env, cfg, bz, budget) {
  const params = { now: nowSec() };
  const ranked = Object.values(bz.products).map((p) => orderFlip(p, params, cfg)).filter(Boolean).sort((a, b) => b.coinsPerHour - a.coinsPerHour).slice(0, cfg.collect.trackedItems).map((f) => f.id);
  const watched = (await env.DB.prepare("SELECT DISTINCT item FROM fl_watch").all()).results.map((r) => r.item);
  budget.left -= 1;
  const ids = [...new Set([...ranked, ...watched])].filter((id) => bz.products[id]);
  const ts = nowSec();
  const stmt = env.DB.prepare("INSERT OR REPLACE INTO fl_hist (product, ts, bid, ask, buyweek, sellweek) VALUES (?, ?, ?, ?, ?, ?)");
  const rows = ids.map((id) => {
    const p = bz.products[id];
    return stmt.bind(id, ts, p.bid.length ? p.bid[0][0] : null, p.ask.length ? p.ask[0][0] : null, Math.round(p.instantBuyWeek), Math.round(p.instantSellWeek));
  });
  for (const part of chunks(rows, 90)) { await env.DB.batch(part); budget.left -= 1; }
  return ids.length;
}

async function prune(env, cfg, budget) {
  const hist = nowSec() - cfg.collect.historyKeepDays * 86400;
  const sales = nowSec() - cfg.collect.salesKeepDays * 86400;
  await env.DB.batch([env.DB.prepare("DELETE FROM fl_hist WHERE ts < ?").bind(hist), env.DB.prepare("DELETE FROM fl_sales WHERE updated < ?").bind(sales)]);
  budget.left -= 1;
}

// ---- Auction House ----

// Merge newly seen sales into the stored per-item lists (newest 40 per item, last 7 days, no duplicates).
async function recordSales(env, cfg, rows, budget) {
  const byCore = new Map();
  for (const r of rows) (byCore.get(r.core) || byCore.set(r.core, []).get(r.core)).push(r);
  if (!byCore.size) return 0;
  const existing = new Map();
  for (const part of chunks([...byCore.keys()], 90)) {
    const { results } = await env.DB.prepare(`SELECT core, data FROM fl_sales WHERE core IN (${part.map(() => "?").join(",")})`).bind(...part).all();
    budget.left -= 1;
    for (const r of results) existing.set(r.core, JSON.parse(r.data));
  }
  const cut = nowSec() - cfg.collect.salesKeepDays * 86400;
  const stmt = env.DB.prepare("INSERT INTO fl_sales (core, item, data, updated) VALUES (?, ?, ?, ?) ON CONFLICT(core) DO UPDATE SET data = excluded.data, updated = excluded.updated");
  const writes = [];
  for (const [core, list] of byCore) {
    const have = existing.get(core) || [];
    const seen = new Set(have.map((e) => e[3]));
    const added = list.filter((r) => !seen.has(r.id.slice(0, 8))).map((r) => [r.ts, r.price, r.full, r.id.slice(0, 8)]);
    const merged = [...added, ...have].filter((e) => e[0] >= cut).sort((a, b) => b[0] - a[0]).slice(0, 40);
    writes.push(stmt.bind(core, list[0].item, JSON.stringify(merged), nowSec()));
  }
  for (const part of chunks(writes, 90)) { await env.DB.batch(part); budget.left -= 1; }
  return rows.length;
}

// A salesIndex for just the given item identities.
async function loadSales(env, cfg, coreKeys, budget) {
  const rows = [];
  for (const part of chunks(coreKeys, 90)) {
    const { results } = await env.DB.prepare(`SELECT core, data FROM fl_sales WHERE core IN (${part.map(() => "?").join(",")})`).bind(...part).all();
    budget.left -= 1;
    for (const r of results) for (const [ts, price, full] of JSON.parse(r.data)) rows.push({ core: r.core, full, ts, price });
  }
  return salesIndex(rows, nowSec(), cfg);
}

async function collectAuctions(env, cfg, budget, status, { sweep }) {
  // The ended-auction feed only keeps the last 60 seconds, so it is read every run. The pages are read every few minutes
  // (config.auction.sweepEveryMinutes) to keep the load on Hypixel's free endpoints modest.
  const listings = [];
  let fetched = 0, failed = 0, totalPages = 0, nowMs = Date.now();
  if (sweep) {
    const first = await hypixel(cfg, "/v2/skyblock/auctions?page=0");
    budget.left -= 1;
    totalPages = first.totalPages || 1;
    const reserve = 10; // sales (ended + D1), the flips store, history and pruning
    const wanted = Math.max(1, Math.min(totalPages, cfg.auction.pagesPerRun, budget.left - reserve));
    listings.push(...(first.auctions || []));
    fetched = 1;
    for (const part of chunks(Array.from({ length: wanted - 1 }, (_, i) => i + 1), 8)) {
      const answers = await Promise.allSettled(part.map((page) => hypixel(cfg, `/v2/skyblock/auctions?page=${page}`)));
      budget.left -= part.length;
      for (const a of answers) {
        if (a.status === "fulfilled") { listings.push(...(a.value.auctions || [])); fetched++; } else failed++;
      }
    }
    nowMs = first.lastUpdated || Date.now();
  }
  // sales first, so this run's flips can use them
  let salesAdded = 0;
  try {
    const ended = await hypixel(cfg, "/v2/skyblock/auctions_ended");
    budget.left -= 1;
    salesAdded = await recordSales(env, cfg, await salesFromEnded(ended.auctions || [], cfg), budget);
    status.auctions = { ...(status.auctions || {}), salesAdded };
  } catch (e) { status.errors.push(String(e.message).slice(0, 160)); }

  if (!sweep) return;
  const bins = activeBins(listings, nowMs);
  const candidates = preScreen(bins, cfg);
  const flips = await binFlips(candidates, { cfg, nowMs, loadSales: (keys) => loadSales(env, cfg, keys, budget) }, {});
  await kvSet(env, "ah", { updated: nowMs, fetched: Date.now(), flips: flips.slice(0, 300) });
  budget.left -= 1;
  status.auctions = { ...(status.auctions || {}), updated: nowMs, fetched: Date.now(), pages: fetched, totalPages, failedPages: failed, listings: listings.length, bins: bins.length, candidates: candidates.length, flips: flips.length, partial: fetched < totalPages };
}

// ---- one run ----

export async function collectFlipper(env, { force = false } = {}) {
  const cfg = flipperConfig(env);
  const budget = { left: cfg.collect.subrequestBudget };
  const started = Date.now();
  // one run at a time (a slow run must not be overlapped by the next minute's)
  const lock = await kvGet(env, "lock");
  budget.left -= 1;
  if (!force && lock && nowSec() - lock.updated < 150) return { skipped: "another run is in progress" };
  await kvSet(env, "lock", { at: started });
  budget.left -= 1;

  const prev = await kvGet(env, "status");
  budget.left -= 1;
  const status = { ...((prev && prev.value) || {}), errors: [], lastRun: nowSec() };
  let bz = null;
  try {
    bz = await sampleBazaar(env, cfg, budget, status);
    await ensureMeta(env, cfg, bz.products, budget);
  } catch (e) { status.errors.push(String(e.message).slice(0, 160)); }

  const sweep = force || new Date().getUTCMinutes() % cfg.auction.sweepEveryMinutes === 0;
  try { await collectAuctions(env, cfg, budget, status, { sweep }); } catch (e) { status.errors.push(String(e.message).slice(0, 160)); }

  // the second Bazaar sample, ~30s after the first (the data refreshes about every 20s)
  const wait = cfg.collect.bazaarEverySeconds * 1000 - (Date.now() - started);
  if (bz && budget.left > 4) {
    if (wait > 0 && wait < 35000 && !force) await sleep(wait);
    try { bz = await sampleBazaar(env, cfg, budget, status); } catch (e) { status.errors.push(String(e.message).slice(0, 160)); }
  }

  try {
    const hist = await kvGet(env, "hist-last");
    budget.left -= 1;
    if (bz && (force || !hist || nowSec() - hist.updated >= cfg.collect.historyEveryMinutes * 60)) {
      status.history = { tracked: await writeHistory(env, cfg, bz, budget), at: nowSec() };
      await kvSet(env, "hist-last", { at: nowSec() });
      budget.left -= 1;
      if (new Date().getUTCMinutes() < cfg.collect.historyEveryMinutes) await prune(env, cfg, budget);
    }
  } catch (e) { status.errors.push(String(e.message).slice(0, 160)); }

  status.budgetLeft = budget.left;
  status.seconds = Math.round((Date.now() - started) / 100) / 10;
  await kvSet(env, "status", status);
  await env.DB.prepare("DELETE FROM fl_kv WHERE k = 'lock'").run();
  return status;
}
