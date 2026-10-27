// Reads the Auction House item_bytes: base64 -> gzip -> NBT (Minecraft's binary tag format). Auction items arrive as
// { i: [ { id, Count, Damage, tag: { display: { Name, Lore }, ExtraAttributes: { id, ... } } } ] }. Works in Workers and Node 18+
// (both have DecompressionStream). All numbers come back as JS numbers (64-bit longs may lose precision, which does not matter here).

const decoder = new TextDecoder();

export function parseNbt(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  const str = () => { const n = v.getUint16(o); o += 2; const s = decoder.decode(bytes.subarray(o, o + n)); o += n; return s; };
  function payload(type) {
    switch (type) {
      case 1: return v.getInt8(o++);
      case 2: { const x = v.getInt16(o); o += 2; return x; }
      case 3: { const x = v.getInt32(o); o += 4; return x; }
      case 4: { const x = Number(v.getBigInt64(o)); o += 8; return x; }
      case 5: { const x = v.getFloat32(o); o += 4; return x; }
      case 6: { const x = v.getFloat64(o); o += 8; return x; }
      case 7: { const n = v.getInt32(o); o += 4; const a = Array.from(bytes.subarray(o, o + n)); o += n; return a; }
      case 8: return str();
      case 9: { const t = v.getInt8(o++); const n = v.getInt32(o); o += 4; const a = []; for (let i = 0; i < n; i++) a.push(payload(t)); return a; }
      case 10: { const obj = {}; for (;;) { const t = v.getInt8(o++); if (t === 0) break; const k = str(); obj[k] = payload(t); } return obj; }
      case 11: { const n = v.getInt32(o); o += 4; const a = []; for (let i = 0; i < n; i++) { a.push(v.getInt32(o)); o += 4; } return a; }
      case 12: { const n = v.getInt32(o); o += 4; const a = []; for (let i = 0; i < n; i++) { a.push(Number(v.getBigInt64(o))); o += 8; } return a; }
      default: throw new Error(`Unknown NBT tag type ${type}`);
    }
  }
  const root = v.getInt8(o++);
  if (root !== 10) throw new Error("NBT root is not a compound");
  str(); // the root name (empty)
  return payload(10);
}

const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

export async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// item_bytes -> { id, count, name, lore, attrs } where `attrs` is ExtraAttributes (the item's internal id and modifiers), or null if unreadable.
export async function decodeItem(itemBytes) {
  try {
    const nbt = parseNbt(await gunzip(b64ToBytes(itemBytes)));
    const item = nbt.i && nbt.i[0];
    if (!item || !item.tag) return null;
    const attrs = item.tag.ExtraAttributes || {};
    return { id: attrs.id || null, count: item.Count || 1, name: item.tag.display && item.tag.display.Name, lore: (item.tag.display && item.tag.display.Lore) || [], attrs };
  } catch {
    return null;
  }
}
