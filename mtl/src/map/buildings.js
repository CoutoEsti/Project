// Buildings as data: footprints, heights and facades, generated block by block
// from the district's style. Deterministic — the same map gives the same city
// on every load and in every export.
//
// Three ways of filling a block:
//   perimeter  a continuous street wall facing every street (plexes, greystone,
//              brick): each side of the block owns its starting corner, so the
//              rows meet at the corners without overlapping. A side that faces
//              a ruelle gets backyards instead of fronts.
//   towers     downtown: podiums on parcels, towers set back on top, taller
//              towards Place Ville Marie.
//   boxes      big footprints with yards or parking (industry, big-box retail).

import { hash01, rng, pointInPolygon, distToRing, ringBBox, polygonArea } from './geom.js';

export const STYLES = {
  downtown: { fill: 'towers', sidewalk: 4.5, ground: 'sidewalk', trees: 0.35 },
  oldstone: { fill: 'perimeter', sidewalk: 2.2, depth: [12, 17], width: [11, 24], floors: [4, 6], floorH: 3.9, facades: ['stone', 'stone', 'stone_dark', 'brick_old'], roof: 0.35, ground: 'sidewalk', trees: 0 },
  plex: { fill: 'perimeter', sidewalk: 4.2, depth: [11, 13], width: [6.8, 8.4], floors: [2, 3], floorH: 3.3, facades: ['brick_red', 'brick_brown', 'brick_red', 'brick_buff', 'brick_dark'], stairs: true, ground: 'sidewalk', trees: 1 },
  brick: { fill: 'perimeter', sidewalk: 3.4, depth: [10, 15], width: [7, 13], floors: [2, 4], floorH: 3.3, facades: ['brick_red', 'brick_brown', 'brick_buff', 'brick_old', 'concrete'], ground: 'sidewalk', trees: 0.7 },
  lofts: { fill: 'perimeter', sidewalk: 3, depth: [18, 30], width: [20, 42], floors: [4, 8], floorH: 3.8, facades: ['brick_old', 'brick_old', 'glass_green', 'concrete'], ground: 'sidewalk', trees: 0.3 },
  walkups: { fill: 'perimeter', sidewalk: 4, depth: [13, 17], width: [13, 21], floors: [3, 4], floorH: 3.2, facades: ['brick_red', 'brick_buff', 'brick_brown', 'concrete'], towerChance: 0.05, ground: 'sidewalk', trees: 1 },
  westmount: { fill: 'houses', sidewalk: 6, depth: [11, 14], width: [11, 15], gap: [3, 7], floors: [2, 3], floorH: 3.4, facades: ['stone', 'brick_red', 'brick_buff'], towerChance: 0.04, ground: 'grass', trees: 1 },
  villas: { fill: 'houses', sidewalk: 7, depth: [11, 15], width: [12, 17], gap: [5, 9], floors: [2, 3], floorH: 3.4, facades: ['stone', 'brick_buff', 'brick_red'], ground: 'grass', trees: 1 },
  bigbox: { fill: 'boxes', sidewalk: 3, cover: 0.42, floors: [1, 1], floorH: 9, facades: ['panel', 'panel_dark'], ground: 'parking', trees: 0.1 },
  factory: { fill: 'boxes', sidewalk: 3, cover: 0.6, floors: [6, 11], floorH: 3.6, facades: ['concrete', 'brick_old', 'concrete'], ground: 'sidewalk', trees: 0.1 },
  industrial: { fill: 'boxes', sidewalk: 3, cover: 0.5, floors: [1, 3], floorH: 4.5, facades: ['panel', 'panel_dark', 'brick_old'], ground: 'parking', trees: 0.1 },
  yard: { fill: 'none', ground: 'gravel', trees: 0 },
  port: { fill: 'none', ground: 'plaza', trees: 0.4 },
  park: { fill: 'none', ground: 'grass', trees: 1 },
  plaza: { fill: 'none', ground: 'plaza', trees: 0.25 },
  verge: { fill: 'none', ground: 'grass', trees: 0.3 },
};

const DOWNTOWN_CORE = { x: -220, n: -120 };

/**
 * @param layout compiled layout (for streetsAt)
 * @param plots  landmark footprints to keep clear: [{ x, n, r }]
 * @returns { buildings: [...], grounds: [...] }
 */
export function generateBuildings(layout, plots = []) {
  const buildings = [];
  for (const block of layout.blocks) {
    const style = STYLES[block.style] || STYLES.verge;
    block.ground = style.ground;
    if (style.fill === 'none') continue;
    const clearOf = (ring) => {
      for (const pl of plots) {
        for (const [x, n] of ring) if (Math.hypot(x - pl.x, n - pl.n) < pl.r) return false;
        const cx = ring.reduce((a, p) => a + p[0], 0) / ring.length;
        const cn = ring.reduce((a, p) => a + p[1], 0) / ring.length;
        if (Math.hypot(cx - pl.x, cn - pl.n) < pl.r) return false;
      }
      return true;
    };
    const R = rng(1000 + block.id * 7919);
    const rect = asRect(block.poly[0]);
    let made = [];
    if (style.fill === 'towers') made = rect ? towers(rect, style, R) : frontage(block, MIDRISE, R, layout);
    else if (style.fill === 'perimeter') made = rect ? perimeter(rect, style, R, layout) : frontage(block, style, R, layout);
    else if (style.fill === 'houses') made = rect ? houses(rect, style, R) : frontage(block, style, R, layout);
    else if (style.fill === 'boxes') {
      const inner = rect || inscribedRect(block);
      made = inner ? boxes(inner, style, R) : [];
    }
    for (const b of made) {
      if (!clearOf(b.ring)) continue;
      if (!rect && !insidePoly(b.ring, block.poly, 0.5)) continue;
      b.block = block.id;
      b.district = block.district;
      buildings.push(b);
    }
  }
  return { buildings };
}

// ------------------------------------------------------------ shapes --

/** Axis-aligned rectangle, if the ring is one (collinear points tolerated). */
export function asRect(ring) {
  const pts = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[(i - 1 + ring.length) % ring.length], b = ring[i], c = ring[(i + 1) % ring.length];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) > 0.5) pts.push(b);
  }
  if (pts.length !== 4) return null;
  const bb = ringBBox(pts);
  for (const [x, n] of pts) {
    const okx = Math.abs(x - bb.x0) < 0.6 || Math.abs(x - bb.x1) < 0.6;
    const okn = Math.abs(n - bb.n0) < 0.6 || Math.abs(n - bb.n1) < 0.6;
    if (!okx || !okn) return null;
  }
  return bb;
}

function box(x0, n0, x1, n1) { return [[x0, n0], [x1, n0], [x1, n1], [x0, n1]]; }

function pick(R, list) { return list[Math.floor(R() * list.length) % list.length]; }
function range(R, [a, b]) { return a + (b - a) * R(); }
function irange(R, [a, b]) { return Math.floor(a + (b - a + 1) * R()); }

function insidePoly(ring, poly, margin) {
  for (const [x, n] of ring) {
    if (!pointInPolygon(x, n, poly)) return false;
    if (margin > 0 && distToRing(x, n, poly[0]) < margin) return false;
  }
  return true;
}

// --------------------------------------------------------- perimeter --

function perimeter(bb, style, R, layout) {
  const s = style.sidewalk;
  const r = { x0: bb.x0 + s, n0: bb.n0 + s, x1: bb.x1 - s, n1: bb.n1 - s };
  const W = r.x1 - r.x0, H = r.n1 - r.n0;
  if (W < 6 || H < 6) return [];
  const out = [];
  // Sides counter-clockwise: south, east, north, west. Each is described by
  // its start corner, its direction along, and its inward normal.
  const sides = [
    { ax: r.x0, an: r.n0, dx: 1, dn: 0, ix: 0, in: 1, len: W, probe: [0, -1] },
    { ax: r.x1, an: r.n0, dx: 0, dn: 1, ix: -1, in: 0, len: H, probe: [1, 0] },
    { ax: r.x1, an: r.n1, dx: -1, dn: 0, ix: 0, in: -1, len: W, probe: [0, 1] },
    { ax: r.x0, an: r.n1, dx: 0, dn: -1, ix: 1, in: 0, len: H, probe: [-1, 0] },
  ];
  const tmp = [];
  // Which sides face a real street (not a ruelle, not nothing)?
  const faces = sides.map((sd) => {
    const mx = sd.ax + sd.dx * sd.len / 2 + sd.probe[0] * (s + 2);
    const mn = sd.an + sd.dn * sd.len / 2 + sd.probe[1] * (s + 2);
    const sts = layout.streetsAt(mx, mn, 1, tmp);
    if (!sts.length) return 'open';
    return sts.every((st) => st.cls === 'alley') ? 'alley' : 'street';
  });
  const maxDepth = Math.min(W, H) / 2 - 1;
  const depths = sides.map(() => Math.min(range(R, style.depth), maxDepth));
  for (let k = 0; k < 4; k++) {
    const sd = sides[k];
    if (faces[k] === 'alley') continue;
    const d = depths[k];
    const next = (k + 1) % 4;
    // Leave the end corner to the next side, unless that side is empty.
    const end = sd.len - (faces[next] === 'alley' ? 0 : depths[next]);
    const prev = (k + 3) % 4;
    const start = faces[prev] === 'alley' ? 0 : 0;
    let t = start;
    while (end - t > 3) {
      let w = range(R, style.width);
      if (end - t - w < style.width[0] * 0.7) w = end - t;
      const a = t, b = Math.min(end, t + w);
      const p0 = [sd.ax + sd.dx * a, sd.an + sd.dn * a];
      const p1 = [sd.ax + sd.dx * b, sd.an + sd.dn * b];
      const q1 = [p1[0] + sd.ix * d, p1[1] + sd.in * d];
      const q0 = [p0[0] + sd.ix * d, p0[1] + sd.in * d];
      const floors = irange(R, style.floors);
      const corner = a === 0 || b === end;
      const extra = corner && style.floors[1] >= 4 && R() < 0.4 ? 1 : 0;
      out.push({
        ring: [p0, p1, q1, q0],
        h: (floors + extra) * style.floorH + 0.6 + R() * 0.8,
        floors: floors + extra,
        floorH: style.floorH,
        facade: pick(R, style.facades),
        roof: style.roof && R() < style.roof ? 'mansard' : 'flat',
        front: [-sd.ix, -sd.in],
        stairs: !!style.stairs && faces[k] === 'street',
        kind: 'row',
      });
      t = b;
    }
  }
  // A tall walk-up now and then, in the block's middle.
  if (style.towerChance && R() < style.towerChance && W > 50 && H > 50) {
    const cx = (r.x0 + r.x1) / 2, cn = (r.n0 + r.n1) / 2;
    const w = Math.min(24, W / 3), h = Math.min(18, H / 3);
    const floors = 9 + Math.floor(R() * 8);
    out.push({ ring: box(cx - w, cn - h, cx + w, cn + h), h: floors * 3.1, floors, floorH: 3.1,
      facade: pick(R, ['concrete', 'brick_buff']), roof: 'flat', front: [0, -1], kind: 'tower' });
  }
  return out;
}

// ------------------------------------------------------------- towers --

function towers(bb, style, R) {
  const s = style.sidewalk;
  const r = { x0: bb.x0 + s, n0: bb.n0 + s, x1: bb.x1 - s, n1: bb.n1 - s };
  const W = r.x1 - r.x0, H = r.n1 - r.n0;
  if (W < 10 || H < 10) return [];
  const out = [];
  // Split big blocks into 2 or 4 parcels, with a lane between them.
  const nx = W > 95 ? 2 : 1, nn = H > 95 ? 2 : 1;
  const gap = 5;
  const pw = (W - gap * (nx - 1)) / nx, ph = (H - gap * (nn - 1)) / nn;
  const cx = (r.x0 + r.x1) / 2, cn = (r.n0 + r.n1) / 2;
  const dist = Math.hypot(cx - DOWNTOWN_CORE.x, cn - DOWNTOWN_CORE.n);
  const core = Math.exp(-(dist * dist) / (2 * 420 * 420));
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nn; j++) {
      const x0 = r.x0 + i * (pw + gap), n0 = r.n0 + j * (ph + gap);
      const x1 = x0 + pw, n1 = n0 + ph;
      const roll = R();
      // Old commercial stock survives on the edges of downtown.
      if (roll < 0.22 * (1 - core)) {
        const floors = 3 + Math.floor(R() * 4);
        out.push({ ring: box(x0, n0, x1, n1), h: floors * 4 + 1, floors, floorH: 4,
          facade: pick(R, ['stone', 'brick_old', 'brick_buff']), roof: 'flat', front: [0, -1], kind: 'midrise' });
        continue;
      }
      const podFloors = 3 + Math.floor(R() * 5);
      const podH = podFloors * 4.2;
      out.push({ ring: box(x0, n0, x1, n1), h: podH, floors: podFloors, floorH: 4.2,
        facade: pick(R, ['stone', 'concrete', 'glass_dark', 'glass_blue']), roof: 'flat', front: [0, -1], kind: 'podium' });
      const set = 5 + R() * 6;
      const tx0 = x0 + set, tn0 = n0 + set, tx1 = x1 - set, tn1 = n1 - set;
      if (tx1 - tx0 < 14 || tn1 - tn0 < 14) continue;
      // Slimmer towers read better: cap the plate at 48 m.
      const pw2 = Math.min(tx1 - tx0, 48), ph2 = Math.min(tn1 - tn0, 48);
      const mx = (tx0 + tx1) / 2, mn = (tn0 + tn1) / 2;
      // Nothing tops the mountain: Place Ville Marie is 188 m, and the
      // tallest here stay near 200.
      const height = 40 + (30 + 125 * core) * (0.4 + R() * 0.6);
      const floors = Math.round(height / 3.7);
      out.push({
        ring: box(mx - pw2 / 2, mn - ph2 / 2, mx + pw2 / 2, mn + ph2 / 2),
        base: podH, h: floors * 3.7, floors, floorH: 3.7,
        facade: pick(R, ['glass_blue', 'glass_dark', 'glass_green', 'glass_silver', 'concrete']),
        roof: R() < 0.25 ? 'crown' : 'flat', front: [0, -1], kind: 'tower',
      });
    }
  }
  return out;
}

// ------------------------------------------------------------- houses --

function houses(bb, style, R) {
  const s = style.sidewalk;
  const r = { x0: bb.x0 + s, n0: bb.n0 + s, x1: bb.x1 - s, n1: bb.n1 - s };
  const W = r.x1 - r.x0, H = r.n1 - r.n0;
  if (W < 10 || H < 10) return [];
  const out = [];
  // Rows along the two long sides, detached, with side gaps.
  const alongX = W >= H;
  const len = alongX ? W : H;
  const d = Math.min(range(R, style.depth), (alongX ? H : W) / 2 - 2);
  for (const edge of [0, 1]) {
    let t = range(R, style.gap);
    while (t + style.width[0] < len) {
      const w = Math.min(range(R, style.width), len - t);
      if (w < style.width[0] * 0.8) break;
      let ring;
      if (alongX) {
        const n0 = edge === 0 ? r.n0 : r.n1 - d;
        ring = box(r.x0 + t, n0, r.x0 + t + w, n0 + d);
      } else {
        const x0 = edge === 0 ? r.x0 : r.x1 - d;
        ring = box(x0, r.n0 + t, x0 + d, r.n0 + t + w);
      }
      const floors = irange(R, style.floors);
      out.push({ ring, h: floors * style.floorH + 2.2, floors, floorH: style.floorH, facade: pick(R, style.facades),
        roof: R() < 0.7 ? 'gable' : 'flat', front: alongX ? [0, edge === 0 ? -1 : 1] : [edge === 0 ? -1 : 1, 0], kind: 'house' });
      t += w + range(R, style.gap);
    }
  }
  if (style.towerChance && R() < style.towerChance && W > 60 && H > 60) {
    const cx = (r.x0 + r.x1) / 2, cn = (r.n0 + r.n1) / 2;
    const floors = 10 + Math.floor(R() * 12);
    out.push({ ring: box(cx - 14, cn - 11, cx + 14, cn + 11), h: floors * 3.2, floors, floorH: 3.2,
      facade: 'concrete', roof: 'flat', front: [0, -1], kind: 'tower' });
  }
  return out;
}

// -------------------------------------------------------------- boxes --

function boxes(bb, style, R) {
  const s = style.sidewalk;
  const r = { x0: bb.x0 + s, n0: bb.n0 + s, x1: bb.x1 - s, n1: bb.n1 - s };
  const W = r.x1 - r.x0, H = r.n1 - r.n0;
  if (W < 14 || H < 14) return [];
  const out = [];
  const target = W * H * style.cover;
  // One to four boxes along the longer axis, set back from the front.
  const count = Math.max(1, Math.min(4, Math.round(target / 3500)));
  const alongX = W >= H;
  const len = alongX ? W : H, wid = alongX ? H : W;
  const gap = 10;
  const each = (len - gap * (count - 1)) / count;
  const depth = Math.min(wid * 0.85, target / (each * count));
  for (let i = 0; i < count; i++) {
    const a = i * (each + gap);
    const shrink = R() * 0.2;
    const w = each * (1 - shrink), dd = depth * (0.75 + R() * 0.25);
    let ring;
    if (alongX) ring = box(r.x0 + a, r.n1 - dd, r.x0 + a + w, r.n1);
    else ring = box(r.x1 - dd, r.n0 + a, r.x1, r.n0 + a + w);
    const floors = irange(R, style.floors);
    out.push({ ring, h: floors * style.floorH + 1, floors, floorH: style.floorH, facade: pick(R, style.facades),
      roof: 'flat', front: alongX ? [0, -1] : [-1, 0], kind: 'box' });
  }
  return out;
}

// ---------------------------------------------------------- frontage --

// Downtown blocks cut by a diagonal get mid-rise stock instead of towers.
const MIDRISE = { sidewalk: 4, depth: [18, 26], width: [18, 34], floors: [5, 12], floorH: 3.8,
  facades: ['stone', 'concrete', 'glass_dark', 'brick_old'] };

/**
 * Irregular blocks (cut by a diagonal, a curve or a shoreline): a row of
 * buildings along every edge that faces a street, each set back by the
 * sidewalk and kept only if it sits inside the block and clear of the others.
 */
function frontage(block, style, R, layout) {
  let ring = block.poly[0].slice();
  if (ringAreaSigned(ring) < 0) ring.reverse();
  const out = [];
  const s = style.sidewalk || 3;
  const tmp = [];
  for (let e = 0; e < ring.length; e++) {
    const a = ring[e], b = ring[(e + 1) % ring.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 10) continue;
    const ux = (b[0] - a[0]) / len, un = (b[1] - a[1]) / len;
    const vx = -un, vn = ux;                 // inward for a counter-clockwise ring
    const mx = (a[0] + b[0]) / 2 - vx * (s + 2), mn = (a[1] + b[1]) / 2 - vn * (s + 2);
    const sts = layout.streetsAt(mx, mn, 1, tmp);
    if (sts.length && sts.every((st) => st.cls === 'alley')) continue;
    const d = range(R, style.depth || [12, 14]);
    let t = s + 1;
    while (t + (style.width ? style.width[0] : 8) < len - s) {
      let w = range(R, style.width || [8, 12]);
      w = Math.min(w, len - s - t);
      const p0 = [a[0] + ux * t + vx * s, a[1] + un * t + vn * s];
      const p1 = [p0[0] + ux * w, p0[1] + un * w];
      const q1 = [p1[0] + vx * d, p1[1] + vn * d];
      const q0 = [p0[0] + vx * d, p0[1] + vn * d];
      const cand = [p0, p1, q1, q0];
      if (insidePoly(cand, block.poly, 0.3) && !out.some((o) => quadsOverlap(o.ring, cand))) {
        const floors = irange(R, style.floors || [2, 3]);
        const floorH = style.floorH || 3.3;
        out.push({ ring: cand, h: floors * floorH + 0.6 + R() * 0.6, floors, floorH,
          facade: pick(R, style.facades || ['brick_red']), roof: style.gap ? (R() < 0.7 ? 'gable' : 'flat') : 'flat',
          front: [-vx, -vn], stairs: !!style.stairs, kind: 'row' });
      }
      t += w + (style.gap ? range(R, style.gap) : 0);
    }
  }
  return out;
}

function ringAreaSigned(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  return -a / 2;
}

/** Separating-axis test for two convex quads. */
function quadsOverlap(A, B) {
  for (const poly of [A, B]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      const ax = -(q[1] - p[1]), an = q[0] - p[0];
      let amin = Infinity, amax = -Infinity, bmin = Infinity, bmax = -Infinity;
      for (const v of A) { const d = v[0] * ax + v[1] * an; amin = Math.min(amin, d); amax = Math.max(amax, d); }
      for (const v of B) { const d = v[0] * ax + v[1] * an; bmin = Math.min(bmin, d); bmax = Math.max(bmax, d); }
      if (amax <= bmin + 0.05 || bmax <= amin + 0.05) return false;
    }
  }
  return true;
}

/** Largest-ish axis-aligned rectangle inside an irregular block. */
function inscribedRect(block) {
  const bb = block.bbox;
  let best = null;
  for (let k = 0; k <= 8; k++) {
    const f = k * 0.05;
    const r = { x0: bb.x0 + (bb.x1 - bb.x0) * f, x1: bb.x1 - (bb.x1 - bb.x0) * f, n0: bb.n0 + (bb.n1 - bb.n0) * f, n1: bb.n1 - (bb.n1 - bb.n0) * f };
    if (insidePoly(box(r.x0, r.n0, r.x1, r.n1), block.poly, 0)) { best = r; break; }
  }
  return best;
}

/** Floor area and count per district, for the README and the tests. */
export function buildingStats(buildings) {
  const by = {};
  for (const b of buildings) {
    const k = b.district || 'autre';
    const a = polygonArea([b.ring]);
    by[k] = by[k] || { count: 0, footprint: 0, tallest: 0 };
    by[k].count++;
    by[k].footprint += a;
    by[k].tallest = Math.max(by[k].tallest, (b.base || 0) + b.h);
  }
  return by;
}

export { hash01 };
