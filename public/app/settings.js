// Settings page. API keys and alert prefs live only in localStorage.
const $ = (id) => document.getElementById(id);
const KEYS = "cdm.keys", PREFS = "cdm.prefs";
const DEFAULT_PREFS = { notify: true, minJackpot: 10000000, myBs: 0, outMinutes: 5, offlineMinutes: 35 };

function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}
function say(id, text, cls) { const m = $(id); m.className = "msg " + cls; m.textContent = text; }

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

// keys
const keys = load(KEYS, { torn: "", ff: "" });
$("key-torn").value = keys.torn || ""; $("key-ff").value = keys.ff || "";
$("save-keys").addEventListener("click", () => {
  const torn = $("key-torn").value.trim(), ff = $("key-ff").value.trim();
  if (!torn) return say("keys-msg", "Paste your Torn key first.", "err");
  if ([torn, ff].some((k) => k && !/^[A-Za-z0-9]{8,64}$/.test(k))) return say("keys-msg", "Keys should be letters and numbers only.", "err");
  save(KEYS, { torn, ff });
  say("keys-msg", "Saved in this browser only.", "ok");
});
$("clear-keys").addEventListener("click", () => {
  try { localStorage.removeItem(KEYS); } catch { /* ignore */ }
  $("key-torn").value = ""; $("key-ff").value = "";
  say("keys-msg", "Key cleared.", "info");
});

// alert prefs
const prefs = Object.assign({}, DEFAULT_PREFS, load(PREFS, {}));
$("p-notify").checked = !!prefs.notify;
for (const k of ["minJackpot", "myBs", "outMinutes", "offlineMinutes"]) $("p-" + k).value = prefs[k];
$("save-prefs").addEventListener("click", () => {
  const next = { notify: $("p-notify").checked };
  for (const k of ["minJackpot", "myBs", "outMinutes", "offlineMinutes"]) {
    const v = parseFloat($("p-" + k).value);
    next[k] = Number.isFinite(v) && v >= 0 ? v : DEFAULT_PREFS[k];
  }
  save(PREFS, next);
  say("prefs-msg", "Saved.", "ok");
});
$("fetch-bs").addEventListener("click", async () => {
  const k = load(KEYS, {}).torn;
  if (!k) return say("prefs-msg", "Save your Torn key first.", "err");
  say("prefs-msg", "Asking Torn...", "info");
  try {
    const d = await api("/api/torn/me", { headers: { "X-Torn-Key": k } });
    if (d.error) return say("prefs-msg", d.error, "err");
    $("p-myBs").value = d.total;
    say("prefs-msg", "Got your stats. Tap Save alert settings.", "ok");
  } catch (e) { say("prefs-msg", e.message, "err"); }
});

// email + invites
function fmtDate(sec) { return new Date(sec * 1000).toLocaleDateString(); }
async function revoke(id) {
  try {
    await api("/api/invites/revoke", { method: "POST", body: { id } });
    if (shownInvite === id) { $("invite-box").hidden = true; shownInvite = null; }
    say("invite-msg", "Invite closed.", "info");
    await loadInvites();
  } catch (e) { say("invite-msg", e.message, "err"); }
}
function xButton(id) {
  const x = document.createElement("button");
  x.type = "button"; x.className = "btn small ghost x-btn"; x.textContent = "X"; x.setAttribute("aria-label", "Close invite");
  x.addEventListener("click", () => revoke(id));
  return x;
}
let shownInvite = null;
async function loadInvites() {
  const { invites } = await api("/api/invites");
  const box = $("invite-list");
  box.replaceChildren();
  const now = Date.now() / 1000;
  for (const i of invites) {
    const item = document.createElement("div"); item.className = "item";
    const open = !i.used_at && i.expires_at >= now;
    const status = i.used_at ? `used by ${i.used_by_name || "a deleted account"}` : i.expires_at < now ? "expired" : "unused";
    const a = document.createElement("span"); a.textContent = status;
    const b = document.createElement("span"); b.className = "meta"; b.textContent = `made ${fmtDate(i.created_at)}`;
    item.append(a, b);
    if (open) item.append(xButton(i.id));
    box.append(item);
  }
}
(async () => {
  try {
    const me = await api("/api/me");
    $("acct-email").value = me.email || "";
    await loadInvites();
  } catch (e) { say("email-msg", e.message, "err"); }
})();
$("save-email").addEventListener("click", async () => {
  try {
    const d = await api("/api/account/email", { method: "POST", body: { email: $("acct-email").value, password: $("acct-pass").value } });
    $("acct-pass").value = "";
    say("email-msg", "Saved. We emailed a notice.", "ok");
  } catch (e) { say("email-msg", e.message, "err"); }
});
$("make-invite").addEventListener("click", async () => {
  try {
    const d = await api("/api/invites", { method: "POST", body: {} });
    shownInvite = d.id;
    $("invite-link").textContent = d.link;
    $("invite-box").hidden = false;
    $("invite-close").onclick = () => revoke(d.id);
    say("invite-msg", "Copy this link now. It is only shown once.", "ok");
    try { await navigator.clipboard.writeText(d.link); say("invite-msg", "Link copied. It is only shown once.", "ok"); } catch { /* manual copy */ }
    await loadInvites();
  } catch (e) { say("invite-msg", e.message, "err"); }
});
