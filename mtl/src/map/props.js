// Street furniture as data: lamp posts along the streets, and the trees — the
// real ones (Montréal's street-tree inventory, via OpenStreetMap) plus the
// mountain's woods, which nobody maps tree by tree. The structure pass already
// placed the highway lighting.

import { Grid, hash01, pointInPolygon, ringBBox, rng } from './geom.js';

const LAMP_SPACING = { boulevard: 34, avenue: 36, street: 44, narrow: 28, plaza: 26 };

/**
 * Lamp posts on both sidewalks of wide streets, alternating on narrow ones,
 * never in an intersection, on a road, over a trench or in the water.
 * @param oldTown (x, n) → true where the lanterns of Old Montréal belong
 */
export function placeStreetLamps(layout, structures, oldTown = () => false) {
  const { index, ground } = structures;
  const T = layout.terrain, s = layout.map.scale;
  const lamps = [];
  const near = new Grid(24);
  const tmp = [], tmp2 = [];
  const taken = (x, n, r) => near.query(x, n, r, tmp2).some((l) => Math.hypot(l.x - x, l.n - n) < r);
  for (const st of layout.streets) {
    const spacing = LAMP_SPACING[st.cls] * s;
    if (!spacing) continue;
    const both = st.cls === 'boulevard' || st.cls === 'avenue';
    let k = 0;
    for (let i = 0; i + 1 < st.path.length; i++) {
      const a = st.path[i], b = st.path[i + 1];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 1e-6) continue;
      const tx = (b[0] - a[0]) / len, tn = (b[1] - a[1]) / len;
      const lx = -tn, ln = tx;
      for (let d = spacing / 2; d < len; d += spacing, k++) {
        for (const side of both ? [1, -1] : [k % 2 ? 1 : -1]) {
          const off = st.half + 0.9 * s;
          const x = a[0] + tx * d + lx * side * off, n = a[1] + tn * d + ln * side * off;
          if (layout.streetsAt(x, n, 0.6 * s, tmp).some((o) => o !== st)) continue;
          if (index.surfacesAt(x, n, 1).length) continue;
          if (ground.kindAt(x, n) !== 'terrain') continue;
          if (taken(x, n, 11 * s)) continue;
          // Lanterns in the old town, white LED on the arteries, the old
          // sodium cobras on the side streets.
          const kind = oldTown(x, n) || st.cls === 'narrow' || st.cls === 'plaza' ? 'lantern' : both ? 'led' : 'cobra';
          const lamp = { x, n, y: T.height(x, n) + 0.05, kind,
            lx: -lx * side, ln: -ln * side, tx, tn };
          lamps.push(lamp);
          near.insert(lamp, x, n, x, n);
        }
      }
    }
  }
  return lamps;
}

/**
 * Trees: every mapped tree that stands clear of the asphalt, then the woods —
 * the forest polygons (Mont Royal, the islands) planted on a jittered grid.
 * Deterministic.
 */
export function placeTrees(layout, structures, map, lamps = []) {
  const { index, ground } = structures;
  const T = layout.terrain, s = map.scale;
  const trees = [];
  const lampGrid = new Grid(16);
  for (const l of lamps) lampGrid.insert(l, l.x, l.n, l.x, l.n);
  const tmp = [], tmp2 = [];
  const clear = (x, n, r) => {
    if (layout.streetsAt(x, n, r, tmp).length) return false;
    if (index.surfacesAt(x, n, r + 1).length) return false;
    return ground.kindAt(x, n) === 'terrain';
  };
  const { xs, ns, count } = map.trees;
  for (let k = 0; k < count; k++) {
    const x = xs[k], n = ns[k];
    if (!clear(x, n, 0.3 * s)) continue;
    if (lampGrid.query(x, n, 3, tmp2).some((l) => Math.hypot(l.x - x, l.n - n) < 2.5 * s)) continue;
    const h = hash01(Math.round(x * 3), Math.round(n * 3), 2);
    trees.push({ x, n, y: T.height(x, n), s: (0.75 + 0.6 * h) * s, kind: h < 0.08 ? 'conifer' : 'leafy' });
  }
  const mapped = trees.length;

  // The woods.
  const R = rng(777);
  const step = 11 * s;
  for (const g of layout.greens) {
    if (g.kind !== 'foret') continue;
    for (const poly of g.poly) {
      const bb = ringBBox(poly[0]);
      for (let x = bb.x0 + step / 2; x < bb.x1; x += step) {
        for (let n = bb.n0 + step / 2; n < bb.n1; n += step) {
          const px = x + (R() - 0.5) * step * 0.9, pn = n + (R() - 0.5) * step * 0.9;
          if (R() < 0.15) continue;
          if (!pointInPolygon(px, pn, poly)) continue;
          if (!clear(px, pn, 3 * s)) continue;
          trees.push({ x: px, n: pn, y: T.height(px, pn), s: (1.0 + R() * 0.9) * s, kind: R() < 0.2 ? 'conifer' : 'leafy' });
        }
      }
    }
  }
  return { trees, mapped };
}

const PARK_SLOT = 6.4;          // metres of kerb per parked car
const PARK_FILL = 0.55;         // share of the slots taken
const PARK_CLEAR = 10;          // metres kept clear of any other street (corners, crosswalks)

/**
 * Cars parked along the kerb of ordinary streets: both sides of a two-way
 * street at least 10.5 m wide, one side of a one-way at least 7.5 m. Never
 * near a corner, on a bridge or ramp, or over water. Deterministic, so every
 * player sees the same cars in the same places. The cars are not scaled with
 * the map: they keep real size, like the player's.
 * @returns [{ x, n, y, yaw (radians, three.js), pitch, len, hue }]
 */
export function placeParkedCars(layout, structures) {
  const { index, ground } = structures;
  const T = layout.terrain, s = layout.map.scale;
  const cars = [];
  const tmp = [];
  for (const st of layout.streets) {
    if (st.cls !== 'street' && st.cls !== 'avenue') continue;
    // The driven lane must stay clear: the game (spawns, checks) drives the
    // right-hand lane, a quarter of the width off the axis, on streets 10 m
    // wide or more, and the axis on narrower ones. A parked car needs its
    // inner flank 1.3 m past that line, so an ordinary 11 m two-way street
    // has no room for them; a 13 m one has, on both sides.
    const w = st.width, lane = w >= 10 ? w / 4 : 0;
    const off = st.half - 1.0;                  // kerb lane: centre of the car
    const fits = off - 0.9 >= lane + 1.3;
    const sides = !fits || w / s < 7.5 ? []
      : st.oneway ? [w >= 10 ? 1 : (hash01(st.index, 3, 11) < 0.5 ? 1 : -1)]
        : [1, -1];
    if (!sides.length) continue;
    for (let i = 0; i + 1 < st.path.length; i++) {
      const a = st.path[i], b = st.path[i + 1];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < PARK_SLOT * 2) continue;
      const tx = (b[0] - a[0]) / len, tn = (b[1] - a[1]) / len;
      const lx = -tn, ln = tx;
      for (let d = PARK_SLOT; d + PARK_SLOT * 0.5 < len; d += PARK_SLOT) {
        for (const side of sides) {
          const h = hash01(Math.round(a[0] + tx * d), Math.round(a[1] + tn * d), side > 0 ? 21 : 22);
          if (h > PARK_FILL) continue;
          const jitter = (hash01(Math.round(a[0] * 3 + d), side, 23) - 0.5) * 0.8;
          const x = a[0] + tx * (d + jitter) + lx * side * off, n = a[1] + tn * (d + jitter) + ln * side * off;
          if (layout.streetsAt(x, n, PARK_CLEAR * s, tmp).some((o) => o !== st)) continue;
          if (index.surfacesAt(x, n, 3).length) continue;
          if (ground.kindAt(x, n) !== 'terrain') continue;
          // Facing the traffic of their own side: on the left of a two-way
          // street, the other way.
          const fx = st.oneway || side < 0 ? tx : -tx, fn = st.oneway || side < 0 ? tn : -tn;
          const y0 = T.height(x - fx * 1.3, n - fn * 1.3), y1 = T.height(x + fx * 1.3, n + fn * 1.3);
          cars.push({
            x, n, y: (y0 + y1) / 2 + 0.03,
            // three.js yaw turning the car's +Z (its nose) onto (fx, -fn).
            yaw: Math.atan2(fx, -fn), pitch: Math.atan2(y1 - y0, 2.6),
            fx, fn, hue: hash01(Math.round(x * 7), Math.round(n * 7), 24),
          });
        }
      }
    }
  }
  return cars;
}
