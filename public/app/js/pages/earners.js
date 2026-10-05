// The Inactive Earners page (/app/earners.html). Wires the pieces together.

import { api } from "/js/core/api.js";
import { $ } from "/js/core/dom.js";
import { watchForUpdates } from "/js/core/update.js";
import { refreshStatuses } from "../features/cards.js";
import { loadAccountKeys } from "../features/account-keys.js";
import { setScanMsg } from "../features/ui.js";
import { state } from "../state.js";
import { loadTypes } from "../earners/data.js";
import { initEarnFilters, renderTypes } from "../earners/filters.js";
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

  // The list of company types (cached for a day).
  if (state.keys.torn) {
    try {
      await loadTypes((path) => api(path, { headers: { "X-Torn-Key": state.keys.torn } }));
      renderTypes();
    } catch (e) { setScanMsg(`Could not load company types: ${e.message}`, "err"); }
  }
}

boot();

watchForUpdates();
