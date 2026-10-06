// Why a mug took what it did: compares what the page predicted when Attack was tapped with what Torn's attack log shows.
// Pure: given one outcome row from /api/mug/outcomes, returns { status, lines }.

import { fmtShortMoney } from "/js/core/format.js";

const RESULT_HINTS = {
  Lost: "You lost the fight. Their stats may be higher than the estimate: check the fair fight before hitting.",
  Stalemate: "The fight was a stalemate. Their stats may be close to yours.",
  Hospitalized: "You hospitalized them instead of mugging. Choose Mug at the end of the fight.",
  Attacked: "The fight ended without a mug.",
  Escape: "They escaped.",
  Timeout: "The fight timed out.",
  "No attack seen": "No attack on them was found in your attack log within 3 hours of the tap.",
};

export function explainOutcome(o) {
  const fm = (n) => (n == null ? "?" : fmtShortMoney(n));
  if (o.matched === 0) {
    return { status: "Waiting", lines: ["Waiting for an attack on them in your Torn attack log. It is checked every minute while a finder page is open."] };
  }
  if (o.result !== "Mugged") {
    return { status: o.result === "No attack seen" ? "No attack" : o.result || "Closed", lines: [RESULT_HINTS[o.result] || `The attack ended as "${o.result}", so nothing was mugged.`] };
  }
  const ratio = o.predicted > 0 ? o.actual / o.predicted : null;
  const lines = [o.predicted > 0 ? `Predicted ${fm(o.predicted)}, took ${fm(o.actual)} (${Math.round(ratio * 100)}% of the prediction).` : `Took ${fm(o.actual)}. No prediction was saved for this one.`];
  let status = "Mugged";
  if (ratio != null && ratio >= 0.8 && ratio <= 1.25) status = "On target";
  else if (ratio != null && ratio > 1.25) {
    status = "Above prediction";
    lines.push("More than predicted: they held more cash than the wage estimate. Their net worth may be a better guide.");
  } else if (ratio != null) {
    status = ratio >= 0.4 ? "Below prediction" : "Far below";
    if (o.others_24h > 0) lines.push(`${o.others_24h} other member mug${o.others_24h === 1 ? "" : "s"} hit them in the 24 hours before, taking cash first.`);
    else if (o.recent_mugs > 0) lines.push(`The site already knew of ${o.recent_mugs} recent mug${o.recent_mugs === 1 ? "" : "s"} when you opened them.`);
    if (o.hosp) lines.push("They were in hospital after a mug when you opened them, so their cash had just been taken.");
    if (!o.others_24h && !o.recent_mugs && !o.hosp) lines.push("No recent mugs are known. They probably spent or banked their cash, or the wage estimate is too high. Torn's mug percentage also varies from fight to fight.");
  }
  return { status, lines };
}
