// Neon, as data: where the signs hang. Montréal at night is its commercial
// arteries — Sainte-Catherine, Saint-Laurent, Mont-Royal, Saint-Denis — lit
// shop by shop, with blade signs sticking out over the sidewalk. Every
// building fronting an artery may carry one; towers downtown may carry a lit
// name at the top. Pure data, deterministic: the same city lights the same.
//
// The palette gives the city its colour at night: not the future, just a
// street where the pinks, cyans and violets win over the sodium.

import { hash01 } from './geom.js';

export const NEON = {
  pink: 0xff2f8f,
  magenta: 0xe03cff,
  violet: 0x8a4dff,
  cyan: 0x22e6ff,
  teal: 0x19ffc2,
  red: 0xff3340,
  amber: 0xffa63a,
  white: 0xf2f6ff,
};

// Per district style: which colours its signs take, and how likely a
// building on an artery is to carry one.
const STYLE = {
  downtown: { p: 0.55, colours: ['cyan', 'magenta', 'pink', 'violet', 'cyan', 'teal', 'white'] },
  oldstone: { p: 0.3, colours: ['amber', 'red', 'white', 'amber'] },
  lofts: { p: 0.35, colours: ['cyan', 'teal', 'violet', 'white'] },
  plex: { p: 0.5, colours: ['pink', 'red', 'amber', 'magenta', 'cyan', 'teal'] },
  brick: { p: 0.45, colours: ['pink', 'amber', 'red', 'violet', 'teal'] },
  walkups: { p: 0.35, colours: ['red', 'amber', 'pink', 'cyan'] },
  westmount: { p: 0.1, colours: ['white', 'amber'] },
  villas: { p: 0.06, colours: ['white', 'amber'] },
  industrial: { p: 0.12, colours: ['cyan', 'white', 'red'] },
  suburb: { p: 0.18, colours: ['red', 'cyan', 'amber', 'white'] },
};

const ARTERY = new Set(['boulevard', 'avenue']);

// Canvas awnings: the usual dark reds, greens and navies.
const AWNING = [0x6e1420, 0x1d4a2c, 0x1a2548, 0x3a1446, 0x222222, 0x7a3a12];

/**
 * @param layout    compiled map (streetsAt)
 * @param buildings prepareBuildings() output (ring, base, h, floorH, cx, cn, tile)
 * @param styleAt   (x, n) → a district style name
 * @returns {
 *   signs: [{ kind: 'band' | 'blade' | 'crown' | 'awning', x, n, y, ux, un, ox, on, w, h, d, colour, accent, tile, seed }],
 * }  (ux, un) along the facade, (ox, on) out of it; y the bottom
 */
export function placeNeon(layout, buildings, styleAt) {
  const s = layout.map.scale || 1;
  const signs = [];
  const tmp = [];
  for (const b of buildings) {
    const st = STYLE[styleAt(b.cx, b.cn)] || STYLE.walkups;
    const seed = hash01(Math.round(b.cx * 3), Math.round(b.cn * 3), 41);
    const real = b.h / s;
    const tower = real > 55;
    if (!tower && (seed > st.p || real < 5)) continue;
    const ring = b.ring;
    const cw = ringSign(ring) < 0;
    // The wall facing an artery: its middle within a sidewalk of the street.
    let best = null;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], c = ring[(i + 1) % ring.length];
      const ex = c[0] - a[0], en = c[1] - a[1], len = Math.hypot(ex, en);
      if (len < 4 * s) continue;
      const ux = ex / len, un = en / len;
      // Outward: right of a → c on a counter-clockwise ring.
      const ox = cw ? -un : un, on = cw ? ux : -ux;
      const mx = (a[0] + c[0]) / 2, mn = (a[1] + c[1]) / 2;
      for (const street of layout.streetsAt(mx + ox * 9 * s, mn + on * 9 * s, 3 * s, tmp)) {
        if (!tower && !ARTERY.has(street.cls)) continue;
        const score = len + (ARTERY.has(street.cls) ? 20 : 0);
        if (!best || score > best.score) best = { score, a, len, ux, un, ox, on, mx, mn };
      }
    }
    if (!best) continue;
    const colour = (k) => NEON[st.colours[Math.floor(hash01(seed * 1000, k, 7) * st.colours.length)]];
    const floorH = b.floorH || 3.3 * s;
    const out = 0.12 * s;
    if (tower && hash01(seed * 991, 3) < 0.4) {
      // A lit name near the top of a tower, seen from across the city.
      const w = Math.min(best.len * 0.6, 34 * s);
      signs.push({ kind: 'crown', x: best.mx + best.ox * out, n: best.mn + best.on * out, y: b.base + b.h - 6.5 * s,
        ux: best.ux, un: best.un, ox: best.ox, on: best.on, w, h: 3.2 * s, d: 0.4 * s,
        colour: colour(1), accent: colour(2), tile: b.tile, seed });
    }
    if (seed > st.p || real < 5) continue;
    // Over the shop: a band across the facade above the ground floor.
    const bandY = b.base + Math.min(floorH * 1.05, b.h - 1.2 * s);
    const w = Math.min(best.len * (0.45 + 0.3 * hash01(seed * 77, 5)), 14 * s);
    const along = (hash01(seed * 31, 9) - 0.5) * Math.max(0, best.len - w) * 0.8;
    signs.push({ kind: 'band', x: best.mx + best.ux * along + best.ox * out, n: best.mn + best.un * along + best.on * out, y: bandY,
      ux: best.ux, un: best.un, ox: best.ox, on: best.on, w, h: 0.95 * s, d: 0.25 * s,
      colour: colour(3), accent: colour(4), tile: b.tile, seed });
    // An awning over the shop window on some, under the band.
    if (hash01(seed * 191, 13) < 0.4) {
      const aw = Math.min(w * 1.1, best.len * 0.9);
      signs.push({ kind: 'awning', x: best.mx + best.ux * along + best.ox * out, n: best.mn + best.un * along + best.on * out,
        y: bandY - 0.35 * s, ux: best.ux, un: best.un, ox: best.ox, on: best.on, w: aw, h: 0.6 * s, d: 1.4 * s,
        colour: AWNING[Math.floor(hash01(seed * 7, 19) * AWNING.length)], tile: b.tile, seed });
    }
    // A blade sign over the sidewalk, on some: the Saint-Laurent look.
    if (real >= 7 && hash01(seed * 57, 11) < 0.55) {
      const t = hash01(seed * 13, 2) < 0.5 ? 0.12 : 0.88;
      const bx = best.a[0] + best.ux * best.len * t, bn = best.a[1] + best.un * best.len * t;
      const h = Math.min((2.6 + 2.2 * hash01(seed * 5, 6)) * s, b.h - floorH * 1.3);
      if (h > 1.5 * s) {
        signs.push({ kind: 'blade', x: bx + best.ox * 0.25 * s, n: bn + best.on * 0.25 * s, y: b.base + floorH * 1.3,
          ux: best.ux, un: best.un, ox: best.ox, on: best.on, w: 1.1 * s, h, d: 0.22 * s,
          colour: colour(5), accent: colour(6), tile: b.tile, seed });
      }
    }
  }
  return signs;
}

function ringSign(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  return -a;
}
