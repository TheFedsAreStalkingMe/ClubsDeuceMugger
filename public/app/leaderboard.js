// Leaderboard page. The Torn key stays in localStorage and is only passed through for the check.
const $ = (id) => document.getElementById(id);
const fmtMoney = (n) => "$" + Math.round(n).toLocaleString("en-US");
function say(text, cls) { const m = $("sync-msg"); m.className = "msg " + cls; m.textContent = text; }
function tornKey() {
  try { return (JSON.parse(localStorage.getItem("cdm.keys") || "{}").torn) || ""; } catch { return ""; }
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || "GET",
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) { location.href = "/"; throw new Error("Signed out"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function row(rank, cells, me) {
  const r = document.createElement("div");
  r.className = "item" + (me ? " me" : "");
  for (const c of cells) { const s = document.createElement("span"); s.textContent = c.text; if (c.cls) s.className = c.cls; r.append(s); }
  return r;
}

async function load() {
  const data = await api(`/api/leaderboard?range=${$("range").value}`);
  const box = $("board");
  box.replaceChildren();
  if (!data.rows.length) {
    const p = document.createElement("p");
    p.className = "empty"; p.textContent = "No mugs yet. Tap Attack on a card, mug someone, then check back.";
    box.append(p);
    return;
  }
  data.rows.forEach((r, i) => {
    box.append(row(i + 1, [
      { text: `${i + 1}.` },
      { text: r.torn_name ? `${r.username} (${r.torn_name})` : r.username },
      { text: fmtMoney(r.total) },
      { text: `${r.mugs} mug${r.mugs === 1 ? "" : "s"}, best ${fmtMoney(r.biggest)}`, cls: "meta" },
    ], r.username === data.me));
  });
}

async function sync(quiet) {
  const key = tornKey();
  if (!key) { if (!quiet) say("Add your Torn key in Settings first.", "err"); return; }
  if (!quiet) say("Checking your attacks...", "info");
  try {
    const d = await api("/api/leaderboard/sync", { method: "POST", headers: { "X-Torn-Key": key }, body: {} });
    if (!quiet) say(d.counted ? `Found ${d.counted} new mug${d.counted === 1 ? "" : "s"}. Linked to ${d.linked}.` : `No new mugs. Linked to ${d.linked}.`, "ok");
    await load();
  } catch (e) { if (!quiet) say(e.message, "err"); }
}

$("range").addEventListener("change", load);
$("sync").addEventListener("click", () => sync(false));
load().then(() => sync(true)).catch((e) => say(e.message, "err"));
