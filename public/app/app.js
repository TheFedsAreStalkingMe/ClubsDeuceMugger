// Clubs Deuce Mugger front end. API keys live only in localStorage.
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LS = { keys: "cdm.keys", watch: "cdm.watch", filters: "cdm.filters", profiles: "cdm.profiles", ff: "cdm.ff", calls: "cdm.calls" };
const TORN_CALLS_PER_MIN = 80; // hard ceiling is 85; stay under it
const WINDOW_MS = 60000;
const NUM_MAX = 1e10;

function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

const state = {
  keys: load(LS.keys, { torn: "", ff: "" }),
  watch: load(LS.watch, []),
  filters: Object.assign(
    { minPrice: 0, minBs: 0, maxBs: NUM_MAX, maxFf: 3, maxSellers: 80, sort: "stats", dir: "desc" },
    load(LS.filters, {})
  ),
  rows: [],
  runId: 0,
};

// ---------------------------------------------------------------- DOM helpers

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else n.setAttribute(k, v);
  }
  for (const kid of kids) if (kid != null) n.append(kid);
  return n;
}
function suit(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `/img/sprite.svg#${name}`);
  svg.append(use);
  return svg;
}
const fmtMoney = (n) => "$" + Math.round(n).toLocaleString("en-US");
function fmtStats(n) {
  if (n == null) return "?";
  for (const [d, s] of [[1e12, "t"], [1e9, "b"], [1e6, "m"], [1e3, "k"]]) if (n >= d) return (n / d).toFixed(n / d >= 100 ? 0 : 2).replace(/\.?0+$/, "") + s;
  return String(Math.round(n));
}
function fmtCountdown(sec) {
  sec = Math.max(0, Math.ceil(sec));
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (d) return `${d}d ${h}h ${m}m`;
  if (h) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}

// ---------------------------------------------------------------- API

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || "GET",
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: "same-origin",
  });
  if (res.status === 401) { location.href = "/"; throw new Error("Signed out"); }
  const data = await res.json().catch(() => ({}));
  if (res.status === 429) {
    const e = new Error(data.error || "Rate limited");
    e.retryAfter = data.retryAfter || 30;
    throw e;
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// Sliding-window limiter shared across tabs/reloads via localStorage.
async function acquireTornSlot(runId) {
  for (;;) {
    if (runId !== state.runId) throw new Error("cancelled");
    const now = Date.now();
    const calls = load(LS.calls, []).filter((t) => now - t < WINDOW_MS);
    if (calls.length < TORN_CALLS_PER_MIN) {
      calls.push(now);
      save(LS.calls, calls);
      return;
    }
    const wait = WINDOW_MS - (now - calls[0]) + 50;
    setScanMsg(`Pacing Torn API calls... ${Math.ceil(wait / 1000)}s`);
    await sleep(Math.min(wait, 1000));
  }
}

// ---------------------------------------------------------------- caches

function cacheGet(key, id) {
  const m = load(key, {});
  return m[id] || null;
}
function cachePut(key, id, value, maxEntries = 3000) {
  const m = load(key, {});
  m[id] = value;
  const ids = Object.keys(m);
  if (ids.length > maxEntries) {
    ids.sort((a, b) => m[a].t - m[b].t).slice(0, ids.length - maxEntries).forEach((k) => delete m[k]);
  }
  save(key, m);
}
// Okay players: trust for 45s. Out players: trust until their timer ends (max 15 min).
function profileFresh(p) {
  if (!p) return false;
  const now = Date.now();
  if (p.until && p.state !== "Okay") return now < Math.min(p.until * 1000, p.t + 15 * 60000);
  return now - p.t < 45000;
}

// ---------------------------------------------------------------- settings

function initSettings() {
  $("key-torn").value = state.keys.torn || "";
  $("key-ff").value = state.keys.ff || "";
  if (!state.keys.torn || !state.keys.ff) $("settings").open = true;
  const msg = $("keys-msg");
  $("save-keys").addEventListener("click", () => {
    const torn = $("key-torn").value.trim(), ff = $("key-ff").value.trim();
    const bad = [torn, ff].some((k) => k && !/^[A-Za-z0-9]{8,64}$/.test(k));
    if (bad) { msg.className = "msg err"; msg.textContent = "Keys should be letters and numbers only."; return; }
    state.keys = { torn, ff };
    save(LS.keys, state.keys);
    msg.className = "msg ok"; msg.textContent = "Saved in this browser only.";
  });
  $("clear-keys").addEventListener("click", () => {
    state.keys = { torn: "", ff: "" };
    try { localStorage.removeItem(LS.keys); } catch { /* ignore */ }
    $("key-torn").value = ""; $("key-ff").value = "";
    msg.className = "msg info"; msg.textContent = "Keys cleared.";
  });
}

// ---------------------------------------------------------------- watchlist

function renderWatch() {
  const box = $("chips");
  box.replaceChildren();
  if (!state.watch.length) box.append(el("span", { class: "hint", text: "No items yet. Add an item ID above." }));
  state.watch.forEach((w, i) => {
    const rm = el("button", { type: "button", "aria-label": `Remove item ${w.id}`, text: "✕" });
    rm.addEventListener("click", () => { state.watch.splice(i, 1); save(LS.watch, state.watch); renderWatch(); });
    box.append(el("span", { class: "chip" }, el("span", { text: w.name ? `${w.name} (#${w.id})` : `#${w.id}` }), rm));
  });
}
function initWatch() {
  $("watch-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const id = parseInt($("watch-id").value, 10);
    if (!Number.isInteger(id) || id < 1 || id > 9999999) return;
    if (!state.watch.some((w) => w.id === id)) { state.watch.push({ id }); save(LS.watch, state.watch); }
    $("watch-id").value = "";
    renderWatch();
  });
  renderWatch();
}

// ---------------------------------------------------------------- filters

// Log-scale sliders so one slider covers $0 to $10b.
const toSlider = (n) => (n <= 1 ? 0 : Math.round(Math.log10(n) * 100));
const fromSlider = (v) => (v <= 0 ? 0 : Math.round(10 ** (v / 100)));

function bindFilter(name, { log }) {
  const num = $(name), range = $(name + "-r");
  const set = (v, from) => {
    state.filters[name] = v;
    if (from !== "num") num.value = v;
    if (from !== "range") range.value = log ? toSlider(v) : v;
    save(LS.filters, state.filters);
  };
  num.addEventListener("input", () => { const v = parseFloat(num.value); if (!Number.isNaN(v)) set(v, "num"); });
  range.addEventListener("input", () => set(log ? fromSlider(+range.value) : +range.value, "range"));
  set(state.filters[name]);
}
function initFilters() {
  bindFilter("minPrice", { log: true });
  bindFilter("minBs", { log: true });
  bindFilter("maxBs", { log: true });
  bindFilter("maxFf", { log: false });
  const ms = $("maxSellers");
  ms.value = state.filters.maxSellers;
  ms.addEventListener("input", () => {
    const v = Math.min(500, Math.max(1, parseInt(ms.value, 10) || 80));
    state.filters.maxSellers = v; save(LS.filters, state.filters);
  });
  for (const id of ["sort", "dir"]) {
    $(id).value = state.filters[id];
    $(id).addEventListener("change", () => { state.filters[id] = $(id).value; save(LS.filters, state.filters); render(); });
  }
}

// ---------------------------------------------------------------- scanning

function setScanMsg(text, cls = "info") { const m = $("scan-msg"); m.className = "msg " + cls; m.textContent = text; }
function setProgress(f) { $("bar").style.width = Math.round(f * 100) + "%"; }

async function pool(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const item = items[i++]; await fn(item); }
  }));
}

async function scan() {
  const runId = ++state.runId;
  const f = state.filters;
  if (!state.watch.length) return setScanMsg("Add at least one item ID to the watchlist.", "err");
  if (!state.keys.torn || !state.keys.ff) { $("settings").open = true; return setScanMsg("Enter both API keys in Settings first.", "err"); }

  $("scan").disabled = true; $("cancel").hidden = false;
  state.rows = []; render(); setProgress(0);
  try {
    // 1. bazaar listings
    setScanMsg("Reading bazaars...");
    const groups = new Map(); // seller:item -> row
    let done = 0;
    await pool(state.watch, 3, async (w) => {
      try {
        const data = await api(`/api/weav3r?item=${w.id}`);
        if (data.item_name && w.name !== data.item_name) { w.name = data.item_name; }
        for (const l of data.listings) {
          if (l.price < f.minPrice) continue;
          const k = `${l.player_id}:${w.id}`;
          const g = groups.get(k) || { id: l.player_id, name: l.player_name, itemId: w.id, itemName: data.item_name || `#${w.id}`, price: l.price, qty: 0, total: 0 };
          g.price = Math.min(g.price, l.price); g.qty += l.quantity; g.total += l.price * l.quantity;
          groups.set(k, g);
        }
      } catch (e) {
        if (runId === state.runId) setScanMsg(`Item ${w.id}: ${e.message}`, "err");
      }
      setProgress(++done / state.watch.length * 0.2);
    });
    save(LS.watch, state.watch); renderWatch();
    if (runId !== state.runId) return;

    let rows = [...groups.values()].sort((a, b) => b.total - a.total);
    const sellerIds = [];
    for (const r of rows) if (!sellerIds.includes(r.id)) sellerIds.push(r.id);
    const keep = new Set(sellerIds.slice(0, f.maxSellers));
    rows = rows.filter((r) => keep.has(r.id));
    const ids = [...keep];

    // 2. FF Scouter estimates
    setScanMsg(`Estimating stats for ${ids.length} sellers...`);
    const ffCache = load(LS.ff, {});
    const need = ids.filter((id) => !ffCache[id] || Date.now() - ffCache[id].t > 6 * 3600e3);
    for (let i = 0; i < need.length; i += 200) {
      const batch = need.slice(i, i + 200);
      const data = await api("/api/ffscouter", { method: "POST", headers: { "X-FF-Key": state.keys.ff }, body: { targets: batch } });
      const list = Array.isArray(data) ? data : data.data || data.results || [];
      const seen = new Set();
      for (const s of list) {
        seen.add(Number(s.player_id));
        ffCache[s.player_id] = { t: Date.now(), ff: s.fair_fight ?? null, bs: s.bs_estimate ?? null };
      }
      for (const id of batch) if (!seen.has(id)) ffCache[id] = { t: Date.now(), ff: null, bs: null };
      save(LS.ff, ffCache);
      if (runId !== state.runId) return;
    }
    setProgress(0.35);

    // 3. filter on stats / fair fight (unknown estimates only pass when no stat limits are set)
    const statLimits = f.minBs > 0 || f.maxBs < NUM_MAX;
    rows = rows.filter((r) => {
      const s = ffCache[r.id] || {};
      r.ff = s.ff; r.bs = s.bs;
      if (r.bs == null) return !statLimits && (r.ff == null || r.ff <= f.maxFf);
      if (r.bs < f.minBs || r.bs > f.maxBs) return false;
      return r.ff == null || r.ff <= f.maxFf;
    });
    state.rows = rows; render();
    if (!rows.length) { setScanMsg("No targets match your filters.", "info"); setProgress(1); return; }

    // 4. Torn status + age, paced under the API limit
    const uniq = [...new Set(rows.map((r) => r.id))];
    let checked = 0, errored = false;
    const apply = (id, p) => { for (const r of state.rows) if (r.id === id) Object.assign(r, { state: p.state, until: p.until, desc: p.desc, age: p.age }); };
    for (const id of uniq) { const p = cacheGet(LS.profiles, id); if (profileFresh(p)) apply(id, p); }
    render();
    const todo = uniq.filter((id) => !profileFresh(cacheGet(LS.profiles, id)));
    checked = uniq.length - todo.length;
    await pool(todo, 3, async (id) => {
      for (;;) {
        if (runId !== state.runId || errored) return;
        try {
          await acquireTornSlot(runId);
          const p = await api(`/api/torn/user?id=${id}`, { headers: { "X-Torn-Key": state.keys.torn } });
          if (p.error) {
            if (p.code === 5) { setScanMsg("Torn says slow down. Waiting 30s...", "info"); await sleep(30000); continue; }
            if ([2, 10, 13, 16].includes(p.code)) { errored = true; setScanMsg(`Torn key problem: ${p.error}`, "err"); return; }
            apply(id, { state: "Unknown", desc: p.error });
          } else {
            const rec = { t: Date.now(), state: p.status?.state || "Okay", until: p.status?.until || 0, desc: p.status?.description || "", age: p.age };
            cachePut(LS.profiles, id, rec);
            apply(id, rec);
          }
        } catch (e) {
          if (e.message === "cancelled") return;
          if (e.retryAfter) { await sleep(e.retryAfter * 1000); continue; }
          apply(id, { state: "Unknown", desc: e.message });
        }
        break;
      }
      checked++;
      setProgress(0.35 + (checked / uniq.length) * 0.65);
      setScanMsg(`Checking status ${checked}/${uniq.length}...`);
      scheduleRender();
    });
    if (runId === state.runId && !errored) { setScanMsg(`Done. ${state.rows.length} listing(s) from ${uniq.length} seller(s).`, "ok"); setProgress(1); }
    render();
  } catch (e) {
    if (e.message !== "cancelled" && runId === state.runId) setScanMsg(e.message, "err");
  } finally {
    if (runId === state.runId) { $("scan").disabled = false; $("cancel").hidden = true; }
  }
}

// ---------------------------------------------------------------- results

let renderTimer = 0;
function scheduleRender() { clearTimeout(renderTimer); renderTimer = setTimeout(render, 300); }

function remaining(r) {
  if (r.state == null) return null;
  if (r.state === "Okay" || !r.until) return 0;
  return Math.max(0, r.until - Date.now() / 1000);
}
function sortValue(r, key) {
  switch (key) {
    case "stats": return r.bs;
    case "hospital": return remaining(r);
    case "age": return r.age;
    default: return r.price;
  }
}
function render() {
  const box = $("results");
  box.replaceChildren();
  if (!state.rows.length) {
    box.append(el("p", { class: "empty", text: "Nothing on the table yet. Hit Scan." }));
    return;
  }
  const { sort, dir } = state.filters;
  const mul = dir === "asc" ? 1 : -1;
  const rows = [...state.rows].sort((a, b) => {
    const x = sortValue(a, sort), y = sortValue(b, sort);
    if (x == null && y == null) return 0;
    if (x == null) return 1; // unknowns always last
    if (y == null) return -1;
    return (x - y) * mul;
  });
  rows.forEach((r, i) => box.append(card(r, i)));
  tick();
}

function card(r, i) {
  const rem = remaining(r);
  const suitName = rem == null ? "diamond" : rem === 0 ? "club" : r.state === "Hospital" ? "heart" : "spade";
  const status = el("span", { class: "status pending", text: "Checking..." });
  status.dataset.until = r.until && r.state !== "Okay" ? r.until : "";
  status.dataset.state = r.state || "";
  status.dataset.known = r.state == null ? "" : "1";
  const dl = el("dl", {},
    el("dt", { text: "Price" }), el("dd", { text: `${fmtMoney(r.price)} × ${r.qty}` }),
    el("dt", { text: "Total" }), el("dd", { text: fmtMoney(r.total) }),
    el("dt", { text: "Est. stats" }), el("dd", { text: fmtStats(r.bs) }),
    el("dt", { text: "Fair fight" }), el("dd", { text: r.ff != null ? Number(r.ff).toFixed(2) : "?" }),
    el("dt", { text: "Account age" }), el("dd", { text: r.age != null ? `${Number(r.age).toLocaleString("en-US")} days` : "?" }),
    el("dt", { text: "Status" }), el("dd", {}, status)
  );
  const corner = (cls) => { const s = el("span", { class: `corner ${cls} ${rem === 0 ? "club-c" : "derse-c"}` }); s.append(suit(suitName)); return s; };
  const art = el("article", { class: "card hover target" },
    corner("tl"), corner("br"),
    el("h3", { class: "name", text: r.name }),
    el("p", { class: "sub", text: `ID ${r.id} · ${r.itemName}` }),
    dl,
    el("div", { class: "btns" },
      el("a", { class: "btn small ghost", href: `https://www.torn.com/bazaar.php?userId=${r.id}`, target: "_blank", rel: "noopener noreferrer", text: "Bazaar" }),
      el("a", { class: "btn small", href: `https://www.torn.com/loader.php?sid=attack&user2ID=${r.id}`, target: "_blank", rel: "noopener noreferrer", text: "Attack" }))
  );
  art.style.animationDelay = `${Math.min(i, 12) * 40}ms`; // CSSOM is CSP-safe, unlike a style attribute
  return art;
}

// Local 1s countdown; no API calls.
function tick() {
  const now = Date.now() / 1000;
  document.querySelectorAll(".status").forEach((s) => {
    if (!s.dataset.known) return;
    const until = Number(s.dataset.until);
    if (until && until > now) {
      s.className = "status out";
      s.textContent = `Out in ${fmtCountdown(until - now)}`;
    } else if (s.dataset.state === "Unknown") {
      s.className = "status pending"; s.textContent = "Unknown";
    } else {
      s.className = "status okay"; s.textContent = "Okay";
    }
  });
}

// ---------------------------------------------------------------- boot

async function boot() {
  try { const me = await api("/api/me"); $("who").textContent = me.username; } catch { return; }
  initSettings(); initWatch(); initFilters(); render();
  $("scan").addEventListener("click", scan);
  $("cancel").addEventListener("click", () => { state.runId++; $("scan").disabled = false; $("cancel").hidden = true; setScanMsg("Stopped.", "info"); });
  $("logout").addEventListener("click", async () => {
    try { await api("/api/logout", { method: "POST", body: {} }); } catch { /* fall through */ }
    location.href = "/";
  });
  setInterval(tick, 1000);
}
boot();
