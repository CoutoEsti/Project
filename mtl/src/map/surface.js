// What the wheels stand on. A city with trenches, tunnels and viaducts has
// several surfaces over the same point, so the question is never "how high is
// the ground here" but "which surface is under a car that is at this height":
// the highest one at or below it, plus a step the car can climb (a kerb).
//
// The streets are not surfaces of their own: they lie on the relief, so the
// relief is what a car on a street stands on.

export function createSurface(layout, structures) {
  const { index, ground } = structures;
  const T = layout.terrain;
  const tmp = [];

  /**
   * @param yRef   the car's current height
   * @param step   how much higher a surface may be and still be climbed onto
   * @returns { y, kind: 'road'|'terrain'|'water'|'void', road, s, i, t }
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
