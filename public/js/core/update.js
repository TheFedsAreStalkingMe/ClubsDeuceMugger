// Tells an open page when a new version of the site has been deployed. An app added to the iPhone home screen can
// stay open for days on the old code, so this offers an Update button instead of leaving it stale.

let loaded = null; // the build this page was loaded with

function showBar() {
  if (document.getElementById("update-bar")) return;
  const bar = document.createElement("div");
  bar.id = "update-bar";
  bar.className = "update-bar";
  const text = document.createElement("span");
  text.textContent = "A new version is ready.";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn small green";
  button.textContent = "Update";
  button.addEventListener("click", () => location.reload());
  bar.append(text, button);
  document.body.prepend(bar);
}

async function check() {
  try {
    const me = await (await fetch("/api/me", { credentials: "same-origin" })).json();
    if (!me.build) return;
    if (loaded === null) loaded = me.build;
    else if (me.build !== loaded) showBar();
  } catch { /* offline: try again later */ }
}

export function watchForUpdates() {
  check();
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") check(); });
  setInterval(check, 5 * 60 * 1000);
}
