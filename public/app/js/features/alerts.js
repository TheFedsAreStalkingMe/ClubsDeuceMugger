// "JACKPOT >:D" banners at the top: a big item, weaker than you, out soon, and offline long enough.

import { $, el } from "/js/core/dom.js";
import { fmtMoney, fmtStats } from "/js/core/format.js";
import { state } from "../state.js";
import { attackLink } from "./cards.js";
import { isMug, rowKey } from "./rules.js";

let shown = ""; // which alerts are on screen, so the page only changes when they do

export function updateAlerts(now) {
  const pf = state.prefs;
  const hits = !pf.notify || !pf.myBs ? [] : state.rows.filter((r) => isMug(r, now, true));
  const key = hits.map(rowKey).join(",");
  if (key === shown) return;
  shown = key;
  $("alerts").replaceChildren(
    ...hits.map((r) => {
      const best = [...r.items].sort((a, b) => b.price - a.price)[0];
      const more = r.items.length > 1 ? ` and ${r.items.length - 1} more` : "";
      return el("div", { class: "alert" },
        el("div", { class: "face", text: "JACKPOT >:D" }),
        el("div", { text: `${r.name} [${r.id}] has ${best.itemName} at ${fmtMoney(r.topPrice)}${more}. Est. stats ${fmtStats(r.bs)}, offline ${Math.round((now - r.last) / 60)}m.` }),
        attackLink(r.id)
      );
    })
  );
}
