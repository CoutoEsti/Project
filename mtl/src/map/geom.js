// Plane geometry on the map frame (x east, n north), with no dependency on
// three.js: the same code runs in the browser, under node for the plan and the
// tests, and in the export.
//
// Polygons follow polygon-clipping's convention: a Polygon is [outer, ...holes],
// a ring is [[x, n], ...], a MultiPolygon is [Polygon, ...].

import pc from '../../vendor/polygon-clipping.js';

export { pc };

export function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
export function lerp(a, b, t) { return a + (b - a) * t; }
export function smoothstep(a, b, v) {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

// ------------------------------------------------------------- polylines --

/** Cumulative arc length along a polyline of [x, n, ...] points. */
export function arcLengths(pts) {
  const s = new Float64Array(pts.length);
  for (let i = 1; i < pts.length; i++) {
    s[i] = s[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  }
  return s;
}

/**
 * Centripetal Catmull-Rom through control points, resampled every `spacing`
 * metres. Returns [{x, n, seg, u}] where seg/u locate the sample between
 * control points `seg` and `seg + 1` — used to carry heights along.
 * Centripetal (alpha = 0.5) never loops or cusps, which matters for ramps whose
 * control points bunch up where they peel off a carriageway.
 */
export function spline(ctrl, spacing = 2, closed = false) {
  const P = closed ? ctrl.slice(0, ctrl.length - (samePoint(ctrl[0], ctrl[ctrl.length - 1]) ? 1 : 0)) : ctrl;
  const count = P.length;
  if (count < 2) return P.map((p) => ({ x: p[0], n: p[1], seg: 0, u: 0 }));
  const segs = closed ? count : count - 1;
  const get = (i) => {
    if (closed) return P[((i % count) + count) % count];
    if (i < 0) return reflect(P[0], P[1]);
    if (i >= count) return reflect(P[count - 1], P[count - 2]);
    return P[i];
  };

  // Dense raw samples first, then an even resampling by arc length.
  const raw = [];
  for (let i = 0; i < segs; i++) {
    const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
    const len = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const steps = Math.max(2, Math.ceil(len / (spacing * 0.25)));
    for (let k = 0; k < steps; k++) {
      const u = k / steps;
      const q = catmull(p0, p1, p2, p3, u);
      raw.push({ x: q[0], n: q[1], seg: i, u });
    }
  }
  const last = closed ? get(0) : P[count - 1];
  raw.push({ x: last[0], n: last[1], seg: segs - 1, u: 1 });

  const s = [0];
  for (let i = 1; i < raw.length; i++) {
    s.push(s[i - 1] + Math.hypot(raw[i].x - raw[i - 1].x, raw[i].n - raw[i - 1].n));
  }
  const total = s[s.length - 1];
  const n = Math.max(2, Math.round(total / spacing) + 1);
  const out = [];
  let j = 0;
  for (let k = 0; k < n; k++) {
    const target = (total * k) / (n - 1);
    while (j < raw.length - 2 && s[j + 1] < target) j++;
    const a = raw[j], b = raw[j + 1];
    const t = s[j + 1] > s[j] ? (target - s[j]) / (s[j + 1] - s[j]) : 0;
    let seg = a.seg, u = lerp(a.u, b.seg === a.seg ? b.u : 1, t);
    if (b.seg !== a.seg && t >= 1) { seg = b.seg; u = b.u; }
    out.push({ x: lerp(a.x, b.x, t), n: lerp(a.n, b.n, t), seg, u });
  }
  return out;
}

function samePoint(a, b) { return Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6; }
function reflect(a, b) { return [2 * a[0] - b[0], 2 * a[1] - b[1]]; }

function catmull(p0, p1, p2, p3, t) {
  const alpha = 0.5;
  const d = (a, b) => Math.max(1e-4, Math.pow(Math.hypot(b[0] - a[0], b[1] - a[1]), alpha));
  const t0 = 0, t1 = t0 + d(p0, p1), t2 = t1 + d(p1, p2), t3 = t2 + d(p2, p3);
  const tt = lerp(t1, t2, t);
  const out = [0, 0];
  for (let c = 0; c < 2; c++) {
    const a1 = ((t1 - tt) * p0[c] + (tt - t0) * p1[c]) / (t1 - t0);
    const a2 = ((t2 - tt) * p1[c] + (tt - t1) * p2[c]) / (t2 - t1);
    const a3 = ((t3 - tt) * p2[c] + (tt - t2) * p3[c]) / (t3 - t2);
    const b1 = ((t2 - tt) * a1 + (tt - t0) * a2) / (t2 - t0);
    const b2 = ((t3 - tt) * a2 + (tt - t1) * a3) / (t3 - t1);
    out[c] = ((t2 - tt) * b1 + (tt - t1) * b2) / (t2 - t1);
  }
  return out;
}

/** Unit tangents and left normals for a sampled path, in place. */
export function frames(samples, closed = false) {
  const m = samples.length;
  for (let i = 0; i < m; i++) {
    let a = samples[Math.max(0, i - 1)], b = samples[Math.min(m - 1, i + 1)];
    if (closed) { a = samples[(i - 1 + m) % m]; b = samples[(i + 1) % m]; }
    let tx = b.x - a.x, tn = b.n - a.n;
    const l = Math.hypot(tx, tn) || 1;
    tx /= l; tn /= l;
    samples[i].tx = tx;
    samples[i].tn = tn;
    // Left of the direction of travel: rotate the tangent counter-clockwise.
    samples[i].lx = -tn;
    samples[i].ln = tx;
  }
  return samples;
}

/**
 * Moving average over a window of `radius` samples, applied twice: a box
 * filter squared is a triangle, which turns grade breaks into parabolic
 * vertical curves — how real highways are drawn.
 */
export function smooth(values, radius, passes = 2) {
  let v = Float64Array.from(values);
  const n = v.length;
  if (radius < 1 || n < 3) return v;
  for (let p = 0; p < passes; p++) {
    const out = new Float64Array(n);
    let acc = 0;
    const at = (i) => v[clamp(i, 0, n - 1)];
    for (let i = -radius; i <= radius; i++) acc += at(i);
    for (let i = 0; i < n; i++) {
      out[i] = acc / (2 * radius + 1);
      acc += at(i + radius + 1) - at(i - radius);
    }
    v = out;
  }
  return v;
}

/**
 * Douglas-Peucker on [x, n, ...] points: keeps the shape within `tol` metres
 * with a fraction of the vertices. Buffering 4 700 ring samples one quad at a
 * time would take polygon-clipping seconds; a few hundred take milliseconds.
 */
export function simplify(pts, tol) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  const t2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop();
    let best = -1, bestD = t2;
    for (let i = a + 1; i < b; i++) {
      const { d2 } = segDist2(pts[i][0], pts[i][1], pts[a][0], pts[a][1], pts[b][0], pts[b][1]);
      if (d2 > bestD) { bestD = d2; best = i; }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/**
 * Douglas-Peucker on points with any number of channels ([x, n, y, ...]):
 * a point is dropped when every channel is within `tol` of the straight
 * interpolation between the kept neighbours. Straight stretches of barrier,
 * wall or paint collapse to their two ends; curves keep what they need.
 */
export function simplifyN(pts, tol) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  const dims = pts[0].length;
  while (stack.length) {
    const [a, b] = stack.pop();
    const A = pts[a], B = pts[b];
    const dx = B[0] - A[0], dn = B[1] - A[1];
    const l2 = dx * dx + dn * dn;
    let best = -1, bestErr = tol;
    for (let i = a + 1; i < b; i++) {
      const P = pts[i];
      let t = l2 > 1e-12 ? ((P[0] - A[0]) * dx + (P[1] - A[1]) * dn) / l2 : 0;
      t = clamp(t, 0, 1);
      let err = Math.hypot(A[0] + dx * t - P[0], A[1] + dn * t - P[1]);
      for (let c = 2; c < dims; c++) err = Math.max(err, Math.abs(A[c] + (B[c] - A[c]) * t - P[c]));
      if (err > bestErr) { bestErr = err; best = i; }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

// --------------------------------------------------------------- polygons --

export function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  }
  return -a / 2;   // positive for counter-clockwise
}

export function polygonArea(poly) {
  let a = Math.abs(ringArea(poly[0]));
  for (let h = 1; h < poly.length; h++) a -= Math.abs(ringArea(poly[h]));
  return a;
}

export function ringBBox(ring) {
  let x0 = Infinity, n0 = Infinity, x1 = -Infinity, n1 = -Infinity;
  for (const [x, n] of ring) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (n < n0) n0 = n; if (n > n1) n1 = n;
  }
  return { x0, n0, x1, n1 };
}

export function pointInRing(x, n, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], ni = ring[i][1], xj = ring[j][0], nj = ring[j][1];
    if ((ni > n) !== (nj > n) && x < ((xj - xi) * (n - ni)) / (nj - ni) + xi) inside = !inside;
  }
  return inside;
}

export function pointInPolygon(x, n, poly) {
  if (!pointInRing(x, n, poly[0])) return false;
  for (let h = 1; h < poly.length; h++) if (pointInRing(x, n, poly[h])) return false;
  return true;
}

export function pointInMulti(x, n, multi) {
  for (const poly of multi) if (pointInPolygon(x, n, poly)) return true;
  return false;
}

/** Squared distance from p to segment ab, and the parameter of the foot. */
export function segDist2(px, pn, ax, an, bx, bn) {
  const dx = bx - ax, dn = bn - an;
  const l2 = dx * dx + dn * dn;
  let t = l2 > 1e-12 ? ((px - ax) * dx + (pn - an) * dn) / l2 : 0;
  t = clamp(t, 0, 1);
  const qx = ax + dx * t - px, qn = an + dn * t - pn;
  return { d2: qx * qx + qn * qn, t };
}

export function distToRing(x, n, ring) {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const { d2 } = segDist2(x, n, ring[j][0], ring[j][1], ring[i][0], ring[i][1]);
    if (d2 < best) best = d2;
  }
  return Math.sqrt(best);
}

/**
 * A point guaranteed to lie inside a polygon (centroids of L-shaped blocks
 * often do not): scan a few horizontal lines and take the middle of the widest
 * inside interval.
 */
export function interiorPoint(poly) {
  const { n0, n1 } = ringBBox(poly[0]);
  let best = null, bestW = -1;
  for (let k = 1; k <= 7; k++) {
    const n = lerp(n0, n1, k / 8);
    const xs = [];
    for (const ring of poly) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[j], b = ring[i];
        if ((a[1] > n) !== (b[1] > n)) xs.push(a[0] + ((n - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
      }
    }
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const w = xs[i + 1] - xs[i];
      if (w > bestW) { bestW = w; best = [(xs[i] + xs[i + 1]) / 2, n]; }
    }
  }
  return best || poly[0][0];
}

/** Drop the closing duplicate polygon-clipping adds to every ring. */
export function openRing(ring) {
  const r = ring.slice();
  if (r.length > 1 && samePoint(r[0], r[r.length - 1])) r.pop();
  return r;
}

export function closeRing(ring) {
  if (ring.length && samePoint(ring[0], ring[ring.length - 1])) return ring;
  return [...ring, ring[0]];
}

// --------------------------------------------------------------- buffering --

/** A quad around segment ab, `half` wide on each side, `ext` longer at both ends. */
export function segmentQuad(ax, an, bx, bn, half, ext = 0) {
  let dx = bx - ax, dn = bn - an;
  const l = Math.hypot(dx, dn) || 1;
  dx /= l; dn /= l;
  const lx = -dn * half, ln = dx * half;
  const sx = ax - dx * ext, sn = an - dn * ext;
  const ex = bx + dx * ext, en = bn + dn * ext;
  return [[sx - lx, sn - ln], [ex - lx, en - ln], [ex + lx, en + ln], [sx + lx, sn + ln], [sx - lx, sn - ln]];
}

export function circleRing(x, n, r, sides = 12) {
  const ring = [];
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    ring.push([x + Math.cos(a) * r, n + Math.sin(a) * r]);
  }
  ring.push(ring[0]);
  return ring;
}

/**
 * Buffer a polyline into a MultiPolygon: one quad per segment plus a disc at
 * every interior vertex so bends have no notch. Straight 2-point lines come out
 * as a plain rectangle, which is what nearly every street is.
 */
export function bufferPolyline(pts, half, ext = 0) {
  if (pts.length < 2) return [];
  const parts = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const e0 = i === 0 ? ext : 0.05;
    const e1 = i + 2 === pts.length ? ext : 0.05;
    const q = segmentQuad(a[0], a[1], b[0], b[1], half, 0);
    // Extend only the outer ends; interior joints get a disc instead.
    if (e0 || e1) {
      let dx = b[0] - a[0], dn = b[1] - a[1];
      const l = Math.hypot(dx, dn) || 1;
      dx /= l; dn /= l;
      q[0][0] -= dx * e0; q[0][1] -= dn * e0; q[3][0] -= dx * e0; q[3][1] -= dn * e0;
      q[1][0] += dx * e1; q[1][1] += dn * e1; q[2][0] += dx * e1; q[2][1] += dn * e1;
      q[4] = q[0];
    }
    parts.push([q]);
  }
  for (let i = 1; i + 1 < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], c = pts[i + 1];
    const turn = Math.abs(Math.atan2(
      (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]),
      (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1])));
    if (turn > 0.02) parts.push([circleRing(b[0], b[1], half, 16)]);
  }
  if (parts.length === 1) return parts;
  return pc.union(...parts);
}

/** Union that tolerates an empty list. */
export function unionAll(list) {
  const polys = list.filter((m) => m && m.length);
  if (!polys.length) return [];
  if (polys.length === 1) return polys[0];
  // polygon-clipping is fastest on balanced merges.
  let layer = polys;
  while (layer.length > 1) {
    const next = [];
    for (let i = 0; i < layer.length; i += 8) next.push(pc.union(...layer.slice(i, i + 8)));
    layer = next;
  }
  return layer[0];
}

/** Convex hull of [x, n] points (monotone chain), counter-clockwise. */
export function convexHull(points) {
  const P = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (P.length < 3) return P;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const p of P) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  for (let i = P.length - 1; i >= 0; i--) {
    const p = P[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** Keep only polygons of a MultiPolygon larger than `minArea`. */
export function dropSlivers(multi, minArea) {
  return multi.filter((p) => polygonArea(p) >= minArea);
}

// ------------------------------------------------------------ spatial hash --

/** A uniform grid of items with bounding boxes, for "what is near (x, n)". */
export class Grid {
  constructor(cell = 32) {
    this.cell = cell;
    this.map = new Map();
  }

  key(i, j) { return i * 73856093 ^ j * 19349663; }

  insert(item, x0, n0, x1, n1) {
    const c = this.cell;
    const i0 = Math.floor(x0 / c), i1 = Math.floor(x1 / c);
    const j0 = Math.floor(n0 / c), j1 = Math.floor(n1 / c);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const k = this.key(i, j);
        let b = this.map.get(k);
        if (!b) { b = []; this.map.set(k, b); }
        b.push(item);
      }
    }
  }

  /** Items whose cells touch the disc (x, n, r); may contain duplicates. */
  query(x, n, r, out = []) {
    out.length = 0;
    const c = this.cell;
    const i0 = Math.floor((x - r) / c), i1 = Math.floor((x + r) / c);
    const j0 = Math.floor((n - r) / c), j1 = Math.floor((n + r) / c);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const b = this.map.get(this.key(i, j));
        if (b) for (let k = 0; k < b.length; k++) out.push(b[k]);
      }
    }
    return out;
  }
}

// ------------------------------------------------------------------ random --

/** Deterministic hash → [0, 1). Same inputs, same city, every load. */
export function hash01(a, b = 0, c = 0) {
  let h = (a * 374761393 + b * 668265263 + c * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Small seeded generator (mulberry32). */
export function rng(seed) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** 2D value noise in [-1, 1], smooth, deterministic. */
export function noise2(x, n) {
  const i = Math.floor(x), j = Math.floor(n);
  const fx = x - i, fn = n - j;
  const u = fx * fx * (3 - 2 * fx), v = fn * fn * (3 - 2 * fn);
  const a = hash01(i, j), b = hash01(i + 1, j), c = hash01(i, j + 1), d = hash01(i + 1, j + 1);
  return (lerp(lerp(a, b, u), lerp(c, d, u), v)) * 2 - 1;
}
