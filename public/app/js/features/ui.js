// Scan feedback: the message line, the progress bar and the run buttons.

import { $ } from "/js/core/dom.js";
import { sleep } from "/js/core/async.js";
import { state } from "../state.js";

export function setScanMsg(text, kind = "info") {
  const m = $("scan-msg");
  m.className = `msg ${kind}`;
  m.textContent = text;
}

export const setProgress = (fraction) => { $("bar").style.width = `${Math.round(fraction * 100)}%`; };

// The bar is split into stages. phase(0.25, 0.5)(0.4) fills the bar to 25% + 40% of the next 25%.
export const phase = (from, to) => (fraction) => setProgress(from + (to - from) * Math.min(1, Math.max(0, fraction)));
export const STAGES = {
  items: phase(0, 0.25), // reading bazaars
  estimates: phase(0.25, 0.5), // FF Scouter
  spies: phase(0.5, 0.6), // TornStats
  status: phase(0.6, 1), // Torn status checks
};

// Waits while counting down on screen, once a second. Stops early if the scan is cancelled.
export async function countdown(sec, label, runId) {
  for (let t = Math.ceil(sec); t > 0; t--) {
    if (runId !== state.runId) return;
    setScanMsg(`${label} ${t}s`);
    await sleep(1000);
  }
}

export function updateRunButtons() {
  const auto = $("auto");
  auto.textContent = state.auto ? "Stop auto hunt" : "Start auto hunt";
  auto.disabled = state.scanning && !state.auto;
  $("cancel").hidden = !(state.scanning || state.auto);
}
