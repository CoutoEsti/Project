// The map compiled: from the hand-written data in montreal.js to everything the
// world, the physics, the plan and the export need. Pure logic, no three.js.
//
// The order matters and is the whole design:
//   1. roads are sampled and given vertical profiles;
//   2. mountain roads carve the terrain;
//   3. sunken roads open holes in the land — except where a street passes over
//      them (a cover) or where they run in a tunnel;
//   4. the land minus holes, the mountain and every corridor is cut into
//      blocks, and each block takes its district's style.
// Walls, barriers, pillars and covers are then *inferred* from what lies on
// either side of each road (see structures.js); none of them is authored.

import * as G from './geom.js';
import { createTerrain } from './terrain.js';

export const SPACING = 2;         // metres between road samples

// Per-class construction rules. `smooth` is the vertical-curve radius in
// metres; `deck` the structural depth under the running surface.
export const ROAD_CLASS = {
  highway: { smooth: 30, barriers: true, pillar: 34, column: 2.4, deck: 1.6, maxGrade: 0.065 },
  ramp: { smooth: 10, barriers: true, pillar: 26, column: 1.6, deck: 1.2, maxGrade: 0.075 },
  bridge: { smooth: 20, barriers: true, pillar: 45, column: 2.2, deck: 1.6, maxGrade: 0.065 },
  road: { smooth: 6, barriers: false, pillar: 30, column: 1.4, deck: 1.0, maxGrade: 0.08 },
  circuit: { smooth: 0, barriers: false, pillar: 30, column: 1.4, deck: 1.0, maxGrade: 0.05 },
  mountain: { smooth: 12, barriers: false, pillar: 30, column: 1.4, deck: 1.0, maxGrade: 0.1 },
};

const SUNKEN = -0.12;             // below this a road needs a hole in the land
const COVER_DEPTH = -1.0;         // a street only covers a road deeper than this

export function compile(map, opts = {}) {
  const T = {};
  const t0 = now();
  const terrain = createTerrain(map.mountain);

  // --- 1. roads ------------------------------------------------------------
  const roads = map.roads.map((r) => sampleRoad(r, terrain));
  pinJunctions(roads);
  T.roads = now() - t0;

  // --- 2. mountain roads carve the relief; terraces for what sits on it ----
  for (const r of roads) {
    // A wide blend: the mountain reshapes itself around its roads instead of
    // standing over them as a wall.
    if (r.follow === 'terrain') terrain.carveRoad(r.samples, r.width / 2 + 0.8, 42);
  }
  for (const lm of map.landmarks) {
    if (terrain.inside(lm.x, lm.n)) {
      const r = { cross: 10, chalet: 38, oratory: 60 }[lm.type] || 15;
      lm.ground = terrain.flatten(lm.x, lm.n, r);
    }
  }

  // --- 3. streets, covers and holes ----------------------------------------
  const t1 = now();
  const streets = map.streets.map((st, i) => ({
    ...st,
    index: i,
    half: st.width / 2,
    corridor: G.bufferPolyline(st.path, st.width / 2, 0),
  }));
  const streetGrid = new G.Grid(48);
  for (const st of streets) {
    for (let i = 0; i + 1 < st.path.length; i++) {
      const a = st.path[i], b = st.path[i + 1];
      const r = st.half + 1;
      streetGrid.insert({ st, a, b }, Math.min(a[0], b[0]) - r, Math.min(a[1], b[1]) - r,
        Math.max(a[0], b[0]) + r, Math.max(a[1], b[1]) + r);
    }
  }
  const streetsAt = (x, n, pad = 0, out = []) => {
    out.length = 0;
    const cand = streetGrid.query(x, n, 0);
    for (const c of cand) {
      const { d2 } = G.segDist2(x, n, c.a[0], c.a[1], c.b[0], c.b[1]);
      const r = c.st.half + pad;
      if (d2 <= r * r && !out.includes(c.st)) out.push(c.st);
    }
    return out;
  };

  // A sample is covered when it runs in a declared tunnel, or when a real
  // street (not an apron around the trench) passes over it.
  const coverers = new Set();
  const tmp = [];
  for (const r of roads) {
    for (const p of r.samples) {
      if (p.tunnel) { p.covered = true; continue; }
      if (p.y > COVER_DEPTH) continue;
      for (const st of streetsAt(p.x, p.n, 0, tmp)) {
        if (st.cls === 'apron') continue;
        p.covered = true;
        p.coverBy = st.index;
        coverers.add(st);
      }
    }
  }

  const sunken = [];
  const surface = [];
  const tunnels = [];
  for (const r of roads) {
    sunken.push(...runs(r, (p) => p.y < SUNKEN && !p.tunnel, 0.5));
    surface.push(...runs(r, (p) => !p.covered, 1.5));
    tunnels.push(...runs(r, (p) => p.tunnel, 0.5));
  }
  let holes = G.unionAll(sunken);
  if (coverers.size && holes.length) holes = G.pc.difference(holes, ...[...coverers].map((s) => s.corridor));
  if (tunnels.length && holes.length) holes = G.pc.difference(holes, G.unionAll(tunnels));
  holes = G.dropSlivers(holes, 4);
  const roadArea = G.unionAll(surface);
  const streetArea = G.unionAll(streets.map((s) => s.corridor));
  T.corridors = now() - t1;

  // --- 4. land, water, blocks ----------------------------------------------
  const t2 = now();
  const W = map.world;
  const worldRect = [[[W.x0, W.n0], [W.x1, W.n0], [W.x1, W.n1], [W.x0, W.n1], [W.x0, W.n0]]];
  const island = G.pc.difference([[G.closeRing(map.land.island)]], [[G.closeRing(map.land.canal)]]);
  const islets = map.land.islands.map((i) => [[G.closeRing(i.ring)]]);
  const landAll = G.pc.intersection(G.pc.union(island, ...islets), worldRect);
  const water = G.pc.difference(worldRect, landAll);
  const mountain = [[G.closeRing(map.mountain.ring)]];
  let flat = G.pc.difference(landAll, mountain);
  if (holes.length) flat = G.pc.difference(flat, holes);

  let pieces = G.pc.difference(flat, streetArea);
  if (roadArea.length) pieces = G.pc.difference(pieces, roadArea);
  pieces = G.dropSlivers(pieces, 40);

  const districts = map.districts.map((d) => ({
    ...d,
    ring: d.ring || (map.land.islands.find((i) => i.id === d.id) || {}).ring || null,
  }));
  const parks = (map.parks || []).map((p) => ({ ...p, poly: [[...p.ring, p.ring[0]]] }));
  const blocks = [];
  for (const poly of pieces) {
    const parts = [];
    let rest = [poly];
    for (const park of parks) {
      if (!rest.length) break;
      const bb = G.ringBBox(poly[0]), pb = G.ringBBox(park.ring);
      if (bb.x1 < pb.x0 || pb.x1 < bb.x0 || bb.n1 < pb.n0 || pb.n1 < bb.n0) continue;
      const inPark = G.pc.intersection(rest, park.poly);
      if (!inPark.length) continue;
      for (const q of inPark) parts.push({ poly: q, park });
      rest = G.pc.difference(rest, park.poly);
    }
    for (const q of rest) parts.push({ poly: q, park: null });
    for (const { poly: q, park } of parts) {
      const area = G.polygonArea(q);
      if (area < 40) continue;
      const [ix, in_] = G.interiorPoint(q);
      const district = districts.find((d) => d.ring && G.pointInRing(ix, in_, d.ring)) || null;
      blocks.push({
        id: blocks.length,
        poly: q.map(G.openRing),
        area,
        bbox: G.ringBBox(q[0]),
        district: district ? district.id : null,
        style: park ? park.style : district ? district.style : 'verge',
        park: park ? park.name : null,
      });
    }
  }
  T.blocks = now() - t2;
  T.total = now() - t0;

  const layout = {
    map, terrain, roads, streets, streetsAt, districts, parks,
    holes, water, land: landAll, flat, mountain, blocks, roadArea, streetArea,
    timings: T,
  };
  layout.roadById = Object.fromEntries(roads.map((r) => [r.id, r]));
  return layout;
}

// ---------------------------------------------------------------- roads --

export function sampleRoad(road, terrain) {
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

  let ys;
  if (road.follow === 'terrain') {
    // Follow a smoothed version of the ground, pinned to street level wherever
    // the road is off the mountain, then limit the grade from those pins so no
    // stretch is steeper than the road allows. The carve step makes the ground
    // agree afterwards.
    const step = (road.maxGrade || cls.maxGrade) * SPACING;
    // Street level wherever the road is off the mountain or on its flat fringe;
    // a short dip into the relief between two such stretches stays flat too.
    const pinned = samples.map((p) => !terrain.inside(p.x, p.n) || terrain.base(p.x, p.n) < 0.4);
    for (let i = 0, run = -1; i <= pinned.length; i++) {
      if (i < pinned.length && !pinned[i]) { if (run < 0) run = i; continue; }
      if (run > 0 && i < pinned.length && i - run < 15) for (let k = run; k < i; k++) pinned[k] = true;
      run = -1;
    }
    ys = G.smooth(samples.map((p) => terrain.base(p.x, p.n)), Math.round(24 / SPACING));
    for (let i = 0; i < ys.length; i++) if (pinned[i]) ys[i] = 0;
    // Best fit under the grade limit: halfway between the steepest-allowed
    // envelope under the ground and the one over it. The road starts climbing
    // before a rise instead of hitting it and cutting a canyon.
    ys = lipschitzFit(ys, step);
    for (let i = 0; i < ys.length; i++) if (pinned[i]) ys[i] = 0;
    const steps = easedSteps(pinned, step);
    limitGrade(ys, pinned, steps);
    ys = G.smooth(ys, Math.round(8 / SPACING));
    for (let i = 0; i < ys.length; i++) if (pinned[i]) ys[i] = 0;
    limitGrade(ys, pinned, steps);
    fair(ys, pinned, steps);
    road._pinned = pinned;
  } else {
    // Heights live on the control points; carry them along by arc length
    // within each control segment, then round the grade breaks.
    const yc = ctrl.map((p) => (p.length > 2 ? p[2] : 0));
    if (closed && yc.length) yc.push(yc[0]);
    const segStart = [], segEnd = [];
    for (const p of samples) {
      if (segStart[p.seg] === undefined) segStart[p.seg] = p.s;
      segEnd[p.seg] = p.s;
    }
    ys = samples.map((p) => {
      const a = segStart[p.seg], b = segEnd[p.seg];
      const u = b > a ? (p.s - a) / (b - a) : 0;
      return G.lerp(yc[p.seg], yc[Math.min(yc.length - 1, p.seg + 1)], G.clamp(u, 0, 1));
    });
    const radius = Math.round(cls.smooth / SPACING);
    if (radius > 0) ys = G.smooth(ys, radius);
  }
  for (let i = 0; i < samples.length; i++) {
    samples[i].y = ys[i];
    samples[i].i = i;
  }

  // Declared tunnel: from the sample nearest `from` to the one nearest `to`.
  if (road.tunnel) {
    const a = nearestIndex(samples, road.tunnel.from), b = nearestIndex(samples, road.tunnel.to);
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) samples[i].tunnel = true;
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
    closedEnd: road.closed === 'end',
    half: road.width / 2,
    samples,
    length: samples.length ? samples[samples.length - 1].s : 0,
    stretches,
  };
}

/** Name of the stretch a sample index falls in. */
export function stretchAt(road, i) {
  let name = road.name, ref = null;
  for (const st of road.stretches || []) {
    if (st.start <= i) { name = st.name; ref = st.ref; } else break;
  }
  return { name, ref };
}

/** Midpoint of the lower and upper `step`-Lipschitz envelopes of f. */
function lipschitzFit(f, step) {
  const n = f.length;
  const lo = Float64Array.from(f), hi = Float64Array.from(f);
  for (let i = 1; i < n; i++) { lo[i] = Math.min(lo[i], lo[i - 1] + step); hi[i] = Math.max(hi[i], hi[i - 1] - step); }
  for (let i = n - 2; i >= 0; i--) { lo[i] = Math.min(lo[i], lo[i + 1] + step); hi[i] = Math.max(hi[i], hi[i + 1] - step); }
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = (lo[i] + hi[i]) / 2;
  return out;
}

/**
 * Keep every step within ±`step` of its neighbours, never moving a pinned
 * sample. Forward then backward: with consistent pins the result is the
 * tightest profile that respects both.
 */
function limitGrade(ys, pinned, step) {
  const at = typeof step === 'number' ? () => step : (i) => step[i];
  for (let i = 1; i < ys.length; i++) {
    if (!pinned[i]) ys[i] = G.clamp(ys[i], ys[i - 1] - at(i - 1), ys[i - 1] + at(i - 1));
  }
  for (let i = ys.length - 2; i >= 0; i--) {
    if (!pinned[i]) ys[i] = G.clamp(ys[i], ys[i + 1] - at(i), ys[i + 1] + at(i));
  }
}

/**
 * Per-sample grade limits that ease in from every pinned sample: the grade
 * may grow by KMAX a metre away from a pin, so a road leaves street level
 * through a vertical curve instead of a kink. Returns steps[i] for the
 * stretch between samples i and i + 1.
 */
function easedSteps(pinned, step) {
  const n = pinned.length;
  const d = new Float64Array(n).fill(Infinity);
  for (let i = 0, last = -Infinity; i < n; i++) { if (pinned[i]) last = i; d[i] = i - last; }
  for (let i = n - 1, last = Infinity; i >= 0; i--) { if (pinned[i]) last = i; d[i] = Math.min(d[i], last - i); }
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const k = Math.min(d[i], i + 1 < n ? d[i + 1] : d[i]) + 0.5;
    out[i] = Math.min(step, KMAX * SPACING * SPACING * k);
  }
  return out;
}

/**
 * Round every grade break into a vertical curve: nowhere does the profile bend
 * faster than KMAX (1/m), nowhere is it steeper than `step` a sample (a
 * number, or one per sample), and
 * pinned samples never move. Grade limiting alone leaves kinks — 0 to 10 % in
 * one sample at the foot of the mountain — that a car at 60 km/h takes as a
 * ramp. Alternating projections onto the two constraints, both convex: the
 * profile settles where both hold.
 */
const KMAX = 0.005;           // a crest lifts a car only above ~160 km/h

function fair(ys, pinned, step, iterations = 3000) {
  const c = KMAX * SPACING * SPACING;       // largest second difference
  for (let it = 0; it < iterations; it++) {
    let worst = 0;
    // Sweep both ways in turn so a correction travels the whole road quickly.
    const fwd = it % 2 === 0;
    for (let j = 1; j + 1 < ys.length; j++) {
      const i = fwd ? j : ys.length - 1 - j;
      const d2 = ys[i - 1] - 2 * ys[i] + ys[i + 1];
      const excess = d2 > c ? d2 - c : d2 < -c ? d2 + c : 0;
      if (!excess) continue;
      if (Math.abs(excess) > worst) worst = Math.abs(excess);
      // Project onto |d2| <= c along (1, -2, 1), restricted to free samples.
      const wa = pinned[i - 1] ? 0 : 1, wb = pinned[i] ? 0 : -2, wc = pinned[i + 1] ? 0 : 1;
      const norm = wa * wa + wb * wb + wc * wc;
      if (!norm) continue;
      const k = excess / norm;
      ys[i - 1] -= wa * k;
      ys[i] -= wb * k;
      ys[i + 1] -= wc * k;
    }
    limitGrade(ys, pinned, step);
    if (worst < 1e-4) break;
  }
  return ys;
}

/**
 * Mountain roads each follow their own smoothed ground, so two of them meeting
 * at a junction disagree by a metre or two. Each end is pinned to whatever it
 * lands on: inside the other road's corridor the minor road takes the major
 * road's height sample by sample (the overlap is one surface), and beyond it
 * the correction fades over 80 m. The builder then trims the minor ribbon at
 * the major road's edge (`junctions`), so the two never draw over each other.
 * Roads earlier in the list are the major road when two ends meet.
 */
function pinJunctions(roads) {
  const index = new Map(roads.map((r, i) => [r, i]));
  for (const r of roads) {
    if (r.follow !== 'terrain') continue;
    r.junctions = [];
    const ri = index.get(r);
    for (const end of [0, r.samples.length - 1]) {
      const p = r.samples[end];
      // The major road: nearest sample of another road within 4 m, ignoring
      // the first few metres of a later mountain road (it will pin to us).
      let major = null, best = 16;
      for (const o of roads) {
        if (o === r) continue;
        const oi = index.get(o), S = o.samples;
        for (let k = 0; k < S.length; k++) {
          const nearEnd = Math.min(k, S.length - 1 - k) * SPACING < 8;
          if (nearEnd && o.follow === 'terrain' && oi > ri) continue;
          const d = (S[k].x - p.x) ** 2 + (S[k].n - p.n) ** 2;
          if (d < best) { best = d; major = o; }
        }
      }
      if (!major) continue;
      const dir = end === 0 ? 1 : -1;
      // Walk in from the end for as long as the two footprints still overlap,
      // copying the major road's height. The ribbon itself will be drawn from
      // where its centreline crosses the major road's edge (`sTrim`).
      let k = end, inside = 0, lastDelta = 0, sTrim = p.s;
      for (; k >= 0 && k < r.samples.length; k += dir) {
        const q = r.samples[k];
        const hit = projectOnRoad(major, q.x, q.n);
        if (!hit || hit.d > major.half + r.half) break;
        if (hit.d <= major.half) sTrim = q.s;
        lastDelta = hit.y - q.y;
        q.y = hit.y;
        inside++;
      }
      const sEdge = r.samples[Math.max(0, Math.min(r.samples.length - 1, k))].s;
      for (let j = k; j >= 0 && j < r.samples.length; j += dir) {
        const q = r.samples[j];
        const w = 1 - G.smoothstep(0, 80, Math.abs(q.s - sEdge));
        if (w <= 0) break;
        q.y += lastDelta * w;
      }
      r.junctions.push({ end: end === 0 ? 'start' : 'end', major: major.id, sEdge, sTrim, samples: inside });
    }
    // Re-impose the grade limit, holding the junctions and the off-mountain
    // stretches fixed.
    const pinned = r._pinned.slice();
    for (const j of r.junctions) {
      for (let i = 0; i < r.samples.length; i++) {
        // Strictly inside the overlap: the first sample past it is free to
        // ease into the road's own grade.
        if ((j.end === 'start' && r.samples[i].s < j.sEdge) || (j.end === 'end' && r.samples[i].s > j.sEdge)) pinned[i] = true;
      }
    }
    const ys = r.samples.map((q) => q.y);
    const steps = easedSteps(pinned, (r.maxGrade || r.rules.maxGrade) * SPACING);
    limitGrade(ys, pinned, steps);
    fair(ys, pinned, steps);
    r.samples.forEach((q, i) => { q.y = ys[i]; });
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
 * ring costs a few hundred quads, not five thousand.
 */
function runs(road, test, margin) {
  const out = [];
  let cur = [];
  const flush = () => {
    if (cur.length >= 2) {
      const pts = G.simplify(cur.map((p) => [p.x, p.n]), 0.25);
      const fp = G.bufferPolyline(pts, road.half + margin, 0);
      if (fp.length) out.push(fp);
    }
    cur = [];
  };
  for (const p of road.samples) {
    if (test(p)) cur.push(p); else flush();
  }
  flush();
  return out;
}

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
