// One bonus weapon listing as a card.

import { el } from "/js/core/dom.js";
import { fmtMoney, fmtStats } from "/js/core/format.js";
import { attackLink } from "../features/cards.js";

const link = (href, text, cls = "btn small ghost") => el("a", { class: cls, href, target: "_blank", rel: "noopener noreferrer", text });
const num = (n) => (n != null ? Number(n).toFixed(1) : "?");

export function bonusCard(r, index) {
  const status = el("span", { class: "status pending", text: "Checking..." });
  status.dataset.pid = r.id;
  status.dataset.until = r.until && r.state !== "Okay" ? r.until : "";
  status.dataset.state = r.state || "";
  status.dataset.known = r.state == null ? "" : "1";
  const checked = el("span", { class: "ago", text: "?" });
  Object.assign(checked.dataset, { pid: r.id, kind: "checked", ts: r.checkedAt ? r.checkedAt / 1000 : "" });

  const row = (label, value) => [el("dt", { text: label }), el("dd", {}, value)];
  const bonuses = r.bonuses.map((b) => `${b.name} ${b.value}%`).join(", ");
  const dl = el("dl", {},
    ...row("Price", fmtMoney(r.price)),
    ...row("Location", "Bazaar"),
    ...row("Damage / Acc / Quality", `${num(r.damage)} / ${num(r.accuracy)} / ${num(r.quality)}`),
    ...row("Seller", `${r.sellerName} (ID ${r.id})`),
    ...row("Est. stats", fmtStats(r.bs)),
    ...row("Fair fight", r.ff != null ? Number(r.ff).toFixed(2) : "?"),
    ...row("Account age", r.age != null ? `${Number(r.age).toLocaleString("en-US")} days` : "?"),
    ...row("Checked", checked),
    ...row("Status", status)
  );
  const art = el("article", { class: "card hover target" },
    el("h3", { class: "name", text: r.name }),
    el("p", { class: `sub rarity-${r.rarity}`, text: `${r.rarity} ${r.kind}` }),
    el("p", { class: "bonus-line", text: bonuses }),
    dl,
    el("div", { class: "btns" }, link(`https://www.torn.com/bazaar.php?userId=${r.id}`, "Listing"), link(`https://www.torn.com/profiles.php?XID=${r.id}`, "Profile"), attackLink(r.id))
  );
  art.style.animationDelay = `${Math.min(index, 12) * 40}ms`;
  return art;
}
