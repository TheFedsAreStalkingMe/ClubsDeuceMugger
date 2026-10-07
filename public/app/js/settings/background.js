// Settings: the background search (src/lib/hunt.js). Turning it on sends your Torn key, your Inactive Earners filters, wages
// and mugging bonuses to the server, which runs the search on a schedule and emails the best targets.

import { api } from "/js/core/api.js";
import { $, say } from "/js/core/dom.js";
import { STORE, load, loadKeys } from "/js/core/storage.js";

const ago = (t) => {
  if (!t) return "not run yet";
  const m = Math.max(0, Math.round((Date.now() / 1000 - t) / 60));
  return m < 1 ? "just now" : m < 120 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};

function show(r) {
  $("bg-on").textContent = r.enabled ? "Update" : "Turn on";
  $("bg-run").hidden = $("bg-off").hidden = !r.enabled;
  if (!r.available) say("bg-state", "Not available yet: the site owner has to add the BG_SECRET secret (see the README).", "info");
  else if (!r.hasEmail) say("bg-state", "Add your email below first: results are emailed to you.", "info");
  else say("bg-state", r.enabled ? `On. Last run ${ago(r.lastRun)}: ${r.lastMsg}` : "Off.", r.enabled ? "ok" : "info");
  if (r.config) $("bg-min").value = r.config.minMug;
}

export async function initBackground() {
  const refresh = async () => { try { show(await api("/api/hunt")); } catch (e) { say("bg-state", e.message, "err"); } };
  await refresh();

  $("bg-on").addEventListener("click", async () => {
    const earn = load(STORE.earnFilters, {}) || {};
    const prefs = load(STORE.prefs, {}) || {};
    const wages = load(STORE.earnWages, {}) || {};
    const config = {
      ...earn, wages, merits: prefs.merits, meritBoost: prefs.meritBoost, plunder: prefs.plunder,
      hideHours: prefs.hideMuggedHours, minMug: Number($("bg-min").value) || 0,
    };
    say("bg-msg", "Checking your key with Torn...", "info");
    try {
      await api("/api/hunt", { method: "POST", body: { tornKey: $("bg-key").value.trim() || loadKeys().torn || "", ffKey: loadKeys().ff || "", password: $("bg-pass").value, config } });
      $("bg-pass").value = "";
      $("bg-key").value = "";
      say("bg-msg", "Saved. It starts at the next scheduled run (within a few minutes). Change the filters on the Inactive Earners page, then tap Update to send them.", "ok");
      await refresh();
    } catch (e) {
      say("bg-msg", e.message, "err");
    }
  });

  $("bg-run").addEventListener("click", async () => {
    say("bg-msg", "Running one step...", "info");
    try {
      const r = await api("/api/hunt/run", { method: "POST", body: {} });
      say("bg-msg", r.ran ? r.lastMsg : "Nothing ran (turned off, or the server has no secret).", r.ran ? "ok" : "info");
      show(r);
    } catch (e) {
      say("bg-msg", e.message, "err");
    }
  });

  $("bg-off").addEventListener("click", async () => {
    try {
      await api("/api/hunt/off", { method: "POST", body: {} });
      say("bg-msg", "Turned off. Your key was deleted from the server.", "ok");
      await refresh();
    } catch (e) {
      say("bg-msg", e.message, "err");
    }
  });
}
