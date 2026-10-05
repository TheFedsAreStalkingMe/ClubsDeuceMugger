// Calls to our own server. Pass { signal } to make a request cancellable.

export async function api(path, { method = "GET", headers = {}, body, signal } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body ? JSON.stringify(body) : undefined,
      credentials: "same-origin",
      signal,
    });
  } catch (e) {
    if (e && e.name === "AbortError") throw new Error("cancelled");
    throw e;
  }
  if (res.status === 401) {
    location.href = "/"; // signed out
    throw new Error("Signed out");
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 429) {
    const e = new Error(data.error || "Rate limited");
    e.retryAfter = data.retryAfter || 30; // seconds to wait
    throw e;
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// For public pages (sign in, recover): a POST that never redirects, so errors can be shown on the form.
export async function postJson(path, body) {
  try {
    const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
  } catch {
    return { ok: false, status: 0, data: { error: "Network trouble. Try again." } };
  }
}
