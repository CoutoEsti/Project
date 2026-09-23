// Everything solid, as 2D segments with a height range, in one uniform grid.
// Adapted from Ruelle's collision (hop/src/vehicle/collision.js): three probe
// circles down the car's centre line, pushed out of any segment they overlap.
// What is new is the third dimension: a segment only counts if its height
// range overlaps the car's, so the trench wall stops a car in the trench and
// not the one driving past on the street above it.

import { Grid, simplifyN, hash01 } from './geom.js';
import { pillarColumns } from './structures.js';

const CELL = 12;
const PROBES = [1.45, 0, -1.45];
const PROBE_RADIUS = 0.93;
const CAR_BOTTOM = 0.28;      // below this, an obstacle is a kerb, not a wall
const CAR_TOP = 1.45;

export class Solids {
  constructor() {
    this.grid = new Grid(CELL);
    this.count = 0;
  }

  /** Add a segment (a point when a == b) with a height range and a radius. */
  add(ax, an, bx, bn, y0, y1, r = 0) {
    const s = { ax, an, bx, bn, y0, y1, r };
    const pad = r + 0.01;
    this.grid.insert(s, Math.min(ax, bx) - pad, Math.min(an, bn) - pad, Math.max(ax, bx) + pad, Math.max(an, bn) + pad);
    this.count++;
  }

  polyline(pts, y0Of, y1Of, r = 0) {
    for (let i = 0; i + 1 < pts.length; i++) {
      const p = pts[i], q = pts[i + 1];
      this.add(p[0], p[1], q[0], q[1], Math.min(y0Of(p), y0Of(q)), Math.max(y1Of(p), y1Of(q)), r);
    }
  }

  near(x, n, r, out) { return this.grid.query(x, n, r, out); }
}

/** Build the solid world from the structures, the buildings and the props. */
export function buildSolids(layout, structures, buildings, extras = {}) {
  const S = new Solids();
  const tol = 0.05;
  for (const w of structures.walls) {
    S.polyline(simplifyN(w.pts, tol), (p) => p[2], (p) => p[3], w.thickness / 2);
  }
  const H = { jersey: 0.81, median: 0.81, parapet: 1.1, circuit: 1.2, guardrail: 0.8 };
  for (const b of structures.barriers) {
    const h = H[b.kind] || 0.9;
    S.polyline(simplifyN(b.pts, tol), (p) => p[2] - 0.2, (p) => p[2] + h, 0.25);
  }
  for (const f of structures.fences) S.polyline(simplifyN(f.pts, tol), (p) => p[2] - 0.2, (p) => p[2] + f.height, 0.05);
  for (const c of structures.closures) {
    const h = c.width / 2 + 0.5;
    S.add(c.x + c.lx * h, c.n + c.ln * h, c.x - c.lx * h, c.n - c.ln * h, c.y - 0.3, c.y + 1.3, 0.3);
  }
  for (const f of structures.fascias) S.add(f.a[0], f.a[1], f.b[0], f.b[1], f.y0, 0.02, 0.35);
  for (const p of structures.pillars) {
    for (const [cx, cn] of pillarColumns(p)) S.add(cx, cn, cx, cn, p.y0, p.y1, (p.w / 2) * 1.2);
  }
  for (const b of buildings) {
    const top = (b.base || 0) + b.h;
    const ring = b.ring;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], c = ring[(i + 1) % ring.length];
      S.add(a[0], a[1], c[0], c[1], -0.5, top, 0);
    }
  }
  for (const l of extras.lamps || []) S.add(l.x, l.n, l.x, l.n, l.y - 0.2, l.y + 6, 0.18);
  for (const t of extras.trees || []) S.add(t.x, t.n, t.x, t.n, t.y - 0.2, t.y + 3, 0.28 * (t.s || 1));
  // Landmarks: the footprint of their lowest few metres (see
  // world/landmarks.js), so the collision follows the model.
  for (const f of extras.footprints || []) {
    const R = f.ring;
    for (let i = 0; i < R.length; i++) {
      const a = R[i], c = R[(i + 1) % R.length];
      S.add(a[0], a[1], c[0], c[1], f.y0, f.y1, 0);
    }
  }
  // The edge of the world.
  const W = layout.map.world;
  const e = [[W.x0, W.n0], [W.x1, W.n0], [W.x1, W.n1], [W.x0, W.n1]];
  for (let i = 0; i < 4; i++) S.add(e[i][0], e[i][1], e[(i + 1) % 4][0], e[(i + 1) % 4][1], -100, 2000, 0);
  return S;
}

const tmp = [];

/**
 * Push the car out of anything it overlaps and take the energy out of the
 * impact. Mutates car: x, n, vx, vn, yawRate. Returns the impact speed.
 * `heading` is the car's yaw in the map frame: forward = (sin h, cos h).
 */
export function resolveCollisions(solids, car, heading, y) {
  const fx = Math.sin(heading), fn = Math.cos(heading);
  let impact = 0;
  for (let p = 0; p < PROBES.length; p++) {
    const px = car.x + fx * PROBES[p];
    const pn = car.n + fn * PROBES[p];
    let pushX = 0, pushN = 0, hits = 0;
    for (const s of solids.near(px, pn, PROBE_RADIUS + 1, tmp)) {
      if (s.y1 < y + CAR_BOTTOM || s.y0 > y + CAR_TOP) continue;
      const dx0 = s.bx - s.ax, dn0 = s.bn - s.an;
      const l2 = dx0 * dx0 + dn0 * dn0;
      let t = l2 > 1e-9 ? ((px - s.ax) * dx0 + (pn - s.an) * dn0) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      let dx = px - (s.ax + dx0 * t), dn = pn - (s.an + dn0 * t);
      let d = Math.hypot(dx, dn);
      const reach = PROBE_RADIUS + s.r;
      if (d >= reach) continue;
      if (d < 1e-5) {
        const wl = Math.sqrt(l2) || 1;
        dx = -dn0 / wl; dn = dx0 / wl; d = 1e-5;
      }
      const depth = reach - d;
      pushX += (dx / d) * depth;
      pushN += (dn / d) * depth;
      hits++;
    }
    if (!hits) continue;
    pushX /= hits;
    pushN /= hits;
    const len = Math.hypot(pushX, pushN);
    if (len < 1e-6) continue;
    const nx = pushX / len, nn = pushN / len;
    car.x += pushX;
    car.n += pushN;
    const vn = car.vx * nx + car.vn * nn;
    if (vn < 0) {
      impact = Math.max(impact, -vn);
      car.vx -= vn * nx * 1.18;
      car.vn -= vn * nn * 1.18;
      // Friction along the wall in proportion to how hard the car hit it, not
      // a flat share of its speed: grazing a barrier at 150 km/h costs a
      // little, it does not glue the car to it (Ruelle's 16 % a step did, at
      // 120 steps a second).
      const tx = -nn, tn = nx;
      const vt = car.vx * tx + car.vn * tn;
      const dvt = Math.min(Math.abs(vt), 0.35 * 1.18 * -vn) * Math.sign(vt);
      car.vx -= dvt * tx;
      car.vn -= dvt * tn;
      // An off-centre hit turns the car away from the wall: the torque of the
      // impulse about the centre (positive yaw turns right).
      car.yawRate -= (fx * nn - fn * nx) * PROBES[p] * -vn * 0.055;
      car.yawRate = Math.max(-3.5, Math.min(3.5, car.yawRate));
    }
  }
  return impact;
}

/**
 * How far along a → b (map frame, at height y) before hitting a solid; used
 * to keep the chase camera out of walls. Returns t in [0, 1].
 */
export function rayClearance(solids, ax, an, bx, bn, y, padding = 0.6) {
  const dx = bx - ax, dn = bn - an;
  const len = Math.hypot(dx, dn);
  if (len < 1e-4) return 1;
  let best = 1;
  const probes = Math.max(2, Math.ceil(len / 8));
  for (let p = 0; p <= probes; p++) {
    const t = p / probes;
    for (const s of solids.near(ax + dx * t, an + dn * t, 6, tmp)) {
      if (s.y1 < y - 0.5 || s.y0 > y + 0.5) continue;
      const hit = segHit(ax, an, dx, dn, s.ax, s.an, s.bx, s.bn);
      if (hit >= 0 && hit < best) best = hit;
    }
  }
  return best >= 1 ? 1 : Math.max(0, best - padding / len);
}

function segHit(ax, an, dx, dn, sx, sn, ex, en) {
  const wx = ex - sx, wn = en - sn;
  const den = dx * wn - dn * wx;
  if (Math.abs(den) < 1e-9) return -1;
  const rx = sx - ax, rn = sn - an;
  const t = (rx * wn - rn * wx) / den;
  const u = (rx * dn - rn * dx) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return -1;
  return t;
}

export { PROBE_RADIUS, hash01 };
