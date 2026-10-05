// Shared constants. Change limits and formats here.

export const SESSION_COOKIE = "__Host-session";
export const SESSION_SECONDS = 7 * 24 * 3600;
export const INVITE_SECONDS = 7 * 24 * 3600; // invite links, and how long an unfinished application is kept
export const APPLY_SESSION_SECONDS = 24 * 3600;
export const RESET_SECONDS = 3600;

// Workers' Web Crypto caps PBKDF2 at 100,000 iterations.
export const PBKDF2_ITERATIONS = 100000;

export const RE = {
  username: /^[A-Za-z0-9_.-]{3,24}$/,
  tornKey: /^[A-Za-z0-9]{8,64}$/, // Torn and FF Scouter keys
  tornStatsKey: /^[A-Za-z0-9_-]{8,64}$/, // TornStats keys can contain underscores
  token: /^[A-Za-z0-9_-]{20,100}$/, // our own random tokens
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
};

export const USER_AGENT = "ClubsDeuceMugger/1.0";

// Upstream services. Each can be overridden by an environment variable (used by the tests).
export const upstream = (env) => ({
  weav3r: env.WEAV3R_API_BASE || "https://weav3r.dev/api",
  tornV1: env.TORN_V1_API_BASE || "https://api.torn.com",
  tornV2: env.TORN_API_BASE || "https://api.torn.com/v2",
  tornStats: env.TORNSTATS_API_BASE || "https://www.tornstats.com/api/v2",
  ffScouter: env.FFSCOUTER_API_BASE || "https://ffscouter.com/api/v1",
});
