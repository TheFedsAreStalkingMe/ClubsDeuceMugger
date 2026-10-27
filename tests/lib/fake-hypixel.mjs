// A fake Hypixel API (Bazaar, auctions, ended auctions, items) and a fake SkyCofl, for the Worker tests. Deterministic data:
//   TEST_ORDER   a clean Bazaar order flip (bid 1000 / ask 1100, deep, busy)
//   TEST_THIN    the same spread but only two orders: Low confidence
//   SULPHUR      sold by an NPC shop at 10 (real NEU data), buy orders at 20: a reverse NPC flip
//   ENCHANTED_GUNPOWDER  crafted from 160 SULPHUR (real NEU recipe), sells at 8,800: a craft flip
//   NPC_SELL_ITEM  Bazaar asks under its NPC sell price of 1,000: an NPC sell flip
//   auctions: four same-variant BINs at 5m / 8m / 8.2m / 8.5m, six ended sales around 8m
import { itemBytes } from "./nbt-writer.mjs";

const product = (id, { asks, bids, buyWeek = 700000, sellWeek = 700000, askOrders = 40, bidOrders = 40 }) => ({
  product_id: id,
  quick_status: { productId: id, buyPrice: asks[0][0], sellPrice: bids[0][0], buyMovingWeek: buyWeek, sellMovingWeek: sellWeek, buyOrders: askOrders, sellOrders: bidOrders, buyVolume: 1e6, sellVolume: 1e6 },
  buy_summary: asks.map(([pricePerUnit, amount]) => ({ pricePerUnit, amount, orders: 1 })),
  sell_summary: bids.map(([pricePerUnit, amount]) => ({ pricePerUnit, amount, orders: 1 })),
});

export const PRODUCTS = [
  product("TEST_ORDER", { asks: [[1100, 5000], [1101, 5000], [1102, 5000]], bids: [[1000, 5000], [999, 5000], [998, 5000]] }),
  product("TEST_THIN", { asks: [[1100, 500]], bids: [[1000, 500]], askOrders: 1, bidOrders: 2 }),
  product("SULPHUR", { asks: [[30, 99999], [31, 99999]], bids: [[20, 99999], [19, 99999]], buyWeek: 5e6, sellWeek: 5e6 }),
  product("ENCHANTED_GUNPOWDER", { asks: [[8800, 5000], [8801, 5000]], bids: [[8000, 5000], [7999, 5000]], buyWeek: 2e6, sellWeek: 2e6 }),
  product("NPC_SELL_ITEM", { asks: [[900, 100], [990, 200], [1010, 500]], bids: [[800, 1000], [790, 1000]], buyWeek: 2e6, sellWeek: 2e6 }),
];

const std = { id: "TEST_BLADE", upgrade_level: 5, modifier: "heroic", enchantments: { sharpness: 7 } };
const NOW = () => Date.now();

function auctionsPage(flags) {
  const mk = (n, price) => ({ uuid: `auc${n}`, auctioneer: "x", start: NOW() - 1000, end: NOW() + 3600_000, item_name: "§dHeroic Test Blade §6✪✪✪✪✪", item_lore: "", tier: "LEGENDARY", category: "weapon", bin: true, claimed: false, starting_bid: price, highest_bid_amount: 0, bids: [], item_bytes: itemBytes(std, "Heroic Test Blade"), last_updated: NOW() });
  return [mk(1, 5_000_000), mk(2, 8_000_000), mk(3, 8_200_000), mk(4, 8_500_000)];
}

// Returns true if the request was handled. `flags`: hypixelDown, auctionPageFail.
export function hypixelRoute(u, flags, send) {
  const p = u.pathname;
  if (p.startsWith("/hypixel/")) {
    if (flags.hypixelDown) { send({ success: false, cause: "Service unavailable" }, 503); return true; }
    if (p === "/hypixel/v2/skyblock/bazaar") { send({ success: true, lastUpdated: Date.now(), products: Object.fromEntries(PRODUCTS.map((x) => [x.product_id, x])) }); return true; }
    if (p === "/hypixel/v2/resources/skyblock/items") {
      send({ success: true, lastUpdated: Date.now(), items: [{ id: "TEST_ORDER", name: "Test Order Item", tier: "COMMON" }, { id: "NPC_SELL_ITEM", name: "Npc Sell Item", tier: "COMMON", npc_sell_price: 1000 }, { id: "ENCHANTED_GUNPOWDER", name: "Enchanted Gunpowder", tier: "UNCOMMON", npc_sell_price: 640 }, { id: "SULPHUR", name: "Sulphur", tier: "COMMON", npc_sell_price: 4 }] });
      return true;
    }
    if (p === "/hypixel/v2/skyblock/auctions") {
      const page = Number(u.searchParams.get("page") || 0);
      if (flags.auctionPageFail && page === 2) { send({ success: false, cause: "boom" }, 500); return true; }
      send({ success: true, page, totalPages: flags.auctionPageFail ? 3 : 1, totalAuctions: 4, lastUpdated: Date.now(), auctions: page === 0 ? auctionsPage(flags) : [] });
      return true;
    }
    if (p === "/hypixel/v2/skyblock/auctions_ended") {
      const sold = [8_000_000, 8_100_000, 7_900_000, 8_000_000, 8_200_000, 7_950_000];
      send({ success: true, lastUpdated: Date.now(), auctions: sold.map((price, i) => ({ auction_id: `sold${i}00000000`, seller: "s", buyer: "b", timestamp: Date.now() - i * 1000, price, bin: true, item_bytes: itemBytes(std, "Heroic Test Blade") })) });
      return true;
    }
    send({ success: false, cause: "Invalid" }, 404);
    return true;
  }
  if (p.startsWith("/cofl/item/price/") && p.endsWith("/history/day")) {
    const t0 = Date.now();
    send(Array.from({ length: 24 }, (_, i) => ({ min: 990, max: 1110, avg: 1050 + i, volume: 1000, time: new Date(t0 - i * 3600_000).toISOString().slice(0, 19) })));
    return true;
  }
  return false;
}
