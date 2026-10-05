// Sign in, and apply for an account (invite link, then name the member who invited you).

import { postJson } from "/js/core/api.js";
import { $, say } from "/js/core/dom.js";

// Submits a form to an endpoint and shows the outcome under it.
//   build(formData) returns the request body, or a string to show as an error without sending.
function wire({ form, msg, endpoint, build, onOk, onError }) {
  const el = $(form);
  el.addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = build(new FormData(el));
    if (typeof body === "string") return say(msg, body, "err");

    const button = el.querySelector("button[type=submit]");
    button.disabled = true;
    say(msg, "One moment...", "info");
    const { ok, data } = await postJson(endpoint, body);
    button.disabled = false;
    if (ok) return onOk(data, el);
    say(msg, data.error || "Something went wrong.", "err");
    if (onError) onError(data);
  });
}

const invite = new URLSearchParams(location.search).get("invite") || "";
let applyToken = "";

// Step 2 of applying: type who invited you.
function showVouchStep(token, note) {
  applyToken = token;
  $("apply-form").hidden = true;
  $("no-invite").hidden = true;
  $("sponsor-form").hidden = false;
  if (note) say("sponsor-msg", note, "info");
}

if (invite) {
  $("no-invite").hidden = true;
  $("apply-form").hidden = false;
}

wire({
  form: "login-form",
  msg: "login-msg",
  endpoint: "/api/login",
  build: (f) => ({ username: f.get("username"), password: f.get("password") }),
  onOk: () => { location.href = "/app/"; },
  // A pending account that never finished step 2 can pick it up here.
  onError: (d) => { if (d.applyToken) showVouchStep(d.applyToken, "Finish your application below."); },
});

wire({
  form: "apply-form",
  msg: "apply-msg",
  endpoint: "/api/signup",
  build: (f) =>
    f.get("password") !== f.get("confirm")
      ? "Passwords do not match."
      : { username: f.get("username"), email: f.get("email"), password: f.get("password"), confirm: f.get("confirm"), invite },
  onOk: (data, form) => { form.reset(); showVouchStep(data.applyToken); },
});

wire({
  form: "sponsor-form",
  msg: "sponsor-msg",
  endpoint: "/api/signup/vouch",
  build: (f) => ({ applyToken, inviter: f.get("inviter") }),
  onOk: () => { location.href = "/app/"; },
});
