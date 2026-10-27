// Builds Hypixel-style item_bytes (base64 of gzipped NBT) for tests, so items with exact modifiers can be made.
import zlib from "node:zlib";

function payload(type, v, out) {
  switch (type) {
    case 1: out.push(Buffer.from([v & 255])); break;
    case 2: { const b = Buffer.alloc(2); b.writeInt16BE(v); out.push(b); break; }
    case 3: { const b = Buffer.alloc(4); b.writeInt32BE(v); out.push(b); break; }
    case 4: { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(v)); out.push(b); break; }
    case 8: { const s = Buffer.from(v, "utf8"); const b = Buffer.alloc(2); b.writeUInt16BE(s.length); out.push(b, s); break; }
    case 9: { const [t, items] = v; out.push(Buffer.from([t])); const b = Buffer.alloc(4); b.writeInt32BE(items.length); out.push(b); for (const x of items) payload(t, x, out); break; }
    case 10: for (const [k, [t, x]] of Object.entries(v)) { out.push(Buffer.from([t])); payload(8, k, out); payload(t, x, out); } out.push(Buffer.from([0])); break;
    default: throw new Error(`type ${type}`);
  }
}
export const nbtPayload = payload;
const typed = (v) => (typeof v === "string" ? [8, v] : typeof v === "number" ? [3, v] : [10, Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typed(x)]))]);

// itemBytes({ id: "HYPERION", upgrade_level: 5, enchantments: { sharpness: 7 } }, "Name") -> base64 gzip NBT like item_bytes
export function itemBytes(attrs, name = "Item", lore = []) {
  const root = { i: [9, [10, [{ id: [2, 1], Count: [1, 1], Damage: [2, 0], tag: [10, { display: [10, { Name: [8, name], Lore: [9, [8, lore]] }], ExtraAttributes: [10, Object.fromEntries(Object.entries(attrs).map(([k, x]) => [k, typed(x)]))] }] }]]] };
  const out = [Buffer.from([10]), Buffer.from([0, 0])];
  payload(10, root, out);
  return zlib.gzipSync(Buffer.concat(out)).toString("base64");
}
