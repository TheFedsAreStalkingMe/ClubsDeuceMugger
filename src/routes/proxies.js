// Passes requests to Weav3r, Torn and FF Scouter for signed-in members.
// Members' API keys travel in request headers for one call and are never stored here.

import { RE, upstream } from "../config.js";
import { fail, json, readJson } from "../lib/http.js";
import { throttle } from "../lib/ratelimit.js";
import { fetchJson, tornV2 } from "../lib/upstream.js";

const header = (request, name) => request.headers.get(name) || "";
const TORN_PER_MINUTE = 84; // Torn allows 100 per key; the site stays under 85
const WEAV3R_PER_MINUTE = 300; // bazaar answers are cached for 30 s, so this is cheap

// ---------------------------------------------------------------- Weav3r (bazaar listings)

// Weav3r is busy (429/503): tell the page to wait a few seconds and ask again, instead of a hard error.
function weav3rFail(res) {
  if (res.status !== 429 && res.status !== 503) return fail(`Weav3r returned ${res.status}`, 502);
  const wait = Math.min(15, Math.max(3, Number(res.headers.get("Retry-After")) || 8));
  return json({ error: "Weav3r is busy", retryAfter: wait }, 429, { "Retry-After": String(wait) });
}

export async function weav3r({ env, url, user }) {
  const item = url.searchParams.get("item") || "";
  if (item !== "all" && !/^\d{1,7}$/.test(item)) return fail("Bad item ID.");
  const blocked = await throttle(env, "weav3r", String(user.id), WEAV3R_PER_MINUTE, 60, { maxRetry: 5 });
  if (blocked) return blocked;
  const base = upstream(env).weav3r;

  // The index lists every item with bazaar listings, so the site can pick what to scan.
  if (item === "all") {
    const { res, data } = await fetchJson(`${base}/marketplace`, { cf: { cacheTtl: 60, cacheEverything: true } });
    if (!res.ok) return weav3rFail(res);
    if (!data || !Array.isArray(data.items)) return fail("Weav3r sent bad data.", 502);
    return json({
      items: data.items
        .filter((i) => i.item_id > 0 && i.total_bazaars > 0 && i.market_price > 0)
        .map((i) => ({ id: i.item_id, name: i.item_name, price: i.market_price, lowest: i.lowest_price, bazaars: i.total_bazaars })),
    });
  }

  const { res, data } = await fetchJson(`${base}/marketplace/${item}`, { cf: { cacheTtl: 30, cacheEverything: true } });
  if (!res.ok) return weav3rFail(res);
  if (!data) return fail("Weav3r sent bad data.", 502);
  return json({
    item_id: data.item_id,
    item_name: data.item_name,
    market_price: data.market_price,
    generated_at: data.generated_at,
    listings: (data.listings || []).map((l) => ({ player_id: l.player_id, player_name: l.player_name, quantity: l.quantity, price: l.price, updated: l.content_updated })),
  });
}

// ---------------------------------------------------------------- Torn (status, age, own stats)

// Runs a Torn v1 call. Torn answers 200 with an error object, so key problems are passed on in the body.
async function tornV1(env, request, user, path, selections) {
  const key = header(request, "X-Torn-Key");
  if (!RE.tornKey.test(key)) return { response: fail("Missing or malformed Torn API key.") };
  const blocked = await throttle(env, "torn", String(user.id), TORN_PER_MINUTE, 60);
  if (blocked) return { response: blocked };
  const { data } = await fetchJson(`${upstream(env).tornV1}${path}?selections=${selections}&key=${key}&comment=ClubsDeuceMugger`);
  if (!data) return { response: fail("Torn sent bad data.", 502) };
  if (data.error) return { response: json({ error: data.error.error || "Torn error", code: data.error.code }) };
  return { data };
}

export async function tornProfile({ request, env, url, user }) {
  const id = url.searchParams.get("id") || "";
  if (!/^\d{1,10}$/.test(id)) return fail("Bad player ID.");
  const { data, response } = await tornV1(env, request, user, `/user/${id}`, "profile");
  if (response) return response;
  return json({
    player_id: data.player_id,
    name: data.name,
    age: data.age,
    last_action: data.last_action && { timestamp: data.last_action.timestamp, status: data.last_action.status },
    status: data.status && { state: data.status.state, description: data.status.description, until: data.status.until },
  });
}

export async function tornMe({ request, env, user }) {
  const { data, response } = await tornV1(env, request, user, "/user/", "battlestats");
  if (response) return response;
  const total = Number(data.total) || ["strength", "defense", "speed", "dexterity"].reduce((n, k) => n + (Number(data[k]) || 0), 0);
  return json({ total });
}

// ---------------------------------------------------------------- Torn companies (inactive earners)

// A Torn API v2 call with the member's key. Key and Torn errors are passed on in the body, like the v1 calls.
async function tornCompany(env, request, user, path, params = {}) {
  const key = header(request, "X-Torn-Key");
  if (!RE.tornKey.test(key)) return { response: fail("Missing or malformed Torn API key.") };
  const blocked = await throttle(env, "torn", String(user.id), TORN_PER_MINUTE, 60);
  if (blocked) return { response: blocked };
  try {
    return { data: await tornV2(upstream(env).tornV2, path, { striptags: "true", ...params }, key) };
  } catch (e) {
    if (e.code) return { response: json({ error: e.message, code: e.code }) };
    return { response: fail("Torn sent bad data.", 502) };
  }
}

// Every company type: id and name (about 40 of them; they almost never change).
export async function companyTypes({ request, env, user }) {
  const { data, response } = await tornCompany(env, request, user, "/torn/companies");
  if (response) return response;
  return json({ types: (data.companies || []).map((t) => ({ id: t.id, name: t.name })) });
}

// One page (up to 100) of the companies of one type, with their star rating.
export async function companyList({ request, env, url, user }) {
  const type = url.searchParams.get("type") || "";
  const offset = url.searchParams.get("offset") || "0";
  if (!/^\d{1,3}$/.test(type) || !/^\d{1,6}$/.test(offset)) return fail("Bad company type or offset.");
  const { data, response } = await tornCompany(env, request, user, `/company/${type}/companies`, { limit: "100", offset });
  if (response) return response;
  return json({
    total: data._metadata?.total ?? null,
    companies: (data.companies || []).map((c) => ({
      id: c.id, name: c.name, type: c.type?.id, typeName: c.type?.name, stars: c.rating,
      hired: c.employees?.hired ?? 0, capacity: c.employees?.capacity ?? 0, income: c.income?.daily ?? 0,
    })),
  });
}

// The people who work at one company, with their status and last action.
export async function companyEmployees({ request, env, url, user }) {
  const id = url.searchParams.get("id") || "";
  if (!/^\d{1,10}$/.test(id)) return fail("Bad company ID.");
  const { data, response } = await tornCompany(env, request, user, `/company/${id}/employees`);
  if (response) return response;
  return json({
    employees: (data.employees || []).map((e) => ({
      id: e.id, name: e.name, position: e.position?.name || "", days: e.days_in_company ?? 0,
      last: e.last_action?.timestamp || 0,
      state: e.status?.state || "Okay", until: e.status?.until || 0, desc: e.status?.description || "",
    })),
  });
}

// ---------------------------------------------------------------- FF Scouter (battle stat estimates)

export async function ffStats({ request, env, user }) {
  const key = header(request, "X-FF-Key");
  if (!RE.tornKey.test(key)) return fail("Missing or malformed FF Scouter key.");
  const targets = (await readJson(request)).targets;
  if (!Array.isArray(targets) || !targets.length || targets.length > 205 || !targets.every((t) => Number.isInteger(t) && t > 0)) {
    return fail("Bad targets list.");
  }
  const blocked = await throttle(env, "ff", String(user.id), 30, 60);
  if (blocked) return blocked;

  const { res, data } = await fetchJson(`${upstream(env).ffScouter}/get-stats?key=${key}&targets=${targets.join(",")}`);
  if (!res.ok || !data) {
    return fail((data && (data.error || data.message)) || `FF Scouter returned ${res.status}`, res.status === 429 ? 429 : 502);
  }
  return json(data);
}

// Is this key registered with FF Scouter?
export async function ffCheck({ request, env, user }) {
  const key = header(request, "X-FF-Key");
  if (!RE.tornKey.test(key)) return fail("Enter a key first.");
  const blocked = await throttle(env, "ffcheck", String(user.id), 10, 60);
  if (blocked) return blocked;
  const { res, data } = await fetchJson(`${upstream(env).ffScouter}/check-key?key=${key}`);
  if (!data) return fail(`FF Scouter returned ${res.status}`, 502);
  if (data.error) return fail(String(data.error), 502);
  return json({ registered: !!data.is_registered, premium: !!data.is_premium, last_used: data.last_used || null });
}

// Registers a key with FF Scouter. Only runs after the member ticks their data-policy box.
export async function ffRegister({ request, env, user }) {
  const key = header(request, "X-FF-Key");
  if (!RE.tornKey.test(key)) return fail("Enter a key first.");
  if ((await readJson(request)).agree !== true) return fail("Tick the box to confirm you read FF Scouter's data policy.");
  const blocked = await throttle(env, "ffreg", String(user.id), 5, 3600);
  if (blocked) return blocked;
  const { res, data } = await fetchJson(`${upstream(env).ffScouter}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, agree_to_data_policy: true, signup_source: "ClubsDeuceMugger" }),
  });
  if (!data) return fail(`FF Scouter returned ${res.status}`, 502);
  if (data.success) return json({ ok: true, message: data.message || "Registered." });
  return fail(data.error || data.message || "FF Scouter did not register the key.");
}
