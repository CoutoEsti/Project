// Mont Royal as a height function.
//
// Four soft summits combined with a smooth maximum (a p-norm), so overlapping
// hills merge into one massif instead of stacking into a spike, then faded to
// street level at the footprint's edge. The same function drives the terrain
// mesh, the mountain roads' profiles and the car's ground contact, so the three
// can never disagree.
//
// Roads then *carve* it: once their profiles are known, the ground within a
// road's width is pinned just under the asphalt and blended back to the natural
// slope a few metres further out — cut and fill, like a real mountain road.

import { distToRing, pointInRing, smoothstep, noise2, Grid, segDist2, ringBBox } from './geom.js';

const P = 4;   // smooth-max exponent: higher is closer to a hard max

export function createTerrain(mountain) {
  const ring = mountain.ring;
  const bbox = ringBBox(ring);
  const fade = mountain.fade || 80;
  const summits = mountain.summits;
  const carve = new Grid(24);
  const cuts = [];      // { ax, an, ay, bx, bn, by, half, blend }
  const flats = [];     // { x, n, r, h, blend }

  function inside(x, n) {
    if (x < bbox.x0 || x > bbox.x1 || n < bbox.n0 || n > bbox.n1) return false;
    return pointInRing(x, n, ring);
  }

  /** Natural relief, before any road or terrace is cut into it. */
  function base(x, n) {
    if (!inside(x, n)) return 0;
    let acc = 0;
    for (const s of summits) {
      const dx = x - s.x, dn = n - s.n;
      const g = Math.exp(-(dx * dx + dn * dn) / (2 * s.r * s.r));
      acc += Math.pow(s.h * g, P);
    }
    let h = Math.pow(acc, 1 / P);
    // Rock and hollows: two octaves, a few metres, never enough to trap a car.
    h += noise2(x / 130, n / 130) * 3.2 + noise2(x / 45 + 17, n / 45 - 9) * 1.1;
    const edge = distToRing(x, n, ring);
    return Math.max(0, h) * smoothstep(0, fade, edge);
  }

  /** Relief with roads and terraces cut in. */
  function height(x, n) {
    let h = base(x, n);
    if (!cuts.length && !flats.length) return h;
    if (!inside(x, n)) return 0;
    // Terraces (the chalet's lookout, the Oratory's forecourt) first.
    for (const f of flats) {
      const d = Math.hypot(x - f.x, n - f.n);
      if (d < f.r + f.blend) {
        const w = 1 - smoothstep(f.r, f.r + f.blend, d);
        h = h + (f.h - h) * w;
      }
    }
    // Then the nearest road, pinned 12 cm under its surface.
    const near = carve.query(x, n, 0);
    let bestW = 0, bestH = 0, bestD = Infinity;
    for (let i = 0; i < near.length; i++) {
      const c = near[i];
      const { d2, t } = segDist2(x, n, c.ax, c.an, c.bx, c.bn);
      const d = Math.sqrt(d2);
      if (d > c.half + c.blend) continue;
      const w = 1 - smoothstep(c.half + 0.6, c.half + c.blend, d);
      // Equal weights (several segments within the road's width): the
      // nearest one, or a neighbour's clamped end sets the height.
      if (w > bestW || (w === bestW && d < bestD)) {
        bestW = w;
        bestD = d;
        bestH = c.ay + (c.by - c.ay) * t - 0.12;
      }
    }
    if (bestW > 0) h = h + (bestH - h) * bestW;
    return h;
  }

  /** Register a road's profile so the ground is cut to fit it. */
  function carveRoad(samples, half, blend = 16) {
    for (let i = 0; i + 1 < samples.length; i++) {
      const a = samples[i], b = samples[i + 1];
      if (!inside(a.x, a.n) && !inside(b.x, b.n)) continue;
      const c = { ax: a.x, an: a.n, ay: a.y, bx: b.x, bn: b.n, by: b.y, half, blend };
      const r = half + blend;
      carve.insert(c, Math.min(a.x, b.x) - r, Math.min(a.n, b.n) - r, Math.max(a.x, b.x) + r, Math.max(a.n, b.n) + r);
      cuts.push(c);
    }
  }

  function flatten(x, n, r, h = base(x, n), blend = 25) {
    flats.push({ x, n, r, h, blend });
    return h;
  }

  /** Surface slope in the direction (dx, dn), for sanity checks. */
  function grade(x, n, dx, dn, step = 2) {
    const l = Math.hypot(dx, dn) || 1;
    const ux = (dx / l) * step, un = (dn / l) * step;
    return (height(x + ux, n + un) - height(x - ux, n - un)) / (2 * step);
  }

  return { ring, bbox, inside, base, height, carveRoad, flatten, grade };
}
