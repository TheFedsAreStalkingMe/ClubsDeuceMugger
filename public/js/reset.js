async function postJson(path, body) {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { ok: res.ok, data: await res.json().catch(() => ({})) };
}
function say(id, text, cls) { const m = document.getElementById(id); m.className = "msg " + cls; m.textContent = text; }

const token = new URLSearchParams(location.search).get("t") || "";
document.getElementById("reset-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  if (f.get("password") !== f.get("confirm")) return say("reset-msg", "Passwords do not match.", "err");
  say("reset-msg", "One moment...", "info");
  const { ok, data } = await postJson("/api/reset", { token, password: f.get("password"), confirm: f.get("confirm") });
  if (ok) { e.target.reset(); say("reset-msg", "Password changed. You can sign in now.", "ok"); }
  else say("reset-msg", data.error || "Something went wrong.", "err");
});
