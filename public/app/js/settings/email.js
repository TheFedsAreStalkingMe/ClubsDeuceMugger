// Settings: the account's email address.

import { api } from "/js/core/api.js";
import { $, say } from "/js/core/dom.js";

export async function initEmail() {
  $("save-email").addEventListener("click", async () => {
    try {
      await api("/api/account/email", { method: "POST", body: { email: $("acct-email").value, password: $("acct-pass").value } });
      $("acct-pass").value = "";
      say("email-msg", "Saved. We emailed a notice.", "ok");
    } catch (e) {
      say("email-msg", e.message, "err");
    }
  });
  try {
    $("acct-email").value = (await api("/api/me")).email || "";
  } catch (e) {
    say("email-msg", e.message, "err");
  }
}
