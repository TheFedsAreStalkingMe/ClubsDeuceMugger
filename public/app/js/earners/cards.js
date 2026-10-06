// One inactive player as a card.

import { el } from "/js/core/dom.js";
import { fmtShortMoney, fmtStats } from "/js/core/format.js";
import { attackLink } from "../features/cards.js";
import { daysInactive, estimateCash, mugScore, predictedMug } from "./rules.js";

const profileLink = (id) =>
  el("a", { class: "btn small ghost", href: `https://www.torn.com/profiles.php?XID=${id}`, target: "_blank", rel: "noopener noreferrer", text: "Profile" });

export function earnCard(r, index) {
  const status = el("span", { class: "status pending", text: "Checking..." });
  status.dataset.pid = r.id;
  status.dataset.until = r.until && r.state !== "Okay" ? r.until : "";
  status.dataset.state = r.state || "";
  status.dataset.known = r.state == null ? "" : "1";
  const checked = el("span", { class: "ago", text: "?" });
  Object.assign(checked.dataset, { pid: r.id, kind: "checked", ts: r.checkedAt ? r.checkedAt / 1000 : "" });

  const row = (label, value) => [el("dt", { text: label }), el("dd", {}, value)];
  const idle = daysInactive(r);
  const cash = estimateCash(r);
  const c = r.company;
  const ms = mugScore(r);
  const tone = ms.score >= 55 ? "good" : ms.score >= 35 ? "mediocre" : "bad";
  const why = ms.parts.map((p) => `${p.label}: ${p.points == null ? "?" : `${p.points}/${p.max}`} (${p.note})`).join("\n");
  const mug = predictedMug(r);
  const dl = el("dl", {},
    ...row("Mug rating", el("span", { class: `rating ${tone}`, title: `${why}\nUnknown parts are left out and the rest scaled up.`, text: `${ms.label} (${ms.score}/100)` })),
    ...row("Predicted mug", el("span", { class: "rating good", title: "Estimated cash x your mug rate (5%, plus merits and Plunder from More options). A rough guess.", text: mug != null ? `~${fmtShortMoney(mug)} (rough)` : "?" })),
    ...row("Net worth", r.networth != null ? fmtShortMoney(r.networth) : "?"),
    ...row("Est. cash", el("span", { class: "rating good", title: "A rough guess: assumed daily wage (see Settings) x days inactive. Torn does not show wages.", text: cash != null ? `~${fmtShortMoney(cash)} (rough)` : "?" })),
    ...row("Days inactive", idle != null ? idle.toFixed(1) : "?"),
    ...row("Est. stats", fmtStats(r.bs)),
    ...row("Fair fight", r.ff != null ? Number(r.ff).toFixed(2) : "?"),
    ...row("Account age", r.age != null ? `${Number(r.age).toLocaleString("en-US")} days` : "?"),
    ...row("Checked", checked),
    ...row("Status", status)
  );
  const art = el("article", { class: "card hover target" },
    el("h3", { class: "name", text: r.name }),
    el("p", { class: "sub", text: `ID ${r.id} · ${r.position || "Employee"} · ${r.daysIn} days in company` }),
    el("p", { class: "sub", text: `${c.name} · ${c.typeName} · ${c.stars}★` }),
    dl,
    el("div", { class: "btns" }, profileLink(r.id), attackLink(r.id))
  );
  art.style.animationDelay = `${Math.min(index, 12) * 40}ms`;
  return art;
}
