// Turn numbers into text.

export const fmtMoney = (n) => "$" + Math.round(n).toLocaleString("en-US");

// 19500000 -> "$19.5m", 1234 -> "$1.2k"
export function fmtShortMoney(n) {
  for (const [size, unit] of [[1e9, "b"], [1e6, "m"], [1e3, "k"]]) {
    if (n >= size) return "$" + (n / size).toFixed(n / size >= 100 ? 0 : 2).replace(/\.?0+$/, "") + unit;
  }
  return "$" + Math.round(n);
}

// 1234567890 -> "1.23b"
export function fmtStats(n) {
  if (n == null) return "?";
  for (const [size, unit] of [[1e12, "t"], [1e9, "b"], [1e6, "m"], [1e3, "k"]]) {
    if (n >= size) return (n / size).toFixed(n / size >= 100 ? 0 : 2).replace(/\.?0+$/, "") + unit;
  }
  return String(Math.round(n));
}

// Seconds ago -> "just now", "12m ago", "3h 5m ago", "2d 4h ago"
export function fmtAgo(sec) {
  sec = Math.max(0, sec);
  if (sec < 90) return "just now";
  const m = Math.floor(sec / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  return d ? `${d}d ${h % 24}h ago` : h ? `${h}h ${m % 60}m ago` : `${m}m ago`;
}

// Seconds ago with second precision under a minute: "8s ago", then like fmtAgo.
export const fmtShortAgo = (sec) => (sec < 60 ? `${Math.max(0, Math.floor(sec))}s ago` : fmtAgo(sec));

// Seconds left -> "12m 40s", "1h 5m 2s", "2d 4h 10m"
export function fmtCountdown(sec) {
  sec = Math.max(0, Math.ceil(sec));
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (d) return `${d}d ${h}h ${m}m`;
  if (h) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}

export const fmtDate = (sec) => new Date(sec * 1000).toLocaleDateString();
