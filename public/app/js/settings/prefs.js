// Settings: jackpot alert rules and your own battle stats.

import { api } from "/js/core/api.js";
import { $, say } from "/js/core/dom.js";
import { STORE, load, loadKeys, save } from "/js/core/storage.js";
import { DEFAULT_PREFS } from "../state.js";

const NUMBER_FIELDS = ["minJackpot", "myBs", "outMinutes", "offlineMinutes"];

function savePrefs() {
  const next = { notify: $("p-notify").checked };
  for (const k of NUMBER_FIELDS) {
    const v = parseFloat($(`p-${k}`).value);
    next[k] = Number.isFinite(v) && v >= 0 ? v : DEFAULT_PREFS[k];
  }
  save(STORE.prefs, next);
  say("prefs-msg", "Saved.", "ok");
}

async function fetchMyStats() {
  const key = loadKeys().torn;
  if (!key) return say("prefs-msg", "Save your Torn key first.", "err");
  say("prefs-msg", "Asking Torn...", "info");
  try {
    const r = await api("/api/torn/me", { headers: { "X-Torn-Key": key } });
    if (r.error) return say("prefs-msg", r.error, "err");
    $("p-myBs").value = r.total;
    say("prefs-msg", "Got your stats. Tap Save alert settings.", "ok");
  } catch (e) {
    say("prefs-msg", e.message, "err");
  }
}

export function initPrefs() {
  const prefs = { ...DEFAULT_PREFS, ...load(STORE.prefs, {}) };
  $("p-notify").checked = !!prefs.notify;
  for (const k of NUMBER_FIELDS) $(`p-${k}`).value = prefs[k];
  $("save-prefs").addEventListener("click", savePrefs);
  $("fetch-bs").addEventListener("click", fetchMyStats);
}
