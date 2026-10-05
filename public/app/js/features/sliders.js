// Sliders with a number box, shared by the Mug Finder and the Inactive Earners page.

import { $ } from "/js/core/dom.js";

// Log-scale sliders so one slider covers 0 to 10 billion.
export const toLog = (n) => (n <= 1 ? 0 : Math.round(Math.log10(n) * 100));
export const fromLog = (v) => (v <= 0 ? 0 : Math.round(10 ** (v / 100)));
const same = (n) => n;

// A slider (id + "-r") kept in step with a number box (id). The number box is exact; `floor` is a minimum.
// `target` is the filters object the value is written to, `save` stores it.
export function slide(name, { to = same, from = same, floor, target, save: store } = {}) {
  const num = $(name);
  const range = $(`${name}-r`);
  const set = (v, source) => {
    if (floor != null && v < floor) v = floor;
    target[name] = v;
    if (source !== "num") num.value = v;
    if (source !== "range") range.value = to(v);
    store();
  };
  num.addEventListener("input", () => {
    const v = parseFloat(num.value);
    if (!Number.isNaN(v) && (floor == null || v >= floor)) set(v, "num");
  });
  num.addEventListener("change", () => { // fix an empty or too-small box when you leave it
    const v = parseFloat(num.value);
    set(Number.isNaN(v) ? floor ?? 0 : v);
  });
  range.addEventListener("input", () => set(from(+range.value), "range"));
  set(target[name]);
}
