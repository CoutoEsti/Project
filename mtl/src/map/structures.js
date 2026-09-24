// Everything that holds the roads up, keeps cars on them and closes them off —
// inferred, never authored.
//
// For each road, on each side, every sample asks one question: what is just
// beyond my edge? The answer picks the structure:
//
//   same-level road     → nothing: the two surfaces merge (a ramp peeling off)
//   lower road, trench  → a skirt wall down to it (a ramp above the main lanes)
//   higher road, trench → nothing: the other one builds the skirt
//   ground far below    → a viaduct: deck fascia, underside, pillars, barrier
//   ground a bit below  → an embankment: a solid wall down to the ground
//   ground above        → a retaining wall up to the street, and a fence on top
//   covered             → a tunnel wall up to the ceiling
//   water               → a bridge: fascia, parapet, piers in the river
//
// The output is plain data — polylines with heights, boxes, points — shared by
// the mesh builder (world/structures.js) and the collision grid, so what you
// see and what you hit are the same thing by construction.

import { createRoadIndex, createGround } from './query.js';
import * as G from './geom.js';

const PROBE = 0.8;          // how far past the edge we look
const WALL_OFFSET = 0.5;    // retaining walls stand on the hole's boundary
const DEEP = -12;           // skirt bottom when there is nothing underneath
const TWIN = 6;             // twin columns stand this far either side
const HEADROOM = 6.2;       // a road this far below drives under the deck
const MERGE = 2.0;          // closer than this in height, two roads merge

export function buildStructures(layout) {
  const { roads, map } = layout;
  const index = createRoadIndex(roads);
  const ground = createGround(layout);
  const out = {
    barriers: [],   // { pts: [[x, n, y]], kind: 'jersey' | 'parapet' | 'median' | 'guardrail' | 'circuit', road }
    walls: [],      // { pts: [[x, n, yBottom, yTop]], kind, thickness, road }
    pillars: [],    // { x, n, y0, y1, w, cap: { len, tx, tn, depth } | null, road }
    ceilings: [],   // { road, i0, i1, ys: [], margin }
    fascias: [],    // { a: [x, n], b: [x, n], y0, y1 }  cover edges across a trench
    fences: [],     // { pts: [[x, n, y]], height }
    closures: [],   // { x, n, y, tx, tn, width, text }
    lamps: [],      // { x, n, y, kind, tx, tn, side }
    decks: [],      // { poly: ring, y, depth } — street bridges over the canal
  };

  for (const r of roads) annotate(r, ground);
  for (const r of roads) roadStructures(r, index, ground, layout, out);
  covers(roads, out, index);
  quays(layout, index, out);
  out.index = index;
  out.ground = ground;
  return out;
}

/** Ground under each centreline sample, and how the deck is carried. */
function annotate(r, ground) {
  for (const p of r.samples) {
    const k = ground.kindAt(p.x, p.n);
    p.gk = k;
    p.g = k === 'hole' ? p.y : ground.heightAt(p.x, p.n, k);
    const rel = p.covered ? 0 : p.y - p.g;
    p.carry = rel > 4.5 ? 'deck' : rel > 0.3 ? 'fill' : 'none';
  }
}

function classify(r, p, side, index, ground) {
  const qx = p.x + side * p.lx * (r.half + PROBE);
  const qn = p.n + side * p.ln * (r.half + PROBE);
  let merge = false, lower = null, higher = null, aboveInTunnel = false;
  for (const o of index.surfacesAt(qx, qn, 0)) {
    // Itself, unless it is another stretch of it: a hairpin's other leg.
    if (o.road === r && Math.abs(o.s - p.s) < r.width * 3) continue;
    const dy = o.y - p.y;
    // A ramp joining in the tunnel merges like anywhere else. Up to a step
    // a car could stumble over, no wall: the data's ramps often land a metre
    // off the carriageway they join, and a wall there stands in its lanes.
    if (Math.abs(dy) < MERGE) merge = true;
    else if (o.covered) { if (dy > 0 && dy < HEADROOM) aboveInTunnel = true; continue; }
    else if (dy < 0) { if (!lower || o.y > lower.y) lower = o; }
    else if (!higher || o.y < higher.y) higher = o;
  }
  if (merge) return { kind: 'merge' };
  // Two bores diverging under the ground: the lower one's wall would stand
  // in the upper one's lanes.
  if (p.covered && aboveInTunnel) return { kind: 'under' };
  if (p.covered) return { kind: p.tunnel ? 'tunnel' : 'covered' };
  const gk = ground.kindAt(qx, qn);
  if (gk === 'hole') {
    if (lower) {
      // A road alongside and below (a ramp over the main lanes) gets a skirt
      // down to it. A road crossing underneath gets nothing: the deck spans
      // it, and a skirt would be a wall across its carriageway.
      // So does one far enough below to drive under the deck: a skirt there
      // would be a wall standing on its lanes.
      const q = lower.road.samples[lower.i];
      if (Math.abs(q.tx * p.tx + q.tn * p.tn) < 0.7 || p.y - lower.y > HEADROOM) return { kind: 'viaduct', g: lower.y };
      return { kind: 'over', to: lower.y };
    }
    if (higher) return { kind: 'under' };
    return { kind: 'void', to: p.y + DEEP };
  }
  const g = ground.heightAt(qx, qn, gk);
  const rel = p.y - g;
  if (gk === 'water') return { kind: rel > 1.5 ? 'water' : 'grade', g };
  if (rel > 4.5) return { kind: 'viaduct', g };
  // Carved ground sits 25 cm under the asphalt: that is not an embankment.
  if (rel > 0.6) {
    if (lower && lower.y > g + 0.3 && p.y - lower.y <= HEADROOM) return { kind: 'over', to: lower.y };
    return { kind: 'embankment', g };
  }
  if (rel < -0.3) {
    if (higher && higher.y - p.y < 3) return { kind: 'under' };
    // A road crossing over at ground level: the wall stops under its deck,
    // and no fence stands across its lanes.
    if (higher && higher.y - g < 2) return { kind: 'sunken', g: Math.min(g, higher.y - 1.2), under: true };
    return { kind: 'sunken', g };
  }
  return { kind: 'grade', g };
}

function roadStructures(r, index, ground, layout, out) {
  const map = layout.map;
  const S = r.samples;
  const rules = r.rules;
  const deck = rules.deck;
  const barrierKind = r.cls === 'bridge' ? 'parapet' : 'jersey';

  for (const side of [1, -1]) {
    const kinds = S.map((p) => classify(r, p, side, index, ground));
    // Smooth out single-sample flickers so walls do not stutter.
    for (let i = 1; i + 1 < kinds.length; i++) {
      if (kinds[i - 1].kind === kinds[i + 1].kind && kinds[i].kind !== kinds[i - 1].kind) {
        kinds[i] = { ...kinds[i - 1] };
      }
    }
    const at = (p, off) => [p.x + side * p.lx * off, p.n + side * p.ln * off];

    runsOf(kinds, (k) => k.kind, (kind, i0, i1) => {
      const seg = S.slice(i0, i1 + 1);
      const ks = kinds.slice(i0, i1 + 1);
      if (seg.length < 2) return;
      const barrier = rules.barriers && ['viaduct', 'water', 'embankment', 'over', 'void'].includes(kind);
      if (kind === 'viaduct' || kind === 'water') {
        out.walls.push({ kind: 'fascia', road: r.id, side, thickness: 0.35,
          pts: seg.map((p) => [...at(p, r.half - 0.17), p.y - deck, p.y + 0.02]) });
      } else if (kind === 'embankment') {
        out.walls.push({ kind: 'skirt', road: r.id, side, thickness: 0.4,
          pts: seg.map((p, j) => [...at(p, r.half - 0.2), Math.min(ks[j].g, p.y) - 0.4, p.y + 0.02]) });
      } else if (kind === 'over' || kind === 'void') {
        out.walls.push({ kind: 'skirt', road: r.id, side, thickness: 0.4,
          pts: seg.map((p, j) => [...at(p, r.half - 0.2), Math.min(ks[j].to, p.y) - 0.4, p.y + 0.02]) });
      } else if (kind === 'sunken') {
        out.walls.push({ kind: 'retaining', road: r.id, side, thickness: 0.6,
          pts: seg.map((p, j) => [...at(p, r.half + WALL_OFFSET + 0.3), p.y - 0.5, ks[j].g + 0.05]) });
        // A fence on the street side wherever the drop is worth falling into.
        // Split where a road passes over.
        let run = [], deep = false;
        const flush = () => {
          if (run.length >= 2 && deep) out.fences.push({ height: 1.6, pts: run });
          run = []; deep = false;
        };
        seg.forEach((p, j) => {
          const f = at(p, r.half + WALL_OFFSET + 0.45);
          const over = index.surfacesAt(f[0], f[1], 1.5).some((o) => o.road !== r && o.y > ks[j].g - 1.5);
          if (ks[j].under || over) { flush(); return; }
          run.push([...f, ks[j].g + 0.05]);
          if (ks[j].g - p.y > 1.2) deep = true;
        });
        flush();
      } else if (kind === 'covered' || kind === 'tunnel') {
        out.walls.push({ kind: 'tunnel', road: r.id, side, thickness: 0.6,
          pts: seg.map((p) => [...at(p, r.half + WALL_OFFSET + 0.3), p.y - 0.5, ceilingY(p) + 0.1]) });
      } else if (kind === 'drop') {
        out.barriers.push({ kind: 'guardrail', road: r.id, pts: seg.map((p) => [...at(p, r.half - 0.3), p.y]) });
      } else if (kind === 'grade' && r.cls === 'circuit') {
        out.barriers.push({ kind: 'circuit', road: r.id, pts: seg.map((p) => [...at(p, r.half + 2.2), p.y]) });
      }
      if (barrier) {
        out.barriers.push({ kind: barrierKind, road: r.id, pts: seg.map((p) => [...at(p, r.half - 0.35), p.y]) });
      }
    });
  }

  // Median barrier down the middle of a dual carriageway, wherever the road
  // is not merging into a street at either end.
  if (r.median) {
    const pts = [];
    const flush = () => { if (pts.length >= 2) out.barriers.push({ kind: 'median', road: r.id, pts: pts.splice(0) }); else pts.length = 0; };
    for (const p of S) {
      const nearEnd = (p.s < 25 || p.s > r.length - 25) && Math.abs(p.y - p.g) < 0.5;
      if (nearEnd || p.s < (r.medianFrom || 0)) flush(); else pts.push([p.x, p.n, p.y]);
    }
    flush();
  }

  // Pillars under decks, clear of streets and of any road running underneath.
  if (rules.pillar) {
    let next = rules.pillar / 2;
    const custom = r.structure === 'jacques-cartier';
    for (const p of S) {
      if (p.s < next) continue;
      if (p.carry !== 'deck') continue;
      if (custom && p.gk === 'water') continue;   // the truss spans the river
      next = p.s + rules.pillar;
      const y0 = p.gk === 'water' ? p.g - 4 : p.g - 0.5;
      const w = rules.column;
      const wide = r.width >= 16;
      const pillar = {
        road: r.id, x: p.x, n: p.n, y0, y1: p.y - deck, w,
        cap: wide ? { len: r.width - 3, tx: p.lx, tn: p.ln, depth: Math.min(2.2, deck + 0.8) } : null,
        twin: custom,
      };
      // Every column, not just the centreline, must stand clear of a street
      // or a road running underneath.
      const pad = w / 2 + 1.5;
      const blocked = pillarColumns(pillar).some(([cx, cn]) =>
        index.surfacesAt(cx, cn, pad).some((o) => o.road !== r && o.y < p.y - 2)
        || layout.streetsAt(cx, cn, pad).some((st) => st.cls !== 'apron'));
      if (blocked) { next = p.s + 6; continue; }
      out.pillars.push(pillar);
    }
  }

  // Lighting.
  lampsFor(r, out);

  // Where the zone cuts a road, a barrier says so.
  if (r.closedEnd) {
    const p = S[Math.max(0, S.length - 5)];
    out.closures.push({ x: p.x, n: p.n, y: p.y, tx: p.tx, tn: p.tn, lx: p.lx, ln: p.ln, width: r.width, text: r.closure || 'Fin de la zone' });
  }
  if (r.closedStart) {
    const p = S[Math.min(S.length - 1, 4)];
    out.closures.push({ x: p.x, n: p.n, y: p.y, tx: -p.tx, tn: -p.tn, lx: -p.lx, ln: -p.ln, width: r.width, text: r.closure || 'Fin de la zone' });
  }
}

/** Where a pillar's columns stand: one on the centreline, or two for a twin. */
export function pillarColumns(p) {
  if (!p.twin) return [[p.x, p.n]];
  const ux = p.cap ? p.cap.tx : 1, un = p.cap ? p.cap.tn : 0;
  return [[p.x - ux * TWIN, p.n - un * TWIN], [p.x + ux * TWIN, p.n + un * TWIN]];
}

function ceilingY(p) {
  return Math.min((p.gs ?? 0) - 1.2, p.y + 6.4);
}

/** Lamp posts: masts in the median, poles on ramps, lanterns on bridges. */
function lampsFor(r, out) {
  const S = r.samples;
  const add = (p, kind, side = 0, off = 0) => {
    out.lamps.push({ x: p.x + side * p.lx * off, n: p.n + side * p.ln * off, y: p.y, gs: p.gs, kind,
      tx: p.tx, tn: p.tn, lx: p.lx * (side || 1), ln: p.ln * (side || 1), road: r.id });
  };
  const every = (step, fn) => {
    let next = step / 2;
    for (const p of S) {
      if (p.s < next) continue;
      next = p.s + step;
      fn(p);
    }
  };
  if (r.cls === 'highway') {
    every(44, (p) => { if (!p.covered) add(p, r.median && p.s >= (r.medianFrom || 0) ? 'mast' : 'pole', 1, r.half - 0.5); });
    every(9, (p) => { if (p.tunnel) { add(p, 'tunnel', 1, r.half - 2.5); add(p, 'tunnel', -1, r.half - 2.5); } });
  } else if (r.cls === 'ramp') {
    every(36, (p) => { if (!p.covered) add(p, 'pole', -1, r.half - 0.4); });
  } else if (r.cls === 'bridge') {
    every(32, (p) => { add(p, 'lantern', 1, r.half - 0.4); add(p, 'lantern', -1, r.half - 0.4); });
  } else if (r.cls === 'mountain') {
    every(48, (p) => add(p, 'pole', 1, r.half + 0.6));
  } else if (r.cls === 'road') {
    every(40, (p) => add(p, 'pole', 1, r.half + 0.6));
  } else if (r.cls === 'circuit') {
    every(70, (p) => add(p, 'flood', 1, r.half + 4));
  }
}

/**
 * Covers: ceilings over tunnels and under streets, the face of each cover
 * where the trench opens again, and the railing along the street's edge.
 */
function covers(roads, out, index) {
  for (const r of roads) {
    const S = r.samples;
    runsOf(S, (p) => (p.covered ? 'c' : 'o'), (k, i0, i1) => {
      if (k !== 'c') return;
      out.ceilings.push({ road: r.id, i0, i1, ys: S.slice(i0, i1 + 1).map(ceilingY), margin: WALL_OFFSET + 0.6 });
      for (const [ic, io] of [[i0, i0 - 1], [i1, i1 + 1]]) {
        if (io < 0 || io >= S.length) continue;
        const p = S[ic], o = S[io];
        if (o.y - o.gs > -0.3) continue;       // the road came up to street level
        const w = r.half + WALL_OFFSET + 0.6;
        const a = [p.x + p.lx * w, p.n + p.ln * w], b = [p.x - p.lx * w, p.n - p.ln * w];
        out.fascias.push({ a, b, y0: ceilingY(p), y1: p.gs + 0.05, face: io > ic ? 1 : -1, tx: p.tx, tn: p.tn });
        // No railing where another road runs across the cover at street level.
        const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        const crossed = [a, m, b].some(([x, n]) => index.surfacesAt(x, n, 1.5).some((q) => q.road !== r && Math.abs(q.y - p.gs) < 2.5));
        if (!crossed) out.fences.push({ height: 1.3, pts: [[a[0], a[1], p.gs + 0.05], [b[0], b[1], p.gs + 0.05]] });
      }
    });
  }
}

/**
 * Shores: a wall from the ground down under the water along every body of
 * water, and a railing on top where the drop is worth one — except where a
 * bridge or a street leaves the land, and along the zone's own edge.
 */
function quays(layout, index, out) {
  const W = layout.map.world, T = layout.terrain;
  const onEdge = (x, n) => Math.abs(x - W.x0) < 1 || Math.abs(x - W.x1) < 1 || Math.abs(n - W.n0) < 1 || Math.abs(n - W.n1) < 1;
  const tmp = [];
  for (const body of layout.waterBodies) {
    for (const poly of body.poly) {
      for (const ring of poly) {
        const R = G.openRing(ring);
        let wall = [], rail = [];
        const flushWall = () => { if (wall.length >= 2) out.walls.push({ kind: 'quay', thickness: 1.0, pts: wall }); wall = []; };
        const flushRail = () => { if (rail.length >= 2) out.fences.push({ height: 1.1, kind: 'rail', pts: rail }); rail = []; };
        for (let i = 0; i < R.length; i++) {
          const a = R[i], b = R[(i + 1) % R.length];
          if (onEdge(a[0], a[1]) && onEdge(b[0], b[1])) { flushWall(); flushRail(); continue; }
          const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
          if (len < 0.01) continue;
          const steps = Math.max(1, Math.ceil(len / 4));
          // Outward normal of the water: the side that is land.
          let nx = (b[1] - a[1]) / len, nn = -(b[0] - a[0]) / len;
          const mx = (a[0] + b[0]) / 2, mn = (a[1] + b[1]) / 2;
          if (layout.waterAt(mx + nx * 1.5, mn + nn * 1.5)) { nx = -nx; nn = -nn; }
          for (let k = 0; k <= steps; k++) {
            if (k === steps && i + 1 < R.length) continue;
            const x = a[0] + ((b[0] - a[0]) * k) / steps, n = a[1] + ((b[1] - a[1]) * k) / steps;
            const top = T.height(x + nx * 0.6, n + nn * 0.6);
            wall.push([x + nx * 0.5, n + nn * 0.5, body.level - 2.5, top + 0.05]);
            const bridged = index.surfacesAt(x + nx * 1.2, n + nn * 1.2, 1.5).length > 0
              || layout.streetsAt(x + nx * 1.2, n + nn * 1.2, 0.5, tmp).length > 0;
            if (bridged || top - body.level < 1.2) flushRail(); else rail.push([x + nx * 0.9, n + nn * 0.9, top + 0.05]);
          }
        }
        flushWall();
        flushRail();
      }
    }
  }
}

/** Call fn(key, i0, i1) for each maximal run of equal keys. */
export function runsOf(list, keyOf, fn) {
  let start = 0;
  for (let i = 1; i <= list.length; i++) {
    if (i === list.length || keyOf(list[i]) !== keyOf(list[start])) {
      fn(keyOf(list[start]), start, i - 1);
      start = i;
    }
  }
}

export { ceilingY };
