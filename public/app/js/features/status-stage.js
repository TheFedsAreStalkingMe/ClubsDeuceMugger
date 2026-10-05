// The "Torn status and account age" stage shared by the Inactive Earners and Bonus Weapon Sellers scans.
// Players with a fresh record in the browser cache are not asked again.

import { pool } from "/js/core/async.js";
import { profileFresh, profiles, recordFrom } from "./records.js";
import { tornCall } from "./torncall.js";
import { setScanMsg } from "./ui.js";
import { state } from "../state.js";

const isCancel = (e) => e && e.message === "cancelled";

// ids: player ids. apply(id, record) writes a record onto rows and cards. Returns true if the key was refused.
export async function checkStatuses(ids, runId, { apply, progress, render }) {
  const unique = [...new Set(ids)];
  const todo = [];
  for (const id of unique) {
    const p = profiles.get(id);
    if (profileFresh(p) && p.age != null) apply(id, p); else todo.push(id);
  }
  let done = unique.length - todo.length;
  progress(done / Math.max(1, unique.length));
  render();
  let keyProblem = false;
  await pool(todo, 3, async (id) => {
    if (runId !== state.runId || keyProblem) return;
    try {
      const p = await tornCall(`/api/torn/user?id=${id}`, runId);
      const rec = recordFrom(p);
      profiles.put(id, rec);
      apply(id, rec);
    } catch (e) {
      if (isCancel(e)) return;
      if (e.fatal) { keyProblem = true; setScanMsg(e.message, "err"); return; }
    }
    progress(++done / unique.length);
    setScanMsg(`Checking status ${done}/${unique.length}...`);
  });
  profiles.flush();
  return keyProblem;
}
