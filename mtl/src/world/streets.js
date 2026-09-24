// Streets as ribbons laid on the relief: asphalt, and a sidewalk on each side.
// Where two streets cross, their ribbons simply overlap — same material, UVs
// in metres, so the overlap is invisible — and the sidewalks sit a hair lower
// than the asphalt, so a crossing street always runs over them.
//
// A ribbon keeps a vertex only where the ground bends under it: a straight
// street on a steady slope is two vertices per side, however long it is.
//
// Receives THREE, never imports it.

import { GeoBuilder, meshOf } from './builder.js';
import * as G from '../map/geom.js';

const LIFT = { asphalt: 0.07, sidewalk: 0.05 };
const SIDEWALK = { boulevard: 3.6, avenue: 3.2, street: 2.6, narrow: 1.8, plaza: 0, alley: 0 };
const STEP = 4;            // metres between height probes
const TOL = 0.03;          // metres a ribbon may stray from the ground

/**
 * @returns { meshes, stats }
 */
export function buildStreets(THREE, layout, M, tiles) {
  const T = layout.terrain;
  const s = layout.map.scale;
  const holeGrid = polyIndex(layout.holes);
  const waterGrid = polyIndex(layout.water);
  const cut = (x, n) => holeGrid(x, n) || waterGrid(x, n);
  const per = new Map();
  const tile = (key) => {
    let t = per.get(key);
    if (!t) { t = { asphalt: new GeoBuilder(), sidewalk: new GeoBuilder() }; per.set(key, t); }
    return t;
  };
  let stations = 0;
  for (const st of layout.streets) {
    const half = st.half;
    const walk = (SIDEWALK[st.cls] ?? 2.4) * s;
    const line = stationsOf(st.path, T, half + walk);
    stations += line.length;
    const mid = st.path[Math.floor(st.path.length / 2)];
    const t = tile(tiles.key(mid[0], mid[1]));
    ribbon(t.asphalt, line, -half, half, LIFT.asphalt, cut, T);
    if (walk > 0) {
      ribbon(t.sidewalk, line, half, half + walk, LIFT.sidewalk, cut, T);
      ribbon(t.sidewalk, line, -half - walk, -half, LIFT.sidewalk, cut, T);
    }
  }
  const meshes = [];
  for (const [key, t] of per) {
    for (const [layer, b, mat] of [['rues', t.asphalt, M.Street_Asphalt], ['trottoirs', t.sidewalk, M.Street_Sidewalk]]) {
      const m = meshOf(THREE, b, mat, `${layer === 'rues' ? 'Rues' : 'Trottoirs'}_${key}`);
      if (!m) continue;
      m.receiveShadow = true;
      m.userData.tile = key;
      m.userData.layer = layer;
      meshes.push(m);
    }
  }
  return { meshes, stats: { stations } };
}

/**
 * Stations along a street: position, left normal, and the ground height at
 * the centre and at `reach` either side. Dense probes first, then only the
 * ones the ground's shape needs (Douglas–Peucker on all three heights).
 */
function stationsOf(path, T, reach) {
  const n = path.length;
  // Mitred normals at joints so the ribbon's edges stay parallel.
  const normals = [];
  for (let i = 0; i < n; i++) {
    const a = path[Math.max(0, i - 1)], b = path[i], c = path[Math.min(n - 1, i + 1)];
    let t1x = b[0] - a[0], t1n = b[1] - a[1], t2x = c[0] - b[0], t2n = c[1] - b[1];
    const l1 = Math.hypot(t1x, t1n) || 1, l2 = Math.hypot(t2x, t2n) || 1;
    t1x /= l1; t1n /= l1; t2x /= l2; t2n /= l2;
    if (i === 0) { t1x = t2x; t1n = t2n; }
    if (i === n - 1) { t2x = t1x; t2n = t1n; }
    let lx = -(t1n + t2n), ln = t1x + t2x;
    const ll = Math.hypot(lx, ln) || 1;
    lx /= ll; ln /= ll;
    // Mitre length, capped so hairpins do not spike.
    const cos = Math.max(0.35, lx * -t1n + ln * t1x);
    normals.push([lx / cos, ln / cos]);
  }
  const out = [];
  for (let i = 0; i + 1 < n; i++) {
    const a = path[i], b = path[i + 1];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const k = Math.max(1, Math.ceil(len / STEP));
    const na = normals[i], nb = normals[i + 1];
    // Probes along this straight edge, both ends included.
    const span = [];
    for (let j = 0; j <= k; j++) {
      const u = j / k;
      const x = a[0] + (b[0] - a[0]) * u, nn = a[1] + (b[1] - a[1]) * u;
      const lx = j === 0 ? na[0] : j === k ? nb[0] : na[0] + (nb[0] - na[0]) * u;
      const ln = j === 0 ? na[1] : j === k ? nb[1] : na[1] + (nb[1] - na[1]) * u;
      span.push([x, nn, T.height(x, nn), T.height(x + lx * reach, nn + ln * reach), T.height(x - lx * reach, nn - ln * reach), lx, ln, u * len]);
    }
    // Along a straight edge only the heights can bend: keep what they need.
    const kept = keepIndices(span.map((p) => [p[7], p[2], p[3], p[4]]), TOL);
    for (const idx of kept) if (idx > 0 || i === 0) out.push(span[idx]);
  }
  return out;
}

/** Douglas–Peucker over [s, y1, y2, y3]: indices of the samples to keep. */
function keepIndices(pts, tol) {
  const m = pts.length;
  if (m <= 2) return pts.map((_, i) => i);
  const keep = new Uint8Array(m);
  keep[0] = keep[m - 1] = 1;
  const stack = [[0, m - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const A = pts[a], B = pts[b], ds = B[0] - A[0] || 1;
    let best = -1, bestErr = tol;
    for (let i = a + 1; i < b; i++) {
      const t = (pts[i][0] - A[0]) / ds;
      let err = 0;
      for (let c = 1; c < 4; c++) err = Math.max(err, Math.abs(A[c] + (B[c] - A[c]) * t - pts[i][c]));
      if (err > bestErr) { bestErr = err; best = i; }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  const out = [];
  for (let i = 0; i < m; i++) if (keep[i]) out.push(i);
  return out;
}

/** A strip between lateral offsets o0 < o1, at the ground plus `lift`. */
function ribbon(b, line, o0, o1, lift, cut, T) {
  let prev = null;
  for (const p of line) {
    const [x, n, , , , lx, ln] = p;
    const ax = x + lx * o0, an = n + ln * o0, bx = x + lx * o1, bn = n + ln * o1;
    const i0 = b.v(ax, an, T.height(ax, an) + lift, 0, 0, 1, ax, an);
    const i1 = b.v(bx, bn, T.height(bx, bn) + lift, 0, 0, 1, bx, bn);
    if (prev) {
      const cx = (x + prev.x) / 2 + lx * (o0 + o1) / 2, cn = (n + prev.n) / 2 + ln * (o0 + o1) / 2;
      if (!cut(cx, cn)) b.quad(prev.i1, prev.i0, i0, i1);
    }
    prev = { x, n, i0, i1 };
  }
}

function polyIndex(multi) {
  const items = multi.map((poly) => ({ poly, bb: G.ringBBox(poly[0]) }));
  const grid = new G.Grid(64);
  for (const it of items) grid.insert(it, it.bb.x0, it.bb.n0, it.bb.x1, it.bb.n1);
  const tmp = [];
  return (x, n) => {
    for (const it of grid.query(x, n, 0, tmp)) {
      if (x < it.bb.x0 || x > it.bb.x1 || n < it.bb.n0 || n > it.bb.n1) continue;
      if (G.pointInPolygon(x, n, it.poly)) return true;
    }
    return false;
  };
}
