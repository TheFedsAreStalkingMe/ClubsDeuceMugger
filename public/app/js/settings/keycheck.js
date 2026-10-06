// Settings: "Check my key" lists each feature of the site and whether the key can do it. The make-key link is built from
// the same list (public/js/core/keyneeds.js), so they cannot drift apart.

import { api } from "/js/core/api.js";
import { $, el, say } from "/js/core/dom.js";
import { checkKey, keyLink } from "/js/core/keyneeds.js";
import { loadKeys } from "/js/core/storage.js";

export function initKeyCheck() {
  $("make-key").href = keyLink();
  $("check-key").addEventListener("click", async () => {
    const key = $("key-torn").value.trim() || loadKeys().torn;
    if (!key) return say("keycheck-msg", "Paste and save your Torn key first.", "err");
    say("keycheck-msg", "Asking Torn what this key can do...", "info");
    $("keycheck-list").replaceChildren();
    try {
      const r = await api("/api/torn/key", { headers: { "X-Torn-Key": key } });
      if (r.error) return say("keycheck-msg", r.error, "err");
      const rows = checkKey(r.selections);
      const bad = rows.filter((x) => x.missing.length);
      say("keycheck-msg", bad.length ? `This key (${r.type || "unknown type"}) is missing access for ${bad.length} feature(s). Make a new key with step 1, or edit it in Torn's API settings.` : `This key (${r.type || "unknown type"}) covers everything the site needs.`, bad.length ? "err" : "ok");
      $("keycheck-list").replaceChildren(...rows.map((x) => el("li", { class: x.missing.length ? "no" : "yes", text: x.missing.length ? `Missing: ${x.feature} (${x.missing.join(", ")})` : `Works: ${x.feature}` })));
    } catch (e) {
      say("keycheck-msg", e.message, "err");
    }
  });
}
