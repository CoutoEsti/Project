// Buildings to meshes: one facade mesh, one roof mesh and one detail mesh per
// district. Facade UVs count window bays across and floors up, so the atlas
// shader lines windows up with corners and floor lines on every wall.

import { GeoBuilder, triangulate, meshOf } from './builder.js';
import { FACADES } from './textures.js';
import { hash01 } from '../map/geom.js';

const BAY = {
  brick_red: 2.7, brick_brown: 2.7, brick_buff: 2.9, brick_dark: 2.7, brick_old: 3.6, stone: 3.2,
  stone_dark: 3.2, concrete: 3.4, panel: 6.5, panel_dark: 6.5, glass_blue: 3.0, glass_dark: 3.0,
  glass_green: 3.0, glass_silver: 3.0,
};

export function buildBuildings(THREE, buildings, M) {
  const zones = new Map();
  const zone = (id) => {
    if (!zones.has(id)) {
      zones.set(id, {
        facade: new GeoBuilder({ facade: 1, seed: 1 }),
        roof: new GeoBuilder(),
        copper: new GeoBuilder(),
        stairs: new GeoBuilder(),
        glow: new GeoBuilder(),
      });
    }
    return zones.get(id);
  };

  buildings.forEach((bld, k) => {
    const Z = zone(bld.tile || bld.district || 'autres');
    let ring = bld.ring.map((p) => [p[0], p[1]]);
    if (area(ring) < 0) ring = ring.reverse();
    const base = (bld.base || 0) + (bld.minH || 0);
    const top = (bld.base || 0) + bld.h;
    if (top - base < 0.5) return;
    const floorH = bld.floorH || 3.3;
    const fIndex = Math.max(0, FACADES.indexOf(bld.facade));
    const bay = (BAY[bld.facade] || 3) * (bld.scale || 1);
    const seed = hash01(k, 71, 3) * 100;

    // Walls.
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 0.05) continue;
      const bays = Math.max(1, Math.round(len / bay));
      wallQuad(Z.facade, a, b, base, top, bays, (top - base) / floorH, fIndex, seed);
    }

    // Roof.
    if (bld.roof === 'mansard' && ring.length === 4) mansard(Z, ring, top);
    else if (bld.roof === 'gable' && ring.length === 4) gable(THREE, Z, ring, top, fIndex, seed, floorH, bay);
    else {
      const { pts, tris } = triangulate(THREE, [ring]);
      Z.roof.flat(pts, tris, top);
      if (bld.roof === 'crown') crown(Z, ring, top, k);
    }

    if (bld.stairs && bld.front) stairs(Z.stairs, ring, bld, k);
  });

  const out = [];
  for (const [id, Z] of zones) {
    const add = (b, mat, name, extra) => {
      const m = meshOf(THREE, b, mat, `${name}_${id}`);
      if (!m) return;
      m.userData.zone = id;
      m.userData.tile = id;
      m.userData.layer = 'batiments';
      Object.assign(m.userData, extra || {});
      m.castShadow = false;
      m.receiveShadow = true;
      out.push(m);
    };
    add(Z.facade, M.Facades, 'Facades', { facadeAtlas: true });
    add(Z.roof, M.Roof, 'Toits');
    add(Z.copper, M.Copper, 'Toits_cuivre');
    add(Z.stairs, M.Metal_Black, 'Escaliers');
    add(Z.glow, M.Neon_White, 'Couronnes');
  }
  return out;
}

function area(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  return -a / 2;
}

/** One wall, facing out of a counter-clockwise ring (right of a → b). */
function wallQuad(b, a, c, y0, y1, bays, floors, facade, seed) {
  const dx = c[0] - a[0], dn = c[1] - a[1];
  const len = Math.hypot(dx, dn);
  const nx = dn / len, nn = -dx / len;
  const i0 = b.v(a[0], a[1], y0, nx, nn, 0, 0, 0, facade, seed);
  const i1 = b.v(c[0], c[1], y0, nx, nn, 0, bays, 0, facade, seed);
  const i2 = b.v(c[0], c[1], y1, nx, nn, 0, bays, floors, facade, seed);
  const i3 = b.v(a[0], a[1], y1, nx, nn, 0, 0, floors, facade, seed);
  b.quad(i0, i1, i2, i3);
}

/** Greystone mansard: sloped copper sides and a flat top, set back 1.4 m. */
function mansard(Z, ring, top) {
  const cx = ring.reduce((s, p) => s + p[0], 0) / 4, cn = ring.reduce((s, p) => s + p[1], 0) / 4;
  const inset = ring.map(([x, n]) => {
    const dx = cx - x, dn = cn - n, l = Math.hypot(dx, dn) || 1;
    return [x + (dx / l) * 1.9, n + (dn / l) * 1.9];
  });
  const h = 3.2;
  for (let i = 0; i < 4; i++) {
    const a = ring[i], b = ring[(i + 1) % 4], c = inset[(i + 1) % 4], d = inset[i];
    const ex = b[0] - a[0], en = b[1] - a[1], l = Math.hypot(ex, en) || 1;
    // Outward normal tilted up.
    const nx = (en / l) * 0.8, nn = (-ex / l) * 0.8, ny = 0.6;
    const i0 = Z.copper.v(a[0], a[1], top, nx, nn, ny, 0, 0);
    const i1 = Z.copper.v(b[0], b[1], top, nx, nn, ny, l, 0);
    const i2 = Z.copper.v(c[0], c[1], top + h, nx, nn, ny, l, h);
    const i3 = Z.copper.v(d[0], d[1], top + h, nx, nn, ny, 0, h);
    Z.copper.quad(i0, i1, i2, i3);
  }
  Z.roof.flat(inset.map(([x, n]) => [x, n, top + h]), [0, 1, 2, 0, 2, 3], top + h);
}

/** Pitched roof along the long axis, with gable ends in the facade material. */
function gable(THREE, Z, ring, top, facade, seed, floorH, bay) {
  const e0 = Math.hypot(ring[1][0] - ring[0][0], ring[1][1] - ring[0][1]);
  const e1 = Math.hypot(ring[2][0] - ring[1][0], ring[2][1] - ring[1][1]);
  // Rotate so ring[0]→ring[1] is a long side.
  const R = e0 >= e1 ? ring : [ring[1], ring[2], ring[3], ring[0]];
  const span = Math.min(e0, e1);
  const rise = Math.min(4.5, span * 0.38);
  const m0 = [(R[3][0] + R[0][0]) / 2, (R[3][1] + R[0][1]) / 2];
  const m1 = [(R[1][0] + R[2][0]) / 2, (R[1][1] + R[2][1]) / 2];
  const slope = (a, b, c, d) => {
    const i0 = Z.roof.v(a[0], a[1], top, 0, 0, 1, a[0], a[1]);
    const i1 = Z.roof.v(b[0], b[1], top, 0, 0, 1, b[0], b[1]);
    const i2 = Z.roof.v(c[0], c[1], top + rise, 0, 0, 1, c[0], c[1]);
    const i3 = Z.roof.v(d[0], d[1], top + rise, 0, 0, 1, d[0], d[1]);
    Z.roof.quad(i0, i1, i2, i3);
  };
  slope(R[0], R[1], m1, m0);
  slope(R[2], R[3], m0, m1);
  // Gable ends: triangles on the short sides, facing out.
  const tri = (a, b, apex) => {
    const dx = b[0] - a[0], dn = b[1] - a[1], l = Math.hypot(dx, dn) || 1;
    const nx = dn / l, nn = -dx / l;
    const bays = Math.max(1, Math.round(l / bay));
    const f = rise / floorH;
    const i0 = Z.facade.v(a[0], a[1], top, nx, nn, 0, 0, 0.5, facade, seed);
    const i1 = Z.facade.v(b[0], b[1], top, nx, nn, 0, bays, 0.5, facade, seed);
    const i2 = Z.facade.v(apex[0], apex[1], top + rise, nx, nn, 0, bays / 2, 0.5 + f, facade, seed);
    Z.facade.tri(i0, i1, i2);
  };
  tri(R[1], R[2], m1);
  tri(R[3], R[0], m0);
}

/** A mechanical penthouse, and on some towers a lit band at the top. */
function crown(Z, ring, top, k) {
  const cx = ring.reduce((s, p) => s + p[0], 0) / ring.length;
  const cn = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  const ex = ring[1][0] - ring[0][0], en = ring[1][1] - ring[0][1], l = Math.hypot(ex, en) || 1;
  const ux = ex / l, un = en / l;
  const hu = l * 0.3, hv = Math.hypot(ring[2][0] - ring[1][0], ring[2][1] - ring[1][1]) * 0.3;
  Z.roof.box(cx, cn, top, top + 7, ux, un, hu, hv);
  if (hash01(k, 5) < 0.3) Z.glow.box(cx, cn, top + 6.6, top + 6.9, ux, un, hu + 0.05, hv + 0.05);
}

/** A thin slab rising from y0 to y1 over `run` metres along (ux, un). */
function slantedSlab(b, cx, cn, ux, un, run, halfW, y0, y1) {
  const vx = -un, vn = ux;
  const p = (s, w, y) => [cx + ux * s + vx * w, cn + un * s + vn * w, y];
  const A = p(-run / 2, -halfW, y1), B = p(-run / 2, halfW, y1), C = p(run / 2, halfW, y0), D = p(run / 2, -halfW, y0);
  const ny = run / Math.hypot(run, y1 - y0), nt = (y1 - y0) / Math.hypot(run, y1 - y0);
  const nx = ux * nt, nn = un * nt;
  const i0 = b.v(A[0], A[1], A[2], nx, nn, ny, 0, 0), i1 = b.v(B[0], B[1], B[2], nx, nn, ny, 1, 0);
  const i2 = b.v(C[0], C[1], C[2], nx, nn, ny, 1, 1), i3 = b.v(D[0], D[1], D[2], nx, nn, ny, 0, 1);
  b.quad(i0, i3, i2, i1);
  const j0 = b.v(A[0], A[1], A[2] - 0.15, -nx, -nn, -ny, 0, 0), j1 = b.v(B[0], B[1], B[2] - 0.15, -nx, -nn, -ny, 1, 0);
  const j2 = b.v(C[0], C[1], C[2] - 0.15, -nx, -nn, -ny, 1, 1), j3 = b.v(D[0], D[1], D[2] - 0.15, -nx, -nn, -ny, 0, 1);
  b.quad(j0, j1, j2, j3);
}

/**
 * Montréal's outdoor staircase: a balcony at the second floor and a straight
 * flight down to the sidewalk, parallel to the facade.
 */
function stairs(b, ring, bld, k) {
  if (hash01(k, 13) < 0.35) return;
  const [fx, fn] = bld.front;
  // The facade edge: the ring edge whose outward normal matches `front`.
  let best = -1, bestDot = 0.7;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], c = ring[(i + 1) % ring.length];
    const dx = c[0] - a[0], dn = c[1] - a[1], l = Math.hypot(dx, dn) || 1;
    const d = (dn / l) * fx + (-dx / l) * fn;
    if (d > bestDot) { bestDot = d; best = i; }
  }
  if (best < 0) return;
  const a = ring[best], c = ring[(best + 1) % ring.length];
  const dx = c[0] - a[0], dn = c[1] - a[1], len = Math.hypot(dx, dn);
  if (len < 5) return;
  const ux = dx / len, un = dn / len;
  const floorH = bld.floorH || 3.3;
  const deck = floorH + 0.2;
  const depth = 1.3;
  // Balcony across most of the facade.
  const bx = (a[0] + c[0]) / 2 + fx * depth / 2, bn = (a[1] + c[1]) / 2 + fn * depth / 2;
  b.box(bx, bn, deck - 0.15, deck, ux, un, len / 2 - 0.3, depth / 2);
  // Railing.
  b.box(bx + fx * depth / 2, bn + fn * depth / 2, deck, deck + 1.0, ux, un, len / 2 - 0.3, 0.03);
  // The flight: one slanted slab from the balcony's end down to the
  // sidewalk, along the facade. Seen from a car, that is the staircase.
  const dir = hash01(k, 29) < 0.5 ? 1 : -1;
  const run = Math.min(len * 0.55, 4.2);
  const sx = (a[0] + c[0]) / 2 + ux * dir * (len / 2 - 0.9 - run / 2) + fx * (depth + 0.55);
  const sn = (a[1] + c[1]) / 2 + un * dir * (len / 2 - 0.9 - run / 2) + fn * (depth + 0.55);
  slantedSlab(b, sx, sn, ux * dir, un * dir, run, 0.55, 0, deck);
}
