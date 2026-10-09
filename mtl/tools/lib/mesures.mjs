// What a driver would see wrong on the map, measured over all of it: the
// shared core of tools/artefacts.mjs, tools/bouts.mjs and tools/filet.mjs.
//
// Every finding has a place (x, n, in the layout's metres) and an amount
// (metres, square metres or a count), so a whole map can be summed per
// 40 m cell and two revisions compared cell by cell.
//
//   artefacts(world)   → { obstacle: [...], hole: [...] }   solid things on the
//                        asphalt, holes under the wheels
//   openEnds(world)    → [...]   road ends with nothing to drive onto
//   slits(world)       → [...]   a gap between two surfaces side by side at
//                        the same level (the strip between two carriageways)
//   groundOver(world)  → [...]   relief drawn above an open road
//   offLevel(world)    → [...]   a point of a road where the car would not
//                        stand at the road's own height
//   walls(world)       → [...]   every wall, barrier and median deck, by kind

import { pillarColumns } from '../../src/map/structures.js';
import { createSurface } from '../../src/map/surface.js';
import { Grid, pointInRing } from '../../src/map/geom.js';

const CAR_BOTTOM = 0.28, CAR_TOP = 1.45;   // map/collide.js
const DY = 0.6;                            // a step the car climbs, map/surface.js
const lerp = (u, v, t) => u + (v - u) * t;
export const roadName = (r) => (r ? `${r.id}${r.name ? ' ' + r.name : ''}` : '?');

function context(world) {
  if (world.__mesures) return world.__mesures;
  const { layout, structures } = world;
  world.__mesures = {
    layout, structures, index: structures.index, T: layout.terrain,
    surface: createSurface(layout, structures),
    byId: new Map(layout.roads.map((r) => [r.id, r])),
  };
  return world.__mesures;
}

// ---------------------------------------------------------------- artefacts --
// Obstacles: every wall, barrier, fence, pillar and building edge, sampled
// every metre. A sample counts when it stands more than `IN` metres inside a
// road or street ribbon and its height range covers a car on that surface. An
// obstacle on its own road's edge is not inside by a metre and does not count.
// Holes: across every road and street, a probe every 2 m along and every
// 1.5 m across, a metre in from the edges; a hole where the surface under the
// car is void or more than 0.6 m below the road there.
// Places are merged within 15 m.
export function artefacts(world, { IN = 1.0 } = {}) {
  const { layout, structures, index, T, surface, byId } = context(world);
  const hits = [], stTmp = [];
  function drivable(x, n) {
    const out = [];
    for (const h of index.surfacesAt(x, n, -IN, hits)) if (!h.covered) out.push({ y: h.y, what: roadName(h.road), road: h.road });
    for (const st of layout.streetsAt(x, n, -IN, stTmp)) if (st.cls !== 'plaza') out.push({ y: T.height(x, n), what: `rue ${st.name || st.id || ''}`, street: st });
    return out;
  }
  const places = { obstacle: [], hole: [] };
  function record(kind, x, n, y, what, on, len) {
    const list = places[kind];
    for (const p of list) {
      if (p.what === what && p.on === on && Math.hypot(p.x - x, p.n - n) < 15) { p.len += len; return; }
    }
    list.push({ kind, x, n, y, what, on, len });
  }
  function alongside(r, x, n, ux, un) {
    const h = index.surfacesAt(x, n, 0, []).find((o) => o.road === r);
    if (!h) return false;
    const p = r.samples[h.i];
    return Math.abs(p.tx * ux + p.tn * un) > 0.85;
  }
  // `pair`: a median's own carriageway; it and the carriageway the other way
  // alongside it (map/structures.js twinOf) are what the median divides.
  function probeSegment(a, b, y0Of, y1Of, what, pair) {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 1e-6) return;
    const ux = (b[0] - a[0]) / L, un = (b[1] - a[1]) / L;
    const k = Math.max(1, Math.ceil(L));
    for (let i = 0; i <= k; i++) {
      const t = i / k;
      const x = a[0] + (b[0] - a[0]) * t, n = a[1] + (b[1] - a[1]) * t;
      const y0 = y0Of(t), y1 = y1Of(t);
      for (const d of drivable(x, n)) {
        if (pair && d.road && (d.road === pair || (d.road.oneway && pair.oneway && alongside(d.road, x, n, ux, un)))) continue;
        if (y1 < d.y + CAR_BOTTOM || y0 > d.y + CAR_TOP) continue;
        record('obstacle', x, n, d.y, what, d.what, L / k);
      }
    }
  }
  for (const w of structures.walls) {
    for (let i = 0; i + 1 < w.pts.length; i++) {
      const p = w.pts[i], q = w.pts[i + 1];
      probeSegment(p, q, (t) => lerp(p[2], q[2], t), (t) => lerp(p[3], q[3], t), `mur ${w.kind} de ${roadName(byId.get(w.road))}`, null);
    }
  }
  const H = { jersey: 1.07, median: 1.07, parapet: 1.1, circuit: 1.2, guardrail: 0.8 };
  for (const b of structures.barriers) {
    const h = H[b.kind] || 0.9;
    for (let i = 0; i + 1 < b.pts.length; i++) {
      const p = b.pts[i], q = b.pts[i + 1];
      probeSegment(p, q, (t) => lerp(p[2], q[2], t) - 0.2, (t) => lerp(p[2], q[2], t) + h, `glissière ${b.kind} de ${roadName(byId.get(b.road))}`, b.kind === 'median' ? byId.get(b.road) : null);
    }
  }
  for (const f of structures.fences) {
    for (let i = 0; i + 1 < f.pts.length; i++) {
      const p = f.pts[i], q = f.pts[i + 1];
      probeSegment(p, q, (t) => lerp(p[2], q[2], t) - 0.2, (t) => lerp(p[2], q[2], t) + f.height, `clôture ${f.kind || ''}`, null);
    }
  }
  for (const p of structures.pillars) {
    for (const [cx, cn] of pillarColumns(p)) {
      for (const d of drivable(cx, cn)) {
        if (p.y1 < d.y + CAR_BOTTOM || p.y0 > d.y + CAR_TOP) continue;
        record('obstacle', cx, cn, d.y, `pilier de ${roadName(byId.get(p.road))}`, d.what, 1);
      }
    }
  }
  for (const b of world.buildings) {
    const base = (b.base || 0) + (b.minH > 2 ? b.minH : 0), top = (b.base || 0) + b.h;
    const R = b.ring;
    for (let i = 0; i < R.length; i++) {
      probeSegment(R[i], R[(i + 1) % R.length], () => base - 0.5, () => top, `bâtiment ${b.id}${b.name ? ' ' + b.name : ''}`, null);
    }
  }

  // y: the road's height, or null for a street, which lies on the relief.
  function probeAcross(x, n, lx, ln, half, yRoad, what) {
    for (let o = -(half - IN); o <= half - IN + 1e-6; o += 1.5) {
      const px = x + lx * o, pn = n + ln * o;
      const y = yRoad ?? T.height(px, pn);
      const s = surface.at(px, pn, y + 0.3);
      if (s.kind === 'void' || s.y < y - 0.6) record('hole', px, pn, y, s.kind === 'void' ? 'vide' : `${(y - s.y).toFixed(1)} m plus bas`, what, 2 * 1.5);
    }
  }
  for (const r of layout.roads) {
    const S = r.samples;
    for (let i = 0; i < S.length; i++) {
      const p = S[i];
      if (p.covered) continue;
      if ((p.s % 2) > 1 && i) continue;
      probeAcross(p.x, p.n, p.lx, p.ln, p.h ?? r.half, p.y, roadName(r));
    }
  }
  for (const st of layout.streets) {
    const P = st.path;
    for (let i = 0; i + 1 < P.length; i++) {
      const a = P[i], b = P[i + 1], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (L < 0.5) continue;
      const tx = (b[0] - a[0]) / L, tn = (b[1] - a[1]) / L;
      for (let d = 0; d < L; d += 2) {
        const x = a[0] + tx * d, n = a[1] + tn * d;
        // Under a road drawn at its level the street gives way (world/streets.js):
        // the road is checked on its own.
        if (index.surfacesAt(x, n, 0, hits).some((h) => !h.covered && Math.abs(h.y - T.height(x, n)) < 0.6)) continue;
        probeAcross(x, n, -tn, tx, st.half, null, `rue ${st.name || ''}`);
      }
    }
  }
  return places;
}

// ---------------------------------------------------------------- open ends --
// Where a road stops, is there anything to drive onto? Probes a metre apart
// across the end, a metre past it, each looking for another road as drawn
// (layout.roadCover: trimmed ends, tapers and joints included), a street or
// its sidewalk at the same height, or bare ground at that height. `miss`: the
// share of probes that find none of these; `grass`: those that find only
// bare ground at the road's level (no drop, but no road either).
const SIDEWALK = { boulevard: 3.6, avenue: 3.2, street: 2.6, narrow: 1.8, plaza: 0, alley: 0 };   // world/streets.js

export function openEnds(world) {
  const { layout, T } = context(world);
  const cover = layout.roadCover;
  const scale = layout.map.scale || 1;
  const tmp = [], hs = [];
  function probe(x, n, y) {
    for (const h of cover.heights(x, n, hs)) if (Math.abs(h - y) <= DY) return 'road';
    if (Math.abs(T.height(x, n) - y) > DY) return null;
    // A street's sidewalk is driven onto too: a kerb, not a hole.
    for (const st of layout.streetsAt(x, n, 4 * scale, tmp)) {
      const walk = (SIDEWALK[st.cls] ?? 2.4) * scale;
      if (layout.streetsAt(x, n, walk, []).includes(st)) return 'street';
    }
    return 'grass';
  }
  const ends = [];
  for (const r of layout.roads) {
    if (r.loop || r.cls === 'circuit') continue;
    const S = r.samples;
    for (const [end, k, dir] of [['start', 0, -1], ['end', S.length - 1, 1]]) {
      const p = S[k];
      const closed = end === 'start' ? r.closedStart : r.closedEnd;
      const h = p.h ?? r.half;
      let total = 0, miss = 0, grass = 0;
      const missing = [];
      for (let v = -h + 0.5; v <= h - 0.5 + 1e-6; v += 1) {
        const x = p.x + p.tx * dir + p.lx * v, n = p.n + p.tn * dir + p.ln * v;
        total++;
        const got = probe(x, n, p.y);
        if (got === 'grass') grass++;
        if (!got) { miss++; missing.push(Math.round(v * 10) / 10); }
      }
      if (!miss && !grass) continue;
      ends.push({
        road: r, p, id: r.id, way: r.osm, name: r.name || '', cls: r.cls, end, closed,
        x: Math.round(p.x), n: Math.round(p.n), y: Math.round(p.y * 10) / 10,
        ground: Math.round((p.y - T.height(p.x, p.n)) * 10) / 10,
        miss: Math.round((miss / total) * 100), grass: Math.round((grass / total) * 100), missing,
      });
    }
  }
  return ends;
}

// -------------------------------------------------------------------- slits --
// Two surfaces side by side at the same level with a strip of nothing (or of
// something far lower) between them: the wheels of a car crossing from one
// to the other drop into it (a median deck between them closes it). Every 2 m along each open road, on each side,
// the strip from its edge out to 3 m is probed every 0.3 m; it is a slit when
// another road or a street at the road's level (within 0.6 m) lies past the
// strip and some probe in between finds void or a surface 0.6 m below.
// Amount: metres of road edge along a slit.
const SLIT_REACH = 3.0, SLIT_STEP = 0.3;

export function slits(world) {
  const { layout, structures, index, T, surface } = context(world);
  const out = [], hits = [], stTmp = [];
  // The deck between two carriageways a few metres apart (map/structures.js
  // medians) closes the strip; it is drawn, not driven, so not in surface.
  const decks = new Grid(32), dTmp = [];
  for (const m of structures.medians || []) {
    for (let i = 0; i + 1 < m.pts.length; i++) {
      const a = m.pts[i], b = m.pts[i + 1];
      const ring = [[a[0], a[1]], [a[2], a[3]], [b[2], b[3]], [b[0], b[1]]];
      const xs = ring.map((q) => q[0]), ns = ring.map((q) => q[1]);
      decks.insert({ ring, y: Math.max(a[4], b[4]) }, Math.min(...xs), Math.min(...ns), Math.max(...xs), Math.max(...ns));
    }
  }
  const decked = (x, n, y) => decks.query(x, n, 0.2, dTmp).some((d) => Math.abs(d.y - y) < 1.5 && pointInRing(x, n, d.ring));
  const level = (x, n, y, own) => {
    for (const h of index.surfacesAt(x, n, 0, hits)) if (h.road !== own && !h.covered && Math.abs(h.y - y) < DY) return roadName(h.road);
    for (const st of layout.streetsAt(x, n, 0, stTmp)) if (st.cls !== 'plaza' && Math.abs(T.height(x, n) - y) < DY) return `rue ${st.name || ''}`;
    return null;
  };
  for (const r of layout.roads) {
    const S = r.samples;
    for (let i = 0; i < S.length; i++) {
      const p = S[i];
      if (p.covered) continue;
      if ((p.s % 2) > 1 && i) continue;
      const h = p.h ?? r.half;
      for (const side of [1, -1]) {
        let gap = false, other = null;
        for (let d = SLIT_STEP; d <= SLIT_REACH + 1e-6; d += SLIT_STEP) {
          const x = p.x + side * p.lx * (h + d), n = p.n + side * p.ln * (h + d);
          const s = surface.at(x, n, p.y + 0.3);
          if ((s.kind === 'void' || s.y < p.y - DY) && !decked(x, n, p.y)) { gap = true; continue; }
          // The first thing at or above the road's level past the edge ends
          // the strip: a slit only if it is another surface at that level.
          if (gap) other = level(x, n, p.y, r);
          break;
        }
        if (gap && other) out.push({ x: p.x + side * p.lx * h, n: p.n + side * p.ln * h, y: p.y, road: roadName(r), other, len: 2 });
      }
    }
  }
  return out;
}

// ------------------------------------------------------- ground over a road --
// The relief drawn above an open road: the trench that should hold it is
// missing there, and the car drives into a slope. Every 4 m along each road.
export function groundOver(world) {
  const { layout, structures } = context(world);
  const out = [];
  for (const r of layout.roads) {
    for (const p of r.samples) {
      if (p.covered || p.s % 4 > 1) continue;
      const k = structures.ground.kindAt(p.x, p.n);
      if (k !== 'hole' && structures.ground.heightAt(p.x, p.n, k) > p.y + 0.5) out.push({ x: p.x, n: p.n, y: p.y, road: roadName(r), len: 4 });
    }
  }
  return out;
}

// --------------------------------------------------------------- off level --
// Along every road, on the centreline and 70 % of the way to each edge, every
// 4 m: does a car at the road's height stand at that height? Not when the
// surface there is void or more than 0.3 m off — another surface laid over
// the road, or none at all.
export function offLevel(world) {
  const { layout, surface } = context(world);
  const out = [];
  for (const r of layout.roads) {
    for (const p of r.samples) {
      if (p.s % 4 > 1) continue;
      const h = p.h ?? r.half;
      for (const o of [0, 0.7, -0.7]) {
        const x = p.x + p.lx * h * o, n = p.n + p.ln * h * o;
        const s = surface.at(x, n, p.y + 0.5);
        if (s.kind === 'void' || Math.abs(s.y - p.y) > 0.3) out.push({ x, n, y: p.y, road: roadName(r), len: 1 });
      }
    }
  }
  return out;
}

// -------------------------------------------------------------------- walls --
// Every wall, barrier and median deck as pieces with a place and a length,
// by kind: what the structures are, to see where they change.
export function walls(world) {
  const { structures } = context(world);
  const out = [];
  const pieces = (kind, pts, road) => {
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      out.push({ kind, x: (a[0] + b[0]) / 2, n: (a[1] + b[1]) / 2, len, road });
    }
  };
  for (const w of structures.walls) pieces(`mur ${w.kind}`, w.pts, w.road);
  for (const b of structures.barriers) pieces(`glissière ${b.kind}`, b.pts, b.road);
  for (const f of structures.fences) pieces(`clôture ${f.kind || ''}`.trim(), f.pts, null);
  for (const m of structures.medians || []) {
    pieces('dalle', m.pts.map((q) => [(q[0] + q[2]) / 2, (q[1] + q[3]) / 2]), m.road);
  }
  for (const p of structures.pillars) out.push({ kind: 'pilier', x: p.x, n: p.n, len: 1, road: p.road });
  return out;
}
