// The Leaderboard page (/app/leaderboard.html).
// The Torn key stays in this browser and is only passed through for the check.

import { api } from "/js/core/api.js";
import { $, el, say } from "/js/core/dom.js";
import { fmtMoney } from "/js/core/format.js";
import { checkKey, keyLink } from "/js/core/keyneeds.js";
import { loadKeys } from "/js/core/storage.js";
import { explainOutcome, mugVerdict } from "../features/outcomes.js";
import { runLeaderboardCheck } from "../features/tracking.js";
import { watchForUpdates } from "/js/core/update.js";

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function boardRow(rank, r, isMe) {
  return el("div", { class: `item${isMe ? " me" : ""}` },
    el("span", { text: `${rank}.` }),
    el("span", { text: r.torn_name ? `${r.username} (${r.torn_name})` : r.username }),
    el("span", { text: fmtMoney(r.total) }),
    el("span", { class: "meta", text: `${plural(r.mugs, "mug")}, best ${fmtMoney(r.biggest)}` })
  );
}

async function loadBoard() {
  const data = await api(`/api/leaderboard?range=${$("range").value}`);
  $("board").replaceChildren(
    ...(data.rows.length
      ? data.rows.map((r, i) => boardRow(i + 1, r, r.username === data.me))
      : [el("p", { class: "empty", text: "No mugs yet. Tap Attack on a card, mug someone, then check back." })])
  );
}

// When the check fails on the key, ask Torn what the key can do and say exactly what is missing.
async function diagnoseKey(key) {
  try {
    const r = await api("/api/torn/key", { headers: { "X-Torn-Key": key } });
    if (r.error) return;
    const bad = checkKey(r.selections).filter((x) => x.missing.length);
    const items = bad.map((x) => el("li", { class: "no", text: `Missing: ${x.feature} (${x.missing.join(", ")})` }));
    items.push(el("li", {}, el("a", { href: keyLink(), target: "_blank", rel: "noopener noreferrer", text: `Make a new key with every permission (your key is: ${r.type || "unknown type"})` })));
    $("sync-diag").replaceChildren(...items);
  } catch { /* the message above already says it */ }
}

const when = (t) => new Date(t * 1000).toLocaleString();

async function loadOutcomes() {
  const d = await api("/api/mug/outcomes");
  const s = d.summary;
  const verdicts = d.rows.map(mugVerdict).filter(Boolean);
  const profit = verdicts.reduce((n, v) => n + v.profit, 0);
  const tally = verdicts.length
    ? ` Last 7 days: ${fmtMoney(profit)} taken, ${verdicts.filter((v) => v.tone === "good").length} good, ${verdicts.filter((v) => v.tone === "mediocre").length} okay and ${verdicts.filter((v) => v.tone === "bad").length} bad mug(s).`
    : "";
  $("outcome-summary").textContent = (s.compared
    ? `Across ${plural(s.compared, "mug")} compared: the middle one took ${Math.round(s.median * 100)}% of its prediction (average ${Math.round(s.mean * 100)}%).`
    : "No mugs to compare yet. Tap Attack on a card, mug them, and the comparison appears here.") + tally;
  $("outcomes").replaceChildren(...d.rows.map((o) => {
    const x = explainOutcome(o);
    return el("div", { class: "item" },
      el("span", {}, `${x.status}`, mugVerdict(o) ? el("span", { class: `rating ${mugVerdict(o).tone}`, text: ` ${mugVerdict(o).label}` }) : null),
      el("span", {}, el("a", { href: `https://www.torn.com/profiles.php?XID=${o.target_id}`, target: "_blank", rel: "noopener noreferrer", text: `Player ${o.target_id}` }), ` (${o.src || "?"}, ${when(o.clicked_at)})`),
      el("span", { text: o.matched === 1 ? `${fmtMoney(o.actual)} of ${o.predicted != null ? fmtMoney(o.predicted) : "?"}` : "" }),
      el("span", { class: "meta", text: x.lines.join(" ") }));
  }));
}

// quiet = automatic check on page load: no messages unless something is wrong.
async function checkMyMugs(quiet) {
  const key = loadKeys().torn;
  if (!key) return quiet || say("sync-msg", "Add your Torn key in Settings first.", "err");
  if (!quiet) say("sync-msg", "Checking your attacks...", "info");
  try {
    const d = await runLeaderboardCheck(key);
    if (!quiet) say("sync-msg", `${d.note || "Checked."} (Linked to ${d.linked}. Taps ${d.taps}, attacks ${d.attacks}, mugs ${d.mugs}, matched ${d.matched}.)`, d.counted ? "ok" : "info");
    await loadBoard();
    await loadOutcomes();
    $("sync-diag").replaceChildren();
  } catch (e) {
    if (!quiet) say("sync-msg", e.message, "err");
    if (/key|access level|permission/i.test(e.message)) { if (quiet) say("sync-msg", e.message, "err"); await diagnoseKey(key); }
  }
}

$("range").addEventListener("change", loadBoard);
$("sync").addEventListener("click", () => checkMyMugs(false));
loadBoard().then(loadOutcomes).then(() => checkMyMugs(true)).catch((e) => say("sync-msg", e.message, "err"));

watchForUpdates();
