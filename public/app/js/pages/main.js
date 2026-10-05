// The Mug Finder page (/app/). Wires the features together.

import { api } from "/js/core/api.js";
import { $ } from "/js/core/dom.js";
import { STORE, save } from "/js/core/storage.js";
import { initAdmin } from "../features/admin.js";
import { dismissAll, forgetOldDismissals, renderFeed } from "../features/feed.js";
import { initFilters } from "../features/filters.js";
import { render, tick } from "../features/results.js";
import { cancelScan, toggleAutoHunt } from "../features/runner.js";
import { scan } from "../features/scan.js";
import { syncLeaderboard } from "../features/tracking.js";
import { updateRunButtons } from "../features/ui.js";
import { initWatch } from "../features/watchlist.js";
import { state } from "../state.js";

// A key saved to the account follows you to a new browser.
async function loadAccountKeys() {
  if (state.keys.torn) return;
  try {
    const r = await api("/api/account/key");
    if (r.saved && r.keys && r.keys.torn) {
      state.keys = { torn: r.keys.torn, ff: r.keys.ff || "", ts: r.keys.ts || "" };
      save(STORE.keys, state.keys);
    }
  } catch { /* no saved key */ }
}

async function boot() {
  let me;
  try {
    me = await api("/api/me");
    $("who").textContent = me.username;
  } catch { return; }

  await loadAccountKeys();
  $("setup-note").hidden = !!state.keys.torn;
  forgetOldDismissals();

  initWatch();
  initFilters();
  render();
  renderFeed();
  updateRunButtons();
  if (me.isOwner) initAdmin();

  $("scan").addEventListener("click", scan);
  $("auto").addEventListener("click", toggleAutoHunt);
  $("cancel").addEventListener("click", cancelScan);
  $("feed-dismiss-all").addEventListener("click", dismissAll);
  $("logout").addEventListener("click", async () => {
    try { await api("/api/logout", { method: "POST", body: {} }); } catch { /* sign out anyway */ }
    location.href = "/";
  });

  setInterval(tick, 1000);
  syncLeaderboard();
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") syncLeaderboard(); });
}

boot();
