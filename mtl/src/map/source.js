// The real city as tools/extract.py left it in mtl/data/: read the files and
// decode them, nothing more. Coordinates are real metres in Montréal's street
// grid frame (x "east", n "north", origin at Peel and Sainte-Catherine);
// zones and scale are applied later, by map/real.js.
//
// `read(name, kind)` fetches one file — 'json', 'text' or 'bin' — so the same
// code runs in the page (fetch) and under node (fs).

export const FILES = ['meta.json', 'rues.json', 'surfaces.json', 'quartiers.json', 'mobilier.json',
  'batiments-noms.json', 'batiments.bin', 'arbres.bin', 'relief.bin'];

const BUILDING_KINDS = ['', 'residential', 'commercial', 'industrial', 'religious', 'education', 'civic', 'medical',
  'transportation', 'entertainment', 'outbuilding', 'agricultural', 'military', 'service'];
const ROOFS = ['', 'gabled', 'hipped', 'dome', 'skillion', 'gambrel', 'mansard', 'saltbox', 'pyramidal', 'onion', 'round'];

export async function loadSource(read) {
  const json = (name) => read(name, 'json');
  const bin = (name) => read(name, 'bin');
  const [meta, rues, surfaces, quartiers, mobilier, noms, bld, arb, rel] = await Promise.all([
    json('meta.json'), json('rues.json'), json('surfaces.json'), json('quartiers.json'), json('mobilier.json'),
    json('batiments-noms.json'), bin('batiments.bin'), bin('arbres.bin'), bin('relief.bin'),
  ]);
  return {
    meta,
    roads: decodeRoads(rues),
    surfaces: decodeSurfaces(surfaces),
    quartiers,
    furniture: mobilier.map(([k, x, n]) => ({ kind: k === 1 ? 'signal' : 'lamp', x, n })),
    buildings: decodeBuildings(bld, noms),
    trees: decodeTrees(arb),
    relief: decodeRelief(rel),
  };
}

/** Browser: files next to the page. */
export function fetchReader(base = 'data/') {
  return async (name, kind) => {
    const r = await fetch(base + name);
    if (!r.ok) throw new Error(`${name} : ${r.status}`);
    if (kind === 'json') return r.json();
    if (kind === 'text') return r.text();
    return r.arrayBuffer();
  };
}

function decodeRoads(doc) {
  const names = doc.names;
  return doc.roads.map((r, id) => {
    const pts = [];
    for (let i = 0; i < r.p.length; i += 2) pts.push([r.p[i] / 10, r.p[i + 1] / 10]);
    return {
      id,
      cls: r.c,
      kind: r.k || null,          // 'link' | 'alley' | null
      name: names[r.n] || '',
      ref: r.r || null,           // 'A15', 'R136'…
      oneway: !!r.o,              // travel runs along the points
      pts,
      levels: r.l || null,        // per edge: OSM layer
      flags: r.f || null,         // per edge: 1 bridge, 2 tunnel
      a: r.a, b: r.b,             // connector ids at both ends, -1 if none
    };
  });
}

function ring(flat) {
  const out = [];
  for (let i = 0; i < flat.length; i += 2) out.push([flat[i], flat[i + 1]]);
  return out;
}

function decodeSurfaces(doc) {
  const polys = (p) => p.map((poly) => poly.map(ring));
  return {
    water: doc.eau.map((w) => ({ name: w.nom, kind: w.type, level: w.niveau, poly: polys(w.poly) })),
    green: doc.verdure.map((g) => ({ kind: g.type, name: g.nom, poly: polys(g.poly) })),
    ground: doc.sol.map((g) => ({ kind: g.type, name: g.nom, poly: polys(g.poly) })),
  };
}

function decodeBuildings(buf, names) {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'MTLB') throw new Error('batiments.bin : format inconnu');
  const count = dv.getUint32(8, true);
  const out = new Array(count);
  let o = 12;
  for (let k = 0; k < count; k++) {
    const np = dv.getUint16(o, true);
    let x = dv.getInt32(o + 2, true), n = dv.getInt32(o + 6, true);
    o += 10;
    const ring = [[x / 10, n / 10]];
    for (let i = 1; i < np; i++) {
      x += dv.getInt16(o, true);
      n += dv.getInt16(o + 2, true);
      o += 4;
      ring.push([x / 10, n / 10]);
    }
    const h = dv.getUint16(o, true) / 10, minH = dv.getUint16(o + 2, true) / 10;
    const floors = dv.getUint8(o + 4), kind = dv.getUint8(o + 5), roof = dv.getUint8(o + 6), flags = dv.getUint8(o + 7);
    o += 8;
    out[k] = {
      id: k, ring, h, minH, floors,
      kind: BUILDING_KINDS[kind] || '', roof: ROOFS[roof] || '',
      part: !!(flags & 1), name: names[k] || '',
    };
  }
  return out;
}

function decodeTrees(buf) {
  const dv = new DataView(buf);
  const count = dv.getUint32(8, true);
  const xs = new Float32Array(count), ns = new Float32Array(count);
  for (let k = 0, o = 12; k < count; k++, o += 8) {
    xs[k] = dv.getInt32(o, true) / 10;
    ns[k] = dv.getInt32(o + 4, true) / 10;
  }
  return { count, xs, ns };
}

function decodeRelief(buf) {
  const dv = new DataView(buf);
  const x0 = dv.getFloat32(8, true), n0 = dv.getFloat32(12, true);
  const dx = dv.getFloat32(16, true), dn = dv.getFloat32(20, true);
  const cols = dv.getUint32(24, true), rows = dv.getUint32(28, true);
  const raw = new Int16Array(buf.slice(32, 32 + cols * rows * 2));
  const data = new Float32Array(cols * rows);
  for (let i = 0; i < data.length; i++) data[i] = raw[i] / 10;
  return { x0, n0, dx, dn, cols, rows, data };
}
