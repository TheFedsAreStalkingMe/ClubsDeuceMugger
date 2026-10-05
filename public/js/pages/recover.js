// Ask for a password reset link.

import { postJson } from "/js/core/api.js";
import { $, say } from "/js/core/dom.js";

$("recover-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  say("recover-msg", "One moment...", "info");
  const { ok, data } = await postJson("/api/recover", { who: new FormData(e.target).get("who") });
  say("recover-msg", ok ? data.message : data.error || "Something went wrong.", ok ? "ok" : "err");
});
