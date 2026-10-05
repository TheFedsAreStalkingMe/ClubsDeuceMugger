// A key saved to the account follows you to a new browser.

import { api } from "/js/core/api.js";
import { STORE, save } from "/js/core/storage.js";
import { state } from "../state.js";

export async function loadAccountKeys() {
  if (state.keys.torn) return;
  try {
    const r = await api("/api/account/key");
    if (r.saved && r.keys && r.keys.torn) {
      state.keys = { torn: r.keys.torn, ff: r.keys.ff || "" };
      save(STORE.keys, state.keys);
    }
  } catch { /* no saved key */ }
}
