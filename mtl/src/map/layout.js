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
  const roads = map.roads.map((r) => sampleRoad(r));
  const roadGrid = indexRoads(roads);
  pinJunctions(roads, roadGrid);
  carve(terrain, roads);
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

  // --- 3. ground, tunnels, covers, holes ---------------------------------------
  const coverers = new Set();
  const tmp = [];
  for (const r of roads) {
    for (const p of r.samples) {
      p.gs = terrain.height(p.x, p.n);          // the ground surface, even over a trench
      if (p.tunnel) { p.covered = true; continue; }
      if (p.y - p.gs > COVER_DEPTH) continue;
      for (const st of streetsAt(p.x, p.n, 0, tmp)) {
        p.covered = true;
        p.coverBy = st.index;
        coverers.add(st);
      }
    }
  }
  const sunken = [], tunnels = [];
  for (const r of roads) {
    sunken.push(...runs(r, (p) => p.y - p.gs < SUNKEN && !p.tunnel, 0.5));
    tunnels.push(...runs(r, (p) => p.tunnel, 0.5));
  }
  let holes = G.unionAll(sunken);
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
function pinJunctions(roads, grid) {
  const tmp = [];
  const rank = (r) => (r.priority || 0) * 1e6 + r.length;
  for (const r of roads) {
    if (r.loop) continue;
    r.junctions = [];
    for (const end of [0, r.samples.length - 1]) {
      const p = r.samples[end];
      let major = null, best = Infinity;
      for (const o of grid.query(p.x, p.n, 0, tmp)) {
        if (o === r || rank(o) < rank(r)) continue;
        const hit = projectOnRoad(o, p.x, p.n);
        if (!hit || hit.d > o.half + 0.5) continue;
        if (Math.abs(hit.y - p.y) > 3) continue;       // one passes over the other
        if (hit.d < best) { best = hit.d; major = o; }
      }
      if (!major) continue;
      const dir = end === 0 ? 1 : -1;
      let k = end, lastDelta = 0, inside = 0, sTrim = p.s;
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
        const w = 1 - G.smoothstep(0, 60, Math.abs(q.s - sEdge));
        if (w <= 0) break;
        q.y += lastDelta * w;
      }
      r.junctions.push({ end: end === 0 ? 'start' : 'end', major: major.id, sEdge, sTrim, samples: inside });
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
  for (const r of roads) {
    const S = r.samples;
    for (let k = 0; k < S.length; k += 2) {
      const p = S[k];
      const ground = terrain.height(p.x, p.n);
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
