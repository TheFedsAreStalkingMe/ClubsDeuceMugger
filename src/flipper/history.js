// Price history maths: volatility and trend from stored samples. Samples are [seconds, bid, ask] in time order (the site
// stores them every 15 minutes for the items it tracks), or hourly averages seeded from SkyCofl for items it does not track yet.
// Pure functions.

const mid = (pt) => (pt[1] > 0 && pt[2] > 0 ? (pt[1] + pt[2]) / 2 : pt[1] > 0 ? pt[1] : pt[2] > 0 ? pt[2] : null);

// The sample closest to `target` seconds, within `tolerance` seconds (or null).
function near(points, target, tolerance) {
  let best = null, gap = Infinity;
  for (const pt of points) {
    const g = Math.abs(pt[0] - target);
    if (g < gap) { gap = g; best = pt; }
  }
  return best && gap <= tolerance ? best : null;
}

// -> { points, volatilityPct, change1hPct, change6hPct } (null where there is not enough history)
export function priceStats(points, nowSec, cfg) {
  const out = { points: 0, volatilityPct: null, change1hPct: null, change6hPct: null };
  if (!Array.isArray(points) || !points.length) return out;
  const day = points.filter((p) => p[0] >= nowSec - 86400 && mid(p) != null);
  out.points = points.length;
  if (day.length >= 3) {
    const v = day.map(mid);
    const avg = v.reduce((n, x) => n + x, 0) / v.length;
    out.volatilityPct = ((Math.max(...v) - Math.min(...v)) / avg) * 100;
  }
  const last = points.at(-1);
  const now = mid(last);
  if (now) {
    const change = (secs, tol) => {
      const old = near(points, last[0] - secs, tol);
      return old && mid(old) ? ((now - mid(old)) / mid(old)) * 100 : null;
    };
    out.change1hPct = change(3600, 2400);
    out.change6hPct = change(6 * 3600, 3 * 3600);
  }
  return out;
}

// SkyCofl's /item/price/{id}/history/day answer ([{ min, max, avg, volume, time }], newest first) -> samples [seconds, avg, avg].
export function parseCoflHistory(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((r) => [Math.floor(Date.parse(`${r.time}Z`) / 1000), Number(r.avg), Number(r.avg)])
    .filter((p) => Number.isFinite(p[0]) && p[1] > 0)
    .sort((a, b) => a[0] - b[0]);
}
