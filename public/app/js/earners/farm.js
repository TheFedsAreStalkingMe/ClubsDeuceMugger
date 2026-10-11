// The farm list (from the mugging guides and Mug.City): players you have already mugged. A good mug can be farmed again
// and again, every 12 hours, for as long as they stay offline ("if the player provides millions and is still offline, mug
// them whenever you have the energy"). The server lists your mugs (/api/mug/targets, no Torn calls); then the page looks
// at the best few (1 Torn call each) to see whether each one is STILL offline since your mug, and when they are ready again.

import { api } from "/js/core/api.js";
import { el } from "/js/core/dom.js";
import { fmtShortMoney } from "/js/core/format.js";
import { state } from "../state.js";
import { attackLink, muggedButton } from "../features/cards.js";
import { mugVerdict } from "../features/outcomes.js";
import { recovery } from "../features/recent.js";
import { tornCall } from "../features/torncall.js";

const HOURS = 12;
const MAX_CHECKED = 10;

// -> { tone, text, ready } for one farm-list entry. `p` is the player's current profile (or null when not checked).
export function farmStatus(t, p, now = Date.now() / 1000) {
  const hours = Math.max(0, (now - t.last_at) / 3600);
  const wait = Math.max(0, HOURS - hours);
  const timing = wait > 0 ? `ready in ${Math.ceil(wait)}h (${Math.round(recovery(hours) * 100)}% of a full mug now)` : "ready now";
  if (!p) return { tone: "", ready: wait <= 0, text: `${timing}; not checked yet` };
  const back = p.last_action && p.last_action.timestamp > t.last_at;
  if (back) return { tone: "bad", ready: false, text: `they were online again after your mug: the money may have moved (${timing})` };
  return { tone: wait <= 0 ? "good" : "mediocre", ready: wait <= 0, text: `still offline since your mug: ${timing}` };
}

export async function renderFarm(box) {
  let list;
  try {
    list = (await api("/api/mug/targets")).targets;
  } catch (e) {
    box.replaceChildren(el("p", { class: "hint", text: e.message }));
    return;
  }
  if (!list.length) {
    box.replaceChildren(el("p", { class: "hint", text: "No mugs yet. Once the site has seen you mug someone (tap Attack on a card, then mug), they appear here to farm again." }));
    return;
  }
  // the best ones first: the biggest average, then the oldest mug (ready sooner)
  list.sort((a, b) => b.avg - a.avg || a.last_at - b.last_at);
  const profiles = new Map();
  const draw = () => {
    const rows = list.map((t) => ({ t, p: profiles.get(t.target_id) || null, s: farmStatus(t, profiles.get(t.target_id) || null) }));
    rows.sort((a, b) => (b.s.ready && b.s.tone === "good") - (a.s.ready && a.s.tone === "good") || (a.s.tone === "bad") - (b.s.tone === "bad") || b.t.avg - a.t.avg);
    box.replaceChildren(...rows.map(({ t, p, s }) => {
      const v = mugVerdict({ matched: 1, result: "Mugged", actual: t.last_actual, predicted: t.last_predicted });
      return el("article", { class: "card target" },
        el("h3", { class: "name", text: p && p.name ? p.name : `Player ${t.target_id}` }),
        el("p", { class: "sub", text: `ID ${t.target_id} · mugged ${t.n} time${t.n === 1 ? "" : "s"}, average ${fmtShortMoney(t.avg)}, best ${fmtShortMoney(t.best)}` }),
        el("p", {}, el("span", { class: `rating ${v.tone}`, text: `${v.label}: last took ${fmtShortMoney(t.last_actual || 0)}` }), " ", el("span", { class: s.tone ? `rating ${s.tone}` : "", text: s.text })),
        p && p.networth != null ? el("p", { class: "sub", text: `Net worth now ${fmtShortMoney(p.networth)}` }) : null,
        el("div", { class: "btns" },
          el("a", { class: "btn small ghost", href: `https://www.torn.com/profiles.php?XID=${t.target_id}`, target: "_blank", rel: "noopener noreferrer", text: "Profile" }),
          muggedButton(t.target_id),
          attackLink(t.target_id, () => ({ src: "earners", mug: t.avg, cash: 0, recent: 0 }))));
    }));
  };
  draw();
  document.addEventListener("cdm:mugged", draw);

  if (!state.keys.torn) return;
  try {
    if (!state.ctrl || state.ctrl.signal.aborted) state.ctrl = new AbortController();
    for (const t of list.slice(0, MAX_CHECKED)) {
      profiles.set(t.target_id, await tornCall(`/api/torn/player?id=${t.target_id}`, state.runId));
      draw();
    }
  } catch { /* the list is still useful without the status check */ }
}
