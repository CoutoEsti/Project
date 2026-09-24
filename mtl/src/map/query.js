// "What is at (x, n)?" — the questions the structure builder, the physics and
// the tests all ask. Pure logic over the compiled layout.

import { Grid, segDist2, pointInPolygon, ringBBox, lerp } from './geom.js';

/**
 * Spatial index of every road ribbon. `surfacesAt` answers with each road
 * whose running surface covers the point, its height there and where along it.
 */
export function createRoadIndex(roads) {
  const grid = new Grid(16);
  for (const r of roads) {
    const S = r.samples;
    for (let i = 0; i + 1 < S.length; i++) {
      const a = S[i], b = S[i + 1], h = r.half + 2;
      grid.insert({ r, i }, Math.min(a.x, b.x) - h, Math.min(a.n, b.n) - h, Math.max(a.x, b.x) + h, Math.max(a.n, b.n) + h);
    }
  }
  const tmp = [];
  const best = new Map();

  /**
   * @param pad  extra lateral reach beyond the half-width (negative shrinks)
   * @returns [{ road, y, d, i, t, s, side }] — side: +1 left of travel, -1 right
   */
  function surfacesAt(x, n, pad = 0, out = []) {
    out.length = 0;
    best.clear();
    for (const c of grid.query(x, n, 0, tmp)) {
      const S = c.r.samples, a = S[c.i], b = S[c.i + 1];
      const { d2, t } = segDist2(x, n, a.x, a.n, b.x, b.n);
      const lim = c.r.half + pad;
      if (d2 > lim * lim) continue;
      // Beyond either end of the road the projection clamps; don't extend it.
      if ((c.i === 0 && t <= 0) || (c.i === S.length - 2 && t >= 1)) {
        const e = t <= 0 ? a : b;
        const along = (x - e.x) * e.tx + (n - e.n) * e.tn;
        if ((t <= 0 && along < -0.05) || (t >= 1 && along > 0.05)) continue;
      }
      const prev = best.get(c.r);
      if (prev && prev.d2 <= d2) continue;
      best.set(c.r, { d2, i: c.i, t });
    }
    for (const [r, v] of best) {
      const a = r.samples[v.i], b = r.samples[v.i + 1];
      const cx = lerp(a.x, b.x, v.t), cn = lerp(a.n, b.n, v.t);
      const side = Math.sign((x - cx) * a.lx + (n - cn) * a.ln) || 1;
      out.push({ road: r, y: lerp(a.y, b.y, v.t), d: Math.sqrt(v.d2), i: v.i, t: v.t, s: lerp(a.s, b.s, v.t), side,
        covered: !!(a.covered && b.covered), tunnel: !!(a.tunnel && b.tunnel) });
    }
    return out;
  }

  return { surfacesAt, grid };
}

/**
 * What the ground is at a point: open water (with its own level — the river,
 * the canal above its locks and the lake on the mountain are not at the same
 * height), a hole in the ground (a trench seen from above), or the relief.
 */
export function createGround(layout) {
  const { terrain } = layout;
  const index = (multi) => multi.map((poly) => ({ poly, bb: ringBBox(poly[0]) }));
  const holes = index(layout.holes);
  const inAny = (list, x, n) => {
    for (const { poly, bb } of list) {
      if (x < bb.x0 || x > bb.x1 || n < bb.n0 || n > bb.n1) continue;
      if (pointInPolygon(x, n, poly)) return true;
    }
    return false;
  };

  function kindAt(x, n) {
    if (layout.waterAt(x, n)) return 'water';
    if (inAny(holes, x, n)) return 'hole';
    return 'terrain';
  }

  /** Height of the ground itself; a hole has none (the trench floor is a road). */
  function heightAt(x, n, kind = kindAt(x, n)) {
    if (kind === 'water') { const w = layout.waterAt(x, n); return w ? w.level : 0; }
    if (kind === 'hole') return -Infinity;
    return terrain.height(x, n);
  }

  return { kindAt, heightAt, inWater: (x, n) => !!layout.waterAt(x, n), inHole: (x, n) => inAny(holes, x, n) };
}
