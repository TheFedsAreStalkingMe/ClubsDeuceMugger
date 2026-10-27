// The Flipper's arithmetic: taxes, fees, order books, fill times, scores. Pure functions (no network, no database), so the
// tests can check them with known numbers. Order books are lists of [pricePerUnit, amount] with the BEST price first.

const clamp01 = (x) => Math.max(0, Math.min(1, x));

// What you keep from a Bazaar sale after the tax.
export const afterTax = (price, tax) => price * (1 - tax);

// Fill `qty` items from a book, level by level. -> { filled, total, avg }. `filled` can be less than `qty` if the book is shallow.
export function walkBook(levels, qty) {
  let left = qty, total = 0, filled = 0;
  for (const [price, amount] of levels) {
    if (left <= 0) break;
    const take = Math.min(left, amount);
    total += take * price;
    filled += take;
    left -= take;
  }
  return { filled, total, avg: filled ? total / filled : 0 };
}

// How many items can be bought from `levels` while every unit still earns at least `minMargin` coins against `valuePerUnit`
// (used for NPC flips: buy up to the point where the book gets too expensive). `side` "buy" means we pay the level price.
export function profitableDepth(levels, valuePerUnit, side = "buy", minMargin = 0) {
  let qty = 0, cost = 0;
  for (const [price, amount] of levels) {
    const margin = side === "buy" ? valuePerUnit - price : price - valuePerUnit;
    if (margin <= minMargin) break;
    qty += amount;
    cost += amount * price;
  }
  return { qty, cost };
}

// Average price over the first `n` levels, weighted by amount. A lone top order barely moves it, so comparing it with the
// top price shows whether the top of the book is an outlier.
export function depthWeighted(levels, n) {
  let value = 0, amount = 0;
  for (const [price, a] of levels.slice(0, n)) { value += price * a; amount += a; }
  return amount ? value / amount : null;
}

// Hours for an order of `qty` to fill when `weeklyVolume` items of that side trade per week. `penalty` slows it for competition.
export function fillHours(qty, weeklyVolume, hoursPerWeek = 168, penalty = 1) {
  if (!(weeklyVolume > 0) || !(qty > 0)) return Infinity;
  return (qty / (weeklyVolume / hoursPerWeek)) * penalty;
}

// ---- Auction House fees (the numbers are in config.js and need in-game verification) ----

export function listingFee(price, cfg) {
  const tier = cfg.auction.listingFee.find((t) => price < t.upTo) || cfg.auction.listingFee.at(-1);
  return Math.round(price * tier.rate);
}
export const durationFee = (cfg) => cfg.auction.durationFee[cfg.auction.duration] ?? 0;
export const claimFee = (price, cfg) => (price >= cfg.auction.claimFeeAbove ? Math.round(price * cfg.auction.claimFee) : 0);

// Profit of buying a BIN at `buy` and relisting it at `sell`: the sale price minus claim fee, minus listing and duration fees, minus what you paid.
export function ahNetProfit(buy, sell, cfg) {
  const fees = listingFee(sell, cfg) + durationFee(cfg) + claimFee(sell, cfg);
  return { net: sell - fees - buy, fees };
}

// ---- scores (all 0 to 1) ----

// Share of what you spend that you earn back (as a percent) mapped so 15% or more is a full score.
export const marginScore = (roiPct) => clamp01(roiPct / 15);

// A full cycle (buy fills, sell fills) in 3 minutes scores 1, 48 hours or more scores 0, on a log scale.
export function speedScore(cycleHours) {
  if (!Number.isFinite(cycleHours) || cycleHours <= 0) return 0;
  return clamp01(1 - Math.log(cycleHours / 0.05) / Math.log(48 / 0.05));
}

// Liquidity 0 to 1: how easily it trades. Bazaar and craft flips by items per week (1,000 = 0, a million = 1, log scale), auctions by
// sales per day (none = 0, ten or more = 1). NPC flips trade at a fixed price, so they are fully liquid.
export function liquidityScore(type, volume) {
  if (type === "npc-reverse" || type === "npc-sell") return 1;
  if (type === "ah-bin") return clamp01(Math.log10(1 + Math.max(0, volume || 0)));
  return clamp01(Math.log10(Math.max(1, (volume || 0) / 1000)) / 3);
}

export const CONFIDENCE_VALUE = { High: 1, Med: 0.6, Low: 0.25 };

// The blended ranking score. `weights` = { margin, speed, reliability } (they are normalised, so any positive numbers work).
export function rankScore(flip, weights) {
  const total = weights.margin + weights.speed + weights.reliability || 1;
  const margin = marginScore(flip.roiPct);
  const speed = speedScore(flip.cycleHours);
  const reliability = CONFIDENCE_VALUE[flip.confidence] ?? 0.25;
  return (weights.margin * margin + weights.speed * speed + weights.reliability * reliability) / total;
}

// Confidence from the safety checks. `flags` are { level: "bad" | "warn", text }. The reasons are shown in the page.
//   Low   at least one serious warning (thin book, outlier order, almost no volume, ...)
//   Med   a milder warning, or no warnings but also little price history yet
//   High  no warnings and enough history to know the price has been steady
export function confidenceFrom(flags, { hasHistory = true } = {}) {
  const bad = flags.filter((f) => f.level === "bad");
  const warn = flags.filter((f) => f.level === "warn");
  const level = bad.length ? "Low" : warn.length || !hasHistory ? "Med" : "High";
  const reasons = [...bad, ...warn].map((f) => f.text);
  if (!reasons.length) reasons.push(hasHistory ? "No warnings: volume, depth and recent prices all look normal." : "No warnings, but there is little price history yet.");
  return { level, reasons };
}
