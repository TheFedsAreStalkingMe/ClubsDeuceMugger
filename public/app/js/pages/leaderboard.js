// The Leaderboard page (/app/leaderboard.html).
// The Torn key stays in this browser and is only passed through for the check.

import { api } from "/js/core/api.js";
import { $, el, say } from "/js/core/dom.js";
import { fmtMoney } from "/js/core/format.js";
import { loadKeys } from "/js/core/storage.js";

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

// quiet = automatic check on page load: no messages unless something is wrong.
async function checkMyMugs(quiet) {
  const key = loadKeys().torn;
  if (!key) return quiet || say("sync-msg", "Add your Torn key in Settings first.", "err");
  if (!quiet) say("sync-msg", "Checking your attacks...", "info");
  try {
    const d = await api("/api/leaderboard/sync", { method: "POST", headers: { "X-Torn-Key": key }, body: {} });
    if (!quiet) say("sync-msg", d.counted ? `Found ${plural(d.counted, "new mug")}. Linked to ${d.linked}.` : `No new mugs. Linked to ${d.linked}.`, "ok");
    await loadBoard();
  } catch (e) {
    if (!quiet) say("sync-msg", e.message, "err");
  }
}

$("range").addEventListener("change", loadBoard);
$("sync").addEventListener("click", () => checkMyMugs(false));
loadBoard().then(() => checkMyMugs(true)).catch((e) => say("sync-msg", e.message, "err"));
