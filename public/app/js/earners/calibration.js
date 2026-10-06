// Learning from your own mugs: when enough of your Inactive earners mugs have been matched with their prediction
// (Leaderboard page, "Your mug outcomes"), the middle ratio of actual / predicted corrects every later prediction.
// Taps save the plain prediction, so this never feeds on itself.

import { load } from "/js/core/storage.js";
import { earn } from "./state.js";

export async function loadCalibration(call) {
  try {
    const { summary } = await call("/api/mug/outcomes?src=earners");
    const minMugs = Number(load("cdm.calMin", 5)) || 5; // (the tests lower it)
    if (summary.compared >= minMugs && summary.median > 0) {
      earn.calibration = { factor: Math.min(2.5, Math.max(0.25, summary.median)), n: summary.compared };
    }
  } catch { /* predictions stay as they are */ }
}
