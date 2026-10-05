// The Inactive Earners page (/app/earners.html). Wires the pieces together.

import { api } from "/js/core/api.js";
import { $, el } from "/js/core/dom.js";
import { watchForUpdates } from "/js/core/update.js";
import { refreshStatuses } from "../features/cards.js";
import { loadAccountKeys } from "../features/account-keys.js";
import { setScanMsg } from "../features/ui.js";
import { state } from "../state.js";
import { loadTypes } from "../earners/data.js";
import { initEarnFilters, renderTypes, showTypesError } from "../earners/filters.js";
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
  render();
  $("scan").addEventListener("click", scanEarners);
  $("cancel").addEventListener("click", cancelEarners);
  $("logout").addEventListener("click", async () => {
    try { await api("/api/logout", { method: "POST", body: {} }); } catch { /* sign out anyway */ }
    location.href = "/";
  });
  setInterval(() => refreshStatuses(Date.now() / 1000), 1000);

  loadTypeList();
}

// The list of company types (cached for a day). A failure is shown in the list itself, with a Try again button.
async function loadTypeList() {
  if (!state.keys.torn) return $("types").replaceChildren(el("span", { class: "hint", text: "Add your Torn key in Settings (on this device, or saved to your account) to load the list." }));
  try {
    await loadTypes((path) => api(path, { headers: { "X-Torn-Key": state.keys.torn } }));
    renderTypes();
  } catch (e) {
    showTypesError(e.message, () => { $("types").replaceChildren(el("span", { class: "hint", text: "Loading..." })); loadTypeList(); });
  }
}

boot();

watchForUpdates();
