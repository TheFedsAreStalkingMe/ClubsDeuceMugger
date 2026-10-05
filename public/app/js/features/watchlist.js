// Item IDs that are always scanned.

import { $, el } from "/js/core/dom.js";
import { STORE, save } from "/js/core/storage.js";
import { state } from "../state.js";

export function renderWatch() {
  const box = $("chips");
  box.replaceChildren();
  if (!state.watch.length) box.append(el("span", { class: "hint", text: "No items yet. Add an item ID above." }));
  state.watch.forEach((w, i) => {
    const remove = el("button", { type: "button", "aria-label": `Remove item ${w.id}`, text: "✕" });
    remove.addEventListener("click", () => {
      state.watch.splice(i, 1);
      save(STORE.watch, state.watch);
      renderWatch();
    });
    box.append(el("span", { class: "chip" }, el("span", { text: w.name ? `${w.name} (#${w.id})` : `#${w.id}` }), remove));
  });
}

export function initWatch() {
  $("watch-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const id = parseInt($("watch-id").value, 10);
    if (!Number.isInteger(id) || id < 1 || id > 9999999) return;
    if (!state.watch.some((w) => w.id === id)) {
      state.watch.push({ id });
      save(STORE.watch, state.watch);
    }
    $("watch-id").value = "";
    renderWatch();
  });
  renderWatch();
}
