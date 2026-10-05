// Settings: make, copy, share and close invite links.

import { api } from "/js/core/api.js";
import { $, el, say } from "/js/core/dom.js";
import { fmtDate } from "/js/core/format.js";

let shownInvite = null; // id of the invite whose link is on screen

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back below */ }
  try {
    const range = document.createRange();
    range.selectNodeContents($("invite-link"));
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    const ok = document.execCommand("copy");
    sel.removeAllRanges();
    return ok;
  } catch { return false; }
}

async function revoke(id) {
  try {
    await api("/api/invites/revoke", { method: "POST", body: { id } });
    if (shownInvite === id) { $("invite-box").hidden = true; shownInvite = null; }
    say("invite-msg", "Invite closed.", "info");
    await loadInvites();
  } catch (e) {
    say("invite-msg", e.message, "err");
  }
}

async function loadInvites() {
  const { invites } = await api("/api/invites");
  const now = Date.now() / 1000;
  $("invite-list").replaceChildren(
    ...invites.map((i) => {
      const open = !i.used_at && i.expires_at >= now;
      const status = i.used_at ? `used by ${i.used_by_name || "a deleted account"}` : open ? "unused" : "expired";
      const close = el("button", { type: "button", class: "btn small ghost x-btn", "aria-label": "Close invite", text: "X" });
      close.addEventListener("click", () => revoke(i.id));
      return el("div", { class: "item" }, el("span", { text: status }), el("span", { class: "meta", text: `made ${fmtDate(i.created_at)}` }), open ? close : null);
    })
  );
}

async function makeInvite() {
  try {
    const d = await api("/api/invites", { method: "POST", body: {} });
    shownInvite = d.id;
    $("invite-link").textContent = d.link;
    $("invite-box").hidden = false;
    say("invite-msg", (await copyText(d.link)) ? "Link copied. It is only shown once." : "Copy this link now. It is only shown once.", "ok");
    await loadInvites();
  } catch (e) {
    say("invite-msg", e.message, "err");
  }
}

export async function initInvites() {
  $("make-invite").addEventListener("click", makeInvite);
  $("invite-copy").addEventListener("click", async () => {
    say("invite-msg", (await copyText($("invite-link").textContent)) ? "Link copied." : "Could not copy. Touch and hold the link to copy it.", "ok");
  });
  if (navigator.share) {
    $("invite-share").addEventListener("click", async () => {
      try { await navigator.share({ title: "Clubs Deuce Mugger invite", text: "Here is your invite:", url: $("invite-link").textContent }); }
      catch { /* share sheet closed */ }
    });
  } else {
    $("invite-share").hidden = true;
  }
  try { await loadInvites(); } catch (e) { say("invite-msg", e.message, "err"); }
}
