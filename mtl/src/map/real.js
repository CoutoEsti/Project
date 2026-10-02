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
// ramps (see profile()). The data's tunnel bit also carries `covered`: a
// street under the Métropolitaine's viaduct is covered, not buried. Every real
// tunnel has a negative layer, so the bit only counts below ground.

import { makeZone, zoneDef, scaleZone } from './zones.js';
import { clipRoad, clipMulti } from './clip.js';
import { backdropCells } from './backdrop.js';
import { createTerrain } from './terrain.js';
import * as G from './geom.js';
import OVERLAY from './montreal.js';

/** Real metres above (below) the ground for an OSM layer. */
const LEVEL_Y = { 1: 7.6, 2: 14.2, 3: 20.8, 4: 27.4, [-1]: -8, [-2]: -13, [-3]: -18, [-4]: -22 };
const GRADE = { highway: 0.05, ramp: 0.065, bridge: 0.05, road: 0.07 };
// layout.js's limit for a lifted piece of street; steeper, it carries its own.
const STREET_GRADE = 0.08;
// A highway sunk under a street that OpenStreetMap puts on a bridge: headroom
// for a truck plus the street's deck (real metres, not scaled).
const SINK = 7.4;
// Level stretch a structure keeps between two of its lifts (or dips) before it
// is allowed back to the ground, per class, real metres: a highway does not
// dive between two overpasses 200 m apart, it stays on its embankment.
const HOLD = { highway: 400, bridge: 400, ramp: 90, road: 30 };

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
  const zone = makeZone(zoneDef(settings));
  if (!zone) throw new Error('zone vide');
  const [bx0, bn0, bx1, bn1] = zone.bbox;
  const S = (v) => v * s;
  const P = (p) => [p[0] * s, p[1] * s];
  const inZone = zone.contains;

  // --- water first: the relief's zero is the river --------------------------
  const river = src.surfaces.water.reduce((a, w) => (!a || area(w.poly) > area(a.poly) ? w : a), null);
  const base = river ? river.level : 6;
  const terrain = createTerrain(src.relief, { scale: s, base });
  const water = [];
  for (const w of src.surfaces.water) {
    const clipped = clipMulti(w.poly, zone, zone.box ? 400 : 150);
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
      const clipped = clipMulti(g.poly, zone, 0);
      if (!clipped.length) continue;
      out.push({ kind: g.kind, name: g.name, poly: clipped.map((poly) => poly.map((r) => r.map(P))) });
    }
  }

  // --- the road network --------------------------------------------------------
  const streets = [], roads = [];
  const special = OVERLAY.bridges || {};
  const sunk = sinkHighways(src.roads, special);
  const chains = chainStreets(src.roads.map((r0) => sunk.patch.get(r0) || r0), special);
  for (const r0 of src.roads) {
    const rp = sunk.patch.get(r0) || r0;
    if (chains.consumed.has(rp)) continue;
    const r = chains.merged.get(rp) || rp;
    // A motorway is one way unless tagged otherwise (OpenStreetMap's implied
    // rule); the data only says so when someone wrote it down.
    const oneway = r.oneway || r.cls === 'motorway';
    for (const piece of clipRoad(r, zone)) {
      if (piece.flags) piece.flags = piece.flags.map((f, i) => ((f & 2) && !(piece.levels && piece.levels[i] < 0) ? f & ~2 : f));
      const highway = isHighway(r);
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
          sinks: (sunk.sinks.get(r0) || []).map(P),
        });
        continue;
      }
      // An ordinary street: only its lifted stretches, plus their approaches,
      // become roads; the rest is draped on the ground.
      const need = (i) => {
        const o = Math.abs(offsetOf(level(i), false));
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
  const onStreet = streetFinder(streets);
  const highways = new G.Grid(64);     // edges of the roads done, streets aside
  const onRoad = streetFinder(roads.map((r) => ({ path: r.pts, half: r.width / 2, r })));
  for (const r of roads) {
    r.path = profile(r, terrain, waterAt, s, done, special[r.name], (x, n) => onStreet(x, n) && !onRoad(x, n, r), highways);
    done.push(r);
    if (!r.street) {
      for (let i = 0; i + 1 < r.path.length; i++) {
        const a = r.path[i], b = r.path[i + 1];
        highways.insert({ a, b }, Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1]));
      }
    }
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
  // The city beyond the edge, as blocks (drawn by world/backdrop.js).
  const backdrop = backdropCells(src.buildings, zone, s);
  return {
    meta: { ...src.meta, zone: settings.zone, echelle: settings.echelle, nomZone: zone.nom },
    // The zone at the map's scale: the edge wall, the ground and the decor follow it.
    zone: scaleZone(zone, s),
    backdrop,
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

// ---------------------------------------------------------------- chains --

/**
 * OpenStreetMap cuts a street at its bridge: the overpass is a way of its
 * own, and the approaches that climb to it belong to the ways on either side
 * (Chemin Rockland: 342 m on layer 2, the ground at both ends). Profiled way
 * by way, the deck had no room for its ramps and ended ten metres up, facing
 * a street on the ground. A lifted street way is joined here with the ways
 * that continue it straight on, until there is room for its ramps at both
 * ends, and the whole is profiled as one. Of the outermost ways it takes only
 * what the ramps need; the rest stays a street of its own, with its own width.
 *
 * `list` holds the roads as the rest of buildMap sees them (sinkHighways'
 * patches applied). Returns `merged` (a way → what to build in its place: a
 * joined copy for the lifted way, the untouched remainder for an outer one)
 * and `consumed` (ways now entirely inside a copy).
 */
function chainStreets(list, special) {
  const street = (r) => !isHighway(r) && !special[r.name] && r.kind !== 'alley' && r.kind !== 'link';
  const ends = new Map();
  const link = (c, r) => { if (c >= 0) { if (!ends.has(c)) ends.set(c, []); ends.get(c).push(r); } };
  for (const r of list) if (street(r)) { link(r.a, r); link(r.b, r); }
  const unit = (p, q) => { const dx = q[0] - p[0], dn = q[1] - p[1], l = Math.hypot(dx, dn) || 1; return [dx / l, dn / l]; };
  // Direction of a way's edge at connector c: arriving there, leaving from there.
  const into = (o, c) => { const P = o.pts, k = P.length - 1; return o.b === c ? unit(P[k - 1], P[k]) : unit(P[1], P[0]); };
  const away = (o, c) => { const P = o.pts, k = P.length - 1; return o.a === c ? unit(P[0], P[1]) : unit(P[k], P[k - 1]); };
  const length = (pts) => { let l = 0; for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return l; };
  // Real metres of ramp the highest lifted edge needs at the street grade.
  const rampFor = (r) => {
    let o = 0;
    for (let i = 0; r.levels && i < r.levels.length; i++) o = Math.max(o, r.levels[i] ? Math.abs(offsetOf(r.levels[i], false)) : 0);
    return o ? o / GRADE.road + 40 : 0;
  };
  const merged = new Map(), consumed = new Set(), used = new Set();
  for (const r of list) {
    if (!street(r) || used.has(r) || !rampFor(r)) continue;
    used.add(r);
    const chain = [{ r, rev: false }];     // rev: the way runs against the chain
    let need = rampFor(r);
    for (const forward of [true, false]) {
      let room = 0;
      let at = forward ? r.b : r.a;
      while (room < need) {
        // Forward, the next way starts where the chain ends; backward, the
        // previous one ends where it starts. A one-way street cannot turn
        // round. It goes straight on, its name may change there (Rockland's
        // overpass lands as Avenue Davaar); at a fork, the branch that keeps
        // the name, or else the clearly straighter one.
        const dir = into((forward ? chain[chain.length - 1] : chain[0]).r, at);
        const next = [];
        for (const o of ends.get(at) || []) {
          if (used.has(o) || o.a === o.b || o.oneway !== r.oneway) continue;
          const rev = forward ? o.a !== at : o.b !== at;
          if (rev && r.oneway) continue;
          const d = away(o, at);
          const dot = dir[0] * d[0] + dir[1] * d[1];
          if (dot >= 0.7) next.push({ o, rev, dot, same: o.name === r.name });
        }
        next.sort((x, y) => y.dot - x.dot);
        const same = next.filter((c) => c.same);
        const pick = same.length === 1 ? same[0]
          : next.length === 1 || (next.length > 1 && next[0].dot - next[1].dot > 0.1) ? next[0] : null;
        if (!pick) break;
        const { o, rev } = pick;
        used.add(o);
        if (forward) chain.push({ r: o, rev }); else chain.unshift({ r: o, rev });
        at = forward ? (rev ? o.a : o.b) : (rev ? o.b : o.a);
        const more = rampFor(o);
        need = Math.max(need, more);
        room = more ? 0 : room + length(o.pts);
      }
    }
    if (chain.length === 1) continue;
    // The joined line, edge data carried; `owner` is the chain piece of each edge.
    const pts = [], levels = [], flags = [], owner = [];
    chain.forEach(({ r: o, rev }, c) => {
      const P = rev ? [...o.pts].reverse() : o.pts;
      const n = o.pts.length - 1;
      const edge = (arr, i) => (arr ? arr[rev ? n - 1 - i : i] : 0);
      pts.push(...(pts.length ? P.slice(1) : P));
      for (let i = 0; i < n; i++) { levels.push(edge(o.levels, i)); flags.push(edge(o.flags, i)); owner.push(c); }
    });
    // Keep `need` of ground beyond the outermost lifted edges; what lies
    // further out in the first and last ways goes back to them.
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const up = (i) => levels[i] || (flags[i] & 1);
    let e0 = 0, e1 = levels.length - 1;
    while (e0 < levels.length && !up(e0)) e0++;
    while (e1 >= 0 && !up(e1)) e1--;
    let k0 = 0, k1 = pts.length - 1;       // vertex range kept
    // Only a neighbour gives back its far end, never the lifted way itself.
    const trimStart = chain[0].r !== r, trimEnd = chain[chain.length - 1].r !== r;
    while (trimStart && k0 + 1 < e0 && owner[k0] === 0 && cum[e0] - cum[k0 + 1] >= need) k0++;
    while (trimEnd && k1 - 1 > e1 + 1 && owner[k1 - 1] === chain.length - 1 && cum[k1 - 1] - cum[e1 + 1] >= need) k1--;
    const rest = (piece, from, to) => {
      const o = piece.r;
      const P = pts.slice(from, to + 1);
      if (P.length < 2) return null;
      const lv = levels.slice(from, to), fl = flags.slice(from, to);
      return { ...o, pts: P, levels: lv.some((v) => v) ? lv : null, flags: fl.some((v) => v) ? fl : null };
    };
    merged.set(r, {
      ...r, pts: pts.slice(k0, k1 + 1),
      levels: levels.slice(k0, k1).some((v) => v) ? levels.slice(k0, k1) : null,
      flags: flags.slice(k0, k1).some((v) => v) ? flags.slice(k0, k1) : null,
    });
    chain.forEach(({ r: o }, c) => {
      if (o === r) return;
      const left = c === 0 && k0 > 0 ? rest(chain[0], 0, k0) : c === chain.length - 1 && k1 < pts.length - 1 ? rest(chain[c], k1, pts.length - 1) : null;
      if (left) merged.set(o, left); else consumed.add(o);
    });
  }
  return { merged, consumed };
}

// -------------------------------------------------------------- trenches --

function isHighway(r) {
  return r.cls === 'motorway' || (r.cls === 'trunk' && (r.kind === 'link' || /^Autoroute/.test(r.name)));
}

/**
 * OpenStreetMap draws a street crossing a highway as a bridge one layer up,
 * the highway staying on layer 0. Taken literally, every street of the grid
 * climbs 7.6 m over Décarie or Ville-Marie on ramps a hundred metres long, and
 * the highway runs at street level: the city built it the other way round.
 * Where a street's bridge crosses an at-grade stretch of highway, the bridge
 * comes down to the ground and the highway goes under it (profile() sinks it
 * and holds it down between close crossings, which makes the trench).
 *
 * Returns `patch` (road → copy with the bridge edges put back on layer 0) and
 * `sinks` (highway → points where it must pass under a street).
 */
function sinkHighways(roads, special) {
  const grid = new G.Grid(100);
  for (const r of roads) {
    if (!isHighway(r) || special[r.name]) continue;
    for (let i = 0; i + 1 < r.pts.length; i++) {
      // At grade or already below it (an underpass OSM put on layer −1).
      const lv = r.levels ? r.levels[i] : 0;
      if (lv > 0 || (r.flags && r.flags[i] & 1)) continue;
      const a = r.pts[i], b = r.pts[i + 1];
      grid.insert({ r, a, b, sink: lv === 0 && !(r.flags && r.flags[i] & 2) }, Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1]));
    }
  }
  const patch = new Map(), sinks = new Map();
  const tmp = [];
  for (const r of roads) {
    if (isHighway(r) || special[r.name] || !r.levels) continue;
    let levels = null, flags = null;
    for (let i = 0; i + 1 < r.pts.length; i++) {
      if (r.levels[i] !== 1 || (levels && levels[i] === 0)) continue;
      const a = r.pts[i], b = r.pts[i + 1];
      const mx = (a[0] + b[0]) / 2, mn = (a[1] + b[1]) / 2;
      const reach = Math.hypot(b[0] - a[0], b[1] - a[1]) / 2;
      const hits = [];
      for (const h of grid.query(mx, mn, reach, tmp)) {
        const x = segCross(a, b, h.a, h.b);
        if (x && !hits.some((o) => o.r === h.r && Math.hypot(o.p[0] - x[0], o.p[1] - x[1]) < 1)) hits.push({ r: h.r, p: x, sink: h.sink });
      }
      if (!hits.length) continue;
      // The whole bridge comes down, not only the edge over the highway.
      levels ||= r.levels.slice();
      flags ||= r.flags ? r.flags.slice() : null;
      let i0 = i, i1 = i;
      while (i0 > 0 && r.levels[i0 - 1] === 1) i0--;
      while (i1 + 1 < r.levels.length && r.levels[i1 + 1] === 1) i1++;
      for (let k = i0; k <= i1; k++) {
        levels[k] = 0;
        if (flags) flags[k] &= ~1;
      }
      for (const h of hits) {
        if (!h.sink) continue;
        if (!sinks.has(h.r)) sinks.set(h.r, []);
        sinks.get(h.r).push(h.p);
      }
    }
    if (levels) patch.set(r, { ...r, levels, flags });
  }
  // A bridge drawn as several ways: the pieces that did not themselves cross
  // the highway come down with the one that did, or they are left up in the
  // air with nothing to climb to.
  const ends = new Map();
  const key = (p) => `${Math.round(p[0] * 2)}:${Math.round(p[1] * 2)}`;
  const lowered = (q) => patch.get(q) || q;
  for (let changed = true; changed;) {
    changed = false;
    ends.clear();
    for (const [, q] of patch) {
      const last = q.levels.length - 1;
      if (q.levels[0] === 0) ends.set(key(q.pts[0]), q.name);
      if (q.levels[last] === 0) ends.set(key(q.pts[q.pts.length - 1]), q.name);
    }
    for (const r of roads) {
      const q = lowered(r);
      if (isHighway(r) || special[r.name] || !q.levels) continue;
      const last = q.levels.length - 1;
      for (const [edge, dir, p] of [[0, 1, q.pts[0]], [last, -1, q.pts[q.pts.length - 1]]]) {
        if (q.levels[edge] !== 1 || ends.get(key(p)) !== r.name) continue;
        const levels = q.levels.slice(), flags = q.flags ? q.flags.slice() : null;
        for (let k = edge; k >= 0 && k <= last && levels[k] === 1; k += dir) {
          levels[k] = 0;
          if (flags) flags[k] &= ~1;
        }
        patch.set(r, { ...q, levels, flags });
        changed = true;
        break;
      }
    }
  }
  return { patch, sinks };
}

/** Intersection point of segments ab and cd, or null. */
function segCross(a, b, c, d) {
  const rx = b[0] - a[0], rn = b[1] - a[1], sx = d[0] - c[0], sn = d[1] - c[1];
  const den = rx * sn - rn * sx;
  if (Math.abs(den) < 1e-9) return null;
  const qx = c[0] - a[0], qn = c[1] - a[1];
  const t = (qx * sn - qn * sx) / den, u = (qx * rn - qn * rx) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return [a[0] + rx * t, a[1] + rn * t];
}

// ------------------------------------------------------------------ profile --

function offsetOf(level, highway = true) {
  // A street under an at-grade highway needs 5 m of headroom and a deck, not
  // the 8 m of a motorway trench.
  if (level === -1 && !highway) return -6.5;
  if (level) return LEVEL_Y[Math.max(-4, Math.min(4, level))];
  return 0;
}

/**
 * Control points [x, n, y] for a road: the ground under it, the layers'
 * heights on the lifted stretches, and ramps between them no steeper than the
 * class allows. The ground under a bridge or a tunnel is read at its two ends
 * and interpolated — a bridge spans its gap, it does not dip into the river.
 */
function profile(r, terrain, waterAt, s, done, spec, onStreet, highways) {
  const grade = GRADE[r.cls] || GRADE.road;
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
  const spans = (test, overland) => {
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
      if (overland) overland(i, j);
      i = j;
    }
  };
  function terrainAt(i) {
    const [x, n] = pts[i];
    return waterAt(x, n) ? g[i] : terrain.height(x, n);
  }
  const lift = new Float64Array(m);
  spans((i) => (fl[i] & 1) || wt[i], (i, j) => overGround(i, j));
  spans((i) => fl[i] & 2);

  /**
   * A bridge spans a dip but must clear a rise: a long viaduct (the
   * Métropolitaine, 5 km) climbs with the land under it. The reference under
   * vertices i..j becomes the highest of the chord and the dry ground across
   * the deck's width, lifted into an envelope no steeper than 2 % so the deck
   * rides over the bumps instead of copying them. The abutments stay put:
   * streets meet them there, and the deck leaves them no steeper than the
   * class allows, down to the old chord at worst. `lift` keeps how much each
   * vertex rose.
   */
  function overGround(i, j) {
    if (j - i < 2) return;
    const G = 0.02, half = r.width / 2;
    const chord = g.slice();
    for (let k = i + 1; k < j; k++) {
      const a = pts[k - 1], b = pts[k + 1];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const lx = -(b[1] - a[1]) / len, ln = (b[0] - a[0]) / len;
      for (const o of [0, half, -half]) {
        const x = pts[k][0] + lx * o, n = pts[k][1] + ln * o;
        if (!waterAt(x, n)) g[k] = Math.max(g[k], terrain.height(x, n));
      }
    }
    for (let k = i + 2; k < j; k++) g[k] = Math.max(g[k], g[k - 1] - (cum[k] - cum[k - 1]) * G);
    for (let k = j - 2; k > i; k--) g[k] = Math.max(g[k], g[k + 1] - (cum[k + 1] - cum[k]) * G);
    for (let k = i + 1; k < j; k++) {
      const reach = Math.min(g[i] + (cum[k] - cum[i]) * grade, g[j] + (cum[j] - cum[k]) * grade);
      g[k] = Math.max(chord[k], Math.min(g[k], reach));
      lift[k] = g[k] - chord[k];
    }
  }

  // Hard targets on vertices touching a lifted edge.
  const target = new Array(m).fill(null);
  for (let i = 0; i < m - 1; i++) {
    // Headroom is for the car, which keeps its size: not scaled.
    const o = offsetOf(lv[i], !r.street);
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
  // A street tagged to pass under a highway that has since gone into its
  // trench (see sinkHighways) crosses over it on the level instead: the
  // whole underpass comes back up to the ground.
  if (r.street) {
    for (let i = 0; i < m;) {
      if (target[i] === null || target[i] >= g[i] - 1) { i++; continue; }
      let j = i;
      while (j + 1 < m && target[j + 1] !== null && target[j + 1] < g[j + 1] - 1) j++;
      let over = false;
      for (let k = i; k <= j && !over; k++) {
        for (const o of done) {
          if (o.street) continue;
          const hit = nearestOnPath(o.path, pts[k][0], pts[k][1], o.width / 2 + 2 * s);
          if (hit && hit.y < g[k] - 4) { over = true; break; }
        }
      }
      if (over) for (let k = i; k <= j; k++) target[k] = null;
      i = j + 1;
    }
  }

  // Under a street that crosses on the level: sunk a full headroom.
  if (r.sinks && r.sinks.length) {
    // Wide enough for the vertical curve (layout.js) to keep the full depth.
    const reach = r.width / 2 + 34 * s;
    for (let k = 0; k < m; k++) {
      if (target[k] !== null) continue;
      if (r.sinks.some(([x, n]) => Math.hypot(pts[k][0] - x, pts[k][1] - n) < reach)) target[k] = g[k] - SINK;
    }
  }
  hold(target, g, cum, GRADE[r.cls] || GRADE.road, (HOLD[r.cls] || HOLD.road) * s);

  // Pin the ends onto a road already profiled, when they land on one — and
  // when it can be reached at all: a short ramp up to a deck forty metres
  // over the island cannot, and is closed off where it ends instead.
  const fixed = new Uint8Array(m);
  for (const k of [0, m - 1]) {
    const [x, n] = pts[k];
    let best = null;
    for (const o of done) {
      // A street's lifted piece continues as the street at both ends: it
      // lands on the next piece of a street, never on a highway it crosses.
      if (r.street && !o.street) continue;
      const hit = nearestOnPath(o.path, x, n, 1.2 * s + o.width / 2);
      if (hit && (!best || hit.d < best.d)) best = hit;
    }
    if (!best) continue;
    const other = k === 0 ? m - 1 : 0;
    const base = target[other] ?? g[other];
    if (Math.abs(best.y - base) > cum[m - 1] * grade * 1.6 + 1) {
      if (k === 0) r.cutStart = true; else r.cutEnd = true;
      r.closure = 'Fermé';
      continue;
    }
    target[k] = best.y; fixed[k] = 1;
    // Near a pin the ground's lift gives way to the grade: the Concorde
    // leaves land 9 m above the river but meets Pierre-Dupuy over the water.
    for (let i = 1; i < m - 1; i++) {
      if (target[i] === null || !lift[i]) continue;
      const cap = best.y + Math.abs(cum[i] - cum[k]) * grade;
      if (target[i] > cap) target[i] = Math.max(target[i] - lift[i], cap);
    }
  }

  // A piece of street that lands on neither another road nor the zone's edge
  // lands on its street, on the ground: steeper than the grade if the data
  // leaves it no room (a bridge way whose street forks right after it), but
  // never a deck ending in the air.
  // So does a ramp or a named bridge whose end the data puts on a street
  // (Jacques-Cartier coming down onto De Lorimier, a Ville-Marie exit) —
  // unless a highway or a ramp already profiled crosses its last stretch: in
  // the knot of an interchange, coming down would take it under a deck
  // without headroom. (Another piece of street crossing it meets it.)
  const lands = r.street || ((r.cls === 'ramp' || spec) && !r.loop);
  if (lands) {
    for (const k of [0, m - 1]) {
      if (fixed[k] || (k === 0 ? r.cutStart : r.cutEnd)) continue;
      if (!r.street && (!onStreet || !onStreet(pts[k][0], pts[k][1]))) continue;
      if (crossedNear(pts, cum, k, 250 * s, highways)) continue;
      target[k] = g[k]; fixed[k] = 1;
    }
  }
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
  if (r.street) {
    // As steep as the street it belongs to, then: layout.js holds it to that.
    let steep = 0;
    for (let i = 1; i < m; i++) steep = Math.max(steep, Math.abs(out[i][2] - out[i - 1][2]) / ((cum[i] - cum[i - 1]) || 1));
    if (steep > STREET_GRADE) r.maxGrade = steep + 0.01;
  }
  r.edgeFlags = fl;
  r.edgeLevels = lv;
  r.cum = cum;
  return out;
}

/**
 * Between two lifted (or two sunk) stretches too close for the road to come
 * back to the ground and stay there a while, it keeps its height: the offset
 * from the ground is carried across, blending from one end's to the other's.
 */
function hold(target, g, cum, grade, flat) {
  const m = target.length;
  let i = -1;
  for (let j = 0; j < m; j++) {
    if (target[j] === null) continue;
    if (i >= 0 && j > i + 1) {
      const oi = target[i] - g[i], oj = target[j] - g[j];
      const gap = cum[j] - cum[i];
      if (Math.sign(oi) === Math.sign(oj) && Math.min(Math.abs(oi), Math.abs(oj)) >= 3
        && gap <= (Math.abs(oi) + Math.abs(oj)) / grade + flat) {
        for (let k = i + 1; k < j; k++) {
          const t = (cum[k] - cum[i]) / gap;
          target[k] = g[k] + oi + (oj - oi) * t;
        }
      }
    }
    i = j;
  }
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

/** Whether an edge of `grid` ({ a, b }) crosses `pts` within `reach` of vertex k (an end). */
const crossTmp = [];
function crossedNear(pts, cum, k, reach, grid) {
  const from = cum[k];
  for (let i = 0; i + 1 < pts.length; i++) {
    if (Math.min(Math.abs(cum[i] - from), Math.abs(cum[i + 1] - from)) > reach) continue;
    const a = pts[i], b = pts[i + 1];
    const mx = (a[0] + b[0]) / 2, mn = (a[1] + b[1]) / 2;
    for (const e of grid.query(mx, mn, Math.hypot(b[0] - a[0], b[1] - a[1]) / 2, crossTmp)) {
      if (segCross(a, b, e.a, e.b)) return true;
    }
  }
  return false;
}

/**
 * Whether a point lies on one of these carriageways ({ path, half }), other
 * than the one whose `r` is `self`.
 */
function streetFinder(streets) {
  const grid = new G.Grid(48);
  for (const st of streets) {
    for (let i = 0; i + 1 < st.path.length; i++) {
      const a = st.path[i], b = st.path[i + 1], h = st.half;
      grid.insert({ a, b, h, r: st.r }, Math.min(a[0], b[0]) - h, Math.min(a[1], b[1]) - h, Math.max(a[0], b[0]) + h, Math.max(a[1], b[1]) + h);
    }
  }
  const tmp = [];
  return (x, n, self = null) => grid.query(x, n, 0, tmp)
    .some((c) => (!self || c.r !== self) && G.segDist2(x, n, c.a[0], c.a[1], c.b[0], c.b[1]).d2 <= c.h * c.h);
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

// ------------------------------------------------------------------- slicing --

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
