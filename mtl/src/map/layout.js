// The map compiled: from buildMap()'s output (map/real.js) to everything the
// world, the physics, the plan and the export need. Pure logic, no three.js.
//
// The ground is Montréal's relief everywhere (map/terrain.js). Streets lie on
// it; roads carry their own heights. Then, in order:
//   1. roads are sampled every 2 m, their profiles rounded into vertical curves,
//      and roads that meet are made to agree where they overlap;
//   2. every road sample learns the ground under it, whether it runs in a
//      tunnel, and whether a street passes over it (a cover);
//   3. sunken roads open holes in the ground — except under those covers and
//      in tunnels.
// Walls, barriers, pillars and ceilings are then *inferred* from what lies on
// either side of each road (see structures.js); none of them is authored.

import * as G from './geom.js';
import { createRoadIndex } from './query.js';

export const SPACING = 2;         // metres between road samples

// Per-class construction rules. `smooth` is the vertical-curve radius in
// metres; `deck` the structural depth under the running surface.
export const ROAD_CLASS = {
  highway: { smooth: 30, barriers: true, pillar: 34, column: 2.4, deck: 1.6, maxGrade: 0.065 },
  ramp: { smooth: 14, barriers: true, pillar: 26, column: 1.6, deck: 1.2, maxGrade: 0.075 },
  bridge: { smooth: 20, barriers: true, pillar: 45, column: 2.2, deck: 1.6, maxGrade: 0.065 },
  road: { smooth: 10, barriers: false, pillar: 30, column: 1.4, deck: 1.0, maxGrade: 0.08 },
  circuit: { smooth: 0, barriers: false, pillar: 30, column: 1.4, deck: 1.0, maxGrade: 0.05 },
};

const SUNKEN = -0.12;             // below the ground by this much, a road needs a hole
const COVER_DEPTH = -1.0;         // a street only covers a road deeper than this
const TUNNEL_DEPTH = -5.0;        // a tunnel needs this much ground over the road

export function compile(map) {
  const T = {};
  const t0 = now();
  const terrain = map.terrain;

  // --- water: polygons with their level, for "what is at (x, n)" ------------------
  const waterGrid = new G.Grid(128);
  for (const w of map.water) {
    for (const poly of w.poly) {
      const b = G.ringBBox(poly[0]);
      waterGrid.insert({ poly, level: w.level, name: w.name, bb: b }, b.x0, b.n0, b.x1, b.n1);
    }
  }
  const wtmp = [];
  const waterAt = (x, n) => {
    for (const it of waterGrid.query(x, n, 0, wtmp)) {
      const b = it.bb;
      if (x < b.x0 || x > b.x1 || n < b.n0 || n > b.n1) continue;
      if (G.pointInPolygon(x, n, it.poly)) return it;
    }
    return null;
  };
  const groundAt = (x, n) => {
    const w = waterAt(x, n);
    return w ? w.level : terrain.height(x, n);
  };

  // --- 1. roads ------------------------------------------------------------
  const lap = (k, t) => { T[k] = Math.round(now() - t); return now(); };
  let tl = now();
  const roads = map.roads.map((r) => sampleRoad(r));
  const roadGrid = indexRoads(roads);
  tl = lap('sample', tl);
  pinJunctions(roads, roadGrid);
  taperJunctions(roads);
  tl = lap('pin', tl);
  separateCrossings(roads);
  levelTwins(roads);
  tl = lap('cross', tl);
  settleEnds(roads, map.streets, terrain);
  relaxSamples(roads);
  // Relaxing each carriageway on its own lets the twins drift apart again.
  for (const r of levelTwins(roads)) relaxRoad(r, r.hard || new Set());
  bindSideJoins(roads);
  tl = lap('relax', tl);
  carve(terrain, roads);
  tl = lap('carve', tl);
  T.roads = now() - t0;

  // --- 2. streets ------------------------------------------------------------
  const t1 = now();
  const streets = map.streets.map((st, i) => ({ ...st, index: i, half: st.width / 2 }));
  const streetGrid = new G.Grid(48);
  for (const st of streets) {
    for (let i = 0; i + 1 < st.path.length; i++) {
      const a = st.path[i], b = st.path[i + 1];
      const r = st.half + 1;
      streetGrid.insert({ st, a, b }, Math.min(a[0], b[0]) - r, Math.min(a[1], b[1]) - r,
        Math.max(a[0], b[0]) + r, Math.max(a[1], b[1]) + r);
    }
  }
  const stTmp = [];
  const streetsAt = (x, n, pad = 0, out = []) => {
    out.length = 0;
    for (const c of streetGrid.query(x, n, 0, stTmp)) {
      const { d2 } = G.segDist2(x, n, c.a[0], c.a[1], c.b[0], c.b[1]);
      const r = c.st.half + pad;
      if (d2 <= r * r && !out.includes(c.st)) out.push(c.st);
    }
    return out;
  };

  tl = now();
  meetStreets(terrain, roads, streetsAt);
  tl = lap('meet', tl);

  // --- 3. ground, tunnels, covers, holes ---------------------------------------
  liftFeet(terrain, roads, streetsAt);
  const coverers = new Set();
  const tmp = [];
  for (const r of roads) {
    for (const p of r.samples) {
      p.gs = terrain.height(p.x, p.n);          // the ground surface, even over a trench
      // A tunnel only where there is room for one: near a portal the grade
      // limit can bring the road within a car's height of the ground, and
      // that stretch is an open trench.
      if (p.tunnel && p.y - p.gs > TUNNEL_DEPTH) p.tunnel = false;
      if (p.tunnel) { p.covered = true; continue; }
      if (p.y - p.gs > COVER_DEPTH) continue;
      for (const st of streetsAt(p.x, p.n, 0, tmp)) {
        p.covered = true;
        p.coverBy = st.index;
        coverers.add(st);
      }
    }
  }
  // Where a ramp comes down onto a street (map/junctions.js streetLandings),
  // its deck stops at the street's edge and the street carries it the rest of
  // the way: no trench may open inside that street, however shallow the
  // ramp's foot. Outside the street the ramp is drawn as ever.
  const landings = [];
  for (const r of roads) {
    if (r.loop) continue;
    const S = r.samples;
    for (const end of ['start', 'end']) {
      if ((r.junctions || []).some((j) => j.end === end)) continue;
      const k0 = end === 'start' ? 0 : S.length - 1, dir = end === 'start' ? 1 : -1;
      const run = [], on = new Set();
      for (let k = k0; k >= 0 && k < S.length; k += dir) {
        const p = S[k];
        if (Math.abs(p.y - p.gs) > 1) break;
        const here = streetsAt(p.x, p.n, 0, tmp).filter((st) => st.cls !== 'plaza');
        if (!here.length) break;
        for (const st of here) on.add(st);
        run.push([p.x, p.n]);
      }
      if (!on.size) continue;
      if (run.length === 1) run.push([run[0][0] + S[k0].tx * dir, run[0][1] + S[k0].tn * dir]);
      try {
        const local = G.bufferPolyline(run, r.half + 1, r.half + 1);
        // Only the stretch of each street near the landing: buffering whole
        // streets costs more than all the rest of the trenches.
        const bb = G.ringBBox(run), pad = r.half + 1;
        const foot = G.unionAll([...on].flatMap((st) => nearRuns(st.path, bb.x0 - pad - st.half, bb.n0 - pad - st.half, bb.x1 + pad + st.half, bb.n1 + pad + st.half)
          .map((pts) => G.bufferPolyline(pts, st.half, 0))));
        const part = G.pc.intersection(local, foot);
        if (part.length) landings.push(part);
      } catch (e) { /* the trench stays as it was */ }
    }
  }
  const sunken = [], tunnels = [];
  // Under a street, a trench opens no wider than its road: the half metre left
  // around it elsewhere, so the ground stops short of the walls, would be a
  // strip of void across the street where it meets or crosses the road.
  const margin = (r, p) => (streetsAt(p.x, p.n, r.half + 0.5, tmp).some((st) => st.cls !== 'plaza') ? 0 : 0.5);
  for (const r of roads) {
    sunken.push(...runs(r, (p) => p.y - p.gs < SUNKEN && !p.tunnel, (p) => margin(r, p)));
    tunnels.push(...runs(r, (p) => p.tunnel, () => 0.5));
  }
  let holes = G.unionAll(sunken);
  if (landings.length && holes.length) holes = G.pc.difference(holes, ...landings);
  if (coverers.size && holes.length) {
    holes = G.pc.difference(holes, ...[...coverers].map((st) => G.bufferPolyline(st.path, st.half, 0)));
  }
  if (tunnels.length && holes.length) holes = G.pc.difference(holes, G.unionAll(tunnels));
  holes = G.dropSlivers(holes, 4);
  T.streets = now() - t1;
  T.total = now() - t0;

  const layout = {
    map, terrain, roads, streets, streetsAt, holes,
    water: map.waterMulti, waterBodies: map.water, waterAt, groundAt,
    greens: map.greens, grounds: map.grounds, quartiers: map.quartiers,
    timings: T,
  };
  layout.roadById = Object.fromEntries(roads.map((r) => [r.id, r]));
  return layout;
}

/** How far under the ribbons a joint is drawn: it only shows where they leave a gap. */
export const JOINT_SINK = 0.03;

/**
 * Where two ways meet end to end at an angle — a carriageway split by the
 * data on a bend, a fork where the way before and both branches end on the
 * same node — each ribbon ends square and the corners on the outside of the
 * bend leave a wedge of bare ground (or of sky, on a viaduct). A joint is the
 * convex hull of those end sections, EasyRoads3D's connector reduced to its
 * essence, drawn a hair under the ribbons so that only the wedges show.
 * Ends joined at the side of a carriageway are left out: map/junctions.js
 * builds their taper (`joins`, junctionPatches()).
 *
 * @returns [{ ring: [[x, n, y]], x, n, y, roads }] — a fan from (x, n, y)
 */
export function findJoints(roads, joins = []) {
  const tapered = new Set(joins.map((j) => `${j.road}:${j.end}`));
  const ends = [];
  for (const r of roads) {
    if (r.loop || r.samples.length < 3) continue;
    const S = r.samples;
    for (const [end, k, q] of [['start', 0, 1], ['end', S.length - 1, S.length - 2]]) {
      if (tapered.has(`${r.id}:${end}`)) continue;
      ends.push({ r, p: S[k], q: S[q] });
    }
  }
  const grid = new G.Grid(16);
  for (const e of ends) grid.insert(e, e.p.x - 1, e.p.n - 1, e.p.x + 1, e.p.n + 1);
  const seen = new Set(), tmp = [], out = [];
  for (const e of ends) {
    if (seen.has(e)) continue;
    const group = [], stack = [e];
    seen.add(e);
    while (stack.length) {
      const a = stack.pop();
      group.push(a);
      for (const b of grid.query(a.p.x, a.p.n, 0, tmp).slice()) {
        if (seen.has(b) || Math.hypot(b.p.x - a.p.x, b.p.n - a.p.n) > 1.5 || Math.abs(b.p.y - a.p.y) > 0.5) continue;
        seen.add(b);
        stack.push(b);
      }
    }
    if (group.length < 2) continue;
    const pts = [];
    for (const { r, p, q } of group) {
      for (const s of [p, q]) {
        const h = s.h ?? r.half;
        pts.push([s.x + s.lx * h, s.n + s.ln * h, s.y], [s.x - s.lx * h, s.n - s.ln * h, s.y]);
      }
    }
    const ring = G.convexHull(pts);
    if (ring.length < 3) continue;
    // Each corner keeps its ribbon's height; the centre takes the mean.
    let cx = 0, cn = 0, cy = 0;
    for (const [x, n, y] of ring) { cx += x; cn += n; cy += y; }
    const k = ring.length;
    out.push({ ring: ring.map(([x, n, y]) => [x, n, y - JOINT_SINK]), x: cx / k, n: cn / k, y: cy / k - JOINT_SINK,
      roads: group.map((g) => g.r.id) });
  }
  return out;
}

/** Height of a joint's fan at (x, n), or null outside it. */
export function jointHeight(j, x, n) {
  const R = j.ring;
  for (let k = 0; k < R.length; k++) {
    const a = R[k], b = R[(k + 1) % R.length];
    // Barycentric coordinates in the triangle (centre, a, b).
    const d = (a[1] - b[1]) * (j.x - b[0]) + (b[0] - a[0]) * (j.n - b[1]);
    if (Math.abs(d) < 1e-9) continue;
    const w0 = ((a[1] - b[1]) * (x - b[0]) + (b[0] - a[0]) * (n - b[1])) / d;
    const w1 = ((b[1] - j.n) * (x - b[0]) + (j.x - b[0]) * (n - b[1])) / d;
    const w2 = 1 - w0 - w1;
    if (w0 >= -1e-6 && w1 >= -1e-6 && w2 >= -1e-6) return w0 * j.y + w1 * a[2] + w2 * b[2];
  }
  return null;
}

// ---------------------------------------------------------------- roads --

export function sampleRoad(road) {
  const cls = ROAD_CLASS[road.cls] || ROAD_CLASS.road;
  const closed = !!road.loop;
  const ctrl = road.path;
  const samples = G.spline(ctrl, SPACING, closed);
  let s = 0;
  for (let i = 0; i < samples.length; i++) {
    if (i) s += Math.hypot(samples[i].x - samples[i - 1].x, samples[i].n - samples[i - 1].n);
    samples[i].s = s;
  }
  G.frames(samples, closed);

  // Heights live on the control points; carry them along by arc length within
  // each control segment, then round the grade breaks.
  const yc = ctrl.map((p) => (p.length > 2 ? p[2] : 0));
  if (closed && yc.length) yc.push(yc[0]);
  const segStart = [], segEnd = [];
  for (const p of samples) {
    if (segStart[p.seg] === undefined) segStart[p.seg] = p.s;
    segEnd[p.seg] = p.s;
  }
  let ys = samples.map((p) => {
    const a = segStart[p.seg], b = segEnd[p.seg];
    const u = b > a ? (p.s - a) / (b - a) : 0;
    return G.lerp(yc[p.seg], yc[Math.min(yc.length - 1, p.seg + 1)], G.clamp(u, 0, 1));
  });
  const radius = Math.round(cls.smooth / SPACING);
  if (radius > 0) ys = G.smooth(ys, radius);
  const flags = road.edgeFlags || [];
  for (let i = 0; i < samples.length; i++) {
    samples[i].y = ys[i];
    samples[i].i = i;
    if ((flags[samples[i].seg] || 0) & 2) samples[i].tunnel = true;
  }

  // Named stretches for the HUD: each starts at the sample nearest its point.
  let stretches = [];
  if (road.stretches) {
    stretches = road.stretches
      .map((st) => ({ ...st, start: nearestIndex(samples, st.from) }))
      .sort((a, b) => a.start - b.start);
  }

  return {
    ...road,
    cls: road.cls,
    rules: cls,
    loop: closed,
    closedStart: !!road.cutStart,
    closedEnd: !!road.cutEnd,
    half: road.width / 2,
    samples,
    length: samples.length ? samples[samples.length - 1].s : 0,
    stretches,
  };
}

/** Name and route number of the stretch a sample index falls in. */
export function stretchAt(road, i) {
  let name = road.name, ref = road.ref || null;
  for (const st of road.stretches || []) {
    if (st.start <= i) { name = st.name; ref = st.ref; } else break;
  }
  return { name, ref };
}

function indexRoads(roads) {
  const grid = new G.Grid(32);
  for (const r of roads) {
    const S = r.samples;
    for (let i = 0; i + 1 < S.length; i += 4) {
      const a = S[i], b = S[Math.min(S.length - 1, i + 4)], h = r.half + 2;
      grid.insert(r, Math.min(a.x, b.x) - h, Math.min(a.n, b.n) - h, Math.max(a.x, b.x) + h, Math.max(a.n, b.n) + h);
    }
  }
  return grid;
}

/**
 * Two roads meeting — a ramp leaving a carriageway, a carriageway split in
 * two by the data — were profiled separately and disagree by a few
 * centimetres where they overlap. Inside the major road's footprint the minor
 * one takes its height sample by sample; beyond it the correction fades over
 * 60 m. The major road is the one with the higher priority, then the longer.
 */
/** Whether a projection fell past either end of a road. */
function beyondEnd(road, hit) {
  const S = road.samples;
  if (road.loop) return false;
  const past = (hit.i === 0 && hit.t <= 0) || (hit.i === S.length - 2 && hit.t >= 1);
  return past && hit.d > 0.5;
}

/**
 * A road that carries on from the end of a wider or narrower one — a
 * carriageway forking into two ramps, a motorway losing a lane — would meet
 * it with a step at each edge. Its width runs from the other's to its own
 * over a taper instead (EasyRoads3D's "I connector"); at a fork, the branch
 * that leaves by the side joins that taper (map/junctions.js), so the two
 * branches share the wide end between them. Every sample carries its own
 * half-width `h` from here on.
 */
function taperJunctions(roads) {
  const byId = new Map(roads.map((r) => [r.id, r]));
  for (const r of roads) {
    for (const p of r.samples) p.h = r.half;
    for (const j of r.junctions || []) {
      if (!j.through) continue;
      const m = byId.get(j.major);
      const dh = m.half - r.half;
      if (Math.abs(dh) < 0.3) continue;
      const len = Math.max(30, Math.abs(dh) * 12);
      const s0 = j.end === 'start' ? 0 : r.length;
      for (const p of r.samples) {
        const u = Math.abs(p.s - s0) / len;
        if (u < 1) p.h = r.half + dh * (1 - G.smoothstep(0, 1, u));
      }
    }
    let max = r.half;
    for (const p of r.samples) if (p.h > max) max = p.h;
    r.maxHalf = max;
  }
}

function pinJunctions(roads, grid) {
  const tmp = [];
  const rank = (r) => (r.priority || 0) * 1e6 + r.length;
  const FADE = 60;
  // Majors first: a ramp takes the height its carriageway ends up with.
  for (const r of [...roads].sort((a, b) => rank(b) - rank(a))) {
    if (r.loop) continue;
    r.junctions = [];
    const S = r.samples;
    const pinned = new Map();          // sample index → height
    const hard = new Set();            // samples standing on the other road
    const edges = [];                  // { k, s, delta, dir }
    for (const end of [0, S.length - 1]) {
      const p = S[end];
      // Every higher road the end lands on: at a fork the way before and the
      // other branch both hold it, and it follows whichever is nearest until
      // it is clear of them all.
      const majors = [];
      for (const o of grid.query(p.x, p.n, 0, tmp)) {
        if (o === r || rank(o) < rank(r) || majors.includes(o)) continue;
        const hit = projectOnRoad(o, p.x, p.n);
        if (!hit || hit.d > o.half + r.half * 0.5) continue;
        if (Math.abs(hit.y - p.y) > 3) continue;       // one passes over the other
        majors.push(o);
      }
      if (!majors.length) continue;
      const dir = end === 0 ? 1 : -1;
      let k = end, lastDelta = 0, inside = 0, sTrim = p.s, major = majors[0];
      const near = [];
      for (; k >= 0 && k < S.length; k += dir) {
        const q = S[k];
        // Any higher road it still overlaps holds it too: a ramp leaving one
        // tunnel bore runs over the other before it can climb.
        for (const o of grid.query(q.x, q.n, 0, tmp)) {
          if (o !== r && !majors.includes(o) && !near.includes(o) && rank(o) >= rank(r)) near.push(o);
        }
        let best = null;
        for (const o of [...majors, ...near]) {
          const hit = projectOnRoad(o, q.x, q.n);
          if (!hit || hit.d > o.half + r.half - 0.5) continue;
          if (!majors.includes(o) && Math.abs(hit.y - q.y) > 3) continue;
          if (!best || hit.d < best.hit.d) best = { o, hit };
        }
        if (!best) break;
        if (best.hit.d <= best.o.half) { sTrim = q.s; major = best.o; hard.add(k); }
        lastDelta = best.hit.y - q.y;
        pinned.set(k, pinned.has(k) ? (pinned.get(k) + best.hit.y) / 2 : best.hit.y);
        inside++;
      }
      const kk = Math.max(0, Math.min(S.length - 1, k));
      edges.push({ k: kk, s: S[kk].s, delta: lastDelta, dir });
      // A little way in: does it carry on from the major road's end (a
      // carriageway cut in two by the data, one branch of a fork) or leave
      // its side (a ramp)? Carried on, it is drawn whole — trimmed, it left
      // a gap as wide as the major road.
      const q6 = S[Math.max(0, Math.min(S.length - 1, end + dir * 6))];
      const on = projectOnRoad(major, q6.x, q6.n);
      const through = !on || beyondEnd(major, on);
      r.junctions.push({ end: end === 0 ? 'start' : 'end', major: major.id, sEdge: S[kk].s, sTrim, samples: inside, through });
    }
    if (!edges.length) continue;
    // Ease the rest of the road onto the pinned stretches: over 60 m from
    // each, or straight across when the two ends are closer than that.
    const both = edges.length === 2 && edges[0].dir > 0 && edges[1].dir < 0 && edges[1].s - edges[0].s < FADE * 2;
    const add = new Float64Array(S.length);
    if (both) {
      const [A, B] = edges;
      for (let i = A.k; i <= B.k; i++) {
        const t = B.s - A.s > 1e-3 ? G.smoothstep(A.s, B.s, S[i].s) : 0.5;
        add[i] = A.delta + (B.delta - A.delta) * t;
      }
    } else {
      for (const e of edges) {
        for (let j = e.k; j >= 0 && j < S.length; j += e.dir) {
          const w = 1 - G.smoothstep(0, FADE, Math.abs(S[j].s - e.s));
          if (w <= 0) break;
          add[j] += e.delta * w;
        }
      }
    }
    for (let i = 0; i < S.length; i++) S[i].y = pinned.has(i) ? pinned.get(i) : S[i].y + add[i];
    r.hard = hard;
  }
}

/**
 * Last pass over every profile: pins, crossings and settled ends each bent
 * it for a good reason, and together they can leave a step. Any stretch
 * steeper than the class allows is shared out between its two ends, except
 * where the road stands on another one (it must keep that one's height).
 */
/**
 * A ramp is one slab with its carriageway until its inner edge pulls clear —
 * the nose. Relaxing each road on its own lets the two drift apart there (at
 * a fork where one branch climbs and the other dives, by a metre), and a ramp
 * standing half on another road at another height is neither one surface nor
 * two. So, majors first, the ramp takes its carriageway's height again up to
 * the nose and eases back to its own over 40 m. A ramp that parts by more
 * than 1.5 m before its nose is climbing away over the shoulder: left alone.
 */
function bindSideJoins(roads) {
  const byId = new Map(roads.map((r) => [r.id, r]));
  const rank = (r) => (r.priority || 0) * 1e6 + r.length;
  for (const r of [...roads].sort((a, b) => rank(b) - rank(a))) {
    for (const j of r.junctions || []) {
      const M = byId.get(j.major);
      if (j.through || !M || r.street || M.street) continue;
      const S = r.samples, dir = j.end === 'start' ? 1 : -1;
      const set = [];
      for (let k = dir > 0 ? 0 : S.length - 1; k >= 0 && k < S.length; k += dir) {
        const p = S[k];
        const hit = projectOnRoad(M, p.x, p.n);
        if (!hit) break;
        const a = M.samples[hit.i], b = M.samples[Math.min(M.samples.length - 1, hit.i + 1)];
        const hM = G.lerp(a.h ?? M.half, b.h ?? M.half, hit.t);
        if (hit.d >= hM + (p.h ?? r.half)) break;
        set.push([k, hit.y]);
      }
      if (!set.length || set.some(([k, y]) => Math.abs(S[k].y - y) > 1.5)) continue;
      for (const [k, y] of set) S[k].y = y;
      // Past the nose, close the step this left and fade the correction out.
      const kl = set[set.length - 1][0], next = S[kl + dir];
      if (!next) continue;
      const step = S[kl].y - next.y;
      for (let k = kl + dir; k >= 0 && k < S.length; k += dir) {
        const w = 1 - G.smoothstep(0, 40, Math.abs(S[k].s - S[kl].s));
        if (w <= 0) break;
        S[k].y += step * w;
      }
      // Then back within the class's grade, the bound stretch held.
      relaxRoad(r, new Set([...(r.hard || []), ...set.map(([k]) => k)]));
    }
  }
}

function relaxSamples(roads) {
  for (const r of roads) {
    relaxRoad(r, r.hard || new Set());
    // Standing on two roads whose heights no grade can join (a street
    // crossing a highway deep in its trench right beside a ramp still on
    // its way down): let go of them rather than keep a wall in the asphalt.
    if (r.hard && r.hard.size && steepest(r) > (r.maxGrade || r.rules.maxGrade) * 2) relaxRoad(r, new Set());
  }
}

function steepest(r) {
  const S = r.samples;
  let worst = 0;
  for (let i = 1; i < S.length; i++) worst = Math.max(worst, Math.abs(S[i].y - S[i - 1].y) / Math.max(0.1, S[i].s - S[i - 1].s));
  return worst;
}

function relaxRoad(r, hard) {
  {
    const S = r.samples;
    const lim = r.maxGrade || r.rules.maxGrade;
    for (let iter = 0; iter < 3000; iter++) {
      let worst = 0;
      for (let i = 1; i < S.length; i++) {
        const ds = Math.max(0.1, S[i].s - S[i - 1].s);
        const d = S[i].y - S[i - 1].y;
        const excess = Math.abs(d) - lim * ds;
        if (excess <= 1e-3) continue;
        let a = hard.has(i - 1), b = hard.has(i);
        // Standing on two roads that disagree: a step either way, so share
        // it rather than keep a wall in the asphalt.
        if (a && b) { if (excess < 0.05) continue; a = b = false; }
        worst = Math.max(worst, excess);
        const ka = b ? 1 : a ? 0 : 0.5;
        const sgn = Math.sign(d);
        S[i - 1].y += sgn * excess * ka;
        S[i].y -= sgn * excess * (1 - ka);
      }
      if (worst < 0.005) break;
    }
  }
}

/**
 * Two roads crossing with too little between them — OpenStreetMap's layers
 * say which is on top, not by how much, and the grade limit can eat the
 * difference. The minor road gives way: within a few metres of the major it
 * comes down (or up) to meet it, a crossing at grade; otherwise it is pushed
 * a full headroom clear, over or under, and eased back on either side.
 */
const HEADROOM = 6.2;
function separateCrossings(roads) {
  const index = createRoadIndex(roads);
  const rank = (r) => (r.priority || 0) * 1e6 + r.length;
  const tmp = [];
  for (const r of [...roads].sort((a, b) => rank(b) - rank(a))) {
    const S = r.samples;
    const maxGrade = r.rules.maxGrade * 0.9;
    const shifts = [];
    // Runs of samples inside a higher road's footprint, crossing it rather
    // than running along it.
    const open = new Map();
    const close = (o) => {
      const run = open.get(o);
      open.delete(o);
      const dy = run.dy / run.k;
      if (Math.abs(dy) > 0.45 && Math.abs(dy) < HEADROOM) {
        // A piece of street meets a road at grade only where the data joins
        // them; otherwise it passes over or under. Upper Lachine's two
        // carriageways crossed the same Turcot ramp 2.40 and 2.55 m above it:
        // one came down onto it, the other went over, side by side.
        const atGrade = Math.abs(dy) < 2.5 && (!r.street || joined(r, o, run));
        const delta = atGrade ? -dy : (dy < 0 ? -1 : 1) * HEADROOM - dy;
        shifts.push({ s0: run.s0, s1: run.s1, delta });
        // Crossing at grade: those samples stand on the major road.
        if (atGrade) for (const i of run.idx) (r.hard ||= new Set()).add(i);
      }
    };
    for (const p of S) {
      const seen = new Set();
      for (const h of index.surfacesAt(p.x, p.n, 0.5, tmp)) {
        const o = h.road;
        if (o === r || rank(o) < rank(r)) continue;
        const q = o.samples[h.i];
        if (Math.abs(p.tx * q.tn - p.tn * q.tx) <= 0.35) continue;
        seen.add(o);
        let run = open.get(o);
        if (!run) { run = { s0: p.s, s1: p.s, dy: 0, k: 0, idx: [] }; open.set(o, run); }
        run.s1 = p.s;
        run.dy += p.y - h.y;
        run.k++;
        run.idx.push(p.i);
        run.x = p.x; run.n = p.n;
      }
      for (const o of [...open.keys()]) if (!seen.has(o)) close(o);
    }
    for (const o of [...open.keys()]) close(o);
    if (!shifts.length) continue;
    const add = new Float64Array(S.length);
    for (const sh of shifts) {
      const ease = Math.abs(sh.delta) / maxGrade;
      for (let i = 0; i < S.length; i++) {
        const p = S[i];
        const d = p.s < sh.s0 ? sh.s0 - p.s : p.s > sh.s1 ? p.s - sh.s1 : 0;
        if (d >= ease) continue;
        const w = 1 - G.smoothstep(0, ease, d);
        if (Math.abs(sh.delta * w) > Math.abs(add[i])) add[i] = sh.delta * w;
      }
    }
    for (let i = 0; i < S.length; i++) S[i].y += add[i];
  }
}

/**
 * The two carriageways of a divided street, lifted or sunk as separate pieces
 * side by side, share one height: the higher of the two where they overlap
 * (a carriageway raised over a ramp leaves its twin a wall's height below it
 * otherwise). Never raised into something passing above.
 */
function levelTwins(roads) {
  const pieces = roads.filter((r) => r.street && r.oneway && r.name);
  const changed = [];
  if (pieces.length < 2) return changed;
  const index = createRoadIndex(roads);
  const tmp = [];
  for (const r of pieces) {
    const raise = new Float64Array(r.samples.length);
    let any = false;
    const L = r.samples[r.samples.length - 1].s;
    r.samples.forEach((p, i) => {
      // Near its ends a carriageway meets the next piece, not its twin.
      if (p.s < 15 || p.s > L - 15) return;
      let top = p.y;
      // Within reach of this carriageway's own edge: the twin's footprint overlaps or touches it.
      for (const h of index.surfacesAt(p.x, p.n, (p.h ?? r.half) + 1, tmp)) {
        const o = h.road;
        if (o === r || !o.street || o.name !== r.name || !o.oneway) continue;
        const q = o.samples[h.i];
        if (p.tx * q.tx + p.tn * q.tn > -0.8) continue;      // the other way, alongside
        if (h.y > top) top = h.y;
      }
      if (top - p.y < 0.3) return;
      // Room above: nothing within a headroom over the new height.
      for (const h of index.surfacesAt(p.x, p.n, 0, tmp)) {
        if (h.road !== r && h.road.name !== r.name && h.y > p.y + 0.5 && h.y < top + HEADROOM) return;
      }
      raise[i] = top - p.y;
      any = true;
    });
    if (!any) continue;
    r.samples.forEach((p, i) => { p.y += raise[i]; });
    changed.push(r);
  }
  return changed;
}

/** Whether two roads share a point of the data near where `run` crossed. */
function joined(r, o, run) {
  const R = 40;
  const P = r.path || r.pts, Q = o.path || o.pts;
  if (!P || !Q) return true;
  for (const a of P) {
    if (Math.abs(a[0] - run.x) > R || Math.abs(a[1] - run.n) > R) continue;
    for (const b of Q) if (Math.abs(a[0] - b[0]) < 0.3 && Math.abs(a[1] - b[1]) < 0.3) return true;
  }
  return false;
}

/**
 * A ramp that ends on a street, not on another road, ends at the street's
 * height: the relief there. Its vertical curve and the grade limit leave it a
 * metre or so off, a step a car cannot climb.
 */
function settleEnds(roads, streets, terrain) {
  const grid = new G.Grid(48);
  for (const st of streets) {
    for (let i = 0; i + 1 < st.path.length; i++) {
      const a = st.path[i], b = st.path[i + 1], h = st.width / 2 + 2;
      grid.insert({ a, b, h }, Math.min(a[0], b[0]) - h, Math.min(a[1], b[1]) - h, Math.max(a[0], b[0]) + h, Math.max(a[1], b[1]) + h);
    }
  }
  const tmp = [];
  const onStreet = (p) => grid.query(p.x, p.n, 0, tmp).some((c) => G.segDist2(p.x, p.n, c.a[0], c.a[1], c.b[0], c.b[1]).d2 < c.h * c.h);
  for (const r of roads) {
    if (r.loop || r.samples.length < 3) continue;
    const S = r.samples;
    const grade = r.rules.maxGrade * 0.8;
    for (const [end, dir, name] of [[0, 1, 'start'], [S.length - 1, -1, 'end']]) {
      if ((r.junctions || []).some((j) => j.end === name)) continue;
      const p = S[end];
      if (!onStreet(p)) continue;
      const delta = terrain.height(p.x, p.n) - p.y;
      if (Math.abs(delta) < 0.05 || Math.abs(delta) > 3) continue;
      const fade = Math.max(30, Math.abs(delta) / grade);
      for (let k = end; k >= 0 && k < S.length; k += dir) {
        const d = Math.abs(S[k].s - p.s);
        if (d >= fade) break;
        S[k].y += delta * (1 - G.smoothstep(0, fade, d));
      }
    }
  }
}

/**
 * A street crossing a road a metre or three off its level can neither pass
 * under it nor over it: it meets it. The relief around the crossing is set to
 * the road's height, and the street, which lies on the relief, ramps up or
 * down to the junction over the next mesh cell.
 */
/**
 * The foot of a ramp climbing out of the street it starts from: meeting the
 * streets lifts whole 20 m cells of ground, and a few tens of centimetres of
 * it could end above the asphalt there. Below the ground, the road counted as
 * sunk, the ground opened round it, and the street went with it. Over its
 * last 40 m, a ramp less than a metre under the ground comes up onto it.
 */
function liftFeet(terrain, roads, streetsAt) {
  const tmp = [];
  for (const r of roads) {
    if (r.loop || r.street) continue;
    const S = r.samples;
    for (const [name, k0, dir] of [['start', 0, 1], ['end', S.length - 1, -1]]) {
      if ((r.junctions || []).some((j) => j.end === name)) continue;
      if (!streetsAt(S[k0].x, S[k0].n, 0.5, tmp).length) continue;
      // How far each sample is under the ground, then a moving maximum and
      // a moving average over ±8 m, so the correction follows no bump of the
      // relief: a lift, not a copy of the ground.
      const ks = [];
      for (let k = k0; k >= 0 && k < S.length && Math.abs(S[k].s - S[k0].s) < 48; k += dir) ks.push(k);
      const need = ks.map((k) => {
        const p = S[k], d = terrain.height(p.x, p.n) + 0.02 - p.y;
        return Math.abs(p.s - S[k0].s) < 40 && d > 0 && d < 1 ? Math.min(d, 0.6) : 0;
      });
      // Climbing out of a trench to the street is not a foot to lift.
      if (ks.some((k) => Math.abs(S[k].s - S[k0].s) < 40 && terrain.height(S[k].x, S[k].n) - S[k].y > 1)) continue;
      const W = 4;
      const peak = need.map((_, i) => Math.max(...need.slice(Math.max(0, i - W), i + W + 1)));
      const lift = ks.map((_, i) => {
        const win = peak.slice(Math.max(0, i - W), i + W + 1);
        return win.reduce((a, b) => a + b, 0) / win.length;
      });
      // Held at the foot, eased out by 48 m so no step is left where it stops.
      const top = Math.max(0, ...lift);
      ks.forEach((k, i) => {
        const w = 1 - G.smoothstep(20, 48, Math.abs(S[k].s - S[k0].s));
        S[k].y += Math.max(lift[i], top * w);
      });
    }
  }
}

function meetStreets(terrain, roads, streetsAt) {
  const g = terrain.grid;
  const tmp = [];
  for (const r of roads) {
    if (r.cls === 'bridge' && r.structure) continue;
    for (let k = 0; k < r.samples.length; k += 2) {
      const p = r.samples[k];
      if (p.tunnel) continue;
      const rel = p.y - terrain.height(p.x, p.n);
      if (Math.abs(rel) < 0.3 || Math.abs(rel) > 3.5) continue;
      const hits = streetsAt(p.x, p.n, 0, tmp);
      if (!hits.length) continue;
      const reach = r.half + g.cell * 0.75;
      const i0 = Math.floor((p.x - reach - g.x0) / g.cell), i1 = Math.ceil((p.x + reach - g.x0) / g.cell);
      const j0 = Math.floor((p.n - reach - g.n0) / g.cell), j1 = Math.ceil((p.n + reach - g.n0) / g.cell);
      for (let j = Math.max(0, j0); j <= Math.min(g.rows - 1, j1); j++) {
        for (let i = Math.max(0, i0); i <= Math.min(g.cols - 1, i1); i++) {
          const x = g.x0 + i * g.cell, n = g.n0 + j * g.cell;
          if (Math.hypot(x - p.x, n - p.n) > reach) continue;
          g.h[j * g.cols + i] = p.y - 0.1;
        }
      }
    }
  }
}

/**
 * Where a road runs at ground level the relief must not show through its
 * asphalt: every ground vertex under its footprint is lowered to 25 cm below
 * the road — a cut, as a real road makes in a slope. Bridges and trenches are
 * left alone; the structure pass deals with those.
 */
function carve(terrain, roads) {
  const g = terrain.grid;
  // Measured from the relief as it was: read back after each cut, a road
  // easing into a trench drags the ground down with it, metre by metre, and
  // the streets over the trench sink into the pit.
  const before = terrain.frozen();
  for (const r of roads) {
    const S = r.samples;
    for (let k = 0; k < S.length; k += 2) {
      const p = S[k];
      const ground = before(p.x, p.n);
      if (Math.abs(p.y - ground) > 1.2) continue;
      // Every vertex of a cell the footprint touches: with 20 m cells, the
      // ones strictly under a 12 m carriageway are too few to hold it clear.
      const reach = r.half + 1 + g.cell * 0.75;
      const i0 = Math.floor((p.x - reach - g.x0) / g.cell), i1 = Math.ceil((p.x + reach - g.x0) / g.cell);
      const j0 = Math.floor((p.n - reach - g.n0) / g.cell), j1 = Math.ceil((p.n + reach - g.n0) / g.cell);
      for (let j = Math.max(0, j0); j <= Math.min(g.rows - 1, j1); j++) {
        for (let i = Math.max(0, i0); i <= Math.min(g.cols - 1, i1); i++) {
          const x = g.x0 + i * g.cell, n = g.n0 + j * g.cell;
          // Within the footprint, measured across the road.
          const d = Math.abs((x - p.x) * p.lx + (n - p.n) * p.ln);
          const along = Math.abs((x - p.x) * p.tx + (n - p.n) * p.tn);
          if (d > reach || along > 2.5 + g.cell * 0.75) continue;
          const kk = j * g.cols + i;
          if (g.h[kk] > p.y - 0.25) g.h[kk] = p.y - 0.25;
        }
      }
    }
  }
}

/** Nearest point on a road's centreline: distance, height and sample index. */
export function projectOnRoad(road, x, n) {
  const S = road.samples;
  let best = null;
  for (let i = 0; i + 1 < S.length; i++) {
    const a = S[i], b = S[i + 1];
    if (Math.abs(a.x - x) > 60 && Math.abs(b.x - x) > 60) continue;
    if (Math.abs(a.n - n) > 60 && Math.abs(b.n - n) > 60) continue;
    const { d2, t } = G.segDist2(x, n, a.x, a.n, b.x, b.n);
    if (!best || d2 < best.d2) best = { d2, t, i };
  }
  if (!best) return null;
  const a = S[best.i], b = S[best.i + 1];
  return { d: Math.sqrt(best.d2), y: G.lerp(a.y, b.y, best.t), i: best.i, t: best.t, s: G.lerp(a.s, b.s, best.t) };
}

function nearestIndex(samples, [x, n]) {
  let best = 0, bd = Infinity;
  for (let i = 0; i < samples.length; i++) {
    const d = (samples[i].x - x) ** 2 + (samples[i].n - n) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

/**
 * Footprints of the runs of samples that satisfy `test`, buffered to the road's
 * half-width plus `margin`. Runs are simplified before buffering so a 9 km
 * carriageway costs a few hundred quads, not five thousand.
 */
/** The runs of a polyline's segments that touch a box, each as a polyline. */
function nearRuns(path, x0, n0, x1, n1) {
  const out = [];
  let cur = null;
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i], b = path[i + 1];
    const hit = Math.max(a[0], b[0]) >= x0 && Math.min(a[0], b[0]) <= x1 && Math.max(a[1], b[1]) >= n0 && Math.min(a[1], b[1]) <= n1;
    if (!hit) { cur = null; continue; }
    if (!cur) out.push(cur = [a]);
    cur.push(b);
  }
  return out;
}

/**
 * Footprints of the stretches of a road where `test` holds, each widened by
 * margin(sample) beyond the road's half width. Where the margin changes, the
 * two pieces share a sample so they meet.
 */
function runs(road, test, margin) {
  const out = [];
  let cur = [], m = 0;
  const flush = () => {
    if (cur.length >= 2) {
      const pts = G.simplify(cur.map((p) => [p.x, p.n]), 0.25);
      const fp = G.bufferPolyline(pts, road.half + m, 0);
      if (fp.length) out.push(fp);
    }
    cur = [];
  };
  for (const p of road.samples) {
    if (!test(p)) { flush(); continue; }
    const mp = margin(p);
    if (cur.length && mp !== m) {
      const last = cur[cur.length - 1];
      flush();
      cur.push(last);
    }
    m = mp;
    cur.push(p);
  }
  flush();
  return out;
}

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
