// Street furniture as data: lamp posts along the streets and trees — on the
// sidewalks of residential districts, in the parks, and a forest on the
// mountain. The structure pass already placed the highway lighting.

import { Grid, hash01, pointInPolygon, ringBBox, rng } from './geom.js';
import { STYLES } from './buildings.js';

const LAMP_SPACING = { boulevard: 34, avenue: 36, street: 42, narrow: 28, service: 40, plaza: 26 };
const TREE_STREET = new Set(['plex', 'brick', 'walkups', 'westmount', 'villas', 'downtown', 'lofts', 'park', 'verge']);

/** Index blocks by bounding box for point lookups. */
export function blockIndex(layout) {
  const g = new Grid(64);
  for (const b of layout.blocks) g.insert(b, b.bbox.x0, b.bbox.n0, b.bbox.x1, b.bbox.n1);
  const tmp = [];
  return (x, n) => {
    for (const b of g.query(x, n, 0, tmp)) {
      if (x < b.bbox.x0 || x > b.bbox.x1 || n < b.bbox.n0 || n > b.bbox.n1) continue;
      if (pointInPolygon(x, n, b.poly)) return b;
    }
    return null;
  };
}

/**
 * Lamp posts on both sidewalks of wide streets, alternating on narrow ones,
 * never in an intersection, a trench or the river.
 */
export function placeStreetLamps(layout, structures) {
  const { index, ground } = structures;
  const lamps = [];
  const near = new Grid(24);
  const tmp = [];
  const taken = (x, n, r) => near.query(x, n, r, tmp).some((l) => Math.hypot(l.x - x, l.n - n) < r);
  for (const st of layout.streets) {
    const spacing = LAMP_SPACING[st.cls];
    if (!spacing) continue;
    const both = st.cls === 'boulevard' || st.cls === 'avenue' || st.cls === 'service';
    let k = 0;
    for (let i = 0; i + 1 < st.path.length; i++) {
      const a = st.path[i], b = st.path[i + 1];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const tx = (b[0] - a[0]) / len, tn = (b[1] - a[1]) / len;
      const lx = -tn, ln = tx;
      for (let d = spacing / 2; d < len; d += spacing, k++) {
        for (const side of both ? [1, -1] : [k % 2 ? 1 : -1]) {
          const off = st.half + 0.9;
          const x = a[0] + tx * d + lx * side * off, n = a[1] + tn * d + ln * side * off;
          // Not in another street, on a road, over a trench or in the water.
          if (layout.streetsAt(x, n, 0.6, tmp).some((o) => o !== st && o.cls !== 'apron')) continue;
          if (index.surfacesAt(x, n, 1).length) continue;
          const kind = ground.kindAt(x, n);
          if (kind !== 'land') continue;
          if (taken(x, n, 11)) continue;
          const oldTown = st.cls === 'narrow' || st.cls === 'plaza' || isOldTown(x, n);
          const lamp = { x, n, y: 0.15, kind: oldTown ? 'lantern' : 'cobra', lx: -lx * side, ln: -ln * side, tx, tn };
          lamps.push(lamp);
          near.insert(lamp, x, n, x, n);
        }
      }
    }
  }
  return lamps;
}

function isOldTown(x, n) {
  return x > -30 && x < 690 && n > -700 && n < -450;
}

/**
 * Trees. Street trees every 9 m on residential sidewalks; parks filled on a
 * jittered grid; the mountain as a forest that leaves its roads, lookouts and
 * the lake clear. Deterministic.
 */
export function placeTrees(layout, structures, lamps) {
  const { index, ground } = structures;
  const trees = [];
  const inBlock = blockIndex(layout);
  const lampGrid = new Grid(16);
  for (const l of lamps) lampGrid.insert(l, l.x, l.n, l.x, l.n);
  const tmp = [];
  const clearOfLamps = (x, n) => !lampGrid.query(x, n, 4, tmp).some((l) => Math.hypot(l.x - x, l.n - n) < 3.5);

  // Street trees.
  for (const st of layout.streets) {
    if (!['street', 'avenue', 'boulevard'].includes(st.cls)) continue;
    for (let i = 0; i + 1 < st.path.length; i++) {
      const a = st.path[i], b = st.path[i + 1];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const tx = (b[0] - a[0]) / len, tn = (b[1] - a[1]) / len;
      for (let d = 5; d < len; d += 11) {
        for (const side of [1, -1]) {
          const off = st.half + 2.1;
          const x = a[0] + tx * d - tn * side * off, n = a[1] + tn * d + tx * side * off;
          const blk = inBlock(x, n);
          if (!blk || !TREE_STREET.has(blk.style)) continue;
          const want = STYLES[blk.style]?.trees ?? 0;
          if (hash01(Math.round(x * 3), Math.round(n * 3), 1) > want * 0.9) continue;
          if (layout.streetsAt(x, n, 3.5, tmp).some((o) => o !== st && o.cls !== 'alley')) continue;
          if (index.surfacesAt(x, n, 2).length) continue;
          if (!clearOfLamps(x, n)) continue;
          trees.push({ x, n, y: 0.15, s: 0.8 + 0.5 * hash01(Math.round(x), Math.round(n), 2), kind: 'leafy' });
        }
      }
    }
  }

  // Parks, plazas, verges and the islands.
  for (const blk of layout.blocks) {
    const style = STYLES[blk.style];
    if (!style || style.fill !== 'none' || !style.trees) continue;
    const step = blk.style === 'park' ? 12 : 20;
    const R = rng(4000 + blk.id);
    const bb = blk.bbox;
    for (let x = bb.x0 + step / 2; x < bb.x1; x += step) {
      for (let n = bb.n0 + step / 2; n < bb.n1; n += step) {
        const px = x + (R() - 0.5) * step * 0.8, pn = n + (R() - 0.5) * step * 0.8;
        if (R() > style.trees * 0.75) continue;
        if (!pointInPolygon(px, pn, blk.poly)) continue;
        if (index.surfacesAt(px, pn, 3).length) continue;
        trees.push({ x: px, n: pn, y: 0.12, s: 0.8 + R() * 0.7, kind: R() < 0.12 ? 'conifer' : 'leafy' });
      }
    }
  }

  // The mountain: a forest, clear of roads, terraces and the lake.
  const T = layout.terrain;
  const mb = T.bbox;
  const R = rng(777);
  const lake = layout.map.mountain.lake;
  const clearings = layout.map.landmarks.filter((l) => T.inside(l.x, l.n)).map((l) => ({ x: l.x, n: l.n, r: l.type === 'oratory' ? 95 : l.type === 'chalet' ? 60 : 30 }));
  const step = 13;
  for (let x = mb.x0; x < mb.x1; x += step) {
    for (let n = mb.n0; n < mb.n1; n += step) {
      const px = x + (R() - 0.5) * step * 0.9, pn = n + (R() - 0.5) * step * 0.9;
      if (R() < 0.18) continue;
      if (!T.inside(px, pn)) continue;
      if (index.surfacesAt(px, pn, 4.5).length) continue;
      if (clearings.some((c) => Math.hypot(c.x - px, c.n - pn) < c.r)) continue;
      if (lake && ((px - lake.x) / (lake.rx + 8)) ** 2 + ((pn - lake.n) / (lake.rn + 8)) ** 2 < 1) continue;
      if (Math.abs(T.grade(px, pn, 1, 0)) > 0.95 || Math.abs(T.grade(px, pn, 0, 1)) > 0.95) continue;
      const y = T.height(px, pn);
      if (y < 0.3) continue;
      trees.push({ x: px, n: pn, y, s: 1.1 + R() * 0.9, kind: R() < 0.22 ? 'conifer' : 'leafy' });
    }
  }
  return trees;
}

export { ringBBox };
