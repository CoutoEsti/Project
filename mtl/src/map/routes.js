// Roads kept one by one: a zone (map/zones.js) can hold, beside its polygons,
// routes — a centre line along real streets and a half width — and the zone is
// then the polygons plus a corridor around each route. The drawing tool
// (zones.html) finds routes with the graph below: two clicks on the plan, and
// the way between them along the streets.
//
// Pure logic, no THREE, no DOM: the same frame as map/zones.js (real metres,
// origin at Peel and Sainte-Catherine).

import * as G from './geom.js';

/** Street widths in real metres: [two-way, one-way]. map/real.js builds with these. */
export const WIDTH = {
  motorway: [23, 12.4], trunk: [18, 9], primary: [19, 11], secondary: [15, 9.5], tertiary: [13, 8.5],
  residential: [11, 8], unclassified: [10, 7.5], living_street: [7, 6], pedestrian: [8, 8], alley: [5, 5],
};
export const LINK_WIDTH = 6.8;

/** Room kept on each side of a route's carriageway: sidewalks, walls, barriers. */
export const ROUTE_MARGIN = 9;

/** Half the width of a road as built, real metres. */
export function roadHalf(r) {
  if (r.kind === 'link') return LINK_WIDTH / 2;
  if (r.kind === 'alley') return WIDTH.alley[0] / 2;
  return (WIDTH[r.cls] || WIDTH.residential)[r.oneway ? 1 : 0] / 2;
}

/** The corridor a route keeps: its centre line widened by `h`, as a multipolygon. */
export function routeCorridor(route) {
  const pts = G.simplify(route.pts, 0.5);
  if (pts.length < 2) return [];
  return G.bufferPolyline(pts, route.h, 0);
}

// --------------------------------------------------------------- graph ------

const CELL = 100;
const key = (p) => `${Math.round(p[0] * 10)},${Math.round(p[1] * 10)}`;

/**
 * The street graph: the roads (map/source.js decodeRoads) cut at every point
 * two of them share, so a path can turn wherever the streets meet.
 * Edges: { id, road, pts, from, to, len }; nodes are ids.
 */
export function buildRoadGraph(roads) {
  const seen = new Map();
  for (const r of roads) {
    const mine = new Set();
    for (const p of r.pts) mine.add(key(p));
    for (const k of mine) seen.set(k, (seen.get(k) || 0) + 1);
  }
  const nodes = new Map(), pos = [];
  const node = (p) => {
    const k = key(p);
    let id = nodes.get(k);
    if (id === undefined) { id = pos.length; nodes.set(k, id); pos.push(p); }
    return id;
  };
  const edges = [], adj = [];
  const link = (a, e, dir) => { (adj[a] || (adj[a] = [])).push({ e, dir }); };
  for (const r of roads) {
    if (r.pts.length < 2) continue;
    let start = 0;
    for (let i = 1; i < r.pts.length; i++) {
      if (i < r.pts.length - 1 && seen.get(key(r.pts[i])) < 2) continue;
      const pts = r.pts.slice(start, i + 1);
      const e = { id: edges.length, road: r, pts, from: node(pts[0]), to: node(pts[pts.length - 1]), len: length(pts) };
      edges.push(e);
      link(e.from, e, 1);
      link(e.to, e, -1);
      start = i;
    }
  }
  // A grid of segments, to find the street under a click.
  const grid = new Map();
  for (const e of edges) {
    for (let i = 0; i + 1 < e.pts.length; i++) {
      const a = e.pts[i], b = e.pts[i + 1];
      const i0 = Math.floor(Math.min(a[0], b[0]) / CELL), i1 = Math.floor(Math.max(a[0], b[0]) / CELL);
      const j0 = Math.floor(Math.min(a[1], b[1]) / CELL), j1 = Math.floor(Math.max(a[1], b[1]) / CELL);
      for (let gi = i0; gi <= i1; gi++) {
        for (let gj = j0; gj <= j1; gj++) {
          const k = gi * 65536 + gj;
          let cell = grid.get(k);
          if (!cell) grid.set(k, (cell = []));
          cell.push(e.id, i);
        }
      }
    }
  }
  return { edges, adj, pos, grid };
}

function length(pts) {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return s;
}

/**
 * The street point nearest (x, n) within `max` metres: { e, i, t, x, n, d, at }
 * — edge, segment, parameter on it, the point, its distance, and its distance
 * along the edge. `accept(edge)` filters. Null when nothing is that close.
 */
export function pickRoad(graph, x, n, max, accept = null) {
  let best = null;
  const i0 = Math.floor((x - max) / CELL), i1 = Math.floor((x + max) / CELL);
  const j0 = Math.floor((n - max) / CELL), j1 = Math.floor((n + max) / CELL);
  for (let gi = i0; gi <= i1; gi++) {
    for (let gj = j0; gj <= j1; gj++) {
      const cell = graph.grid.get(gi * 65536 + gj);
      if (!cell) continue;
      for (let k = 0; k < cell.length; k += 2) {
        const e = graph.edges[cell[k]], i = cell[k + 1];
        if (accept && !accept(e)) continue;
        const a = e.pts[i], b = e.pts[i + 1];
        const { d2, t } = G.segDist2(x, n, a[0], a[1], b[0], b[1]);
        if (d2 > max * max || (best && d2 >= best.d * best.d)) continue;
        best = { e: e.id, i, t, x: a[0] + (b[0] - a[0]) * t, n: a[1] + (b[1] - a[1]) * t, d: Math.sqrt(d2) };
      }
    }
  }
  if (best) {
    const e = graph.edges[best.e];
    best.at = length(e.pts.slice(0, best.i + 1)) + Math.hypot(best.x - e.pts[best.i][0], best.n - e.pts[best.i][1]);
  }
  return best;
}

/** The part of an edge between two distances along it, in the order asked. */
function slice(e, s0, s1) {
  const rev = s1 < s0;
  const lo = Math.min(s0, s1), hi = Math.max(s0, s1);
  const out = [];
  let s = 0;
  for (let i = 0; i + 1 < e.pts.length; i++) {
    const a = e.pts[i], b = e.pts[i + 1], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const ta = (lo - s) / (l || 1), tb = (hi - s) / (l || 1);
    if (tb >= 0 && ta <= 1) {
      const u = Math.max(0, ta), v = Math.min(1, tb);
      const p = [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u], q = [a[0] + (b[0] - a[0]) * v, a[1] + (b[1] - a[1]) * v];
      if (!out.length) out.push(p);
      out.push(q);
    }
    s += l;
  }
  return rev ? out.reverse() : out;
}

const same = (r, o) => (r.ref && r.ref === o.ref) || (r.name && r.name === o.name);

/**
 * The way along the streets from a picked point to another (pickRoad), as a
 * driver would take it: one-way streets in their direction, staying on the
 * road it starts on when it can (other streets cost 50 % more, ramps 20 %,
 * alleys and footways three times). Falls back to ignoring one-way streets.
 * Returns { pts, len, edges } or null.
 */
export function routeBetween(graph, A, B) {
  return shortest(graph, A, B, true) || shortest(graph, A, B, false);
}

function shortest(graph, A, B, oneway) {
  const { edges, adj } = graph;
  const eA = edges[A.e], eB = edges[B.e];
  const ok = (e, dir) => !oneway || !e.road.oneway || dir > 0;
  const weight = (e) => {
    const r = e.road;
    let k = same(r, eA.road) ? 1 : 1.5;
    if (r.kind === 'link') k *= 1.2;
    if (r.kind === 'alley' || r.cls === 'pedestrian') k *= 3;
    return k;
  };
  // On the same edge, going the allowed way: the piece between the two points.
  if (A.e === B.e && ok(eA, B.at >= A.at ? 1 : -1)) {
    const pts = slice(eA, A.at, B.at);
    return { pts, len: Math.abs(B.at - A.at), edges: [eA] };
  }
  const dist = new Map(), prev = new Map();
  const heap = [];
  const push = (node, d, from) => {
    if (d >= (dist.get(node) ?? Infinity)) return;
    dist.set(node, d);
    prev.set(node, from);
    heapPush(heap, [d, node]);
  };
  if (ok(eA, 1)) push(eA.to, (eA.len - A.at) * weight(eA), { start: 1 });
  if (ok(eA, -1)) push(eA.from, A.at * weight(eA), { start: -1 });
  let best = Infinity, bestEnd = null;
  while (heap.length) {
    const [d, node] = heapPop(heap);
    if (d > (dist.get(node) ?? Infinity)) continue;
    if (d >= best) break;
    // Into B's edge from this node.
    if (node === eB.from && ok(eB, 1)) { const c = d + B.at * weight(eB); if (c < best) { best = c; bestEnd = { node, dir: 1 }; } }
    if (node === eB.to && ok(eB, -1)) { const c = d + (eB.len - B.at) * weight(eB); if (c < best) { best = c; bestEnd = { node, dir: -1 }; } }
    for (const { e, dir } of adj[node] || []) {
      if (!ok(e, dir)) continue;
      push(dir > 0 ? e.to : e.from, d + e.len * weight(e), { e, dir, node });
    }
  }
  if (!bestEnd) return null;
  // Walk back: B's piece, the whole edges, A's piece.
  const parts = [];
  parts.push(bestEnd.dir > 0 ? slice(eB, 0, B.at) : slice(eB, eB.len, B.at));
  const used = [eB];
  let node = bestEnd.node;
  for (let guard = 0; guard < 100000; guard++) {
    const p = prev.get(node);
    if (p.start) {
      parts.push(p.start > 0 ? slice(eA, A.at, eA.len) : slice(eA, A.at, 0));
      used.push(eA);
      break;
    }
    parts.push(p.dir > 0 ? p.e.pts : p.e.pts.slice().reverse());
    used.push(p.e);
    node = p.node;
  }
  parts.reverse();
  const pts = [];
  for (const part of parts) for (const q of part) {
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(q[0] - last[0], q[1] - last[1]) > 0.05) pts.push(q);
  }
  return pts.length >= 2 ? { pts, len: length(pts), edges: used.reverse() } : null;
}

/**
 * The other carriageway of a divided road, between the same two places: from
 * the point across from B back to the point across from A, along one-way
 * streets of the same name or number heading the other way. Null when the
 * route is not on a divided road.
 */
export function twinRoute(graph, A, B, route) {
  const eA = graph.edges[A.e], eB = graph.edges[B.e];
  if (!eA.road.oneway || !eB.road.oneway) return null;
  const across = (P, eP) => {
    const d = direction(eP, P.at);
    return pickRoad(graph, P.x, P.n, 70, (e) => e.id !== eP.id && e.road.oneway && (same(e.road, eA.road) || same(e.road, eB.road))
      && dot(direction(e, null, P), d) < -0.6);
  };
  const A2 = across(A, eA), B2 = across(B, eB);
  if (!A2 || !B2) return null;
  const back = shortest(graph, B2, A2, true);
  if (!back || back.len > route.len * 1.6 + 200) return null;
  return back;
}

const dot = (u, v) => u[0] * v[0] + u[1] * v[1];

/** Unit direction of an edge at a distance along it, or nearest a point. */
function direction(e, at, P = null) {
  let i = 0;
  if (P) {
    let bd = Infinity;
    for (let k = 0; k + 1 < e.pts.length; k++) {
      const a = e.pts[k], b = e.pts[k + 1], d = G.segDist2(P.x, P.n, a[0], a[1], b[0], b[1]).d2;
      if (d < bd) { bd = d; i = k; }
    }
  } else {
    let s = 0;
    for (; i + 2 < e.pts.length; i++) {
      const l = Math.hypot(e.pts[i + 1][0] - e.pts[i][0], e.pts[i + 1][1] - e.pts[i][1]);
      if (s + l >= at) break;
      s += l;
    }
  }
  const a = e.pts[i], b = e.pts[i + 1], l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
}

function heapPush(h, item) {
  h.push(item);
  let i = h.length - 1;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (h[p][0] <= h[i][0]) break;
    [h[p], h[i]] = [h[i], h[p]];
    i = p;
  }
}

function heapPop(h) {
  const top = h[0], last = h.pop();
  if (h.length) {
    h[0] = last;
    let i = 0;
    for (;;) {
      const l = i * 2 + 1, r = l + 1;
      let m = i;
      if (l < h.length && h[l][0] < h[m][0]) m = l;
      if (r < h.length && h[r][0] < h[m][0]) m = r;
      if (m === i) break;
      [h[m], h[i]] = [h[i], h[m]];
      i = m;
    }
  }
  return top;
}
