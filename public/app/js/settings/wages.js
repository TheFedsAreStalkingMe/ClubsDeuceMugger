// Settings: the assumed daily wage for the Inactive earners estimate.

import { api } from "/js/core/api.js";
import { $, el, say } from "/js/core/dom.js";
import { STORE, load, loadKeys, save } from "/js/core/storage.js";
import { loadTypes } from "../earners/data.js";
import { DEFAULT_WAGES } from "../earners/state.js";

const wages = () => ({ ...DEFAULT_WAGES, ...load(STORE.earnWages, {}) });

function saveWages() {
  const next = { base: Math.max(0, parseFloat($("w-base").value) || DEFAULT_WAGES.base), types: {} };
  for (const input of document.querySelectorAll("#w-types input")) {
    const v = parseFloat(input.value);
    if (Number.isFinite(v) && v >= 0) next.types[input.dataset.type] = v;
  }
  save(STORE.earnWages, next);
  say("wages-msg", "Saved.", "ok");
}

export async function initWages() {
  const w = wages();
  $("w-base").value = w.base;
  $("save-wages").addEventListener("click", saveWages);
  const key = loadKeys().torn;
  if (!key) return;
  try {
    const types = await loadTypes((path) => api(path, { headers: { "X-Torn-Key": key } }));
    $("w-types").replaceChildren(...types.map((t) => {
      const input = el("input", { type: "number", inputmode: "numeric", min: "0", step: "1000", placeholder: "default" });
      input.dataset.type = t.id;
      if (w.types[t.id] != null) input.value = w.types[t.id];
      return el("label", {}, t.name, input);
    }));
  } catch (e) {
    $("w-types").replaceChildren(el("span", { class: "hint", text: `Could not load company types: ${e.message}` }));
  }
}
