// The ground: street-level land (asphalt, with holes where trenches open),
// the blocks sitting on it, the river, the land beyond the map, and the
// mountain. Receives THREE, never imports it.

import { GeoBuilder, triangulate, meshOf } from './builder.js';
import { asRect, STYLES } from '../map/buildings.js';

// Residential blocks: the middle is backyards, not concrete.
const YARDS = new Set(['plex', 'brick', 'walkups', 'lofts']);

const GROUND = {
  sidewalk: { material: 'Sidewalk', h: 0.15 },
  grass: { material: 'Grass', h: 0.12 },
  parking: { material: 'Parking', h: 0.1 },
  gravel: { material: 'Gravel', h: 0.08 },
  plaza: { material: 'Plaza', h: 0.12 },
};

/** Land at street level: one mesh, asphalt, holes cut for the trenches. */
export function buildLand(THREE, layout, M) {
  const b = new GeoBuilder();
  for (const poly of layout.flat) {
    const { pts, tris } = triangulate(THREE, poly.map(openRing));
    b.flat(pts, tris, 0);
  }
  const mesh = meshOf(THREE, b, M.Asphalt, 'Sol');
  mesh.userData.zone = 'sol';
  mesh.receiveShadow = true;
  return mesh;
}

/** Blocks: a slab per block with its kerb, grouped by district and surface. */
export function buildBlocks(THREE, layout, M) {
  const groups = new Map();
  const yards = new Map();
  for (const block of layout.blocks) {
    const g = GROUND[block.ground] || GROUND.sidewalk;
    const key = (block.district || 'autres') + '|' + g.material;
    if (!groups.has(key)) groups.set(key, { b: new GeoBuilder(), kerb: new GeoBuilder(), g, zone: block.district || 'autres' });
    const { b, kerb } = groups.get(key);
    const { pts, tris, outer, holes } = triangulate(THREE, block.poly);
    b.flat(pts, tris, g.h);
    const rect = YARDS.has(block.style) ? asRect(block.poly[0]) : null;
    if (rect) {
      const s = (STYLES[block.style].sidewalk || 3) + 0.2;
      if (rect.x1 - rect.x0 > 2 * s + 4 && rect.n1 - rect.n0 > 2 * s + 4) {
        const zone = block.district || 'autres';
        if (!yards.has(zone)) yards.set(zone, new GeoBuilder());
        const y = yards.get(zone);
        const q = [[rect.x0 + s, rect.n0 + s], [rect.x1 - s, rect.n0 + s], [rect.x1 - s, rect.n1 - s], [rect.x0 + s, rect.n1 - s]];
        y.flat(q, [0, 1, 2, 0, 2, 3], g.h + 0.01);
      }
    }
    // Kerb faces: outer ring counter-clockwise faces out, holes clockwise.
    for (const ring of [outer, ...holes]) {
      let u = 0;
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], c = ring[(i + 1) % ring.length];
        u += kerb.wall(a[0], a[1], c[0], c[1], -0.05, g.h, -0.05, g.h, u);
      }
    }
  }
  const out = [];
  for (const [zone, y] of yards) {
    const m = meshOf(THREE, y, M.Yard, `Cours_${zone}`);
    if (m) { m.userData.zone = zone; out.push(m); }
  }
  for (const [key, { b, kerb, g, zone }] of groups) {
    const top = meshOf(THREE, b, M[g.material], `Ilots_${key}`);
    if (top) { top.userData.zone = zone; top.receiveShadow = true; out.push(top); }
    const k = meshOf(THREE, kerb, M.Curb, `Bordures_${key}`);
    if (k) { k.userData.zone = zone; out.push(k); }
  }
  return out;
}

/** The river and the canal: a single plane under the land. */
export function buildWater(THREE, layout, M) {
  const W = layout.map.world, y = layout.map.levels.water, pad = 4000;
  const b = new GeoBuilder();
  const pts = [[W.x0 - pad, W.n0 - pad], [W.x1 + pad, W.n0 - pad], [W.x1 + pad, W.n1 + pad], [W.x0 - pad, W.n1 + pad]];
  b.flat(pts, [0, 1, 2, 0, 2, 3], y);
  const m = meshOf(THREE, b, M.Water, 'Fleuve');
  m.userData.zone = 'sol';
  return m;
}

/**
 * Beyond the map: flat land out to the horizon, so the edge of the world is
 * never a cliff into the void. The south of it is the South Shore.
 */
export function buildOutside(THREE, layout, M) {
  const W = layout.map.world, far = 14000;
  const b = new GeoBuilder();
  const outer = [[W.x0 - far, W.n0 - far], [W.x1 + far, W.n0 - far], [W.x1 + far, W.n1 + far], [W.x0 - far, W.n1 + far]];
  const inner = [[W.x0, W.n0], [W.x0, W.n1], [W.x1, W.n1], [W.x1, W.n0]];
  const { pts, tris } = triangulate(THREE, [outer, inner]);
  b.flat(pts, tris, 0.0, false, 0.25);
  const m = meshOf(THREE, b, M.Gravel, 'Horizon');
  m.userData.zone = 'sol';
  m.userData.exportSkip = true;
  return m;
}

/**
 * Mont Royal: a grid over the mountain's box. Cells outside the footprint are
 * dropped; the first ring of outside vertices sits a few centimetres under the
 * land so there is never a crack along the edge (the terrain material draws
 * behind coplanar land thanks to its polygon offset).
 */
export function buildTerrain(THREE, layout, M, step = 5) {
  const T = layout.terrain, bb = T.bbox;
  const x0 = bb.x0 - step * 2, n0 = bb.n0 - step * 2;
  const cols = Math.ceil((bb.x1 - bb.x0) / step) + 5;
  const rows = Math.ceil((bb.n1 - bb.n0) / step) + 5;
  const H = new Float32Array(cols * rows);
  const inside = new Uint8Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x = x0 + i * step, n = n0 + j * step;
      const k = j * cols + i;
      inside[k] = T.inside(x, n) ? 1 : 0;
      H[k] = inside[k] ? T.height(x, n) : -0.06;
    }
  }
  const b = new GeoBuilder({ color: 3 });
  const idx = new Int32Array(cols * rows).fill(-1);
  const vertex = (i, j) => {
    const k = j * cols + i;
    if (idx[k] >= 0) return idx[k];
    const x = x0 + i * step, n = n0 + j * step;
    const hL = H[j * cols + Math.max(0, i - 1)], hR = H[j * cols + Math.min(cols - 1, i + 1)];
    const hD = H[Math.max(0, j - 1) * cols + i], hU = H[Math.min(rows - 1, j + 1) * cols + i];
    let nx = (hL - hR) / (2 * step), nn = (hD - hU) / (2 * step), ny = 1;
    const l = Math.hypot(nx, nn, ny);
    nx /= l; nn /= l; ny /= l;
    const slope = 1 - ny;
    // Forest floor, rock where it is steep, a little lighter up high.
    const rock = Math.min(1, Math.max(0, (slope - 0.18) / 0.22));
    const high = Math.min(1, Math.max(0, H[k] / 110));
    // Colours picked in sRGB, stored linear as three.js expects of vertex colours.
    const lin = (c) => Math.pow(c, 2.2);
    const r = 0.21 + 0.22 * rock + 0.04 * high, g = 0.27 + 0.12 * rock + 0.05 * high, bl = 0.17 + 0.19 * rock;
    idx[k] = b.v(x, n, H[k], nx, nn, ny, x, n, lin(r), lin(g), lin(bl));
    return idx[k];
  };
  for (let j = 0; j + 1 < rows; j++) {
    for (let i = 0; i + 1 < cols; i++) {
      const k = j * cols + i;
      if (!(inside[k] || inside[k + 1] || inside[k + cols] || inside[k + cols + 1])) continue;
      const a = vertex(i, j), c = vertex(i + 1, j), d = vertex(i + 1, j + 1), e = vertex(i, j + 1);
      b.quad(a, c, d, e);
    }
  }
  const m = meshOf(THREE, b, M.Terrain, 'Mont-Royal');
  m.material.polygonOffset = true;
  m.material.polygonOffsetFactor = 1;
  m.material.polygonOffsetUnits = 2;
  m.userData.zone = 'mont-royal';
  m.receiveShadow = true;
  return m;
}

function openRing(ring) {
  const r = ring.slice();
  const a = r[0], z = r[r.length - 1];
  if (r.length > 1 && Math.abs(a[0] - z[0]) < 1e-9 && Math.abs(a[1] - z[1]) < 1e-9) r.pop();
  return r;
}
