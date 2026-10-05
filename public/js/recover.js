async function postJson(path, body) {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { ok: res.ok, data: await res.json().catch(() => ({})) };
}
function say(id, text, cls) { const m = document.getElementById(id); m.className = "msg " + cls; m.textContent = text; }

document.getElementById("recover-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  say("recover-msg", "One moment...", "info");
  const { ok, data } = await postJson("/api/recover", { who: new FormData(e.target).get("who") });
  say("recover-msg", ok ? data.message : data.error || "Something went wrong.", ok ? "ok" : "err");
});
