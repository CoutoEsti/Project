// What the wheels stand on. A city with a trench, a tunnel and a viaduct has
// several surfaces over the same point, so the question is never "how high is
// the ground here" but "which surface is under a car that is at this height":
// the highest one at or below it, plus a step the car can climb (a kerb).

import { blockIndex } from './props.js';
import { pointInPolygon, ringBBox } from './geom.js';

const KERB = { sidewalk: 0.15, grass: 0.12, parking: 0.1, gravel: 0.08, plaza: 0.12 };

export function createSurface(layout, structures) {
  const { index, ground } = structures;
  const T = layout.terrain;
  const inBlock = blockIndex(layout);
  const decks = structures.decks.map((d) => ({ ...d, bb: ringBBox(d.poly[0]) }));
  const water = layout.map.levels.water;
  const tmp = [];

  /**
   * @param yRef   the car's current height
   * @param step   how much higher a surface may be and still be climbed onto
   * @returns { y, kind: 'road'|'land'|'block'|'terrain'|'deck'|'water'|'void', road, s, i, t }
   *          (s, i, t: where along the road — arc length, segment, fraction)
   */
  function at(x, n, yRef, step = 0.6) {
    const lim = yRef + step;
    let best = -Infinity, kind = 'void', road = null, s = 0, i = 0, t = 0;
    for (const o of index.surfacesAt(x, n, 0, tmp)) {
      if (o.y <= lim && o.y > best) { best = o.y; kind = 'road'; road = o.road; s = o.s; i = o.i; t = o.t; }
    }
    const k = ground.kindAt(x, n);
    if (k === 'land') {
      const blk = inBlock(x, n);
      const gy = blk ? KERB[blk.ground] ?? 0.15 : 0;
      if (gy <= lim && gy > best) { best = gy; kind = blk ? 'block' : 'land'; road = null; }
    } else if (k === 'terrain') {
      const gy = T.height(x, n);
      if (gy <= lim + 0.2 && gy > best) { best = gy; kind = 'terrain'; road = null; }
    } else if (k === 'water') {
      for (const d of decks) {
        if (x < d.bb.x0 || x > d.bb.x1 || n < d.bb.n0 || n > d.bb.n1) continue;
        if (pointInPolygon(x, n, d.poly) && d.y <= lim && d.y > best) { best = d.y; kind = 'deck'; road = null; }
      }
      if (best === -Infinity) { best = water; kind = 'water'; }
    }
    return { y: best, kind, road, s, i, t };
  }

  return { at };
}
