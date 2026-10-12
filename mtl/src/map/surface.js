// What the wheels stand on. A city with trenches, tunnels and viaducts has
// several surfaces over the same point, so the question is never "how high is
// the ground here" but "which surface is under a car that is at this height":
// the highest one at or below it, plus a step the car can climb (a kerb).
//
// The streets are not surfaces of their own: they lie on the relief, so the
// relief is what a car on a street stands on.

import { Grid } from './geom.js';
import { jointHeight } from './layout.js';

export function createSurface(layout, structures) {
  const { index, ground } = structures;
  const T = layout.terrain;
  const tmp = [];
  // Joints fill the wedges where two ways meet end to end (layout.js).
  const joints = new Grid(32);
  for (const j of layout.joints || []) {
    let x0 = Infinity, n0 = Infinity, x1 = -Infinity, n1 = -Infinity;
    for (const [x, n] of j.ring) { x0 = Math.min(x0, x); n0 = Math.min(n0, n); x1 = Math.max(x1, x); n1 = Math.max(n1, n); }
    joints.insert({ j, x0, n0, x1, n1 }, x0, n0, x1, n1);
  }
  const jtmp = [];
  // The asphalt between twin carriageways (structures.fills), as triangles.
  const fills = new Grid(16);
  for (const f of structures.fills || []) {
    for (let i = 0; i + 1 < f.pts.length; i++) {
      const p = f.pts[i], q = f.pts[i + 1];
      const A = [p[0], p[1], p[2]], B = [p[3], p[4], p[5]], C = [q[3], q[4], q[5]], D = [q[0], q[1], q[2]];
      for (const t of [[A, B, C], [A, C, D]]) {
        const xs = t.map((v) => v[0]), ns = t.map((v) => v[1]);
        fills.insert(t, Math.min(...xs), Math.min(...ns), Math.max(...xs), Math.max(...ns));
      }
    }
  }
  const ftmp = [];

  /**
   * @param yRef   the car's current height
   * @param step   how much higher a surface may be and still be climbed onto
   * @returns { y, kind: 'road'|'joint'|'terrain'|'water'|'void', road, s, i, t }
   *          (s, i, t: where along the road — arc length, segment, fraction)
   */
  function at(x, n, yRef, step = 0.6) {
    const lim = yRef + step;
    let best = -Infinity, kind = 'void', road = null, s = 0, i = 0, t = 0;
    let asphalt = -Infinity, roof = -Infinity;
    for (const o of index.surfacesAt(x, n, 0, tmp)) {
      if (o.y > lim) continue;
      if (o.y > best) { best = o.y; kind = 'road'; road = o.road; s = o.s; i = o.i; t = o.t; }
      // A car on a covered road is under the ground: the relief there is its
      // roof, even where the portal brings the two within a step.
      if (o.covered) { if (yRef - o.y < 1) roof = Math.max(roof, o.y); } else asphalt = Math.max(asphalt, o.y);
    }
    for (const c of joints.query(x, n, 0, jtmp)) {
      if (x < c.x0 || x > c.x1 || n < c.n0 || n > c.n1) continue;
      const y = jointHeight(c.j, x, n);
      if (y === null || y > lim) continue;
      asphalt = Math.max(asphalt, y);
      if (y > best) { best = y; kind = 'joint'; road = null; }
    }
    for (const t of fills.query(x, n, 0, ftmp)) {
      const y = triHeight(t, x, n);
      if (y === null || y > lim) continue;
      asphalt = Math.max(asphalt, y);
      if (y > best) { best = y; kind = 'joint'; road = null; }
    }
    const k = ground.kindAt(x, n);
    if (k === 'terrain') {
      const gy = T.height(x, n);
      // Inside a road's footprint the relief is under the asphalt: a slope
      // across the road pokes through by a few decimetres, and a car would
      // climb it and jump off.
      const buried = gy - asphalt < 1.2 || (roof > -Infinity && gy > roof - 0.05);
      if (gy <= lim + 0.2 && gy > best && !buried) {
        best = gy; kind = 'terrain'; road = null;
      }
    } else if (k === 'water' && best === -Infinity) {
      best = ground.heightAt(x, n, 'water');
      kind = 'water';
    }
    return { y: best, kind, road, s, i, t };
  }

  return { at };
}

/** Height of the triangle [[x, n, y] × 3] at (x, n), or null outside it. */
function triHeight([a, b, c], x, n) {
  const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
  if (Math.abs(d) < 1e-9) return null;
  const w0 = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (n - c[1])) / d;
  const w1 = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (n - c[1])) / d;
  const w2 = 1 - w0 - w1;
  if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) return null;
  return w0 * a[2] + w1 * b[2] + w2 * c[2];
}
