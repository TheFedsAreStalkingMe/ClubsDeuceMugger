// Number formatting for the Flipper: coins as 1.2k / 3.4m / 5.6b, hours, percentages, ages. Pure functions.

// 1234 -> "1.2k", 3400000 -> "3.4m", 5.6e9 -> "5.6b". Under 1000 it keeps one decimal only when needed ("0.4", "12.5", "950").
export function fmtCoins(n) {
  if (n == null || !Number.isFinite(n)) return "?";
  const a = Math.abs(n), sign = n < 0 ? "-" : "";
  for (const [size, unit] of [[1e12, "t"], [1e9, "b"], [1e6, "m"], [1e3, "k"]]) {
    if (a >= size) {
      const v = a / size;
      return sign + (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)).replace(/\.0+$|(\.\d*?)0+$/, "$1") + unit;
    }
  }
  return sign + (a >= 100 ? a.toFixed(0) : a.toFixed(1)).replace(/\.0$/, "");
}

// "50m" -> 50000000, "1.5b" -> 1500000000, "250k", "12,000" -> 12000. Anything else -> 0.
export function parseCoins(text) {
  const m = String(text || "").trim().toLowerCase().replace(/[, ]/g, "").match(/^(\d+(?:\.\d+)?)([kmbt]?)$/);
  if (!m) return 0;
  return Number(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9, t: 1e12 }[m[2]] || 1);
}

// hours -> "?" (unknown), "<1m", "12m", "3.5h", "4d"
export function fmtHours(h) {
  if (h == null || !Number.isFinite(h)) return "?";
  if (h < 1 / 60) return "<1m";
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 48) return `${h.toFixed(h < 10 ? 1 : 0)}h`;
  return `${Math.round(h / 24)}d`;
}

export const fmtPct = (n) => (n == null || !Number.isFinite(n) ? "?" : `${n >= 100 ? n.toFixed(0) : n.toFixed(1)}%`);

// seconds -> "12s", "3m", "2h"
export function fmtAge(sec) {
  if (sec == null) return "no data";
  if (sec < 90) return `${Math.round(sec)}s`;
  if (sec < 5400) return `${Math.round(sec / 60)}m`;
  return `${Math.round(sec / 3600)}h`;
}
