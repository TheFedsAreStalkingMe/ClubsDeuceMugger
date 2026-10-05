// Scan, auto hunt and cancel buttons.

import { sleep } from "/js/core/async.js";
import { state } from "../state.js";
import { scan } from "./scan.js";
import { setProgress, setScanMsg, updateRunButtons } from "./ui.js";

// Scans again and again, collecting good mugs in the feed, until stopped.
export async function toggleAutoHunt() {
  if (state.auto) {
    state.auto = false;
    updateRunButtons();
    setScanMsg("Auto hunt stopped.", "info");
    return;
  }
  state.auto = true;
  updateRunButtons();
  while (state.auto) {
    await scan();
    if (!state.auto) break;
    if (state.outcome === "fatal") { state.auto = false; updateRunButtons(); break; } // needs fixing first
    for (let t = state.filters.autoEvery; t > 0 && state.auto; t--) {
      setScanMsg(`Auto hunt on. Next scan in ${t}s`, "info");
      await sleep(1000);
    }
  }
}

export function cancelScan() {
  state.auto = false;
  state.runId++; // running stages see this and stop
  state.scanning = false;
  if (state.ctrl) state.ctrl.abort();
  document.getElementById("scan").disabled = false;
  updateRunButtons();
  setProgress(0);
  setScanMsg("Scan cancelled.", "info");
}
