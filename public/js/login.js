function wire(formId, msgId, endpoint, build, onOk, onErr) {
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
        if (onErr) onErr(data);
      }
    } catch {
      msg.className = "msg err";
      msg.textContent = "Network trouble. Try again.";
    } finally {
      btn.disabled = false;
    }
  });
}

const invite = new URLSearchParams(location.search).get("invite") || "";
const applyForm = document.getElementById("apply-form");
const sponsorForm = document.getElementById("sponsor-form");
let applyToken = "";

function showSponsorStep(token, note) {
  applyToken = token;
  applyForm.hidden = true;
  document.getElementById("no-invite").hidden = true;
  sponsorForm.hidden = false;
  if (note) {
    const m = document.getElementById("sponsor-msg");
    m.className = "msg info";
    m.textContent = note;
  }
}

if (invite) {
  document.getElementById("no-invite").hidden = true;
  applyForm.hidden = false;
}

wire(
  "login-form",
  "login-msg",
  "/api/login",
  (f) => ({ username: f.get("username"), password: f.get("password") }),
  () => { location.href = "/app/"; },
  // A pending account that never finished the sponsor step can pick it back up.
  (d) => { if (d.applyToken) showSponsorStep(d.applyToken, "Finish your application below."); }
);
wire(
  "apply-form",
  "apply-msg",
  "/api/signup",
  (f) => {
    if (f.get("password") !== f.get("confirm")) return "Passwords do not match.";
    return { username: f.get("username"), email: f.get("email"), password: f.get("password"), confirm: f.get("confirm"), invite };
  },
  (data, form) => {
    form.reset();
    showSponsorStep(data.applyToken);
  }
);

wire(
  "sponsor-form",
  "sponsor-msg",
  "/api/signup/vouch",
  (f) => ({ applyToken, inviter: f.get("inviter") }),
  () => { location.href = "/app/"; }
);
