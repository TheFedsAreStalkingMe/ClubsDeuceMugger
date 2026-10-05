// Owner panel: every account, with approve / deny / remove. Built only for the owner.

import { api } from "/js/core/api.js";
import { $, el } from "/js/core/dom.js";

export async function initAdmin() {
  const list = el("div", { class: "list", id: "admin-list" });
  const count = el("p", { class: "hint", text: "Loading accounts..." });
  $("alerts").after(el("section", { class: "card panel", id: "admin" }, el("h2", { text: "Owner panel" }), count, list));

  async function refresh() {
    const { users } = await api("/api/admin/users");
    count.textContent = `${users.length} account${users.length === 1 ? "" : "s"} registered`;
    list.replaceChildren(...users.map(userRow));
  }

  function actionButton(user, action, label, style) {
    const b = el("button", { class: `btn small ${style || ""}`, type: "button", text: label });
    b.addEventListener("click", async () => {
      if (action !== "approve" && !confirm(`${label} ${user.username}?`)) return;
      b.disabled = true;
      try {
        await api("/api/admin/users", { method: "POST", body: { id: user.id, action } });
        await refresh();
      } catch (e) {
        alert(e.message);
        b.disabled = false;
      }
    });
    return b;
  }

  function userRow(u) {
    const actions = el("div", { class: "acts" });
    if (!u.owner) {
      if (u.status === "pending") actions.append(actionButton(u, "approve", "Approve", "green"), actionButton(u, "deny", "Deny", "ghost"));
      else actions.append(actionButton(u, "delete", "Remove", "ghost"));
    }
    return el("div", { class: "item" },
      el("span", {}, el("span", { class: `tag ${u.status}`, text: u.owner ? "owner" : u.status }), ` ${u.username}`),
      el("span", { class: "meta", text: [u.email, u.invited_by ? `invited by ${u.invited_by}` : ""].filter(Boolean).join(" | ") }),
      actions
    );
  }

  try { await refresh(); } catch (e) { list.textContent = e.message; }
}
