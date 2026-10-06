// The Bonus Weapon Sellers page (/app/bonus.html). Wires the pieces together.

import { api } from "/js/core/api.js";
import { $ } from "/js/core/dom.js";
import { watchForUpdates } from "/js/core/update.js";
import { loadAccountKeys } from "../features/account-keys.js";
import { refreshStatuses } from "../features/cards.js";
import { startMugWatch } from "../features/tracking.js";
import { startRowWatch } from "../features/watch.js";
import { state } from "../state.js";
import { initBonusFilters } from "../bonus/filters.js";
import { bonus } from "../bonus/state.js";
import { render } from "../bonus/results.js";
import { cancelBonus, scanBonus } from "../bonus/scan.js";

async function boot() {
  let me;
  try {
    me = await api("/api/me");
    $("who").textContent = me.username;
  } catch { return; }

  await loadAccountKeys();
  $("setup-note").hidden = !!state.keys.torn;
  initBonusFilters();
  render();
  $("scan").addEventListener("click", scanBonus);
  $("cancel").addEventListener("click", cancelBonus);
  $("logout").addEventListener("click", async () => {
    try { await api("/api/logout", { method: "POST", body: {} }); } catch { /* sign out anyway */ }
    location.href = "/";
  });
  setInterval(() => refreshStatuses(Date.now() / 1000), 1000);
  startMugWatch();
  startRowWatch({ rows: () => bonus.rows, render });
}

boot();

watchForUpdates();
