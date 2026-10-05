function wire(formId, msgId, endpoint, build, onOk) {
  const form = document.getElementById(formId);
  const msg = document.getElementById(msgId);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = form.querySelector("button[type=submit]");
    const body = build(new FormData(form));
    if (typeof body === "string") {
      msg.className = "msg err";
      msg.textContent = body;
      return;
    }
    btn.disabled = true;
    msg.className = "msg info";
    msg.textContent = "One moment...";
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        onOk(data, form, msg);
      } else {
        msg.className = "msg err";
        msg.textContent = data.error || "Something went wrong.";
      }
    } catch {
      msg.className = "msg err";
      msg.textContent = "Network trouble. Try again.";
    } finally {
      btn.disabled = false;
    }
  });
}

wire(
  "login-form",
  "login-msg",
  "/api/login",
  (f) => ({ username: f.get("username"), password: f.get("password") }),
  () => { location.href = "/app/"; }
);

wire(
  "apply-form",
  "apply-msg",
  "/api/signup",
  (f) => {
    if (f.get("password") !== f.get("confirm")) return "Passwords do not match.";
    return { username: f.get("username"), password: f.get("password"), confirm: f.get("confirm") };
  },
  (data, form, msg) => {
    form.reset();
    msg.className = "msg ok";
    msg.textContent = data.message || "Application sent, waiting for approval";
  }
);
