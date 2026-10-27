// A small price chart (SVG, built with DOM calls so the strict CSP is happy). Points are [seconds, bid, ask]; the ask line is the
// price you pay to buy now, the bid line what you get selling now.

import { fmtCoins } from "./format.js";

const NS = "http://www.w3.org/2000/svg";
const svg = (tag, attrs = {}, text) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text != null) e.textContent = text;
  return e;
};

export function priceChart(points) {
  const W = 600, H = 220, L = 56, R = 10, T = 10, B = 24;
  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img", "aria-label": "Price history" });
  const pts = (points || []).filter((p) => p[1] > 0 || p[2] > 0);
  if (pts.length < 2) {
    root.append(svg("text", { x: W / 2, y: H / 2, "text-anchor": "middle", class: "chart-note" }, "Not enough price history yet"));
    return root;
  }
  const values = pts.flatMap((p) => [p[1], p[2]].filter((v) => v > 0));
  let lo = Math.min(...values), hi = Math.max(...values);
  if (hi === lo) { hi += 1; lo -= 1; }
  const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
  const t0 = pts[0][0], t1 = pts.at(-1)[0];
  const x = (t) => L + ((t - t0) / Math.max(1, t1 - t0)) * (W - L - R);
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  for (const f of [0, 0.5, 1]) {
    const v = lo + f * (hi - lo);
    root.append(svg("line", { x1: L, x2: W - R, y1: y(v), y2: y(v), class: "chart-grid" }), svg("text", { x: L - 6, y: y(v) + 4, "text-anchor": "end", class: "chart-note" }, fmtCoins(v)));
  }
  const line = (i, cls) => {
    const d = pts.filter((p) => p[i] > 0).map((p) => `${x(p[0]).toFixed(1)},${y(p[i]).toFixed(1)}`).join(" ");
    if (d) root.append(svg("polyline", { points: d, class: cls, fill: "none" }));
  };
  line(2, "chart-ask");
  line(1, "chart-bid");
  const span = t1 - t0;
  root.append(svg("text", { x: L, y: H - 6, class: "chart-note" }, span > 2 * 86400 ? `${Math.round(span / 86400)}d ago` : `${Math.round(span / 3600)}h ago`), svg("text", { x: W - R, y: H - 6, "text-anchor": "end", class: "chart-note" }, "now"));
  return root;
}
