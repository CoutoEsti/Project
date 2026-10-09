// Streets as ribbons laid on the relief: asphalt, and a sidewalk on each side.
// Where two streets cross, their ribbons simply overlap — same material, UVs
// in metres, so the overlap is invisible — and the sidewalks sit a hair lower
// than the asphalt, so a crossing street always runs over them.
//
// A ribbon keeps a vertex only where the ground bends under it: a straight
// street on a steady slope is two vertices per side, however long it is.
//
// Receives THREE, never imports it.

import { GeoBuilder, meshOf } from './builder.js';
import * as G from '../map/geom.js';

const LIFT = { asphalt: 0.07, sidewalk: 0.05, kerb: 0.06 };
// The kerb: a lighter band of the sidewalk along the carriageway, a hair above
// the sidewalk and still under any crossing street's asphalt. Same mesh as the
// sidewalk (vertex colours), so it costs no draw call.
const KERB = { width: 0.3, tint: 1.45 };
const SIDEWALK = { boulevard: 3.6, avenue: 3.2, street: 2.6, narrow: 1.8, plaza: 0, alley: 0 };
const STEP = 4;            // metres between height probes
const ROAD_OVER = 0.6;
const SHARP = 0.85;        // below this cosine of half the turn, a joint is rounded, not mitred     // a road this close to the street's level replaces it
const TOL = 0.03;          // metres a ribbon may stray from the ground

/**
 * @returns { meshes, stats }
 */
export function buildStreets(THREE, layout, M, tiles, opts = {}) {
  const T = layout.terrain;
  const s = layout.map.scale;
  const holeGrid = polyIndex(layout.holes);
  const waterGrid = polyIndex(layout.water);
  const cut = (x, n) => holeGrid(x, n) || waterGrid(x, n);
  // Where a road at street level runs over a street — a ramp's foot, a
  // carriageway alongside a boulevard — the road is the one surface there:
  // the street's asphalt, kerbs and sidewalks under it are left out, so no
  // two pavements lie on top of each other a few centimetres apart.
  // The roads are meshed first (world/build.js): their drawn surface, not
  // their centreline's reach, says where a street gives way.
  const cover = layout.roadCover;
  const htmp = [];
  const underRoad = (x, n) => {
    if (!cover) return false;
    const g = T.height(x, n);
    return cover.heights(x, n, htmp).some((y) => Math.abs(y - g) < ROAD_OVER);
  };
  const nearRoad = (x, n, r) => !!cover && cover.near(x, n, r, T.height(x, n), ROAD_OVER + 0.5);
  const cutAll = (x, n) => underRoad(x, n) || cut(x, n);
  // A sidewalk or kerb never runs across another street's carriageway: in a
  // crossing the carriageways meet and nothing else, so the corner reads as
  // one pavement instead of kerbs and slabs poking through it.
  const stmp = [];
  // Another street, not the next piece of this one, within reach.
  const crossing = (st, x, n, pad) => {
    for (const o of layout.streetsAt(x, n, pad, stmp)) if (o !== st && (o.name !== st.name || !st.name)) return true;
    return false;
  };
  const onOtherStreet = (st, x, n, pad = 0) => {
    for (const o of layout.streetsAt(x, n, pad, stmp)) if (o !== st) return true;
    return false;
  };
  // Merged by tile for the page; one object per street for the export
  // (opts.split), to pick and edit in an engine.
  const per = new Map();
  const tile = (key, st) => {
    let t = per.get(key);
    if (!t) { t = { asphalt: new GeoBuilder(), sidewalk: new GeoBuilder({ color: 3 }), st }; per.set(key, t); }
    return t;
  };
  let stations = 0;
  for (const st of layout.streets) {
    const half = st.half;
    const walk = (SIDEWALK[st.cls] ?? 2.4) * s;
    // Stations every 2 m where a road comes near, so the cut follows its edge.
    const line = densifyNear(stationsOf(st.path, T, half + walk), (x, n) => nearRoad(x, n, half + walk + 3), T);
    stations += line.length;
    const mid = st.path[Math.floor(st.path.length / 2)];
    const t = opts.split ? tile(`st${st.index}`, st) : tile(tiles.key(mid[0], mid[1]));
    // Which quads may need cutting, decided once for the four strips of
    // sidewalk and kerb: a road at street level near, or another street's
    // carriageway reaching the sidewalks.
    const nearR = [], nearS = [];
    for (let i = 1; i < line.length; i++) {
      const x = (line[i - 1][0] + line[i][0]) / 2, n = (line[i - 1][1] + line[i][1]) / 2;
      nearR.push(nearRoad(x, n, half + walk));
      nearS.push(walk > 0 && crossing(st, x, n, half + walk));
    }
    const fine = { flags: nearR, under: underRoad };
    ribbon(t.asphalt, line, -half, half, LIFT.asphalt, cutAll, T, 1, fine);
    if (walk > 0) {
      const cutWalk = (x, n) => onOtherStreet(st, x, n) || cutAll(x, n);
      const fineWalk = { wide: 1, flags: nearR.map((v, i) => v || nearS[i]), under: (x, n) => underRoad(x, n) || onOtherStreet(st, x, n) };
      ribbon(t.sidewalk, line, half, half + walk, LIFT.sidewalk, cutWalk, T, 1, fineWalk);
      ribbon(t.sidewalk, line, -half - walk, -half, LIFT.sidewalk, cutWalk, T, 1, fineWalk);
      const kw = Math.min(KERB.width * s, walk * 0.5);
      ribbon(t.sidewalk, line, half, half + kw, LIFT.kerb, cutWalk, T, KERB.tint, fineWalk);
      ribbon(t.sidewalk, line, -half - kw, -half, LIFT.kerb, cutWalk, T, KERB.tint, fineWalk);
    }
  }
  const meshes = [];
  for (const [key, t] of per) {
    for (const [layer, b, mat] of [['rues', t.asphalt, M.Street_Asphalt], ['trottoirs', t.sidewalk, M.Street_Sidewalk]]) {
      const label = t.st ? `Rue ${t.st.index} ${t.st.name || 'sans nom'}` : key;
      const m = meshOf(THREE, b, mat, `${layer === 'rues' ? 'Rues' : 'Trottoirs'}_${label}`);
      if (!m) continue;
      if (t.st) {
        m.name = layer === 'rues' ? label : `Trottoirs ${label}`;
        m.userData.piece = { kind: layer === 'rues' ? 'rue' : 'trottoirs', index: t.st.index, osm: t.st.osm ?? null, name: t.st.name || null, cls: t.st.cls, width: t.st.width };
      }
      m.receiveShadow = true;
      m.userData.tile = t.st ? tiles.key(mid0(t.st)[0], mid0(t.st)[1]) : key;
      m.userData.layer = layer;
      meshes.push(m);
    }
  }
  return { meshes, stats: { stations } };
}

function mid0(st) { return st.path[Math.floor(st.path.length / 2)]; }

/**
 * Stations along a street: position, left normal, and the ground height at
 * the centre and at `reach` either side. Dense probes first, then only the
 * ones the ground's shape needs (Douglas–Peucker on all three heights).
 */
function stationsOf(path, T, reach) {
  const n = path.length;
  // Mitred normals at gentle joints so the ribbon's edges stay parallel; at a
  // sharp one a mitre would shoot a spike far past the street, so the edges
  // keep their own normals and a round fan closes the outside of the turn.
  const startN = [], endN = [], fans = [];
  for (let i = 0; i < n; i++) {
    const a = path[Math.max(0, i - 1)], b = path[i], c = path[Math.min(n - 1, i + 1)];
    let t1x = b[0] - a[0], t1n = b[1] - a[1], t2x = c[0] - b[0], t2n = c[1] - b[1];
    const l1 = Math.hypot(t1x, t1n) || 1, l2 = Math.hypot(t2x, t2n) || 1;
    t1x /= l1; t1n /= l1; t2x /= l2; t2n /= l2;
    if (i === 0) { t1x = t2x; t1n = t2n; }
    if (i === n - 1) { t2x = t1x; t2n = t1n; }
    let lx = -(t1n + t2n), ln = t1x + t2x;
    const ll = Math.hypot(lx, ln) || 1;
    lx /= ll; ln /= ll;
    const cos = lx * -t1n + ln * t1x;
    if (cos >= SHARP) {
      startN.push([lx / cos, ln / cos]); endN.push([lx / cos, ln / cos]); fans.push(null);
      continue;
    }
    const n1 = [-t1n, t1x], n2 = [-t2n, t2x];
    endN.push(n1); startN.push(n2);
    const a1 = Math.atan2(n1[1], n1[0]);
    let da = Math.atan2(n2[1], n2[0]) - a1;
    da = Math.atan2(Math.sin(da), Math.cos(da));
    const k = Math.ceil(Math.abs(da) / 0.4);
    const fan = [];
    for (let j = 1; j < k; j++) {
      const t = a1 + (da * j) / k;
      fan.push([Math.cos(t), Math.sin(t)]);
    }
    fans.push(fan);
  }
  const probe = (x, nn, lx, ln, s) => [x, nn, T.height(x, nn), T.height(x + lx * reach, nn + ln * reach), T.height(x - lx * reach, nn - ln * reach), lx, ln, s];
  const out = [];
  for (let i = 0; i + 1 < n; i++) {
    const a = path[i], b = path[i + 1];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const k = Math.max(1, Math.ceil(len / STEP));
    const na = startN[i], nb = endN[i + 1];
    // The fan round a sharp joint: stations on the joint itself, turning.
    if (i > 0 && fans[i]) for (const [lx, ln] of fans[i]) out.push(probe(a[0], a[1], lx, ln, 0));
    // Probes along this straight edge, both ends included.
    const span = [];
    for (let j = 0; j <= k; j++) {
      const u = j / k;
      const x = a[0] + (b[0] - a[0]) * u, nn = a[1] + (b[1] - a[1]) * u;
      const lx = j === 0 ? na[0] : j === k ? nb[0] : na[0] + (nb[0] - na[0]) * u;
      const ln = j === 0 ? na[1] : j === k ? nb[1] : na[1] + (nb[1] - na[1]) * u;
      span.push(probe(x, nn, lx, ln, u * len));
    }
    // Along a straight edge only the heights can bend: keep what they need.
    const kept = keepIndices(span.map((p) => [p[7], p[2], p[3], p[4]]), TOL);
    for (const idx of kept) if (idx > 0 || i === 0 || fans[i]) out.push(span[idx]);
  }
  return out;
}

/** Douglas–Peucker over [s, y1, y2, y3]: indices of the samples to keep. */
function keepIndices(pts, tol) {
  const m = pts.length;
  if (m <= 2) return pts.map((_, i) => i);
  const keep = new Uint8Array(m);
  keep[0] = keep[m - 1] = 1;
  const stack = [[0, m - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const A = pts[a], B = pts[b], ds = B[0] - A[0] || 1;
    let best = -1, bestErr = tol;
    for (let i = a + 1; i < b; i++) {
      const t = (pts[i][0] - A[0]) / ds;
      let err = 0;
      for (let c = 1; c < 4; c++) err = Math.max(err, Math.abs(A[c] + (B[c] - A[c]) * t - pts[i][c]));
      if (err > bestErr) { bestErr = err; best = i; }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  const out = [];
  for (let i = 0; i < m; i++) if (keep[i]) out.push(i);
  return out;
}

/**
 * Stations every 2 m wherever `near` says a road is close, so a street can
 * stop at a road's edge rather than at the next bend of the ground.
 */
function densifyNear(line, near, T) {
  const out = [line[0]];
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i];
    const k = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 2);
    if (k > 1 && (near(a[0], a[1]) || near(b[0], b[1]) || near((a[0] + b[0]) / 2, (a[1] + b[1]) / 2))) {
      for (let j = 1; j < k; j++) {
        const u = j / k;
        const x = a[0] + (b[0] - a[0]) * u, n = a[1] + (b[1] - a[1]) * u;
        out.push([x, n, T.height(x, n), a[3], a[4], a[5] + (b[5] - a[5]) * u, a[6] + (b[6] - a[6]) * u, a[7]]);
      }
    }
    out.push(b);
  }
  return out;
}

/**
 * A strip between lateral offsets o0 < o1, at the ground plus `lift`;
 * `tint` is its vertex colour when the builder has one.
 */
/**
 * `fine` ({ flags, under }): for quad i, whether it may straddle an edge, and
 * the test that edge separates.
 */
function ribbon(b, line, o0, o1, lift, cut, T, tint = 1, fine = null) {
  let prev = null, q = -1;
  for (const p of line) {
    q++;
    const [x, n, , , , lx, ln] = p;
    const ax = x + lx * o0, an = n + ln * o0, bx = x + lx * o1, bn = n + ln * o1;
    const i0 = b.v(ax, an, T.height(ax, an) + lift, 0, 0, 1, ax, an, tint, tint, tint);
    const i1 = b.v(bx, bn, T.height(bx, bn) + lift, 0, 0, 1, bx, bn, tint, tint, tint);
    if (prev) {
      const cx = (x + prev.x) / 2 + lx * (o0 + o1) / 2, cn = (n + prev.n) / 2 + ln * (o0 + o1) / 2;
      // Near a road, a quad wholly under it goes, one wholly clear stays, and
      // only one straddling its edge is cut into strips.
      const mixed = fine && fine.flags[q - 1] && straddles(fine.under, cx, cn, [ax, an], [bx, bn], prev.b, prev.a);
      if (mixed) strips(b, prev.p, p, o0, o1, lift, cut, T, tint, fine.wide || 1);
      else if (!cut(cx, cn)) b.quad(prev.i1, prev.i0, i0, i1);
    }
    prev = { x, n, i0, i1, p, a: [ax, an], b: [bx, bn] };
  }
}

/** Whether the cut test changes over a quad: its centre against its corners. */
function straddles(cut, cx, cn, ...corners) {
  const c = cut(cx, cn);
  return corners.some(([x, n]) => cut(x, n) !== c);
}

/**
 * One quad of a ribbon that straddles an edge (a road's, another street's),
 * cut into tiles of about a metre and a half, each kept or dropped on its own:
 * a road covering half a street takes half of it, a crossing street takes the
 * corner of a sidewalk and leaves the rest.
 */
function strips(b, a, c, o0, o1, lift, cut, T, tint, wide) {
  const across = Math.max(1, Math.ceil((o1 - o0) / wide));
  const along = Math.max(1, Math.ceil(Math.hypot(c[0] - a[0], c[1] - a[1]) / 2.5));
  const at = (u, o) => {
    const lx = a[5] + (c[5] - a[5]) * u, ln = a[6] + (c[6] - a[6]) * u;
    const x = a[0] + (c[0] - a[0]) * u + lx * o, n = a[1] + (c[1] - a[1]) * u + ln * o;
    return [x, n, T.height(x, n) + lift];
  };
  const v = ([x, n, y]) => b.v(x, n, y, 0, 0, 1, x, n, tint, tint, tint);
  for (let i = 0; i < along; i++) {
    const u0 = i / along, u1 = (i + 1) / along;
    for (let j = 0; j < across; j++) {
      const w0 = o0 + ((o1 - o0) * j) / across, w1 = o0 + ((o1 - o0) * (j + 1)) / across;
      const A0 = at(u0, w0), A1 = at(u0, w1), C0 = at(u1, w0), C1 = at(u1, w1);
      if (cut((A0[0] + A1[0] + C0[0] + C1[0]) / 4, (A0[1] + A1[1] + C0[1] + C1[1]) / 4)) continue;
      b.quad(v(A1), v(A0), v(C0), v(C1));
    }
  }
}

function polyIndex(multi) {
  const items = multi.map((poly) => ({ poly, bb: G.ringBBox(poly[0]) }));
  const grid = new G.Grid(64);
  for (const it of items) grid.insert(it, it.bb.x0, it.bb.n0, it.bb.x1, it.bb.n1);
  const tmp = [];
  return (x, n) => {
    for (const it of grid.query(x, n, 0, tmp)) {
      if (x < it.bb.x0 || x > it.bb.x1 || n < it.bb.n0 || n > it.bb.n1) continue;
      if (G.pointInPolygon(x, n, it.poly)) return true;
    }
    return false;
  };
}
