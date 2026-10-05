// Request and response helpers.

export const nowSec = () => Math.floor(Date.now() / 1000);

export const clientIp = (request) => request.headers.get("CF-Connecting-IP") || "local";

// Public site address used in emailed links.
export const baseUrl = (env, url) => (env.APP_URL || url.origin).replace(/\/$/, "");

export async function readJson(request) {
  try {
    const data = await request.json();
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

export const str = (v) => (typeof v === "string" ? v : "");

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

export const fail = (message, status = 400) => json({ error: message }, status);

export function tooMany(retryAfter) {
  return json({ error: "Too many attempts. Slow down and try again soon.", retryAfter }, 429, {
    "Retry-After": String(retryAfter),
  });
}

export function withSecurityHeaders(response) {
  const res = new Response(response.body, response);
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("Referrer-Policy", "no-referrer");
  res.headers.set(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; " +
      "connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'"
  );
  if (res.headers.get("Content-Type")?.includes("text/html") && !res.headers.has("Cache-Control")) {
    res.headers.set("Cache-Control", "no-store");
  }
  return res;
}
