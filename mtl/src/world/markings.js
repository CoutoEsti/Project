// Paint to meshes: thin strips a couple of centimetres above the surface, with
// a polygon offset so they always win the depth test against the asphalt.

import { GeoBuilder, meshOf } from './builder.js';
import { simplifyN } from '../map/geom.js';

export function buildMarkings(THREE, strips, M, tile = null) {
  const white = new GeoBuilder(), yellow = new GeoBuilder();
  for (const s of strips) {
    const b = s.color === 'yellow' ? yellow : white;
    const pts = simplifyN(s.pts, 0.02);
    if (s.dash) dashed(b, pts, s.w, s.dash);
    else strip(b, pts, s.w);
  }
  const out = [];
  const w = meshOf(THREE, white, M.Marking_White, 'Marquage_blanc');
  const y = meshOf(THREE, yellow, M.Marking_Yellow, 'Marquage_jaune');
  for (const m of [w, y]) {
    if (!m) continue;
    m.userData.zone = 'routes';
    m.userData.tile = tile;
    m.userData.layer = 'marquage';
    m.userData.detail = true;
    m.renderOrder = 1;
    out.push(m);
  }
  return out;
}

/** A continuous strip along [x, n, y] points. */
function strip(b, pts, w) {
  const h = w / 2;
  let pl = -1, pr = -1;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], c = pts[Math.min(pts.length - 1, i + 1)];
    let dx = c[0] - a[0], dn = c[1] - a[1];
    const l = Math.hypot(dx, dn) || 1;
    dx /= l; dn /= l;
    const lx = -dn, ln = dx;
    const p = pts[i];
    const L = b.v(p[0] + lx * h, p[1] + ln * h, p[2], 0, 0, 1, 0, 0);
    const R = b.v(p[0] - lx * h, p[1] - ln * h, p[2], 0, 0, 1, 1, 0);
    if (pl >= 0) b.quad(pl, pr, R, L);
    pl = L; pr = R;
  }
}

/** Dashes: walk the polyline, emitting a strip for each painted stretch. */
function dashed(b, pts, w, [on, off]) {
  let acc = 0, painting = true, cur = [pts[0]];
  for (let i = 0; i + 1 < pts.length; i++) {
    let a = pts[i];
    const c = pts[i + 1];
    let seg = Math.hypot(c[0] - a[0], c[1] - a[1]);
    while (seg > 0) {
      const left = (painting ? on : off) - acc;
      if (left > seg) {
        acc += seg;
        if (painting) cur.push(c);
        seg = 0;
      } else {
        const t = left / seg;
        const m = [a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t, a[2] + (c[2] - a[2]) * t];
        if (painting) { cur.push(m); if (cur.length >= 2) strip(b, cur, w); }
        painting = !painting;
        acc = 0;
        cur = [m];
        a = m;
        seg -= left;
      }
    }
  }
  if (painting && cur.length >= 2) strip(b, cur, w);
}
