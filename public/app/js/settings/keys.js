// Settings: API key (this browser, optionally locked on the account) and FF Scouter sign up.

import { api } from "/js/core/api.js";
import { $, say } from "/js/core/dom.js";
import { STORE, loadKeys, remove, save } from "/js/core/storage.js";

const KEY_FORMAT = /^[A-Za-z0-9]{8,64}$/;

let accountSaved = false; // is a key currently saved on the account?

function fillFields(keys) {
  $("key-torn").value = keys.torn || "";
  $("key-ff").value = keys.ff || "";
}

// The password box only matters while "keep it on my account" is ticked.
function showPasswordRow() {
  $("pass-row").hidden = !$("save-account").checked;
}

async function loadAccountState() {
  try {
    const r = await api("/api/account/key");
    accountSaved = r.saved;
    $("save-account").checked = r.saved;
    showPasswordRow();
    if (r.locked) {
      say("keys-msg", "Your saved key is locked. Sign out and back in to unlock it.", "info");
    } else if (r.saved && !$("key-torn").value) { // new browser: pull the saved key down
      const keys = { torn: r.keys.torn || "", ff: r.keys.ff || "" };
      fillFields(keys);
      save(STORE.keys, keys);
      say("keys-msg", "Loaded your saved key.", "ok");
    }
  } catch { /* the box just stays off */ }
}

async function saveKeys() {
  const torn = $("key-torn").value.trim(), ff = $("key-ff").value.trim();
  if (!torn) return say("keys-msg", "Paste your Torn key first.", "err");
  if ([torn, ff].some((k) => k && !KEY_FORMAT.test(k))) return say("keys-msg", "Keys are letters and numbers only.", "err");

  const keepOnAccount = $("save-account").checked;
  const password = $("key-pass").value;
  if (keepOnAccount && !password) return say("keys-msg", "Enter your password to keep the key on your account.", "err");

  save(STORE.keys, { torn, ff });
  try {
    if (keepOnAccount) {
      await api("/api/account/key", { method: "POST", body: { torn, ff, password } });
      accountSaved = true;
      $("key-pass").value = "";
      say("keys-msg", "Saved here and on your account.", "ok");
    } else if (accountSaved) {
      await api("/api/account/key", { method: "POST", body: { clear: true } });
      accountSaved = false;
      say("keys-msg", "Saved here. Removed from your account.", "ok");
    } else {
      say("keys-msg", "Saved on this device.", "ok");
    }
  } catch (e) {
    say("keys-msg", `Saved on this device, but not on your account: ${e.message}`, "err");
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
      showPasswordRow();
    } catch { /* keep going */ }
  }
  say("keys-msg", "Key cleared.", "info");
}

// ---- FF Scouter: is this key signed up with them? If not, offer to sign it up (needs the consent tick).

async function testFfKey() {
  const key = $("key-ff").value.trim() || $("key-torn").value.trim();
  if (!KEY_FORMAT.test(key)) return say("keys-msg", "Paste your key first.", "err");
  say("keys-msg", "Asking FF Scouter...", "info");
  $("register-box").hidden = true;
  try {
    const r = await api("/api/ffscouter/check", { headers: { "X-FF-Key": key } });
    if (r.registered) return say("keys-msg", "FF Scouter knows this key. Stat estimates will work.", "ok");
    say("keys-msg", "FF Scouter does not know this key yet. Sign up below, wait about 5 minutes, then check again.", "err");
    $("register-box").hidden = false;
  } catch (e) {
    say("keys-msg", e.message, "err");
  }
}

async function registerFfKey() {
  const key = $("key-torn").value.trim();
  if (!KEY_FORMAT.test(key)) return say("keys-msg", "Paste your Torn key in step 2 first.", "err");
  if (!$("ff-agree").checked) return say("keys-msg", "Tick the box to agree to the FF Scouter policy.", "err");
  say("keys-msg", "Signing up...", "info");
  try {
    const r = await api("/api/ffscouter/register", { method: "POST", headers: { "X-FF-Key": key }, body: { agree: true } });
    $("register-box").hidden = true;
    say("keys-msg", `${r.message} Wait about 5 minutes, then check again.`, "ok");
  } catch (e) {
    say("keys-msg", e.message, "err");
  }
}

export function initKeys() {
  fillFields(loadKeys());
  loadAccountState();
  $("save-account").addEventListener("change", showPasswordRow);
  $("save-keys").addEventListener("click", saveKeys);
  $("clear-keys").addEventListener("click", clearKeys);
  $("test-ff").addEventListener("click", testFfKey);
  $("ff-register").addEventListener("click", registerFfKey);
}
