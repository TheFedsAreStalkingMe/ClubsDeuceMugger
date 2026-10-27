// Which auctions are the SAME item? Two "Hyperion" are only comparable if the things that change the price match. This turns an
// item's ExtraAttributes (from nbt.js) into two keys:
//   core  the identity that must match: item id, stars (upgrade_level: 1-5 dungeon, 6-10 master), recombobulator, ultimate
//         enchant, pet (type, tier, level bucket, held item, skin), Kuudra attributes, single enchanted book
//   full  core + reforge, Hot Potato / Fuming books, the whole enchant list, gemstones, dye, rune, skin
// A price is only trusted from items with the same `full` key; the same `core` key but a different `full` key is a weaker match.
// Pet level is read from the item's display name ("[Lvl 30] Bat") and bucketed: level 1, then tens (10-19, 20-29...), then 100 and 200.
// (If the name has no level, experience as a share of the experience to level 100 is used.)

const PET_MAX_EXP = { COMMON: 5624785, UNCOMMON: 8644220, RARE: 12626665, EPIC: 18608500, LEGENDARY: 25353230, MYTHIC: 25353230 };

// Other attributes that change what an item sells for (scrolls, upgrades, parts, tuning). Each is added to the full key as it is,
// so two items that differ in any of them are not treated as the same item.
const PRICE_ATTRS = ["ability_scroll", "power_ability_scroll", "art_of_war_count", "wood_singularity_count", "artOfPeaceApplied", "drill_part_engine", "drill_part_fuel_tank", "drill_part_upgrade_module", "ethermerge", "tuned_transmission", "talisman_enrichment", "mana_disintegrator_count", "jalapeno_count", "farming_for_dummies_count", "polarvoid", "is_shiny", "bookworm_books", "stats_book", "champion_combat_xp_bucket", "rune_bonus", "new_years_cake"];

const parseJson = (s) => { try { return JSON.parse(s); } catch { return null; } };
const enchantList = (e) => Object.entries(e || {}).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}${v}`);

export function variantOf(attrs, displayName = "") {
  if (!attrs || !attrs.id) return null;
  const id = attrs.id;
  const core = [id], full = [];
  const label = [];

  if (id === "PET") {
    const pet = parseJson(attrs.petInfo) || {};
    const lvl = Number((String(displayName).match(/\[Lvl (\d+)\]/) || [])[1]);
    let bucket;
    if (Number.isFinite(lvl)) bucket = lvl >= 200 ? "200" : lvl >= 100 ? "100" : lvl <= 1 ? "1" : String(Math.floor(lvl / 10) * 10);
    else {
      const max = PET_MAX_EXP[pet.tier] || PET_MAX_EXP.LEGENDARY;
      bucket = pet.exp >= max ? "100" : `x${Math.min(9, Math.floor(((pet.exp || 0) / max) * 10)) * 10}`;
    }
    core.push(pet.type || "?", pet.tier || "?", `lv${bucket}`, `held:${pet.heldItem || "none"}`, `skin:${pet.skin || "none"}`);
    label.push(`${pet.type || "Pet"} (${pet.tier || "?"}), level ${bucket === "1" ? "1" : bucket === "100" || bucket === "200" ? `${bucket}+` : bucket.startsWith("x") ? `about ${bucket.slice(1)}% of max exp` : `${bucket}-${Number(bucket) + 9}`}${pet.heldItem ? `, ${pet.heldItem}` : ""}${pet.skin ? ", skin" : ""}`);
    return { id, core: core.join("|"), full: core.join("|"), label: label.join(", ") };
  }

  const ench = attrs.enchantments || {};
  if (id === "ENCHANTED_BOOK") {
    const list = enchantList(ench);
    core.push(...list);
    label.push(`Enchanted Book: ${list.join(", ") || "?"}`);
    return { id, core: core.join("|"), full: core.join("|"), label: label.join(", ") };
  }

  const stars = attrs.upgrade_level || attrs.dungeon_item_level || 0;
  // Dungeon item quality (baseStatBoostPercentage 0-50) and the Master Mode floor change the price a lot: they are part of the identity.
  const quality = Number.isFinite(attrs.baseStatBoostPercentage) ? (attrs.baseStatBoostPercentage >= 50 ? "q50" : `q${Math.floor(attrs.baseStatBoostPercentage / 5) * 5}`) : null;
  const recomb = attrs.rarity_upgrades ? 1 : 0;
  const ultimate = Object.keys(ench).filter((k) => k.startsWith("ultimate_")).map((k) => `${k}${ench[k]}`).sort();
  const attributes = enchantList(attrs.attributes);
  core.push(`stars${stars}`, `recomb${recomb}`, ...ultimate, ...attributes.map((a) => `attr:${a}`));
  if (quality) core.push(quality);
  if (attrs.item_tier != null) core.push(`tier${attrs.item_tier}`);
  // party hats: the year and colour decide the price
  for (const k of ["party_hat_year", "party_hat_color", "party_hat_emoji"]) if (attrs[k] != null) core.push(`${k}=${attrs[k]}`);
  if (stars) label.push(`${stars} star${stars === 1 ? "" : "s"}${stars > 5 ? ` (${stars - 5} master)` : ""}`);
  if (recomb) label.push("recombobulated");
  if (ultimate.length) label.push(ultimate.join(", "));
  if (attributes.length) label.push(attributes.join(", "));

  const hp = attrs.hot_potato_count || 0;
  full.push(`reforge:${attrs.modifier || "none"}`, `hpb${Math.min(hp, 10)}`, `fuming${Math.max(0, hp - 10)}`, `ench:${enchantList(ench).join(",")}`);
  const gems = attrs.gems ? Object.entries(attrs.gems).filter(([k]) => k !== "unlocked_slots").map(([k, v]) => `${k}=${typeof v === "object" ? v.quality || "" : v}`).sort() : [];
  full.push(`gems:${gems.join(",")}`, `dye:${attrs.dye_item || "none"}`, `rune:${attrs.runes ? Object.keys(attrs.runes).join("+") : "none"}`, `skin:${attrs.skin || "none"}`);
  for (const k of PRICE_ATTRS) if (attrs[k] != null && attrs[k] !== 0 && attrs[k] !== "") full.push(`${k}=${JSON.stringify(attrs[k])}`);
  if (quality) label.push(`quality ${quality.slice(1)}${quality === "q50" ? "" : "+"}`);
  if (attrs.modifier) label.push(`reforge ${attrs.modifier}`);
  if (hp) label.push(hp > 10 ? `HPB 10 + ${hp - 10} fuming` : `${hp} HPB`);
  return { id, core: core.join("|"), full: `${core.join("|")}|${full.join("|")}`, label: label.join(", ") };
}
