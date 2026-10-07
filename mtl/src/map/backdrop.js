// The city that goes on past the zone's edge, as data: the real buildings
// outside the zone, gathered into blocks, so the world can stand a cheap
// silhouette of them behind the invisible wall (world/backdrop.js draws them).
// Pure logic, no three.js.
//
// Each occupied cell of a grid becomes one box: as tall as the buildings in it
// (their mean, pulled a third of the way towards the tallest, so a tower
// still reads as one), as wide as their footprints fill the cell. Near the
// edge the cells are small; farther out they merge into coarser ones. When
// there are too many, the band shrinks: the near city matters more than the
// far one, and the horizon painting stands in for it.

import * as G from './geom.js';

const NEAR_CELL = 30;           // real metres
const GAP = 25;                 // nothing closer than this to the wall
const NEAR_BAND = 450;          // finer cells up to here, coarser beyond
const MAX_BAND = 1500;
const MAX_BOXES = 14000;

/**
 * @param buildings  decoded buildings, real metres ({ ring, h, minH, part })
 * @param zone       makeZone() in real metres
 * @param scale      the map's scale: the output is multiplied by it
 * @returns { count, data: Float32Array [x, n, w, d, h] × count, band }
 */
export function backdropCells(buildings, zone, scale = 1) {
  const near = new Map();
  const [zx0, zn0, zx1, zn1] = zone.bbox;
  const lim = MAX_BAND + NEAR_CELL;
  for (const b of buildings) {
    if (b.part || b.minH > 1) continue;
    const ring = b.ring;
    const r0 = ring[0];
    if (r0[0] < zx0 - lim - 200 || r0[0] > zx1 + lim + 200 || r0[1] < zn0 - lim - 200 || r0[1] > zn1 + lim + 200) continue;
    let cx = 0, cn = 0;
    for (const p of ring) { cx += p[0]; cn += p[1]; }
    cx /= ring.length; cn /= ring.length;
    if (cx < zx0 - lim || cx > zx1 + lim || cn < zn0 - lim || cn > zn1 + lim) continue;
    const key = `${Math.floor(cx / NEAR_CELL)},${Math.floor(cn / NEAR_CELL)}`;
    let c = near.get(key);
    if (!c) { c = { i: Math.floor(cx / NEAR_CELL), j: Math.floor(cn / NEAR_CELL), area: 0, hArea: 0, max: 0 }; near.set(key, c); }
    const a = Math.abs(G.ringArea(ring));
    if (a < 30) continue;
    const h = heightOf(b, a);
    c.area += a;
    c.hArea += a * h;
    if (h > c.max) c.max = h;
  }

  // Distance of each occupied cell to the zone, once.
  const cells = [];
  for (const c of near.values()) {
    c.x = (c.i + 0.5) * NEAR_CELL; c.n = (c.j + 0.5) * NEAR_CELL;
    if (zone.contains(c.x, c.n, NEAR_CELL * 0.75 + GAP)) continue;
    if (!zone.contains(c.x, c.n, MAX_BAND)) continue;
    c.d = distance(zone, c.x, c.n);
    if (c.d < GAP) continue;
    cells.push(c);
  }

  let band = MAX_BAND, out = [];
  for (let tries = 0; tries < 8; tries++) {
    out = gather(cells.filter((c) => c.d <= band));
    if (out.length <= MAX_BOXES) break;
    band *= 0.8;
  }
  const data = new Float32Array(out.length * 5);
  out.forEach((b, k) => {
    data[k * 5] = b.x * scale; data[k * 5 + 1] = b.n * scale;
    data[k * 5 + 2] = b.w * scale; data[k * 5 + 3] = b.w * scale; data[k * 5 + 4] = b.h * scale;
  });
  return { count: out.length, data, band };
}

/** OpenStreetMap's height, else its floors, else what its kind and size suggest (as map/buildings.js). */
function heightOf(b, area) {
  if (b.h > 0) return b.h;
  if (b.floors) return b.floors * 3.4 + 1.2;
  if (b.kind === 'industrial' || b.kind === 'transportation' || b.kind === 'service') return 9;
  if (b.kind === 'religious') return 18;
  if (area < 250) return 9;
  if (area < 700) return 12;
  return area > 3000 ? 16 : 14;
}

/** Far cells merge two by two (2 × 2 near cells); the boxes come out sized to what they hold. */
function gather(cells) {
  const list = [];
  const far = new Map();
  for (const c of cells) {
    if (c.d <= NEAR_BAND) { list.push({ cell: NEAR_CELL, area: c.area, hArea: c.hArea, max: c.max, x: c.x, n: c.n, wx: c.x * c.area, wn: c.n * c.area }); continue; }
    const key = `${Math.floor(c.i / 2)},${Math.floor(c.j / 2)}`;
    let f = far.get(key);
    if (!f) { f = { cell: NEAR_CELL * 2, area: 0, hArea: 0, max: 0, wx: 0, wn: 0 }; far.set(key, f); }
    f.area += c.area; f.hArea += c.hArea; f.wx += c.x * c.area; f.wn += c.n * c.area;
    if (c.max > f.max) f.max = c.max;
  }
  list.push(...far.values());
  const out = [];
  for (const f of list) {
    const fill = f.area / (f.cell * f.cell);
    if (fill < 0.06) continue;
    const mean = f.hArea / f.area;
    const h = Math.max(5, mean + (f.max - mean) * 0.33);
    out.push({ x: f.wx / f.area, n: f.wn / f.area, w: f.cell * Math.sqrt(Math.min(0.85, Math.max(0.3, fill * 1.2))), h });
  }
  return out;
}

function distance(zone, x, n) {
  let best = Infinity;
  for (const [ax, an, bx, bn] of zone.edges) {
    const d = G.segDist2(x, n, ax, an, bx, bn).d2;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}
