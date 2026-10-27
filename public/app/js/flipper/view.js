// The Flipper table and the detail panel. Everything is built with DOM calls and textContent (the CSP forbids inline script and style).

import { el } from "/js/core/dom.js";
import { fmtCoins, fmtHours, fmtPct } from "./format.js";
import { priceChart } from "./chart.js";

export const TYPE_LABEL = {
  "bazaar-order": "Bazaar order", "bazaar-instant": "Bazaar instant", craft: "Craft", "npc-reverse": "Reverse NPC", "npc-sell": "NPC sell", "ah-bin": "Auction BIN",
};

// [key, heading, sort key (or null), help text]
export const COLUMNS = [
  ["name", "Item", null, "The item and the type of flip."],
  ["buyAt", "Buy at", null, "Price per item you pay. Bazaar order: your buy order (best bid + 0.1). NPC flips: the NPC or Bazaar price. Auction: the BIN price."],
  ["sellAt", "Sell at", null, "Price per item you list or get. Bazaar order: your sell offer (best ask - 0.1), before tax."],
  ["unitProfit", "Net / item", "profit", "Profit per item after tax and fees."],
  ["roiPct", "ROI", "roi", "Net profit as a percent of what you spend."],
  ["qty", "Qty", null, "How many to buy: your order size, what you can afford, a share of the weekly volume, the book depth and the NPC limit, whichever is smallest."],
  ["totalProfit", "Total", "profit", "Net profit for that quantity (per trip for NPC flips)."],
  ["fillSellHours", "Time to sell", "speed", "Estimated time for the sell side to fill (the whole cycle is in the tooltip)."],
  ["coinsPerHour", "Coins/hour", "cph", "Net profit x cycles per hour: total profit divided by the whole buy-fill, sell-fill and handling time."],
  ["volume", "Volume", null, "Weekly items traded on the slower side (Bazaar) or sales per day (Auction)."],
  ["npcFloor", "NPC floor", null, "What an NPC pays per item: the least you would get if you dumped it."],
  ["confidence", "Confidence", null, "High / Med / Low with the reasons in the tooltip."],
  ["star", "", null, "Watchlist"],
];

const qtyText = (f) => (f.qty >= 1000 ? fmtCoins(f.qty) : String(Math.round(f.qty)));
const tipFor = (f) => [
  `${TYPE_LABEL[f.type] || f.type}: buy ${fmtCoins(f.buyAt)}, sell ${fmtCoins(f.sellAt)}, net ${fmtCoins(f.unitProfit)} per item.`,
  `Liquidity ${f.liquidity ?? "?"}/100.`,
  f.cycleHours != null ? `Cycle: ${fmtHours(f.fillBuyHours)} to fill the buy + ${fmtHours(f.fillSellHours)} to fill the sell + handling = ${fmtHours(f.cycleHours)}.` : "Time to sell is unknown (no recorded sales).",
  ...f.reasons,
].join("\n");

export function renderHead(row, sort, onSort) {
  row.replaceChildren(...COLUMNS.map(([key, label, sortKey, help]) => {
    const th = el("th", { title: help, class: sortKey ? "sortable" : "", text: label + (sortKey && sort === sortKey ? " v" : "") });
    if (sortKey) th.addEventListener("click", () => onSort(sortKey));
    return th;
  }));
}

// One table row. `watched` = Set of item ids, `handlers` = { open(flip), star(flip) }.
export function flipRow(f, watched, handlers) {
  const name = el("td", { class: "name" }, el("div", { text: f.name }), el("span", { class: "tagtype", text: TYPE_LABEL[f.type] || f.type }));
  if (f.type === "ah-bin") name.append(" ", el("span", { class: "hint", text: f.variant || "" }));
  if (f.type === "npc-reverse" && f.npcName) name.append(" ", el("span", { class: "hint", text: `from ${f.npcName}` }));
  const star = el("button", { class: `fl-star${watched.has(f.id) ? " on" : ""}`, type: "button", "aria-label": watched.has(f.id) ? "Remove from watchlist" : "Add to watchlist", title: "Watchlist", text: watched.has(f.id) ? "★" : "☆" });
  star.addEventListener("click", (e) => { e.stopPropagation(); handlers.star(f); });
  const tr = el("tr", { class: "fl-row", title: tipFor(f) },
    name,
    el("td", { text: fmtCoins(f.buyAt) }),
    el("td", { text: fmtCoins(f.sellAt) }),
    el("td", { text: fmtCoins(f.unitProfit) }),
    el("td", { text: fmtPct(f.roiPct) }),
    el("td", { text: qtyText(f) }),
    el("td", { text: fmtCoins(f.totalProfit) }),
    el("td", { text: f.fillSellHours == null ? "?" : fmtHours(f.fillSellHours) }),
    el("td", { text: f.coinsPerHour == null ? "?" : fmtCoins(f.coinsPerHour) }),
    el("td", { text: fmtCoins(f.volume) }),
    el("td", { text: f.npcFloor ? fmtCoins(f.npcFloor) : "-" }),
    el("td", { class: `conf-${f.confidence}`, title: f.reasons.join("\n"), text: f.confidence }),
    el("td", {}, star));
  tr.addEventListener("click", () => handlers.open(f));
  return tr;
}

const level = (l) => el("li", { class: l.level, text: l.text });

// The detail panel for one Bazaar item (from /api/flipper/item).
export function fillDetail(d, parts) {
  parts.title.textContent = d.name;
  parts.sub.textContent = `${d.id}${d.meta && d.meta.t ? ` - ${d.meta.t.toLowerCase()}` : ""}${d.meta && d.meta.c ? ` - ${d.meta.c.toLowerCase()}` : ""}. Sell offers move ${d.book.instantBuyWeek.toLocaleString("en-US")} items a week by instant buyers, buy orders ${d.book.instantSellWeek.toLocaleString("en-US")} by instant sellers.`;
  parts.chart.replaceChildren(priceChart(d.history.points));
  parts.source.textContent = `Price history: ${d.history.source}. Green = sell offers (what you pay), purple = buy orders (what you get).`;
  parts.ask.replaceChildren(...d.book.ask.slice(0, 6).map(([p, a]) => el("li", {}, el("span", { text: fmtCoins(p) }), el("span", { text: `x${a.toLocaleString("en-US")}` }))));
  parts.bid.replaceChildren(...d.book.bid.slice(0, 6).map(([p, a]) => el("li", {}, el("span", { text: fmtCoins(p) }), el("span", { text: `x${a.toLocaleString("en-US")}` }))));
  const notes = [];
  if (d.npc) notes.push({ level: "", text: `NPC floor: an NPC pays ${fmtCoins(d.npc.npcPrice)} per item${d.npc.belowFloor ? " (more than the best buy order: dumping to an NPC beats the Bazaar)" : ""}.` });
  if (d.shopPrice) notes.push({ level: "", text: `An NPC shop (${d.shopPrice[1]}) sells it for ${fmtCoins(d.shopPrice[0])} each.` });
  const route = (steps, indent = "") => steps.flatMap((s) => [`${indent}${s.n}x ${s.id} via ${s.how} at ${fmtCoins(s.unit)} each`, ...(s.steps ? route(s.steps, `${indent}  `) : [])]);
  if (d.craftRoute && d.craftRoute.how === "craft") for (const line of route(d.craftRoute.steps)) notes.push({ level: "", text: `Craft: ${line}` });
  for (const f of d.flips) {
    notes.push({ level: f.confidence === "Low" ? "bad" : f.confidence === "Med" ? "warn" : "", text: `${TYPE_LABEL[f.type]}: ${fmtCoins(f.unitProfit)} per item (${fmtPct(f.roiPct)}), ${f.confidence} confidence.` });
    for (const r of f.reasons) notes.push({ level: f.confidence === "High" ? "" : "warn", text: `  ${r}` });
  }
  if (!notes.length) notes.push({ level: "", text: "No flips for this item right now." });
  parts.notes.replaceChildren(...notes.map(level));
}

// The detail panel for an Auction House flip (there is no Bazaar book or chart): what to look at in the game, and why it is rated as it is.
export function fillAuctionDetail(f, parts) {
  parts.title.textContent = f.name;
  parts.sub.textContent = `${f.tier ? `${f.tier.toLowerCase()} - ` : ""}${f.variant || f.id}. Listed at ${fmtCoins(f.buyAt)}, likely resale ${fmtCoins(f.sellAt)} after a ${fmtCoins(f.fees)} fee, net ${fmtCoins(f.unitProfit)} (${fmtPct(f.roiPct)}).`;
  parts.chart.replaceChildren(el("p", { class: "hint", text: "Auction flips have no price chart: the reference price comes from comparable listings and recent sales of the same variant." }));
  parts.source.textContent = f.fillSellHours == null ? "No recorded sales of this variant yet, so the time to sell is unknown." : `Expected time to sell about ${fmtHours(f.fillSellHours)} (${f.competitors} cheaper comparable listing${f.competitors === 1 ? "" : "s"}).`;
  parts.ask.replaceChildren();
  parts.bid.replaceChildren();
  const notes = [{ level: "", text: `Open it in the game with ${f.command}` }, ...f.reasons.map((text) => ({ level: f.confidence === "High" ? "" : "warn", text })), ...f.flags.map((x) => ({ level: x.level, text: x.text }))];
  parts.notes.replaceChildren(...notes.map(level));
}
