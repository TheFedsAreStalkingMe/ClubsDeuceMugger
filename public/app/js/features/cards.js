// One listing as a card, and the live status text on it.

import { el } from "/js/core/dom.js";
import { fmtAgo, fmtCountdown, fmtMoney, fmtShortAgo, fmtShortMoney, fmtStats } from "/js/core/format.js";
import { mugOutlook } from "./rules.js";
import { trackAttack } from "./tracking.js";

// `pred` is a function returning what the page predicted for this player (read when Attack is tapped).
export function attackLink(id, pred) {
  const a = el("a", {
    class: "btn small", href: `https://www.torn.com/page.php?sid=attack&user2ID=${id}`,
    target: "_blank", rel: "noopener noreferrer", text: "Attack",
  });
  a.addEventListener("click", () => trackAttack(id, pred ? pred() : undefined));
  return a;
}

const bazaarLink = (id) =>
  el("a", { class: "btn small ghost", href: `https://www.torn.com/bazaar.php?userId=${id}`, target: "_blank", rel: "noopener noreferrer", text: "Bazaar" });

// Everything this seller has that qualifies: single items and stacks.
function itemList(r) {
  return el("ul", { class: "items" },
    ...r.items.map((it) => {
      const detail = [`${fmtShortMoney(it.price)} each`, it.market ? `${Math.round((it.price / it.market) * 100)}% of market` : "", it.activity != null ? `${it.activity}/hr` : ""].filter(Boolean).join(" · ");
      return el("li", {},
        el("span", { class: "line" }, el("span", { text: `${it.itemName} ×${it.qty}` }), el("span", { text: fmtShortMoney(it.total) })),
        el("span", { class: "meta", text: detail }));
    }));
}

const signed = (n) => `${n < 0 ? "-" : "+"}${fmtShortMoney(Math.abs(n))}`;

// opts.found: seconds since a feed mug was found. opts.dismiss: makes an X button.
export function card(r, index, opts = {}) {
  const status = el("span", { class: "status pending", text: "Checking..." });
  status.dataset.pid = r.id;
  status.dataset.until = r.until && r.state !== "Okay" ? r.until : "";
  status.dataset.state = r.state || "";
  status.dataset.known = r.state == null ? "" : "1";

  const out = mugOutlook(r);
  const row = (label, value) => [el("dt", { text: label }), el("dd", {}, value)];
  // A time that keeps counting up on its own (see refreshStatuses).
  const ago = (kind, ts) => {
    const span = el("span", { class: "ago", text: "?" });
    Object.assign(span.dataset, { pid: r.id, kind, ts: ts || "" });
    return span;
  };
  const dl = el("dl", {},
    ...row("Total", fmtMoney(r.total)),
    ...row("Expected profit", el("span", { class: `rating ${out.rating}`, text: `${signed(out.profit)} · ${out.rating} mug`, title: `Resale ${signed(out.resale)}, mug ${signed(out.mug)} (${(out.rate * 100).toFixed(1)}% of their cash)` })),
    ...row("Est. stats", fmtStats(r.bs)),
    ...row("Fair fight", r.ff != null ? Number(r.ff).toFixed(2) : "?"),
    ...row("Account age", r.age != null ? `${Number(r.age).toLocaleString("en-US")} days` : "?"),
    ...(opts.found != null ? row("Found", fmtAgo(opts.found)) : []),
    ...row("Last seen", ago("last", r.last)),
    ...row("Checked", ago("checked", r.checkedAt ? r.checkedAt / 1000 : 0)),
    ...row("Status", status)
  );

  const art = el("article", { class: "card hover target" },
    el("h3", { class: "name", text: r.name }),
    el("p", { class: "sub", text: `ID ${r.id} · ${r.items.length} item${r.items.length === 1 ? "" : "s"}` }),
    itemList(r),
    dl,
    el("div", { class: "btns" }, bazaarLink(r.id), attackLink(r.id, () => ({ src: "bazaar", mug: mugOutlook(r).mug, cash: r.total })))
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
