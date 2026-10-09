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
  // The decks between two carriageways alongside (map/structures.js medians):
  // quads from one edge to the other, at the higher carriageway's level.
  const slabs = new Grid(32);
  for (const md of structures.medians || []) {
    for (let k = 0; k + 1 < md.pts.length; k++) {
      const p = md.pts[k], q = md.pts[k + 1];
      const ring = [[p[0], p[1]], [p[2], p[3]], [q[2], q[3]], [q[0], q[1]]];
      const xs = ring.map((v) => v[0]), ns = ring.map((v) => v[1]);
      const c = { ring, y: (p[4] + q[4]) / 2, x0: Math.min(...xs), n0: Math.min(...ns), x1: Math.max(...xs), n1: Math.max(...ns) };
      slabs.insert(c, c.x0, c.n0, c.x1, c.n1);
    }
  }
  const stmp = [];

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
    for (const c of slabs.query(x, n, 0, stmp)) {
      if (x < c.x0 || x > c.x1 || n < c.n0 || n > c.n1 || c.y > lim || !inRing(c.ring, x, n)) continue;
      asphalt = Math.max(asphalt, c.y);
      if (c.y > best) { best = c.y; kind = 'joint'; road = null; }
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

function inRing(R, x, n) {
  let inside = false;
  for (let i = 0, j = R.length - 1; i < R.length; j = i++) {
    const [xi, ni] = R[i], [xj, nj] = R[j];
    if ((ni > n) !== (nj > n) && x < ((xj - xi) * (n - ni)) / (nj - ni) + xi) inside = !inside;
  }
  return inside;
}
