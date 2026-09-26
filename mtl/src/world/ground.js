// The ground: Montréal's relief as one grid mesh per tile, cut open where
// there is water or a trench, and coloured by what covers it — lawns, parks,
// the mountain's woods, parking lots, rail yards. The streets are laid on top
// (world/streets.js), the buildings stand on it.
//
// Every full cell is the exact pair of triangles map/terrain.js reads heights
// from, so the car, the streets and the ground agree to the millimetre. Only
// the cells a shoreline or a trench edge crosses are clipped; their few
// triangles are the one place the mesh and the function differ, and only
// inside that cell.
//
// Receives THREE, never imports it.

import { GeoBuilder, triangulate, meshOf } from './builder.js';
import * as G from '../map/geom.js';

// Ground colours, sRGB; stored linear, as three.js expects vertex colours.
const COVER = {
  lot: [0.37, 0.36, 0.33],
  gazon: [0.31, 0.40, 0.22], parc: [0.27, 0.38, 0.20], terrain: [0.30, 0.43, 0.22], golf: [0.32, 0.46, 0.24],
  cimetiere: [0.27, 0.36, 0.21], foret: [0.17, 0.26, 0.13],
  industriel: [0.43, 0.42, 0.39], voies: [0.33, 0.30, 0.27], place: [0.55, 0.52, 0.47], stationnement: [0.23, 0.23, 0.24],
};
const PRIORITY = { foret: 1, gazon: 2, parc: 2, terrain: 3, golf: 3, cimetiere: 2, industriel: 4, voies: 4, place: 5, stationnement: 6 };
const lin = (c) => Math.pow(c, 2.2);

/**
 * @returns { meshes: Mesh[] } every mesh tagged userData.tile / userData.layer
 */
export function buildGround(THREE, layout, M, tiles) {
  const T = layout.terrain, g = T.grid, W = layout.map.world;
  const cell = g.cell;
  const i0 = Math.max(0, Math.floor((W.x0 - g.x0) / cell)), i1 = Math.min(g.cols - 1, Math.ceil((W.x1 - g.x0) / cell));
  const j0 = Math.max(0, Math.floor((W.n0 - g.n0) / cell)), j1 = Math.min(g.rows - 1, Math.ceil((W.n1 - g.n0) / cell));
  const X = (i) => g.x0 + i * cell, N = (j) => g.n0 + j * cell;

  // --- what covers the ground, per vertex ---------------------------------------
  const cover = coverIndex(layout);
  const cols = i1 - i0 + 1, rows = j1 - j0 + 1;
  const color = new Float32Array(cols * rows * 3);
  const normal = new Float32Array(cols * rows * 3);
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const k = (j - j0) * cols + (i - i0);
      const x = X(i), n = N(j);
      const hL = g.h[j * g.cols + Math.max(0, i - 1)], hR = g.h[j * g.cols + Math.min(g.cols - 1, i + 1)];
      const hD = g.h[Math.max(0, j - 1) * g.cols + i], hU = g.h[Math.min(g.rows - 1, j + 1) * g.cols + i];
      let nx = (hL - hR) / (2 * cell), nn = (hD - hU) / (2 * cell), ny = 1;
      const l = Math.hypot(nx, nn, ny);
      nx /= l; nn /= l; ny /= l;
      normal[k * 3] = nx; normal[k * 3 + 1] = nn; normal[k * 3 + 2] = ny;
      const c = COVER[cover(x, n)] || COVER.lot;
      // Steep ground shows rock and dry earth whatever grows on it.
      const rock = Math.min(1, Math.max(0, (1 - ny - 0.12) / 0.2));
      color[k * 3] = lin(c[0] + (0.42 - c[0]) * rock);
      color[k * 3 + 1] = lin(c[1] + (0.39 - c[1]) * rock);
      color[k * 3 + 2] = lin(c[2] + (0.34 - c[2]) * rock);
    }
  }

  // --- what cuts the ground: water and trenches ----------------------------------
  const cuts = [...layout.water, ...layout.holes].map((poly) => ({ poly, bb: G.ringBBox(poly[0]) }));
  const cutGrid = new G.Grid(cell * 4);
  for (const c of cuts) cutGrid.insert(c, c.bb.x0, c.bb.n0, c.bb.x1, c.bb.n1);
  // Cells an edge of a cut crosses, found by walking each edge through the
  // grid cell by cell.
  const boundary = new Map();       // cell key → Set of cut indices
  const cellKey = (i, j) => j * g.cols + i;
  const mark = (i, j, ci) => {
    const k = cellKey(i, j);
    let set = boundary.get(k);
    if (!set) { set = new Set(); boundary.set(k, set); }
    set.add(ci);
  };
  cuts.forEach((c, ci) => {
    for (const ring of c.poly) {
      for (let a = 0; a < ring.length; a++) {
        const p = ring[a], q = ring[(a + 1) % ring.length];
        traverse((p[0] - g.x0) / cell, (p[1] - g.n0) / cell, (q[0] - g.x0) / cell, (q[1] - g.n0) / cell,
          (i, j) => mark(i, j, ci));
      }
    }
  });
  const tmp = [];
  const cutAt = (x, n) => {
    for (const c of cutGrid.query(x, n, 0, tmp)) {
      if (x < c.bb.x0 || x > c.bb.x1 || n < c.bb.n0 || n > c.bb.n1) continue;
      if (G.pointInPolygon(x, n, c.poly)) return true;
    }
    return false;
  };
  // The cuts, pre-clipped to 8 × 8-cell blocks: a cell then clips against a
  // few dozen vertices instead of the whole river.
  const BLOCK = 8;
  const local = new Map();
  const localCuts = (i, j, near) => {
    const bi = Math.floor(i / BLOCK), bj = Math.floor(j / BLOCK);
    const key = bj * 100000 + bi;
    let m = local.get(key);
    if (!m) { m = new Map(); local.set(key, m); }
    const out = [];
    const bx0 = g.x0 + bi * BLOCK * cell, bn0 = g.n0 + bj * BLOCK * cell;
    const bx1 = bx0 + BLOCK * cell, bn1 = bn0 + BLOCK * cell;
    for (const ci of near) {
      let piece = m.get(ci);
      if (piece === undefined) {
        const rings = [];
        for (let r = 0; r < cuts[ci].poly.length; r++) {
          const cl = clipRing(cuts[ci].poly[r], bx0 - 0.5, bn0 - 0.5, bx1 + 0.5, bn1 + 0.5);
          if (cl.length >= 3) rings.push(G.closeRing(cl));
          else if (r === 0) break;
        }
        piece = rings.length ? rings : null;
        m.set(ci, piece);
      }
      if (piece) out.push(piece);
    }
    return out;
  };

  // --- mesh, tile by tile ------------------------------------------------------
  const builders = new Map();
  const tileOf = (x, n) => {
    const key = tiles.key(x, n);
    let t = builders.get(key);
    if (!t) { t = { b: new GeoBuilder({ color: 3 }), idx: new Map() }; builders.set(key, t); }
    return t;
  };
  const gridVertex = (t, i, j) => {
    const k = (j - j0) * cols + (i - i0);
    let v = t.idx.get(k);
    if (v !== undefined) return v;
    v = t.b.v(X(i), N(j), g.h[j * g.cols + i], normal[k * 3], normal[k * 3 + 1], normal[k * 3 + 2], X(i), N(j),
      color[k * 3], color[k * 3 + 1], color[k * 3 + 2]);
    t.idx.set(k, v);
    return v;
  };
  const colorAt = (x, n) => {
    const i = Math.min(i1, Math.max(i0, Math.round((x - g.x0) / cell))), j = Math.min(j1, Math.max(j0, Math.round((n - g.n0) / cell)));
    const k = (j - j0) * cols + (i - i0);
    return [color[k * 3], color[k * 3 + 1], color[k * 3 + 2], normal[k * 3], normal[k * 3 + 1], normal[k * 3 + 2]];
  };
  let clipped = 0;
  for (let j = j0; j < j1; j++) {
    for (let i = i0; i < i1; i++) {
      const x = X(i), n = N(j);
      if (x + cell < W.x0 || x > W.x1 || n + cell < W.n0 || n > W.n1) continue;
      const t = tileOf(x + cell / 2, n + cell / 2);
      const near = boundary.get(cellKey(i, j));
      if (!near) {
        if (cutAt(x + cell / 2, n + cell / 2)) continue;
        // The diagonal runs (i, j) → (i + 1, j + 1), as in terrain.height().
        const a = gridVertex(t, i, j), b = gridVertex(t, i + 1, j), c = gridVertex(t, i + 1, j + 1), d = gridVertex(t, i, j + 1);
        t.b.tri(a, b, c);
        t.b.tri(a, c, d);
        continue;
      }
      // A shore or a trench edge crosses this cell: keep what is land.
      const square = [[[x, n], [x + cell, n], [x + cell, n + cell], [x, n + cell], [x, n]]];
      let land;
      try {
        const pieces = localCuts(i, j, near);
        land = pieces.length ? G.pc.difference(square, ...pieces) : square;
      } catch (e) {
        land = cutAt(x + cell / 2, n + cell / 2) ? [] : square;
      }
      clipped++;
      for (const poly of land) {
        if (G.polygonArea(poly) < 0.05) continue;
        const { pts, tris } = triangulate(THREE, poly.map(G.openRing));
        const base = t.b.count;
        for (const [px, pn] of pts) {
          const [r, gg, bl, nx, nn, ny] = colorAt(px, pn);
          t.b.v(px, pn, T.height(px, pn), nx, nn, ny, px, pn, r, gg, bl);
        }
        for (let q = 0; q < tris.length; q += 3) t.b.tri(base + tris[q], base + tris[q + 1], base + tris[q + 2]);
      }
    }
  }

  const meshes = [];
  for (const [key, t] of builders) {
    const m = meshOf(THREE, t.b, M.Terrain, `Sol_${key}`);
    if (!m) continue;
    m.receiveShadow = true;
    m.userData.tile = key;
    m.userData.layer = 'sol';
    meshes.push(m);
  }

  // --- water ---------------------------------------------------------------------
  for (const w of layout.waterBodies) {
    const b = new GeoBuilder();
    for (const poly of w.poly) {
      const { pts, tris } = triangulate(THREE, poly.map(G.openRing));
      b.flat(pts, tris, w.level);
    }
    const m = meshOf(THREE, b, M.Water, `Eau_${w.name || w.kind}`);
    if (!m) continue;
    m.userData.layer = 'eau';
    m.userData.tile = tiles.key(...centre(w.poly[0][0]));
    meshes.push(m);
  }

  // --- the zone's rim: a skirt down so the edge never shows a crack ---------------
  meshes.push(...buildRim(THREE, layout, M));
  return { meshes, stats: { clipped } };
}

/**
 * Beyond the zone: the real relief carries on, coarse and bare, with the river
 * in it — a map on a table, not a map in the void. Then flat land to the
 * horizon.
 */
export function buildOutside(THREE, layout, M) {
  const T = layout.terrain, g = T.grid, W = layout.map.world;
  const step = 5;                       // mesh vertices: every fifth
  const b = new GeoBuilder({ color: 3 });
  const idx = new Map();
  const c0 = lin(0.35), c1 = lin(0.36), c2 = lin(0.33);
  const vert = (i, j) => {
    const k = j * g.cols + i;
    let v = idx.get(k);
    if (v !== undefined) return v;
    const x = g.x0 + i * g.cell, n = g.n0 + j * g.cell;
    v = b.v(x, n, g.h[k] - 0.3, 0, 0, 1, x, n, c0, c1, c2);
    idx.set(k, v);
    return v;
  };
  for (let j = 0; j + step < g.rows; j += step) {
    for (let i = 0; i + step < g.cols; i += step) {
      const x = g.x0 + i * g.cell, n = g.n0 + j * g.cell, e = step * g.cell;
      if (x >= W.x0 && x + e <= W.x1 && n >= W.n0 && n + e <= W.n1) continue;
      const a = vert(i, j), c = vert(i + step, j), d = vert(i + step, j + step), f = vert(i, j + step);
      b.tri(a, c, d);
      b.tri(a, d, f);
    }
  }
  const out = [];
  // A far-off city in a texture: roofs and parks by day, street lights by night.
  const mat = M.Outskirts || M.Terrain;
  const m = meshOf(THREE, b, mat, 'Alentours');
  if (m) {
    m.userData.layer = 'alentours';
    m.userData.exportSkip = true;
    m.material = mat;
    out.push(m);
  }
  // The river, around and outside the zone: a plane at its level with the zone
  // cut out (inside the zone every body of water is its own mesh).
  const far = 16000;
  const bb = T.bbox;
  const outer = [[bb.x0 - far, bb.n0 - far], [bb.x1 + far, bb.n0 - far], [bb.x1 + far, bb.n1 + far], [bb.x0 - far, bb.n1 + far]];
  const inner = [[W.x0, W.n0], [W.x0, W.n1], [W.x1, W.n1], [W.x1, W.n0]];
  const ring = triangulate(THREE, [outer, inner]);
  const wb = new GeoBuilder();
  wb.flat(ring.pts, ring.tris, -0.4);
  const w = meshOf(THREE, wb, M.Water, 'Fleuve_alentours');
  w.userData.layer = 'alentours';
  w.userData.exportSkip = true;
  out.push(w);
  return out;
}

function buildRim(THREE, layout, M) {
  const T = layout.terrain, W = layout.map.world;
  const b = new GeoBuilder();
  const edges = [[[W.x0, W.n0], [W.x1, W.n0]], [[W.x1, W.n0], [W.x1, W.n1]], [[W.x1, W.n1], [W.x0, W.n1]], [[W.x0, W.n1], [W.x0, W.n0]]];
  for (const [p, q] of edges) {
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const steps = Math.ceil(len / 10);
    for (let s = 0; s < steps; s++) {
      const ax = p[0] + ((q[0] - p[0]) * s) / steps, an = p[1] + ((q[1] - p[1]) * s) / steps;
      const bx = p[0] + ((q[0] - p[0]) * (s + 1)) / steps, bn = p[1] + ((q[1] - p[1]) * (s + 1)) / steps;
      const ya = T.height(ax, an), yb = T.height(bx, bn);
      // Facing out of the zone: the ring is counter-clockwise, walls face right.
      b.wall(ax, an, bx, bn, ya - 6, ya, yb - 6, yb);
    }
  }
  const m = meshOf(THREE, b, M.Concrete_Dark, 'Bord_de_zone');
  m.userData.layer = 'sol';
  m.userData.exportSkip = true;
  return [m];
}

/** "What covers the ground at (x, n)?" over the parks and land-use polygons. */
function coverIndex(layout) {
  const items = [];
  for (const g of [...layout.greens, ...layout.grounds]) {
    for (const poly of g.poly) items.push({ kind: g.kind, poly, bb: G.ringBBox(poly[0]), p: PRIORITY[g.kind] || 0 });
  }
  const grid = new G.Grid(100);
  for (const it of items) grid.insert(it, it.bb.x0, it.bb.n0, it.bb.x1, it.bb.n1);
  const tmp = [];
  return (x, n) => {
    let best = null;
    for (const it of grid.query(x, n, 0, tmp)) {
      if (best && it.p <= best.p) continue;
      if (x < it.bb.x0 || x > it.bb.x1 || n < it.bb.n0 || n > it.bb.n1) continue;
      if (G.pointInPolygon(x, n, it.poly)) best = it;
    }
    return best ? best.kind : 'lot';
  };
}

function centre(ring) {
  let x = 0, n = 0;
  for (const p of ring) { x += p[0]; n += p[1]; }
  return [x / ring.length, n / ring.length];
}

/**
 * Every grid cell the segment (ax, an) → (bx, bn) passes through, in cell
 * units (Amanatides & Woo).
 */
function traverse(ax, an, bx, bn, visit) {
  let i = Math.floor(ax), j = Math.floor(an);
  const iEnd = Math.floor(bx), jEnd = Math.floor(bn);
  const dx = bx - ax, dn = bn - an;
  const stepI = dx > 0 ? 1 : -1, stepJ = dn > 0 ? 1 : -1;
  const tDeltaI = dx !== 0 ? Math.abs(1 / dx) : Infinity, tDeltaJ = dn !== 0 ? Math.abs(1 / dn) : Infinity;
  let tMaxI = dx !== 0 ? ((dx > 0 ? i + 1 - ax : ax - i) * tDeltaI) : Infinity;
  let tMaxJ = dn !== 0 ? ((dn > 0 ? j + 1 - an : an - j) * tDeltaJ) : Infinity;
  visit(i, j);
  let guard = 0;
  while ((i !== iEnd || j !== jEnd) && guard++ < 100000) {
    if (tMaxI < tMaxJ) { i += stepI; tMaxI += tDeltaI; } else { j += stepJ; tMaxJ += tDeltaJ; }
    visit(i, j);
  }
}

/** Sutherland–Hodgman: a ring clipped to an axis-aligned box (open ring out). */
function clipRing(ring, x0, n0, x1, n1) {
  let pts = G.openRing(ring);
  const edges = [
    (p) => p[0] >= x0, (p) => p[0] <= x1, (p) => p[1] >= n0, (p) => p[1] <= n1,
  ];
  const cross = [
    (a, b) => { const t = (x0 - a[0]) / (b[0] - a[0]); return [x0, a[1] + (b[1] - a[1]) * t]; },
    (a, b) => { const t = (x1 - a[0]) / (b[0] - a[0]); return [x1, a[1] + (b[1] - a[1]) * t]; },
    (a, b) => { const t = (n0 - a[1]) / (b[1] - a[1]); return [a[0] + (b[0] - a[0]) * t, n0]; },
    (a, b) => { const t = (n1 - a[1]) / (b[1] - a[1]); return [a[0] + (b[0] - a[0]) * t, n1]; },
  ];
  for (let e = 0; e < 4 && pts.length; e++) {
    const inside = edges[e], out = [];
    for (let k = 0; k < pts.length; k++) {
      const a = pts[(k + pts.length - 1) % pts.length], b = pts[k];
      const ia = inside(a), ib = inside(b);
      if (ib) {
        if (!ia) out.push(cross[e](a, b));
        out.push(b);
      } else if (ia) {
        out.push(cross[e](a, b));
      }
    }
    pts = out;
  }
  return pts;
}
