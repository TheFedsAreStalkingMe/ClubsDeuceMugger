# Flipper data sources

Every source below was fetched live on **2026-10-27** from the development environment and checked before the Flipper was built on it. "Verified" means the response shape, the update rhythm and the access rules were read from the real endpoint or its official documentation that day. Anything that could not be confirmed is marked.

The Flipper is read-only analysis. It only displays suggestions and never plays the game for you. It is not affiliated with or endorsed by Hypixel Inc.

## Chosen sources

| Data | Primary | Fallback / top-up |
|---|---|---|
| Bazaar order books and weekly volume | Hypixel `/v2/skyblock/bazaar` | none needed (it is the only source of live order books) |
| Active auctions (BIN listings) | Hypixel `/v2/skyblock/auctions` (44 pages of 1000 on the verification date) | none (see "Moulberry lowest-BIN" below) |
| Sold-price history for auctions | Hypixel `/v2/skyblock/auctions_ended`, recorded by this site | none |
| Item names, tiers, categories, NPC sell prices | Hypixel `/v2/resources/skyblock/items` | none |
| Crafting recipes and NPC shop buy prices | NotEnoughUpdates item repo (generated file) | none |
| Bazaar price history for items not yet tracked | this site's own samples | SkyCofl `/api/item/price/{id}/history/day` |

## Hypixel Public API (`https://api.hypixel.net`)

- **Docs:** https://api.hypixel.net/ (the OpenAPI spec embedded in the page), policy https://developer.hypixel.net/policies
- **Key:** none of the four endpoints below needs an API key (the spec lists no security requirement for them). The policy says keyless endpoints exist "to allow more continuous polling of that data" and that Hypixel will not raise limits to bypass this. No numeric limit is published for them; polling must stay respectful.
- **Cache / update rhythm (measured):** responses carry `Cache-Control: public, max-age=60, s-maxage=300`, but measured over 6 samples the Bazaar `lastUpdated` advanced every **20 seconds** and the CDN `Age` header never exceeded 20 s. Auctions say their cache lasts 60 s.
- **Policy points that matter here:** the product must say it is not affiliated with Hypixel (done in the page footer); no proxying of the API for third parties (the site serves derived flips, not raw API data); no betting or gambling features.

| Endpoint | Provides | Notes |
|---|---|---|
| `/v2/skyblock/bazaar` | `products[id]` with `quick_status`, `buy_summary`, `sell_summary` | 2,201 products on the verification date; 3.6 MB; top 30 orders per side only |
| `/v2/skyblock/auctions?page=N` | active auctions, newest-updated first, with `item_bytes` (base64 gzip NBT) | `totalPages`, `lastUpdated` included; 2.3 MB per page |
| `/v2/skyblock/auctions_ended` | auctions that ended in the last 60 seconds (`price`, `bin`, `item_bytes`, `timestamp`) | ~65 sales per call; has no item name, so the site decodes `item_bytes` |
| `/v2/resources/skyblock/items` | 5,680 items: `id`, `name`, `tier`, `category`, `npc_sell_price` | `npc_sell_price` present on 2,441 items (0 means NPCs do not pay for it); cached by Hypixel for a week; only 1 item has a `recipes` field, so recipes come from NEU |

### Bazaar naming (the API's names are easy to get backwards)

Verified against live data (the sell offers in `buy_summary` are the higher prices):

- `buy_summary` = **sell offers** (asks). What you **pay** when you buy instantly. The first entry is the lowest and best.
- `sell_summary` = **buy orders** (bids). What you **get** when you sell instantly. The first entry is the highest and best.
- `quick_status.buyPrice` / `sellPrice` follow the same naming; both are "the weighted average of the top 2% of orders by volume".
- `buyMovingWeek` = items bought instantly in a week (these fill sell offers); `sellMovingWeek` = items sold instantly in a week (these fill buy orders). **Not verifiable without the game:** this reading of the two weekly volumes is the working assumption behind every fill-time estimate.
- Prices move in steps of 0.1 coin.

## NotEnoughUpdates item repo

- **URL:** https://github.com/NotEnoughUpdates/NotEnoughUpdates-REPO (MIT licence, "Copyright (c) 2020 Moulberry").
- **Provides:** 8,940 item files. Grid crafting recipes (`recipe`, or `recipes` of type `crafting`), NPC shop offers (`recipes` of type `npc_shop` on the NPC's item file, e.g. `{ "cost": ["SKYBLOCK_COIN:7"], "result": "WHEAT:3" }`), plus Forge, Kat upgrade, trade and drop data.
- **How it is used:** `scripts/flipper-build-data.mjs` turns a local clone into `public/flipper-data/recipes.json` (2,513 craftable items, 481 NPC shop items with coin-only prices). Forge, Kat, trade and drop data are not used. The file is generated, committed and served as a static asset because a Worker cannot read 9,000 repository files at run time. Re-run the script when the repo changes.
- **Update frequency:** changes with game updates (commit history on GitHub). The generated file records the NEU commit it came from.
- **Limits:** none for a local clone. Shop **stock and per-trip limits are not in the data**, nor are unlock requirements beyond the free-text `Requires:` line.

## SkyCofl / Coflnet (`https://sky.coflnet.com/api`)

- **Live and keyless:** verified `GET /api/item/price/{id}/history/day` (hourly min/max/avg/volume, ~24 points), `/api/bazaar/{id}/history`, `/api/bazaar/{id}/snapshot` and `/api/craft/profit` all returned 200 with JSON.
- **Used for:** only a top-up of 24 hourly price points on the item detail chart when this site has fewer than 24 own samples for that item. Answers are cached an hour.
- **NOT verified:** its published terms and rate limits (the Swagger page loads a placeholder spec and no terms page was found). It is therefore used sparingly: at most one call per item detail view, cached, and never in the polling loop.

## Request footprint

Per minute: 2 Bazaar requests (about 30 s apart), 1 ended-auctions request, and every second minute the 44 auction pages (+ SkyCofl only on an item detail view). About 25 requests a minute on average, all keyless public endpoints, each no faster than its cache window. Configurable with `FLIPPER_AUCTION_EVERY_MIN` and `FLIPPER_AUCTION_PAGES`.

## Not used

- **BazaarTracker** (https://bazaartracker.com/api): its API page states the API "will not work unless you have purchased an API licence and obtained an api key". Paid, so excluded.
- **Moulberry lowest-BIN JSON** (https://lowestbin.moulberry.codes/lowestbin.json): **could not be reached** from the development environment (the proxy answered 502), so it could not be verified as live or maintained. The Flipper builds its own lowest-BIN data from the auction pages instead.
- **The official Hypixel wiki** is closed (July 2026), so mechanics values are marked "VERIFY IN-GAME" in `src/flipper/config.js` rather than cited.

## Values that need in-game confirmation

All in `src/flipper/config.js`, each marked `[VERIFY IN-GAME]`: the Bazaar sell tax (1.25% base, lowered by upgrades), the Auction House BIN listing fee tiers (1% / 2% / 2.5%), the flat duration fees (20 / 45 / 100 / 350 / 1200), the claim fee (1%, from 1m), the NPC per-trip limit (10 stacks) and the reading of the weekly volumes above. A profit shown by the Flipper is only as right as these.
