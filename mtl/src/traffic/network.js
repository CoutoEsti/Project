// The road network as traffic sees it: nodes where ways meet, edges between
// them, lanes as lateral offsets along each edge, and what controls each
// junction (lights, stops, nothing). Pure logic, no three.js: the host of a
// multiplayer game and a headless test build the very same network from the
// same map, so ids agree everywhere.
//
// Nodes are the vertices OpenStreetMap shares between ways (and the ends of
// ways): a street crossing another at grade shares a node, a bridge over a
// highway does not. Edges carry no geometry until a car needs it (centre()).

import { Grid, hash01 } from '../map/geom.js';

// Free-flow speeds, m/s: Montréal's limits (40 on side streets, 50 on
// arteries, 100 on the autoroutes).
const SPEED = {
  street: 11.1, avenue: 13.9, boulevard: 13.9, narrow: 8.3,
  highway: 27.8, ramp: 16.7, bridge: 19.4, road: 13.9,
};
// Which approach keeps going at a junction without lights: the higher rank.
// Ramps always give way (they end at a street or merge onto a highway).
const RANK = { highway: 10, bridge: 6, ramp: 0 };
const SIGNAL_REACH = 20;    // a signal head this close to a junction runs it (real metres)
const STOP_SETBACK = 3.5;   // stop line ahead of the crossing street's edge, as the paint (map/markings.js)

// Light cycle, seconds: each axis of a junction in turn (two at a plain
// crossing), green, yellow, then a second of all red.
const PHASE = 26;
const GREEN = 22, YELLOW = 3;
const AXIS_SPREAD = Math.PI / 6;   // approaches within 30° (either way) share an axis

export function buildNetwork(layout) {
  const s = layout.map.scale;
  const T = layout.terrain;

  // --- the ways traffic drives ---------------------------------------------------
  const lines = [];
  for (const st of layout.streets) {
    if (st.cls === 'alley' || st.cls === 'plaza') continue;
    lines.push({ pts: st.path, street: st, cls: st.cls, oneway: st.oneway, width: st.width, rank: st.rank || 0 });
  }
  for (const r of layout.roads) {
    if (r.cls === 'circuit' || !r.samples || r.samples.length < 2) continue;
    const cls = r.street ? 'road' : r.cls;
    lines.push({ pts: r.pts, road: r, cls, oneway: r.oneway, width: r.width,
      rank: r.street ? r.priority : RANK[cls] ?? r.priority, lanes: r.lanes });
  }

  // --- nodes: shared vertices -------------------------------------------------------
  // Ways that share a vertex carry the very same coordinates, so a rounded
  // key finds them; plain arrays, there are ~10^5 vertices. Only the shared
  // ones and the ends of ways become nodes.
  const ids = new Map();
  const cx = [], cn = [], shared = [];
  const cluster = (x, n) => {
    const k = Math.round(x * 4) * 4194304 + Math.round(n * 4);
    const id = ids.get(k);
    if (id !== undefined) { shared[id] = 1; return id; }
    ids.set(k, cx.length);
    cx.push(x); cn.push(n); shared.push(0);
    return cx.length - 1;
  };
  const vids = lines.map((L) => L.pts.map((p) => cluster(p[0], p[1])));
  const nodes = [];
  const nodeOf = new Map();
  const node = (id) => {
    let o = nodeOf.get(id);
    if (!o) {
      o = { id: nodes.length, x: cx[id], n: cn[id], edges: [], in: [], out: [] };
      nodes.push(o);
      nodeOf.set(id, o);
    }
    return o;
  };

  // --- edges: the stretches between nodes --------------------------------------------
  const edges = [];
  lines.forEach((L, li) => {
    const V = vids[li], last = V.length - 1;
    let start = 0;
    for (let k = 1; k <= last; k++) {
      if (k !== last && !shared[V[k]]) continue;
      if (V[k] === V[start] && k - start < 2) { start = k; continue; }
      const a = node(V[start]), b = node(V[k]);
      const pts = L.pts.slice(start, k + 1).map((p) => [p[0], p[1]]);
      pts[0] = [a.x, a.n];
      pts[pts.length - 1] = [b.x, b.n];
      let len = 0;
      for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      if (len > 0.5) edges.push(makeEdge(edges.length, L, a, b, pts, len, s));
      start = k;
    }
  });

  // Road edges take their heights and curves from the road's own samples.
  // The edges of one road come in order, so a cursor finds them.
  const cursor = new Map();
  for (const e of edges) {
    if (!e.road) continue;
    const S = e.road.samples;
    const from = cursor.get(e.road) || 0;
    e.i0 = nearestSample(S, e.pts[0], from);
    e.i1 = nearestSample(S, e.pts[e.pts.length - 1], e.i0);
    cursor.set(e.road, e.i1);
  }

  // --- edge directions: what a car drives ------------------------------------------------
  // ed = edge * 2 + dir; dir 0 runs a → b.
  for (const e of edges) {
    const a = nodes[e.a], b = nodes[e.b];
    a.edges.push(e.id);
    b.edges.push(e.id);
    if (e.lanes[0]) { a.out.push(e.id * 2); b.in.push(e.id * 2); }
    if (e.lanes[1]) { b.out.push(e.id * 2 + 1); a.in.push(e.id * 2 + 1); }
  }

  // --- junction control ------------------------------------------------------------------
  const signals = new Grid(32);
  for (const f of layout.map.furniture || []) if (f.kind === 'signal') signals.insert(f, f.x, f.n, f.x, f.n);
  const reach = SIGNAL_REACH * s;
  const tmp = [];
  for (const o of nodes) {
    const deg = o.edges.length;
    o.control = 'none';
    if (deg < 3) continue;
    const es = o.edges.map((id) => edges[id]);
    // Where a ramp meets a highway, nobody stops: cars merge.
    if (es.some((e) => e.cls === 'highway') || es.every((e) => e.cls === 'ramp')) { o.control = 'merge'; continue; }
    let lit = false;
    for (const f of signals.query(o.x, o.n, reach, tmp)) {
      if (Math.hypot(f.x - o.x, f.n - o.n) < reach) { lit = true; break; }
    }
    const top = Math.max(...es.map((e) => e.rank));
    o.top = top;
    o.allWay = es.every((e) => e.rank === top);
    o.control = lit ? 'signal' : 'stop';
    // How far back each approach stops: clear of the widest crossing way.
    o.clear = Math.max(...es.map((e) => e.width / 2)) + STOP_SETBACK * s;
  }
  // Lights a few metres apart (a boulevard's two carriageways, a dog-leg)
  // run as one: same cycle, so a car through the first green is not caught
  // by a red in the middle of the box.
  const lit = nodes.filter((o) => o.control === 'signal');
  const near = new Grid(64);
  for (const o of lit) near.insert(o, o.x, o.n, o.x, o.n);
  const root = new Map(lit.map((o) => [o.id, o.id]));
  const find = (id) => { while (root.get(id) !== id) id = root.get(id); return id; };
  for (const o of lit) {
    for (const p of near.query(o.x, o.n, 40 * s, tmp)) {
      if (p === o || Math.hypot(p.x - o.x, p.n - o.n) > 40 * s) continue;
      const a = find(o.id), b = find(p.id);
      if (a !== b) root.set(Math.max(a, b), Math.min(a, b));
    }
  }
  // Light phases: the cluster's approaches sorted into axes (two at a plain
  // crossing, three where a diagonal street comes in), each axis green in
  // turn. Every approach of the cluster shares them, so two ways that cross
  // are never green together, whichever of its junctions they enter by.
  const members = new Map();
  for (const o of lit) {
    const r = find(o.id);
    if (!members.has(r)) members.set(r, []);
    members.get(r).push(o);
  }
  for (const [r, group] of members) {
    const aps = [];
    for (const o of group) for (const ed of o.in) aps.push({ o, ed, h: approach(edges[ed >> 1], ed & 1), rank: edges[ed >> 1].rank });
    aps.sort((p, q) => q.rank - p.rank || p.ed - q.ed);
    const axes = [];
    for (const ap of aps) {
      let k = axes.findIndex((h) => fold(ap.h - h) < AXIS_SPREAD);
      if (k < 0) { k = axes.length; axes.push(ap.h); }
      ap.phase = k;
    }
    const phases = Math.max(2, axes.length);
    for (const o of group) {
      o.phases = phases;
      o.offset = hash01(r, 7) * PHASE * phases;
      o.group = new Map();
    }
    for (const ap of aps) ap.o.group.set(ap.ed, ap.phase);
  }

  // Where each edge's drivable run starts and ends: short of the junction box.
  for (const e of edges) {
    const trim = (o) => (o.control === 'signal' || o.control === 'stop' ? Math.min(o.clear, e.len * 0.42) : 0);
    e.t0 = trim(nodes[e.a]);
    e.t1 = trim(nodes[e.b]);
  }

  // --- spatial index, for spawning around a player -------------------------------------------
  const grid = new Grid(64);
  for (const e of edges) {
    let x0 = Infinity, n0 = Infinity, x1 = -Infinity, n1 = -Infinity;
    for (const [x, n] of e.pts) { x0 = Math.min(x0, x); n0 = Math.min(n0, n); x1 = Math.max(x1, x); n1 = Math.max(n1, n); }
    grid.insert(e, x0, n0, x1, n1);
  }

  const net = { nodes, edges, grid, scale: s, centre: (e) => centre(e, T) };
  return net;
}

function makeEdge(id, L, a, b, pts, len, s) {
  const w = L.width, h = w / 2;
  let lanes, offsets;
  if (L.oneway) {
    const n = L.road ? Math.max(1, L.lanes || 1) : Math.max(1, Math.floor(w / s / 3.5));
    const edge = Math.min(0.6, h * 0.12);
    const lw = (w - 2 * edge) / n;
    lanes = [n, 0];
    offsets = [Array.from({ length: n }, (_, k) => h - edge - lw * (k + 0.5)), []];
  } else {
    let n = 1, med = 0;
    if (L.cls === 'boulevard') { med = w / s >= 24 ? 1.1 : 0.12; n = Math.max(1, Math.floor((h / s - med) / 3.5)); }
    else if (L.cls === 'avenue') { med = 0.12; n = w / s >= 16 ? 2 : 1; }
    else if (L.road && L.lanes >= 2 && L.cls === 'bridge') n = Math.max(1, Math.floor(L.lanes / 2));
    med *= s;
    const lw = (h - med) / n;
    const side = Array.from({ length: n }, (_, k) => -(med + lw * (k + 0.5)));
    lanes = [n, n];
    offsets = [side, side];
  }
  return {
    id, a: a.id, b: b.id, pts, len, plen: len, cls: L.cls, rank: L.rank, width: w,
    street: L.street || null, road: L.road || null,
    lanes, offsets, speed: SPEED[L.cls] || SPEED.street, geo: null, t0: 0, t1: 0,
  };
}

function nearestSample(S, [x, n], from) {
  let best = from, bd = Infinity;
  for (let i = from; i < S.length; i++) {
    const d = (S[i].x - x) ** 2 + (S[i].n - n) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  if (bd > 25 && from > 0) return nearestSample(S, [x, n], 0);
  return best;
}

/** Heading (compass radians) of a car arriving at the far end of ed. */
export function arrival(e, dir) {
  const P = e.pts, m = P.length;
  const [p, q] = dir ? [P[1], P[0]] : [P[m - 2], P[m - 1]];
  return Math.atan2(q[0] - p[0], q[1] - p[1]);
}

/**
 * The centreline of an edge, a → b, built once on first use: points every
 * few metres with height, arc length and left normal.
 */
function centre(e, T) {
  if (e.geo) return e.geo;
  let P = [];
  if (e.road && e.i1 > e.i0 + 1) {
    const S = e.road.samples;
    for (let i = e.i0; i <= e.i1; i++) P.push([S[i].x, S[i].n, S[i].y]);
  } else if (e.road) {
    const S = e.road.samples;
    const y0 = S[e.i0].y, y1 = S[e.i1].y;
    P = densify(e.pts, 4).map((p, i, A) => [p[0], p[1], y0 + (y1 - y0) * (i / Math.max(1, A.length - 1))]);
  } else {
    P = densify(e.pts, 4).map((p) => [p[0], p[1], T.height(p[0], p[1])]);
  }
  const m = P.length;
  const xs = new Float64Array(m), ns = new Float64Array(m), ys = new Float64Array(m), ss = new Float64Array(m);
  const lx = new Float64Array(m), ln = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    xs[i] = P[i][0]; ns[i] = P[i][1]; ys[i] = P[i][2];
    if (i) ss[i] = ss[i - 1] + Math.hypot(xs[i] - xs[i - 1], ns[i] - ns[i - 1]);
  }
  for (let i = 0; i < m; i++) {
    const a = Math.max(0, i - 1), b = Math.min(m - 1, i + 1);
    const tx = xs[b] - xs[a], tn = ns[b] - ns[a], l = Math.hypot(tx, tn) || 1;
    lx[i] = -tn / l; ln[i] = tx / l;
  }
  // The edge length is the centreline's: the samples of a road curve.
  e.len = ss[m - 1];
  e.geo = { xs, ns, ys, ss, lx, ln, m };
  return e.geo;
}

function densify(pts, step) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const k = Math.max(1, Math.ceil(l / step));
    for (let j = 1; j <= k; j++) out.push([a[0] + ((b[0] - a[0]) * j) / k, a[1] + ((b[1] - a[1]) * j) / k]);
  }
  return out;
}

/**
 * The light an approach sees at time t: 'g', 'y' or 'r'. A pure function of
 * the shared clock, so every player sees the same lights without a byte sent.
 */
export function lightAt(node, ed, t) {
  const g = node.group ? node.group.get(ed) || 0 : 0;
  const cycle = PHASE * (node.phases || 2);
  let u = (t + node.offset - g * PHASE) % cycle;
  if (u < 0) u += cycle;
  if (u >= PHASE) return 'r';
  if (u < GREEN) return 'g';
  if (u < GREEN + YELLOW) return 'y';
  return 'r';
}

/**
 * The direction an approach comes from, over its last ~15 m: the very last
 * segment of a way is often a short kink that says nothing of the street.
 */
function approach(e, dir) {
  const P = dir ? e.pts.slice().reverse() : e.pts;
  const b = P[P.length - 1];
  let i = P.length - 1, d = 0;
  while (i > 0 && d < 15) { d += Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]); i--; }
  return Math.atan2(b[0] - P[i][0], b[1] - P[i][1]);
}

/** Angle between two directions as lines (0 to π/2): opposite ways are one axis. */
function fold(a) {
  const d = Math.abs(a) % Math.PI;
  return d > Math.PI / 2 ? Math.PI - d : d;
}

/** Heading (compass radians) of a car leaving the near end of ed. */
export function departure(e, dir) {
  const P = e.pts, m = P.length;
  const [p, q] = dir ? [P[m - 1], P[m - 2]] : [P[0], P[1]];
  return Math.atan2(q[0] - p[0], q[1] - p[1]);
}

/**
 * The drivable run of an edge direction: from the stop line at its start
 * node (s0) to the one at its end node (s1), in its own arc length.
 */
export function span(net, ed, out = {}) {
  const e = net.edges[ed >> 1], dir = ed & 1;
  net.centre(e);
  out.e = e;
  out.dir = dir;
  out.len = e.len;
  out.s0 = dir ? e.t1 : e.t0;
  out.s1 = Math.max(out.s0, e.len - (dir ? e.t0 : e.t1));
  out.from = dir ? e.b : e.a;
  out.to = dir ? e.a : e.b;
  out.lanes = e.lanes[dir];
  out.offsets = e.offsets[dir];
  return out;
}

/**
 * Where a car is at arc length s along an edge direction, `lat` metres left
 * of the centreline: position, height, heading and pitch.
 */
export function pointOn(net, ed, s, lat, out) {
  const e = net.edges[ed >> 1], dir = ed & 1;
  const g = net.centre(e);
  const L = e.len;
  let se = dir ? L - s : s;
  se = se < 0 ? 0 : se > L ? L : se;
  const { ss, xs, ns, ys, lx, ln, m } = g;
  let lo = 0, hi = m - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ss[mid] <= se) lo = mid; else hi = mid;
  }
  const d = ss[hi] - ss[lo];
  const t = d > 1e-9 ? (se - ss[lo]) / d : 0;
  const sg = dir ? -1 : 1;
  const nx = lx[lo] + (lx[hi] - lx[lo]) * t, nn = ln[lo] + (ln[hi] - ln[lo]) * t;
  out.x = xs[lo] + (xs[hi] - xs[lo]) * t + nx * lat * sg;
  out.n = ns[lo] + (ns[hi] - ns[lo]) * t + nn * lat * sg;
  out.y = ys[lo] + (ys[hi] - ys[lo]) * t;
  const tx = (xs[hi] - xs[lo]) * sg, tn = (ns[hi] - ns[lo]) * sg;
  out.h = Math.atan2(tx, tn);
  out.p = d > 1e-9 ? Math.atan2((ys[hi] - ys[lo]) * sg, d) : 0;
  return out;
}

/** A short link between two lit junctions (a boulevard's median): one box with the first. */
export function insideBox(net, ed) {
  const e = net.edges[ed >> 1];
  return e.plen < 30 * net.scale && net.nodes[ed & 1 ? e.b : e.a].control === 'signal';
}
