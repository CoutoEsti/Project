// The map for one zone at one scale, from the real data: the object compile()
// takes. Everything is cut to the zone and multiplied by the scale here, once,
// so nothing downstream ever needs to know either.
//
// What becomes what:
//   streets  every drivable way at ground level, draped on the relief: the
//            car drives on the ground there, the street is paint and kerbs
//   roads    what leaves the ground: motorways and their ramps whole, and the
//            bridges, tunnels and overpasses of ordinary streets with enough
//            approach on each side to climb or dive at a sane grade
//
// OpenStreetMap says *that* a way is a bridge on layer 1 or a tunnel on layer
// −2, never how high. Heights come from the layer (LEVEL_Y), measured from the
// ground under the abutments, and a grade limit spreads each change into
// ramps (see profile()).

import { ZONES } from './zones.js';
import { createTerrain } from './terrain.js';
import * as G from './geom.js';
import OVERLAY from './montreal.js';

/** Real metres above (below) the ground for an OSM layer. */
const LEVEL_Y = { 1: 7.6, 2: 14.2, 3: 20.8, 4: 27.4, [-1]: -8, [-2]: -13, [-3]: -18, [-4]: -22 };
const TUNNEL_Y = -8;
const GRADE = { highway: 0.05, ramp: 0.065, bridge: 0.05, road: 0.07 };

/** Street widths in real metres: [two-way, one-way]. */
const WIDTH = {
  motorway: [23, 12.4], trunk: [18, 9], primary: [19, 11], secondary: [15, 9.5], tertiary: [13, 8.5],
  residential: [11, 8], unclassified: [10, 7.5], living_street: [7, 6], pedestrian: [8, 8], alley: [5, 5],
};
const LINK_WIDTH = 6.8;

/** How a street is drawn and furnished (markings, lamps, trees). */
function streetClass(r, width) {
  if (r.kind === 'alley') return 'alley';
  if (r.cls === 'pedestrian') return 'plaza';
  if (r.cls === 'living_street') return 'narrow';
  if (r.cls === 'primary' || r.cls === 'trunk') return width >= 17 ? 'boulevard' : 'avenue';
  if (r.cls === 'secondary') return 'avenue';
  return 'street';
}

const PRIORITY = { motorway: 6, trunk: 5, primary: 4, secondary: 3, tertiary: 2, residential: 1 };

/**
 * @param src      loadSource() output
 * @param settings { zone, echelle }
 */
export function buildMap(src, settings) {
  const s = settings.echelle / 100;
  const zone = ZONES[settings.zone];
  const [bx0, bn0, bx1, bn1] = zone.box;
  const S = (v) => v * s;
  const P = (p) => [p[0] * s, p[1] * s];
  const inZone = (x, n, pad = 0) => x >= bx0 - pad && x <= bx1 + pad && n >= bn0 - pad && n <= bn1 + pad;

  // --- water first: the relief's zero is the river --------------------------
  const river = src.surfaces.water.reduce((a, w) => (!a || area(w.poly) > area(a.poly) ? w : a), null);
  const base = river ? river.level : 6;
  const terrain = createTerrain(src.relief, { scale: s, base });
  const water = [];
  for (const w of src.surfaces.water) {
    const clipped = clipToBox(w.poly, zone.box, 400);
    if (!clipped.length) continue;
    water.push({ name: w.name, kind: w.kind, level: (w.level - base) * s, poly: clipped.map((poly) => poly.map((r) => r.map(P))) });
  }
  const waterMulti = water.flatMap((w) => w.poly);
  const waterIndex = indexPolys(water.map((w) => ({ level: w.level, poly: w.poly })));
  const waterAt = (x, n) => {
    for (const it of waterIndex.query(x, n)) if (G.pointInMulti(x, n, it.poly)) return it;
    return null;
  };

  const greens = [], grounds = [];
  for (const [list, out] of [[src.surfaces.green, greens], [src.surfaces.ground, grounds]]) {
    for (const g of list) {
      const clipped = clipToBox(g.poly, zone.box, 0);
      if (!clipped.length) continue;
      out.push({ kind: g.kind, name: g.name, poly: clipped.map((poly) => poly.map((r) => r.map(P))) });
    }
  }

  // --- the road network --------------------------------------------------------
  const streets = [], roads = [];
  const special = OVERLAY.bridges || {};
  for (const r of src.roads) {
    // A motorway is one way unless tagged otherwise (OpenStreetMap's implied
    // rule); the data only says so when someone wrote it down.
    const oneway = r.oneway || r.cls === 'motorway';
    for (const piece of clipRoad(r, zone.box)) {
      const highway = r.cls === 'motorway' || (r.cls === 'trunk' && (r.kind === 'link' || /^Autoroute/.test(r.name)));
      const width = S(r.kind === 'link' && highway ? LINK_WIDTH : r.kind === 'alley' ? WIDTH.alley[0]
        : (WIDTH[r.cls] || WIDTH.residential)[oneway ? 1 : 0]);
      const pts = piece.pts.map(P);
      const edges = piece.pts.length - 1;
      const level = (i) => (piece.levels ? piece.levels[i] : 0);
      const flag = (i) => (piece.flags ? piece.flags[i] : 0);
      const wet = (i) => {
        const a = pts[i], b = pts[i + 1];
        return !!waterAt((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      };
      // Which edges leave the ground.
      const lifted = [];
      for (let i = 0; i < edges; i++) lifted.push(level(i) !== 0 || (flag(i) & 2) || ((flag(i) & 1) && wet(i)));
      const name = r.name;
      const common = { name, ref: r.ref, oneway, osm: r.id, a: r.a, b: r.b, cutStart: piece.cutStart, cutEnd: piece.cutEnd };
      if (highway || special[name]) {
        const loop = pts.length > 3 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 1;
        roads.push({
          ...common,
          loop,
          id: `r${r.id}${piece.part ? `-${piece.part}` : ''}`,
          cls: special[name] ? special[name].cls || 'bridge' : r.kind === 'link' ? 'ramp' : 'highway',
          lanes: Math.max(1, Math.round((width / s - 1.6) / 3.6)),
          width, median: false, pts, levels: piece.levels, flags: piece.flags, wet: lifted.map((_, i) => wet(i)),
          priority: (PRIORITY[r.cls] || 0) + (r.kind === 'link' ? 0 : 1),
          structure: special[name] ? special[name].structure : null,
        });
        continue;
      }
      // An ordinary street: only its lifted stretches, plus their approaches,
      // become roads; the rest is draped on the ground.
      const need = (i) => {
        const o = Math.abs(offsetOf(level(i), flag(i), false));
        return o > 0 ? o / GRADE.road + S(25) : S(30);
      };
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
      const spans = [];
      for (let i = 0; i < edges; i++) {
        if (!lifted[i]) continue;
        const reach = need(i);
        const s0 = cum[i] - reach, s1 = cum[i + 1] + reach;
        const last = spans[spans.length - 1];
        if (last && s0 <= last[1]) last[1] = Math.max(last[1], s1); else spans.push([s0, s1]);
      }
      const total = cum[cum.length - 1];
      let cursor = 0;
      const pushStreet = (a, b) => {
        if (b - a < S(4)) return;
        const sub = slice(pts, cum, a, b);
        if (sub.pts.length < 2) return;
        streets.push({ ...common, cls: streetClass(r, width / s), width, half: width / 2, path: sub.pts,
          rank: PRIORITY[r.cls] || 0 });
      };
      spans.forEach(([a, b], k) => {
        a = Math.max(0, a); b = Math.min(total, b);
        pushStreet(cursor, a);
        const sub = slice(pts, cum, a, b);
        // A bridge when it carries the street over water on a raised layer.
        const cls = sub.edges.some((i) => wet(i) && level(i) > 0) ? 'bridge' : 'road';
        roads.push({
          ...common,
          id: `s${r.id}-${k}${piece.part ? `-${piece.part}` : ''}`,
          cls,
          lanes: oneway ? 1 : 2, width, median: false,
          pts: sub.pts, levels: sub.edges.map(level), flags: sub.edges.map(flag), wet: sub.edges.map(wet),
          priority: PRIORITY[r.cls] || 0,
          street: true,
        });
        cursor = b;
      });
      pushStreet(cursor, total);
    }
  }

  // Heights of the roads, majors first so minor roads can meet them.
  roads.sort((a, b) => b.priority - a.priority);
  const done = [];
  for (const r of roads) {
    r.path = profile(r, terrain, waterAt, s, done, special[r.name]);
    done.push(r);
  }

  // --- buildings, trees, street furniture --------------------------------------
  const landmarkPlots = (OVERLAY.landmarks || []).filter((l) => inZone(l.x, l.n)).map((l) => ({ x: S(l.x), n: S(l.n), r: S(l.clear || 40) }));
  const buildings = [];
  for (const b of src.buildings) {
    const c = centroid(b.ring);
    if (!inZone(c[0], c[1])) continue;
    const ring = b.ring.map(P);
    const cx = c[0] * s, cn = c[1] * s;
    if (landmarkPlots.some((p) => Math.hypot(cx - p.x, cn - p.n) < p.r)) continue;
    buildings.push({ ...b, ring, cx, cn, h: S(b.h), minH: S(b.minH) });
  }
  const tx = [], tn = [];
  for (let k = 0; k < src.trees.count; k++) {
    const x = src.trees.xs[k], n = src.trees.ns[k];
    if (inZone(x, n)) { tx.push(x * s); tn.push(n * s); }
  }
  const furniture = src.furniture.filter((f) => inZone(f.x, f.n)).map((f) => ({ ...f, x: f.x * s, n: f.n * s }));
  // District names: the hand-placed ones, then the data's own; a data name
  // takes the style of the nearest hand-placed one.
  const curated = (OVERLAY.quartiers || []).map((q) => ({ ...q, type: 'neighborhood', x: q.x * s, n: q.n * s }));
  const styleNear = (x, n) => {
    let best = null, bd = Infinity;
    for (const q of curated) { const d = Math.hypot(q.x - x, q.n - n); if (d < bd) { bd = d; best = q; } }
    return best ? best.style : 'walkups';
  };
  const quartiers = curated.filter((q) => inZone(q.x / s, q.n / s, 800))
    .concat(src.quartiers.filter((q) => inZone(q.x, q.n, 800)).map((q) => ({ ...q, x: q.x * s, n: q.n * s, style: styleNear(q.x * s, q.n * s) })));

  // --- the hand-placed layer: landmarks, spawns, signs, races ---------------------
  const scalePt = (o) => ({ ...o, x: o.x * s, n: o.n * s, y: o.y !== undefined ? o.y * s : undefined });
  const landmarks = (OVERLAY.landmarks || []).filter((l) => inZone(l.x, l.n)).map(scalePt);
  const spawns = (OVERLAY.spawns || []).filter((p) => inZone(p.x, p.n)).map(scalePt);
  const signs = (OVERLAY.signs || []).filter((g) => inZone(g.at[0], g.at[1])).map((g) => ({ ...g, at: P(g.at) }));
  const races = (OVERLAY.races || []).filter((rc) => rc.points.every(([x, n]) => inZone(x, n)))
    .map((rc) => ({ ...rc, points: rc.points.map(P) }));

  const world = { x0: S(bx0), n0: S(bn0), x1: S(bx1), n1: S(bn1) };
  return {
    meta: { ...src.meta, zone: settings.zone, echelle: settings.echelle, nomZone: zone.nom },
    settings: { ...settings },
    scale: s,
    world,
    levels: { ground: 0, kerb: S(0.15), clearance: 5.0, deck: 1.2 },
    terrain,
    water, waterMulti, greens, grounds,
    streets, roads,
    buildings, trees: { xs: Float32Array.from(tx), ns: Float32Array.from(tn), count: tx.length }, furniture, quartiers, styleNear,
    landmarks, spawns, signs, races,
  };
}

// ------------------------------------------------------------------ profile --

function offsetOf(level, flag, highway = true) {
  // A street under an at-grade highway needs 5 m of headroom and a deck, not
  // the 8 m of a motorway trench.
  if (level === -1 && !highway) return -6.5;
  if (level) return LEVEL_Y[Math.max(-4, Math.min(4, level))];
  if (flag & 2) return TUNNEL_Y;
  return 0;
}

/**
 * Control points [x, n, y] for a road: the ground under it, the layers'
 * heights on the lifted stretches, and ramps between them no steeper than the
 * class allows. The ground under a bridge or a tunnel is read at its two ends
 * and interpolated — a bridge spans its gap, it does not dip into the river.
 */
function profile(r, terrain, waterAt, s, done, spec) {
  const src = densify(r.pts, r.levels, r.flags, r.wet, 12 * s);
  const { pts, lv, fl, wt } = src;
  const m = pts.length;
  const cum = [0];
  for (let i = 1; i < m; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  // Ground reference, spanning runs of bridge and tunnel edges.
  const g = pts.map(([x, n]) => {
    const w = waterAt(x, n);
    return w ? w.level : terrain.height(x, n);
  });
  const spans = (test) => {
    for (let i = 0; i < m - 1;) {
      if (!test(i)) { i++; continue; }
      let j = i;
      while (j < m - 1 && test(j)) j++;
      // Edges i..j-1 are in the run: vertices i..j.
      const ga = terrainAt(i), gb = terrainAt(j);
      for (let k = i + 1; k < j; k++) {
        const t = (cum[k] - cum[i]) / ((cum[j] - cum[i]) || 1);
        g[k] = ga + (gb - ga) * t;
      }
      i = j;
    }
  };
  function terrainAt(i) {
    const [x, n] = pts[i];
    return waterAt(x, n) ? g[i] : terrain.height(x, n);
  }
  spans((i) => (fl[i] & 1) || wt[i]);
  spans((i) => fl[i] & 2);

  // Hard targets on vertices touching a lifted edge.
  const target = new Array(m).fill(null);
  for (let i = 0; i < m - 1; i++) {
    // Headroom is for the car, which keeps its size: not scaled.
    const o = offsetOf(lv[i], fl[i], !r.street);
    const bridgeFlat = !o && ((fl[i] & 1) || wt[i]);
    if (!o && !bridgeFlat) continue;
    for (const k of [i, i + 1]) {
      const y = g[k] + (bridgeFlat ? 0.5 : o);
      if (target[k] === null || Math.abs(y - g[k]) > Math.abs(target[k] - g[k])) target[k] = y;
    }
  }
  if (spec && spec.peak) {
    // A named bridge with a known silhouette (Jacques-Cartier over the
    // river and Île Sainte-Hélène): a parabola from its first wet span to
    // its last, peaking at `peak` metres.
    let i0 = -1, i1 = -1;
    for (let i = 0; i < m - 1; i++) if (wt[i]) { if (i0 < 0) i0 = i; i1 = i + 1; }
    if (i0 >= 0) {
      for (let k = i0; k <= i1; k++) {
        const t = (cum[k] - cum[i0]) / ((cum[i1] - cum[i0]) || 1);
        const y = g[k] + spec.peak * s * (1 - (2 * t - 1) ** 2) + 8 * s;
        target[k] = Math.max(target[k] ?? -Infinity, y);
      }
    }
  }
  // Pin the ends onto a road already profiled, when they land on one — and
  // when it can be reached at all: a short ramp up to a deck forty metres
  // over the island cannot, and is closed off where it ends instead.
  const fixed = new Uint8Array(m);
  const grade0 = GRADE[r.cls] || GRADE.road;
  for (const k of [0, m - 1]) {
    const [x, n] = pts[k];
    let best = null;
    for (const o of done) {
      const hit = nearestOnPath(o.path, x, n, 1.2 * s + o.width / 2);
      if (hit && (!best || hit.d < best.d)) best = hit;
    }
    if (!best) continue;
    const other = k === 0 ? m - 1 : 0;
    const base = target[other] ?? g[other];
    if (Math.abs(best.y - base) > cum[m - 1] * grade0 * 1.6 + 1) {
      if (k === 0) r.cutStart = true; else r.cutEnd = true;
      r.closure = 'Fermé';
      continue;
    }
    target[k] = best.y; fixed[k] = 1;
  }

  const grade = GRADE[r.cls] || GRADE.road;
  const up = new Float64Array(m).fill(-Infinity), dn = new Float64Array(m).fill(Infinity);
  for (let i = 0; i < m; i++) {
    if (target[i] === null) continue;
    if (target[i] >= g[i]) up[i] = target[i]; else dn[i] = target[i];
  }
  for (let i = 1; i < m; i++) {
    const d = (cum[i] - cum[i - 1]) * grade;
    up[i] = Math.max(up[i], up[i - 1] - d);
    dn[i] = Math.min(dn[i], dn[i - 1] + d);
  }
  for (let i = m - 2; i >= 0; i--) {
    const d = (cum[i + 1] - cum[i]) * grade;
    up[i] = Math.max(up[i], up[i + 1] - d);
    dn[i] = Math.min(dn[i], dn[i + 1] + d);
  }
  const out = [];
  for (let i = 0; i < m; i++) {
    let y;
    if (target[i] !== null) y = target[i];
    else if (up[i] > g[i] && dn[i] < g[i]) y = up[i] - g[i] < g[i] - dn[i] ? up[i] : dn[i];
    else if (up[i] > g[i]) y = up[i];
    else if (dn[i] < g[i]) y = dn[i];
    else y = g[i];
    out.push([pts[i][0], pts[i][1], y]);
  }
  relax(out, cum, grade, fixed);
  r.edgeFlags = fl;
  r.edgeLevels = lv;
  r.cum = cum;
  return out;
}

/**
 * OpenStreetMap's layers are an order, not heights: a tunnel on layer −3 can
 * come out onto a viaduct on layer 3 a hundred metres on. Where the targets
 * cannot all be met within the grade, the grade wins: each too-steep step is
 * shared between its two ends until none is left, the ends landing on
 * another road staying put.
 */
function relax(out, cum, grade, fixed) {
  const m = out.length;
  const lim = grade * 1.02;
  for (let iter = 0; iter < 400; iter++) {
    let worst = 0;
    for (let i = 1; i < m; i++) {
      const ds = cum[i] - cum[i - 1];
      const d = out[i][2] - out[i - 1][2];
      const excess = Math.abs(d) - lim * ds;
      if (excess <= 1e-3) continue;
      worst = Math.max(worst, excess);
      const sgn = Math.sign(d);
      const a = fixed[i - 1], b = fixed[i];
      if (a && b) continue;
      const ka = b ? 1 : a ? 0 : 0.5;
      out[i - 1][2] += sgn * excess * ka;
      out[i][2] -= sgn * excess * (1 - ka);
    }
    if (worst < 0.01) break;
  }
}

/** Split long edges so heights have somewhere to change; edge data carried. */
function densify(pts, levels, flags, wet, maxLen) {
  const out = [pts[0]], lv = [], fl = [], wt = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const k = Math.max(1, Math.ceil(len / maxLen));
    for (let j = 1; j <= k; j++) {
      out.push([a[0] + ((b[0] - a[0]) * j) / k, a[1] + ((b[1] - a[1]) * j) / k]);
      lv.push(levels ? levels[i] : 0);
      fl.push(flags ? flags[i] : 0);
      wt.push(wet ? wet[i] : false);
    }
  }
  return { pts: out, lv, fl, wt };
}

function nearestOnPath(path, x, n, reach) {
  let best = null;
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i], b = path[i + 1];
    if (Math.min(a[0], b[0]) - reach > x || Math.max(a[0], b[0]) + reach < x) continue;
    if (Math.min(a[1], b[1]) - reach > n || Math.max(a[1], b[1]) + reach < n) continue;
    const { d2, t } = G.segDist2(x, n, a[0], a[1], b[0], b[1]);
    if (d2 <= reach * reach && (!best || d2 < best.d2)) best = { d2, d: Math.sqrt(d2), y: a[2] + (b[2] - a[2]) * t };
  }
  return best;
}

// ------------------------------------------------------------------- clipping --

/**
 * A road cut to the zone: the pieces of it inside the box, each with its
 * edge data and whether it was cut at either end (the map ends there).
 */
function clipRoad(r, box) {
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
  let bb = null;
  for (const poly of multi) {
    const b = G.ringBBox(poly[0]);
    bb = bb ? { x0: Math.min(bb.x0, b.x0), n0: Math.min(bb.n0, b.n0), x1: Math.max(bb.x1, b.x1), n1: Math.max(bb.n1, b.n1) } : b;
  }
  if (!bb || bb.x1 < x0 || bb.x0 > x1 || bb.n1 < n0 || bb.n0 > n1) return [];
  if (bb.x0 >= x0 && bb.x1 <= x1 && bb.n0 >= n0 && bb.n1 <= n1) return multi;
  const rect = [[[x0, n0], [x1, n0], [x1, n1], [x0, n1], [x0, n0]]];
  try {
    return G.pc.intersection(multi.map((poly) => poly.map(G.closeRing)), rect).map((poly) => poly.map(G.openRing));
  } catch (e) {
    return multi;
  }
}

/** A slice of a polyline by arc length [a, b]; `edges`: source edge of each new edge. */
function slice(pts, cum, a, b) {
  const out = [], edges = [];
  const at = (d) => {
    let i = 0;
    while (i < cum.length - 2 && cum[i + 1] < d) i++;
    const t = (d - cum[i]) / ((cum[i + 1] - cum[i]) || 1);
    return { i, p: [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t] };
  };
  const A = at(a), B = at(b);
  out.push(A.p);
  for (let i = A.i + 1; i <= B.i; i++) { out.push(pts[i]); edges.push(i - 1); }
  out.push(B.p);
  edges.push(B.i);
  // Collapse zero-length edges at the ends.
  const P = [out[0]], E = [];
  for (let k = 1; k < out.length; k++) {
    if (Math.hypot(out[k][0] - P[P.length - 1][0], out[k][1] - P[P.length - 1][1]) < 0.05) continue;
    P.push(out[k]);
    E.push(edges[k - 1]);
  }
  return { pts: P, edges: E };
}

// ------------------------------------------------------------------- helpers --

function area(multi) {
  let a = 0;
  for (const poly of multi) a += Math.abs(G.ringArea(poly[0]));
  return a;
}

function centroid(ring) {
  let x = 0, n = 0;
  for (const p of ring) { x += p[0]; n += p[1]; }
  return [x / ring.length, n / ring.length];
}

function indexPolys(items) {
  const grid = new G.Grid(200);
  for (const it of items) {
    for (const poly of it.poly) {
      const b = G.ringBBox(poly[0]);
      grid.insert({ ...it, poly: [poly] }, b.x0, b.n0, b.x1, b.n1);
    }
  }
  const tmp = [];
  return { query: (x, n) => grid.query(x, n, 0, tmp) };
}
