const token = new URLSearchParams(location.search).get("t") || "";
const q = document.getElementById("question");
const btn = document.getElementById("confirm");

async function post(path) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  return { ok: res.ok, data: await res.json().catch(() => ({})) };
}

(async () => {
  const { ok, data } = await post("/api/approval/preview");
  if (!ok) {
    q.className = "msg err";
    q.textContent = data.error || "This link is invalid, expired, or already used.";
    return;
  }
  const approve = data.action === "approve";
  q.textContent = `${approve ? "Approve" : "Deny"} the application from "${data.username}"?`;
  btn.textContent = approve ? "Approve" : "Deny and delete";
  btn.className = "btn block " + (approve ? "green" : "");
  btn.hidden = false;
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    const r = await post("/api/approval/confirm");
    btn.hidden = true;
    if (r.ok) {
      q.className = "msg ok";
      q.textContent = approve ? `${data.username} is approved and can sign in now.` : `${data.username}'s application was deleted.`;
    } else {
      q.className = "msg err";
      q.textContent = r.data.error || "That did not work.";
    }
  });
})();
