// The Inactive Earners page (/app/earners.html). Wires the pieces together.

import { api } from "/js/core/api.js";
import { $, el } from "/js/core/dom.js";
import { watchForUpdates } from "/js/core/update.js";
import { refreshStatuses } from "../features/cards.js";
import { startMugWatch } from "../features/tracking.js";
import { startRowWatch } from "../features/watch.js";
import { mugScore } from "../earners/rules.js";
import { loadAccountKeys } from "../features/account-keys.js";
import { setScanMsg } from "../features/ui.js";
import { state } from "../state.js";
import { loadTypes } from "../earners/data.js";
import { loadCalibration } from "../earners/calibration.js";
import { initEarnFilters, renderTypes, showTypesError } from "../earners/filters.js";
import { earn } from "../earners/state.js";
import { render } from "../earners/results.js";
import { cancelEarners, scanEarners } from "../earners/scan.js";

async function boot() {
  let me;
  try {
    me = await api("/api/me");
    $("who").textContent = me.username;
  } catch { return; }

  await loadAccountKeys();
  $("setup-note").hidden = !!state.keys.torn;
  initEarnFilters();
  await loadCalibration((path) => api(path));
  if (earn.calibration.n) {
    const f = earn.calibration.factor;
    $("calib-note").hidden = false;
    $("calib-note").textContent = `Predictions are adjusted x${f.toFixed(2)} from your ${earn.calibration.n} real mugs (they were running ${f < 1 ? "high" : "low"}).`;
  }
  render();
  $("scan").addEventListener("click", scanEarners);
  $("cancel").addEventListener("click", cancelEarners);
  $("logout").addEventListener("click", async () => {
    try { await api("/api/logout", { method: "POST", body: {} }); } catch { /* sign out anyway */ }
    location.href = "/";
  });
  setInterval(() => refreshStatuses(Date.now() / 1000), 1000);
  startMugWatch();
  startRowWatch({ rows: () => earn.rows, render, score: (r) => mugScore(r).score });

  loadTypeList();
}

// The list of company types (cached for a day). A failure is shown in the list itself, with a Try again button.
async function loadTypeList() {
  if (!state.keys.torn) return $("types").replaceChildren(el("span", { class: "hint", text: "Add your Torn key in Settings (on this device, or saved to your account) to load the list." }));
  try {
    await loadTypes((path) => api(path, { headers: { "X-Torn-Key": state.keys.torn } }));
    renderTypes();
  } catch (e) {
    const hint = /access level/i.test(e.message) ? " Your key needs company and Torn access: make a new key with step 1 in Settings, or edit your key in Torn's API settings and tick Company and Torn." : "";
    showTypesError(e.message + hint, () => { $("types").replaceChildren(el("span", { class: "hint", text: "Loading..." })); loadTypeList(); });
  }
}

boot();

watchForUpdates();
