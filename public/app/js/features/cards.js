// One listing as a card, and the live status text on it.

import { el } from "/js/core/dom.js";
import { fmtAgo, fmtCountdown, fmtMoney, fmtShortAgo, fmtStats } from "/js/core/format.js";
import { trackAttack } from "./tracking.js";

export function attackLink(id) {
  const a = el("a", {
    class: "btn small", href: `https://www.torn.com/loader.php?sid=attack&user2ID=${id}`,
    target: "_blank", rel: "noopener noreferrer", text: "Attack",
  });
  a.addEventListener("click", () => trackAttack(id));
  return a;
}

const bazaarLink = (id) =>
  el("a", { class: "btn small ghost", href: `https://www.torn.com/bazaar.php?userId=${id}`, target: "_blank", rel: "noopener noreferrer", text: "Bazaar" });

function statsText(r) {
  if (r.bs == null) return "?";
  const spyAge = r.src === "Spy" && r.spyTs ? ` (${fmtAgo(Date.now() / 1000 - r.spyTs).split(" ")[0]} old)` : "";
  return `${fmtStats(r.bs)} ${r.src || "Est."}${spyAge}`;
}

// opts.found: seconds since a feed mug was found. opts.dismiss: makes an X button.
export function card(r, index, opts = {}) {
  const status = el("span", { class: "status pending", text: "Checking..." });
  status.dataset.pid = r.id;
  status.dataset.until = r.until && r.state !== "Okay" ? r.until : "";
  status.dataset.state = r.state || "";
  status.dataset.known = r.state == null ? "" : "1";

  const row = (label, value) => [el("dt", { text: label }), el("dd", {}, value)];
  // A time that keeps counting up on its own (see refreshStatuses).
  const ago = (kind, ts) => {
    const span = el("span", { class: "ago", text: "?" });
    Object.assign(span.dataset, { pid: r.id, kind, ts: ts || "" });
    return span;
  };
  const dl = el("dl", {},
    ...row("Price", `${fmtMoney(r.price)} × ${r.qty}`),
    ...row("Market", r.market ? `${fmtMoney(r.market)} (${Math.round((r.price / r.market) * 100)}%)` : "?"),
    ...row("Total", fmtMoney(r.total)),
    ...row("Activity", r.activity != null ? `${r.activity} changed/hr${r.bazaars ? `, ${r.bazaars} bazaars` : ""}` : "?"),
    ...row("Stats", statsText(r)),
    ...row("Fair fight", r.ff != null ? Number(r.ff).toFixed(2) : "?"),
    ...row("Account age", r.age != null ? `${Number(r.age).toLocaleString("en-US")} days` : "?"),
    ...(opts.found != null ? row("Found", fmtAgo(opts.found)) : []),
    ...row("Last seen", ago("last", r.last)),
    ...row("Checked", ago("checked", r.checkedAt ? r.checkedAt / 1000 : 0)),
    ...row("Status", status)
  );

  const art = el("article", { class: "card hover target" },
    el("h3", { class: "name", text: r.name }),
    el("p", { class: "sub", text: `ID ${r.id} · ${r.itemName}` }),
    dl,
    el("div", { class: "btns" }, bazaarLink(r.id), attackLink(r.id))
  );
  if (opts.dismiss) {
    const x = el("button", { class: "x", type: "button", "aria-label": "Dismiss", text: "X" });
    x.addEventListener("click", opts.dismiss);
    art.prepend(x);
  }
  art.style.animationDelay = `${Math.min(index, 12) * 40}ms`; // CSSOM is allowed by the CSP, a style attribute is not
  return art;
}

// Called every second: live "Out in 12m 40s" text and "12s ago" times. Only touches the page when the text changed.
export function refreshStatuses(now) {
  for (const s of document.querySelectorAll(".status")) {
    if (!s.dataset.known) continue;
    const until = Number(s.dataset.until);
    const st = s.dataset.state;
    let cls, text;
    if (st === "Okay") { cls = "status okay"; text = "Okay"; }
    else if (st === "Unknown") { cls = "status pending"; text = "Unknown"; }
    else if (until && until > now) { cls = "status out"; text = `${st === "Hospital" ? "" : `${st}: `}${st === "Hospital" ? "Out" : "out"} in ${fmtCountdown(until - now)}`; }
    else if (!until && st) { cls = "status out"; text = st; } // away with no timer, for example Abroad
    else { cls = "status okay"; text = "Okay"; } // the timer ran out
    if (s.className !== cls) s.className = cls;
    if (s.textContent !== text) s.textContent = text;
  }
  for (const a of document.querySelectorAll(".ago")) {
    const ts = Number(a.dataset.ts);
    const text = !ts ? "?" : a.dataset.kind === "checked" ? fmtShortAgo(now - ts) : fmtAgo(now - ts);
    if (a.textContent !== text) a.textContent = text;
  }
}
