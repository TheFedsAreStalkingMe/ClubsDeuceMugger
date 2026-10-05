// Choose a new password using the emailed link.

import { postJson } from "/js/core/api.js";
import { $, say } from "/js/core/dom.js";

const token = new URLSearchParams(location.search).get("t") || "";

$("reset-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  if (f.get("password") !== f.get("confirm")) return say("reset-msg", "Passwords do not match.", "err");
  say("reset-msg", "One moment...", "info");
  const { ok, data } = await postJson("/api/reset", { token, password: f.get("password"), confirm: f.get("confirm") });
  if (ok) {
    e.target.reset();
    say("reset-msg", "Password changed. You can sign in now.", "ok");
  } else {
    say("reset-msg", data.error || "Something went wrong.", "err");
  }
});
