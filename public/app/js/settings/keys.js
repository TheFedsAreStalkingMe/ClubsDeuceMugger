// Settings: API keys (this browser, optionally the account) and FF Scouter registration.

import { api } from "/js/core/api.js";
import { $, say } from "/js/core/dom.js";
import { STORE, loadKeys, remove, save } from "/js/core/storage.js";

const TORN_KEY = /^[A-Za-z0-9]{8,64}$/;
const TORNSTATS_KEY = /^[A-Za-z0-9_-]{8,64}$/;

let accountSaved = false; // is a key currently saved on the account?

function fillFields(keys) {
  $("key-torn").value = keys.torn || "";
  $("key-ff").value = keys.ff || "";
  $("key-ts").value = keys.ts || "";
}

async function loadAccountState() {
  try {
    const r = await api("/api/account/key");
    if (!r.available) {
      $("save-account").disabled = true;
      $("save-account-hint").textContent = "Saving to your account is not turned on yet. The site owner needs to finish setup.";
      return;
    }
    accountSaved = r.saved;
    $("save-account").checked = r.saved;
    if (r.saved && !$("key-torn").value) { // new browser: pull the saved key down
      const keys = { torn: r.keys.torn || "", ff: r.keys.ff || "", ts: r.keys.ts || "" };
      fillFields(keys);
      save(STORE.keys, keys);
      say("keys-msg", "Loaded your saved key from your account.", "ok");
    }
  } catch { /* the checkbox just stays off */ }
}

async function saveKeys() {
  const torn = $("key-torn").value.trim(), ff = $("key-ff").value.trim(), ts = $("key-ts").value.trim();
  if (!torn) return say("keys-msg", "Paste your Torn key first.", "err");
  if ([torn, ff].some((k) => k && !TORN_KEY.test(k))) return say("keys-msg", "Keys should be letters and numbers only.", "err");
  if (ts && !TORNSTATS_KEY.test(ts)) return say("keys-msg", "The TornStats key has odd characters. Check it.", "err");
  save(STORE.keys, { torn, ff, ts });

  const wantAccount = $("save-account").checked && !$("save-account").disabled;
  try {
    if (wantAccount) {
      await api("/api/account/key", { method: "POST", body: { torn, ff, ts } });
      accountSaved = true;
      say("keys-msg", "Saved in this browser and to your account.", "ok");
    } else if (accountSaved) {
      await api("/api/account/key", { method: "POST", body: { clear: true } });
      accountSaved = false;
      say("keys-msg", "Saved in this browser. Removed from your account.", "ok");
    } else {
      say("keys-msg", "Saved in this browser only.", "ok");
    }
  } catch (e) {
    say("keys-msg", `Saved in this browser, but not to your account: ${e.message}`, "err");
  }
}

async function clearKeys() {
  remove(STORE.keys);
  fillFields({});
  if (accountSaved) {
    try {
      await api("/api/account/key", { method: "POST", body: { clear: true } });
      accountSaved = false;
      $("save-account").checked = false;
    } catch { /* keep going */ }
  }
  say("keys-msg", "Key cleared.", "info");
}

// ---- FF Scouter: is this key registered with them? If not, offer to register it (needs the consent tick).

async function testFfKey() {
  const key = $("key-ff").value.trim() || $("key-torn").value.trim();
  if (!TORN_KEY.test(key)) return say("keys-msg", "Paste your key first.", "err");
  say("keys-msg", "Asking FF Scouter...", "info");
  $("register-box").hidden = true;
  try {
    const r = await api("/api/ffscouter/check", { headers: { "X-FF-Key": key } });
    if (r.registered) return say("keys-msg", "FF Scouter knows this key. Stat estimates will work.", "ok");
    say("keys-msg", "FF Scouter does not know this key yet. Register it below, then wait about 5 minutes and test again.", "err");
    $("register-box").hidden = false;
  } catch (e) {
    say("keys-msg", e.message, "err");
  }
}

async function registerFfKey() {
  const key = $("key-torn").value.trim();
  if (!TORN_KEY.test(key)) return say("keys-msg", "Paste your Torn key in the Torn API key box first.", "err");
  if (!$("ff-agree").checked) return say("keys-msg", "Tick the box to confirm you read the FF Scouter policy.", "err");
  say("keys-msg", "Registering...", "info");
  try {
    const r = await api("/api/ffscouter/register", { method: "POST", headers: { "X-FF-Key": key }, body: { agree: true } });
    $("register-box").hidden = true;
    say("keys-msg", `${r.message} Wait about 5 minutes, then tap Test key again.`, "ok");
  } catch (e) {
    say("keys-msg", e.message, "err");
  }
}

export function initKeys() {
  fillFields(loadKeys());
  loadAccountState();
  $("save-keys").addEventListener("click", saveKeys);
  $("clear-keys").addEventListener("click", clearKeys);
  $("test-ff").addEventListener("click", testFfKey);
  $("ff-register").addEventListener("click", registerFfKey);
}
