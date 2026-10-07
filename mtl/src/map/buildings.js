// The real buildings, made ready to draw: where their base sits on the
// relief, how tall they are when OpenStreetMap does not say, what their walls
// are made of, and which tile they belong to.
//
// Heights: OpenStreetMap's own when it has one (most of downtown), else its
// floor count, else a guess from the building's kind, size and district —
// Montréal's plexes are two or three floors, its warehouses one tall one.
// Facades: the district's style decides — grey stone in Old Montréal, brick
// and outdoor staircases on the Plateau, curtain wall downtown.

import { hash01 } from './geom.js';

// District styles: facades to pick from, floor height, whether plexes get the
// outdoor staircase. Referenced by name from map/montreal.js (QUARTIERS).
export const STYLES = {
  downtown: { facades: ['concrete', 'stone', 'brick_buff', 'panel'], tall: ['glass_blue', 'glass_dark', 'glass_silver', 'glass_green', 'concrete'], floorH: 3.8 },
  oldstone: { facades: ['stone', 'stone', 'stone_dark', 'brick_old'], floorH: 3.9 },
  plex: { facades: ['brick_red', 'brick_brown', 'brick_red', 'brick_buff', 'brick_dark'], floorH: 3.3, stairs: true },
  brick: { facades: ['brick_red', 'brick_brown', 'brick_buff', 'brick_old', 'concrete'], floorH: 3.3, stairs: true },
  lofts: { facades: ['brick_old', 'brick_old', 'concrete', 'glass_green'], tall: ['glass_green', 'glass_blue', 'concrete'], floorH: 3.8 },
  walkups: { facades: ['brick_red', 'brick_buff', 'brick_brown', 'concrete'], floorH: 3.2 },
  westmount: { facades: ['stone', 'brick_red', 'brick_buff'], floorH: 3.4 },
  villas: { facades: ['stone', 'brick_buff', 'brick_red'], floorH: 3.4 },
  industrial: { facades: ['panel', 'panel_dark', 'brick_old', 'concrete'], floorH: 5 },
  suburb: { facades: ['brick_buff', 'brick_red', 'panel', 'concrete'], floorH: 3.2 },
};

const BY_KIND = {
  industrial: 'industrial', transportation: 'industrial', agricultural: 'industrial', military: 'industrial', service: 'industrial',
};

/**
 * @param map    buildMap() output (buildings already scaled)
 * @param layout compile() output (terrain, streetsAt)
 * @param tiles  map/tiles.js tiling
 * @param styleAt (x, n) → a STYLES key, from the nearest district
 */
export function prepareBuildings(map, layout, tiles, styleAt) {
  const T = layout.terrain, s = map.scale;
  const out = [];
  const tmp = [];
  for (const b of map.buildings) {
    const ring = b.ring;
    let base = Infinity;
    for (const [x, n] of ring) base = Math.min(base, T.height(x, n));
    base = Math.min(base, T.height(b.cx, b.cn)) - 0.3 * s;
    const area = Math.abs(ringArea(ring)) / (s * s);         // real m²
    const style = STYLES[BY_KIND[b.kind] || styleAt(b.cx, b.cn)] || STYLES.walkups;
    const seed = hash01(Math.round(b.cx * 7), Math.round(b.cn * 7), 11);
    let h = b.h;
    if (!(h > 0)) {
      if (b.floors) h = (b.floors * style.floorH + 1.2) * s;
      else h = guessHeight(b, area, style, seed) * s;
    }
    if (h < 2.2 * s) h = 2.2 * s;
    const real = h / s;
    const floorH = style.floorH * s;
    let facade;
    if (real > 45 && style.tall) facade = style.tall[Math.floor(seed * style.tall.length)];
    else if (real > 60) facade = ['glass_blue', 'glass_dark', 'glass_silver', 'concrete'][Math.floor(seed * 4)];
    else if (b.kind === 'religious') facade = 'stone';
    else if (b.kind === 'outbuilding') facade = 'panel_dark';
    else facade = style.facades[Math.floor(seed * style.facades.length)];
    // Pitched roofs where the data says so and the footprint is a plain
    // rectangle; otherwise flat, as nearly every roof in Montréal is.
    let roof = 'flat';
    if ((b.roof === 'gabled' || b.roof === 'hipped' || b.roof === 'gambrel' || b.roof === 'saltbox') && ring.length === 4) roof = 'gable';
    else if (b.roof === 'mansard' && ring.length === 4) roof = 'mansard';
    else if (real > 55 && hash01(seed * 1000, 3) < 0.6) roof = 'crown';
    // The outdoor staircase: plexes facing a street.
    let front = null;
    if (style.stairs && real <= 13 && area < 320 && b.kind !== 'outbuilding') front = facing(layout, b, tmp);
    out.push({
      id: b.id, name: b.name, ring, base, h, minH: b.minH || 0, facade, roof, floorH, front, stairs: !!front,
      tile: tiles.key(b.cx, b.cn), cx: b.cx, cn: b.cn, kind: b.kind, scale: s,
    });
  }
  return out;
}

function guessHeight(b, area, style, seed) {
  if (b.kind === 'outbuilding' || area < 30) return 3.2;
  if (style === STYLES.industrial || b.kind === 'industrial') return 7 + seed * 5;
  if (b.kind === 'religious') return 14 + seed * 8;
  if (b.kind === 'commercial' || b.kind === 'civic' || b.kind === 'education' || b.kind === 'medical') {
    return area > 3000 ? 12 + seed * 8 : 8 + seed * 6;
  }
  // Housing: plexes on small lots, walk-ups and blocks as the footprint grows.
  if (area < 250) return (seed < 0.35 ? 2 : 3) * style.floorH + 1.2;
  if (area < 700) return (3 + Math.floor(seed * 2)) * style.floorH + 1.2;
  return (4 + Math.floor(seed * 4)) * style.floorH + 1.2;
}

/** Outward direction of the wall that faces the nearest street, or null. */
function facing(layout, b, tmp) {
  const near = layout.streetsAt(b.cx, b.cn, 16, tmp);
  if (!near.length) return null;
  let best = null, bd = Infinity;
  for (const st of near) {
    const P = st.path;
    for (let i = 0; i + 1 < P.length; i++) {
      const a = P[i], c = P[i + 1];
      const dx = c[0] - a[0], dn = c[1] - a[1], l2 = dx * dx + dn * dn || 1;
      const t = Math.max(0, Math.min(1, ((b.cx - a[0]) * dx + (b.cn - a[1]) * dn) / l2));
      const px = a[0] + dx * t, pn = a[1] + dn * t;
      const d = Math.hypot(px - b.cx, pn - b.cn);
      if (d < bd) { bd = d; best = [px - b.cx, pn - b.cn]; }
    }
  }
  if (!best) return null;
  const l = Math.hypot(best[0], best[1]) || 1;
  return [best[0] / l, best[1] / l];
}

function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  return -a / 2;
}
