// Cutting the real data to a zone (map/zones.js): roads to a polyline, surfaces
// to a multipolygon. A rectangle zone keeps the cheap code it always had; a
// drawn one is cut at its boundary, wherever that runs.

import * as G from './geom.js';

/** Pieces shorter than this (real metres) that a cut leaves are dropped: a stub cannot carry a barrier. */
const MIN_PIECE = 10;

/**
 * A road cut to the zone: the pieces of it inside, each with its edge data and
 * whether it was cut at either end (the map ends there, see structures.js).
 */
export function clipRoad(r, zone) {
  return zone.box ? clipRoadBox(r, zone.box) : clipRoadPoly(r, zone);
}

/** A multipolygon cut to the zone widened by `pad`; empty if it misses it. */
export function clipMulti(multi, zone, pad) {
  return zone.box ? clipToBox(multi, zone.box, pad) : clipToPoly(multi, zone, pad);
}

// ------------------------------------------------------------------- polygon --

function clipRoadPoly(r, zone) {
  const P = r.pts;
  let x0 = Infinity, n0 = Infinity, x1 = -Infinity, n1 = -Infinity;
  for (const p of P) {
    if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
    if (p[1] < n0) n0 = p[1]; if (p[1] > n1) n1 = p[1];
  }
  const whole = zone.boxState(x0, n0, x1, n1);
  if (whole === 0) return [];
  if (whole === 1) return [{ pts: P, levels: r.levels, flags: r.flags, cutStart: false, cutEnd: false, part: 0 }];
  const pieces = [];
  let cur = null;
  const flush = (cutEnd) => {
    if (!cur) return;
    cur.cutEnd = cutEnd;
    pieces.push(cur);
    cur = null;
  };
  const at = (a, b, t) => (t <= 0 ? a : t >= 1 ? b : [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  for (let i = 0; i + 1 < P.length; i++) {
    const a = P[i], b = P[i + 1];
    const state = zone.boxState(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1]));
    let ts = [0, 1];
    if (state === 0) { flush(true); continue; }
    if (state === 2) ts = crossings(a, b, zone.edges);
    for (let k = 0; k + 1 < ts.length; k++) {
      const ta = ts[k], tb = ts[k + 1];
      if (Math.hypot((b[0] - a[0]) * (tb - ta), (b[1] - a[1]) * (tb - ta)) < 0.05) continue;
      const m = at(a, b, (ta + tb) / 2);
      if (state === 2 && !zone.contains(m[0], m[1])) { flush(true); continue; }
      if (!cur) {
        cur = { pts: [at(a, b, ta)], levels: [], flags: [], cutStart: !(i === 0 && ta === 0), cutEnd: false, part: pieces.length };
      }
      cur.pts.push(at(a, b, tb));
      cur.levels.push(r.levels ? r.levels[i] : 0);
      cur.flags.push(r.flags ? r.flags[i] : 0);
    }
  }
  flush(false);
  return pieces.filter((p) => p.pts.length >= 2 && (!(p.cutStart || p.cutEnd) || length(p.pts) >= MIN_PIECE)).map((p) => ({
    ...p, levels: p.levels.some((v) => v) ? p.levels : null, flags: p.flags.some((v) => v) ? p.flags : null,
  }));
}

function length(pts) {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return s;
}

/** Parameters t in [0, 1] along a → b, sorted, at which it crosses an edge of the zone (ends included). */
function crossings(a, b, edges) {
  const ts = [0, 1];
  const dx = b[0] - a[0], dn = b[1] - a[1];
  const lx = Math.min(a[0], b[0]), hx = Math.max(a[0], b[0]), ln = Math.min(a[1], b[1]), hn = Math.max(a[1], b[1]);
  for (const e of edges) {
    if (Math.max(e[0], e[2]) < lx || Math.min(e[0], e[2]) > hx || Math.max(e[1], e[3]) < ln || Math.min(e[1], e[3]) > hn) continue;
    const ex = e[2] - e[0], en = e[3] - e[1];
    const den = dx * en - dn * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = ((e[0] - a[0]) * en - (e[1] - a[1]) * ex) / den;
    const u = ((e[0] - a[0]) * dn - (e[1] - a[1]) * dx) / den;
    if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t);
  }
  return ts.sort((p, q) => p - q);
}

function clipToPoly(multi, zone, pad) {
  const bb = multiBBox(multi);
  const [zx0, zn0, zx1, zn1] = zone.bbox;
  if (!bb || bb.x1 < zx0 - pad || bb.x0 > zx1 + pad || bb.n1 < zn0 - pad || bb.n0 > zn1 + pad) return [];
  if (pad <= 0 && zone.boxState(bb.x0, bb.n0, bb.x1, bb.n1) === 1) return multi;
  try {
    return G.pc.intersection(multi.map((poly) => poly.map(G.closeRing)), zone.grow(pad)).map((poly) => poly.map(G.openRing));
  } catch (e) {
    return pad > 0 || zone.boxState(bb.x0, bb.n0, bb.x1, bb.n1) ? multi : [];
  }
}

// ----------------------------------------------------------------- rectangle --

function clipRoadBox(r, box) {
  const [x0, n0, x1, n1] = box;
  const inside = (p) => p[0] >= x0 && p[0] <= x1 && p[1] >= n0 && p[1] <= n1;
  const P = r.pts;
  if (P.every(inside)) return [{ pts: P, levels: r.levels, flags: r.flags, cutStart: false, cutEnd: false, part: 0 }];
  const pieces = [];
  let cur = null;
  const lerpP = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  for (let i = 0; i + 1 < P.length; i++) {
    const a = P[i], b = P[i + 1];
    // Liang–Barsky: the part of edge ab inside the box.
    let t0 = 0, t1 = 1;
    const dx = b[0] - a[0], dn = b[1] - a[1];
    const clip = (p, q) => {
      if (p === 0) return q >= 0;
      const t = q / p;
      if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
      return true;
    };
    if (!(clip(-dx, a[0] - x0) && clip(dx, x1 - a[0]) && clip(-dn, a[1] - n0) && clip(dn, n1 - a[1]))) {
      if (cur) { pieces.push(cur); cur = null; }
      continue;
    }
    const pa = t0 > 0 ? lerpP(a, b, t0) : a, pb = t1 < 1 ? lerpP(a, b, t1) : b;
    if (!cur) cur = { pts: [pa], levels: [], flags: [], cutStart: t0 > 0 || i > 0 && !inside(a), cutEnd: false, part: pieces.length };
    cur.pts.push(pb);
    cur.levels.push(r.levels ? r.levels[i] : 0);
    cur.flags.push(r.flags ? r.flags[i] : 0);
    if (t1 < 1) { cur.cutEnd = true; pieces.push(cur); cur = null; }
  }
  if (cur) pieces.push(cur);
  return pieces.filter((p) => p.pts.length >= 2).map((p) => ({
    ...p, levels: p.levels.some((v) => v) ? p.levels : null, flags: p.flags.some((v) => v) ? p.flags : null,
  }));
}

/** A multipolygon cut to the box (grown by `pad`), empty if it misses it. */
function clipToBox(multi, box, pad) {
  const [x0, n0, x1, n1] = [box[0] - pad, box[1] - pad, box[2] + pad, box[3] + pad];
  const bb = multiBBox(multi);
  if (!bb || bb.x1 < x0 || bb.x0 > x1 || bb.n1 < n0 || bb.n0 > n1) return [];
  if (bb.x0 >= x0 && bb.x1 <= x1 && bb.n0 >= n0 && bb.n1 <= n1) return multi;
  const rect = [[[x0, n0], [x1, n0], [x1, n1], [x0, n1], [x0, n0]]];
  try {
    return G.pc.intersection(multi.map((poly) => poly.map(G.closeRing)), rect).map((poly) => poly.map(G.openRing));
  } catch (e) {
    return multi;
  }
}

function multiBBox(multi) {
  let bb = null;
  for (const poly of multi) {
    const b = G.ringBBox(poly[0]);
    bb = bb ? { x0: Math.min(bb.x0, b.x0), n0: Math.min(bb.n0, b.n0), x1: Math.max(bb.x1, b.x1), n1: Math.max(bb.n1, b.n1) } : b;
  }
  return bb;
}
