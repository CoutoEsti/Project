// A .zip with stored (uncompressed) entries: enough to hand the Unity export
// over as one download instead of dozens, with no library. The .glb inside
// are already binary; deflate would gain little on them.

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * @param files [{ name, data: ArrayBuffer | Uint8Array | string }]
 * @returns Uint8Array, the whole archive
 */
export function zip(files) {
  const enc = new TextEncoder();
  const entries = files.map((f) => {
    const data = typeof f.data === 'string' ? enc.encode(f.data) : new Uint8Array(f.data.buffer || f.data, f.data.byteOffset || 0, f.data.byteLength);
    return { name: enc.encode(f.name), data, crc: crc32(data) };
  });
  let size = 22;
  for (const e of entries) size += 30 + e.name.length + e.data.length + 46 + e.name.length;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  let o = 0;
  const offsets = [];
  // DOS date 2026-01-01 00:00: a fixed stamp keeps the archive reproducible.
  const TIME = 0, DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
  for (const e of entries) {
    offsets.push(o);
    dv.setUint32(o, 0x04034b50, true);
    dv.setUint16(o + 4, 20, true);
    dv.setUint16(o + 6, 0x0800, true);          // UTF-8 names
    dv.setUint16(o + 8, 0, true);               // stored
    dv.setUint16(o + 10, TIME, true);
    dv.setUint16(o + 12, DATE, true);
    dv.setUint32(o + 14, e.crc, true);
    dv.setUint32(o + 18, e.data.length, true);
    dv.setUint32(o + 22, e.data.length, true);
    dv.setUint16(o + 26, e.name.length, true);
    dv.setUint16(o + 28, 0, true);
    out.set(e.name, o + 30);
    out.set(e.data, o + 30 + e.name.length);
    o += 30 + e.name.length + e.data.length;
  }
  const cd = o;
  entries.forEach((e, i) => {
    dv.setUint32(o, 0x02014b50, true);
    dv.setUint16(o + 4, 20, true);
    dv.setUint16(o + 6, 20, true);
    dv.setUint16(o + 8, 0x0800, true);
    dv.setUint16(o + 10, 0, true);
    dv.setUint16(o + 12, TIME, true);
    dv.setUint16(o + 14, DATE, true);
    dv.setUint32(o + 16, e.crc, true);
    dv.setUint32(o + 20, e.data.length, true);
    dv.setUint32(o + 24, e.data.length, true);
    dv.setUint16(o + 28, e.name.length, true);
    dv.setUint32(o + 42, offsets[i], true);
    out.set(e.name, o + 46);
    o += 46 + e.name.length;
  });
  dv.setUint32(o, 0x06054b50, true);
  dv.setUint16(o + 8, entries.length, true);
  dv.setUint16(o + 10, entries.length, true);
  dv.setUint32(o + 12, o - cd, true);
  dv.setUint32(o + 16, cd, true);
  return out;
}
