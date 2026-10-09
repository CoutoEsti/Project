// Road surfaces and everything the structure pass inferred: walls, barriers,
// pillars, tunnel ceilings, fences, closures, street bridges. Pure meshing —
// every decision was already taken in map/structures.js.

import { GeoBuilder, triangulate, meshOf } from './builder.js';
import { textPanel, hasCanvas } from './textures.js';
import { simplifyN } from '../map/geom.js';
import { pillarColumns } from '../map/structures.js';
import { JOINT_SINK } from '../map/layout.js';

const TOL = 0.04;   // metres: invisible, and a straight wall costs two quads

// Barrier cross-sections: [half-width, height] from the base up. The concrete
// ones are the tall wall of Québec's highways, 1.07 m: three quarters of a
// car's height, so it reads as a wall and not a kerb.
const PROFILES = {
  jersey: [[0.3, 0], [0.28, 0.075], [0.12, 0.33], [0.1, 1.07]],
  median: [[0.3, 0], [0.28, 0.075], [0.12, 0.33], [0.1, 1.07]],
  parapet: [[0.22, 0], [0.22, 0.98], [0.16, 1.04]],
  circuit: [[0.25, 0], [0.25, 1.15], [0.2, 1.2]],
};

/**
 * @param opts.split one mesh per road, side join and joint, named after it
 *   (the export: something to pick and edit in an engine). The page draws
 *   them merged, three draw calls for every road.
 */
export function buildRoads(THREE, layout, S, M, opts = {}) {
  const out = [];
  const top = new GeoBuilder();
  const under = new GeoBuilder();
  const circuit = new GeoBuilder();
  const joins = layout.joins || [];
  const landings = layout.landings || [];
  const pieces = new Pieces(opts.split);
  const byId = layout.roadById || {};
  for (const r of layout.roads) {
    const [i0, i1, sunk] = drawRange(r, joins);
    const b = pieces.of(r.id, () => roadLabel(r), roadData(r), 'Asphalt', r.cls === 'circuit' ? circuit : top);
    const under_ = pieces.of(r.id, null, null, 'Concrete_Dark', under);
    // Edges slid onto the street a ramp comes down to (map/junctions.js).
    const edges = new Map();
    for (const l of landings) if (l.road === r.id) for (const [k, e] of l.edges) edges.set(k, e);
    ribbon(b, r.samples, i0, i1, (p) => (sunk(p) ? p.y - JOINT_SINK : p.y), halfOf(r), false, edges);
    // Undersides where the deck is carried on pillars.
    let run = [];
    const flush = () => {
      if (run.length >= 2) ribbon(under_, run, 0, run.length - 1, (p) => p.y - r.rules.deck, halfOf(r), true);
      run = [];
    };
    for (let i = i0; i <= i1; i++) {
      if (r.samples[i].carry === 'deck') run.push(r.samples[i]); else flush();
    }
    flush();
  }
  for (const j of joins) {
    const lbl = () => `Jonction ${roadLabel(byId[j.road] || { id: j.road })} > ${roadLabel(byId[j.major] || { id: j.major })}`;
    joinSurface(pieces.of(`join:${j.road}:${j.end}`, lbl, { kind: 'jonction', road: j.road, major: j.major }, 'Asphalt', top), j);
  }
  // Joints: the wedges where two ways meet end to end at an angle.
  (layout.joints || []).forEach((j, k) => joint(pieces.of(`joint:${k}`, () => `Raccord ${k}`, { kind: 'raccord' }, 'Asphalt', top), j));
  // The strip between twin carriageways that touch (map/structures.js fills).
  for (const f of S.fills || []) {
    const b = pieces.of(`fill:${f.road}:${f.other}`, () => `Terre-plein ${f.road} ${f.other}`, { kind: 'raccord' }, 'Asphalt', top);
    for (let i = 0; i + 1 < f.pts.length; i++) {
      const p = f.pts[i], q = f.pts[i + 1];
      const v = (x, n, y) => b.v(x, n, y - JOINT_SINK, 0, 0, 1, x, n);
      orientedQuad(b, v(p[0], p[1], p[2]), v(p[3], p[4], p[5]), v(q[3], q[4], q[5]), v(q[0], q[1], q[2]));
    }
  }
  // What is actually drawn, for the streets to give way to (world/streets.js).
  layout.roadCover = coverIndex([top, circuit, ...pieces.builders('Asphalt')]);
  for (const m of pieces.meshes(THREE, M)) push(out, m, 'routes');
  push(out, meshOf(THREE, top, M.Asphalt, 'Routes'), 'routes');
  push(out, meshOf(THREE, circuit, M.Asphalt, 'Circuit'), 'ile-notre-dame');
  push(out, meshOf(THREE, under, M.Concrete_Dark, 'Dessous_tabliers'), 'routes');
  return out;
}

/**
 * A ramp joined at the side (map/junctions.js) starts at its nose, the taper
 * before it being part of the carriageway. Any other road that runs into a
 * major one is drawn whole, a hair under it where the two overlap: trimmed
 * square at the major road's edge, it left a wedge of ground on one side
 * and a corner in the air on the other, or a gap where the "major" road was
 * itself ending (three ramps meeting at one node).
 *
 * @returns [i0, i1, sunk(p)]
 */
function drawRange(r, joins) {
  const S = r.samples;
  let n0 = -1, n1 = -1;
  for (const j of joins) {
    if (j.road !== r.id) continue;
    if (j.end === 'start') n0 = j.nose; else n1 = j.nose;
  }
  let s0 = -Infinity, s1 = Infinity;
  for (const j of r.junctions || []) {
    if (j.through) continue;           // carries on from the other's end: whole
    if (j.end === 'start' && n0 < 0) s0 = j.sTrim;
    else if (j.end === 'end' && n1 < 0) s1 = j.sTrim;
  }
  const sunk = (p) => p.s < s0 || p.s > s1;
  return [n0 >= 0 ? n0 : 0, n1 >= 0 ? n1 : S.length - 1, sunk];
}

/** A joint (map/layout.js findJoints): a fan from its centre, facing up. */
function joint(b, j) {
  const c = b.v(j.x, j.n, j.y, 0, 0, 1, j.x, j.n);
  const ring = j.ring.map(([x, n, y]) => b.v(x, n, y, 0, 0, 1, x, n));
  // The hull runs counter-clockwise seen from above, as ribbon() lays faces.
  for (let k = 0; k < ring.length; k++) b.tri(c, ring[k], ring[(k + 1) % ring.length]);
}

/**
 * The running surface as drawn — trimmed ends, noses and landings included —
 * indexed for "which heights at (x, n)" and "anything within r of it".
 */
function coverIndex(builders) {
  const CELL = 8, grid = new Map(), tris = [];
  const key = (i, j) => i * 1e6 + j;
  for (const b of builders) {
    const P = b.pos, I = b.idx;
    for (let t = 0; t + 2 < b.nIdx; t += 3) {
      const v = [I[t], I[t + 1], I[t + 2]].map((k) => [P[k * 3], -P[k * 3 + 2], P[k * 3 + 1]]);
      const id = tris.push(v) - 1;
      const i0 = Math.floor(Math.min(v[0][0], v[1][0], v[2][0]) / CELL), i1 = Math.floor(Math.max(v[0][0], v[1][0], v[2][0]) / CELL);
      const j0 = Math.floor(Math.min(v[0][1], v[1][1], v[2][1]) / CELL), j1 = Math.floor(Math.max(v[0][1], v[1][1], v[2][1]) / CELL);
      if ((i1 - i0 + 1) * (j1 - j0 + 1) > 400) continue;
      const lo = Math.min(v[0][2], v[1][2], v[2][2]), hi = Math.max(v[0][2], v[1][2], v[2][2]);
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        let c = grid.get(key(i, j));
        if (!c) grid.set(key(i, j), c = { ids: [], lo: Infinity, hi: -Infinity, levels: [] });
        c.ids.push(id);
        c.lo = Math.min(c.lo, lo); c.hi = Math.max(c.hi, hi);
        // Height bands present in the cell, a metre apart: "is there road at
        // this level here" without walking the triangles.
        for (let y = Math.floor(lo); y <= Math.floor(hi); y++) if (!c.levels.includes(y)) c.levels.push(y);
      }
    }
  }
  return {
    /** Heights of the drawn road surfaces over (x, n). */
    heights(x, n, out = []) {
      out.length = 0;
      const c = grid.get(key(Math.floor(x / CELL), Math.floor(n / CELL)));
      if (!c) return out;
      for (const id of c.ids) {
        const [a, b, d] = tris[id];
        const den = (b[1] - d[1]) * (a[0] - d[0]) + (d[0] - b[0]) * (a[1] - d[1]);
        if (!den) continue;
        const u = ((b[1] - d[1]) * (x - d[0]) + (d[0] - b[0]) * (n - d[1])) / den;
        const v = ((d[1] - a[1]) * (x - d[0]) + (a[0] - d[0]) * (n - d[1])) / den;
        if (u < 0 || v < 0 || u + v > 1) continue;
        out.push(u * a[2] + v * b[2] + (1 - u - v) * d[2]);
      }
      return out;
    },
    /** Any drawn road within about r metres (by grid cell) and dy of height y. */
    near(x, n, r, y, dy) {
      const i0 = Math.floor((x - r) / CELL), i1 = Math.floor((x + r) / CELL);
      const j0 = Math.floor((n - r) / CELL), j1 = Math.floor((n + r) / CELL);
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          const c = grid.get(key(i, j));
          if (!c || c.lo > y + dy || c.hi < y - dy) continue;
          for (let k = Math.floor(y - dy); k <= Math.floor(y + dy); k++) if (c.levels.includes(k)) return true;
        }
      }
      return false;
    },
  };
}

/** The taper of a side join: strips from the carriageway's edge to the ramp's outer edge. */
function joinSurface(b, j) {
  const R = j.rows;
  for (let i = 0; i + 1 < R.length; i++) {
    const [e0x, e0n, e0y, o0x, o0n, o0y] = R[i];
    const [e1x, e1n, e1y, o1x, o1n, o1y] = R[i + 1];
    // Both rows collapsed on the carriageway's edge: nothing to fill yet.
    if (Math.hypot(o0x - e0x, o0n - e0n) < 0.02 && Math.hypot(o1x - e1x, o1n - e1n) < 0.02) continue;
    const P = [[e0x, e0n, e0y], [o0x, o0n, o0y], [o1x, o1n, o1y], [e1x, e1n, e1y]];
    // Front faces run counter-clockwise seen from above, as ribbon() lays them.
    let area = 0;
    for (let k = 0; k < 4; k++) { const p = P[k], q = P[(k + 1) % 4]; area += p[0] * q[1] - q[0] * p[1]; }
    if (area < 0) P.reverse();
    const ids = P.map(([x, n, y]) => b.v(x, n, y, 0, 0, 1, x, n));
    b.quad(ids[0], ids[1], ids[2], ids[3]);
  }
}

/** Half-width of a road at a sample (it tapers at forks), plus `extra`. */
function halfOf(r, extra = 0) {
  return (p) => (p.h ?? r.half) + extra;
}

function ribbon(b, S, i0, i1, yOf, halfAt, down, edges = null) {
  let prevL = -1, prevR = -1, prevIn = false;
  for (let i = i0; i <= i1; i++) {
    const p = S[i];
    const y = yOf(p);
    const a = S[Math.max(i0, i - 1)], c = S[Math.min(i1, i + 1)];
    const ds = Math.max(0.01, c.s - a.s);
    const grade = (yOf(c) - yOf(a)) / ds;
    let nx = -grade * p.tx, nn = -grade * p.tn, ny = 1;
    const l = Math.hypot(nx, nn, ny);
    nx /= l; nn /= l; ny /= l;
    if (down) { nx = -nx; nn = -nn; ny = -ny; }
    const half = halfAt(p);
    let lx = p.x + p.lx * half, ln = p.n + p.ln * half, ly = y;
    let rx = p.x - p.lx * half, rn = p.n - p.ln * half, ry = y;
    const e = edges && edges.get(i);
    if (e && e.L) [lx, ln, ly] = e.L;
    if (e && e.R) [rx, rn, ry] = e.R;
    const inside = !!(e && e.inside);
    const L = b.v(lx, ln, ly, nx, nn, ny, lx, ln);
    const R = b.v(rx, rn, ry, nx, nn, ny, rx, rn);
    // Both edges on another surface's edge: that stretch is the other's.
    if (prevL >= 0 && !(inside && prevIn)) {
      if (down) b.quad(prevL, L, R, prevR);
      else b.quad(prevL, prevR, R, L);
    }
    prevL = L; prevR = R; prevIn = inside;
  }
}

// ------------------------------------------------------------ structures --

export function buildStructureMeshes(THREE, layout, S, M, opts = {}) {
  const out = [];
  const shared = {
    concrete: new GeoBuilder(), tunnel: new GeoBuilder(), metal: new GeoBuilder(), fence: new GeoBuilder(),
    darkConcrete: new GeoBuilder(), asphalt: new GeoBuilder(), stripes: new GeoBuilder(),
  };
  const { concrete, tunnel, metal, fence, darkConcrete, asphalt, stripes } = shared;
  // With opts.split, what stands along a road is that road's, one object
  // per road and material.
  const pieces = new Pieces(opts.split);
  const byId = layout.roadById || {};
  const MAT = { concrete: 'Concrete', tunnel: 'Tunnel', metal: 'Metal', fence: 'Fence', darkConcrete: 'Concrete_Dark', asphalt: 'Asphalt', stripes: 'Marking_Red' };
  const of = (road) => {
    if (!opts.split || road == null) return shared;
    const r = byId[road] || { id: road };
    const g = {};
    for (const k in MAT) g[k] = pieces.of(`ouvrage:${road}`, () => `Ouvrages ${roadLabel(r)}`, { kind: 'ouvrages', road }, MAT[k], shared[k]);
    return g;
  };

  // Walls: thick polylines, both faces and a top. Tunnel walls are tiled on
  // the face that looks at the road.
  for (const w of S.walls) {
    const tunnelWall = w.kind === 'tunnel';
    const B = of(w.road);
    thickWall(B.concrete, simplifyN(w.pts, TOL), w.thickness, tunnelWall ? B.tunnel : null, w.side);
  }

  // Barriers.
  for (const bar of S.barriers) {
    const B = of(bar.road);
    if (bar.kind === 'guardrail') { guardrail(B.metal, bar.pts); continue; }
    const prof = PROFILES[bar.kind] || PROFILES.jersey;
    const pts = simplifyN(bar.pts, TOL);
    extrude(B.concrete, pts, prof);
    if (bar.kind === 'parapet') railOnTop(B.metal, pts, 1.18);
  }

  // The deck between twin carriageways: a concrete top between their two
  // barriers and, where they are up on pillars, an underside.
  for (const md of S.medians || []) {
    const { concrete, darkConcrete } = of(md.road);
    for (let i = 0; i + 1 < md.pts.length; i++) {
      const p = md.pts[i], q = md.pts[i + 1];
      const quad = (b, dy, down) => {
        const ny = down ? -1 : 1;
        const a = b.v(p[0], p[1], p[4] + dy, 0, 0, ny, p[0], p[1]);
        const c = b.v(p[2], p[3], p[4] + dy, 0, 0, ny, p[2], p[3]);
        const d = b.v(q[2], q[3], q[4] + dy, 0, 0, ny, q[2], q[3]);
        const e = b.v(q[0], q[1], q[4] + dy, 0, 0, ny, q[0], q[1]);
        orientedQuad(b, a, c, d, e, down);
      };
      quad(concrete, 0.03, false);
      if (md.lifted[i] && md.lifted[i + 1]) quad(darkConcrete, -md.depth, true);
    }
  }

  // Pillars: a column and, under wide decks, a hammerhead cap.
  for (const p of S.pillars) {
    const { concrete } = of(p.road);
    const ux = p.cap ? p.cap.tx : 1, un = p.cap ? p.cap.tn : 0;
    if (p.twin) {
      for (const [cx, cn] of pillarColumns(p)) concrete.box(cx, cn, p.y0, p.y1, ux, un, p.w / 2, p.w / 2);
      concrete.box(p.x, p.n, p.y1 - 1.6, p.y1, ux, un, 8, p.w / 2 + 0.3);
    } else {
      concrete.box(p.x, p.n, p.y0, p.y1 - (p.cap ? p.cap.depth * 0.6 : 0), ux, un, p.w / 2, p.w / 2);
      if (p.cap) concrete.box(p.x, p.n, p.y1 - p.cap.depth, p.y1, ux, un, p.cap.len / 2, p.w / 2 + 0.2);
    }
  }

  // Tunnel and cover ceilings, facing down.
  for (const c of S.ceilings) {
    const { darkConcrete } = of(c.road);
    const r = layout.roadById[c.road];
    const seg = r.samples.slice(c.i0, c.i1 + 1);
    const ys = c.ys;
    ribbon(darkConcrete, seg, 0, seg.length - 1, (p) => ys[p.i - c.i0] ?? ys[0], halfOf(r, c.margin + 0.3), true);
  }

  // Cover faces where the trench opens again under a street.
  for (const f of S.fascias) {
    const { concrete } = of(f.road);
    const dx = f.b[0] - f.a[0], dn = f.b[1] - f.a[1];
    const len = Math.hypot(dx, dn) || 1;
    const ux = dx / len, un = dn / len;
    concrete.box((f.a[0] + f.b[0]) / 2, (f.a[1] + f.b[1]) / 2, f.y0 - 0.4, f.y1, ux, un, len / 2, 0.35);
  }

  // Fences: posts, rails and chain-link.
  for (const f of S.fences) {
    const B = of(f.road);
    fenceMesh(f.kind === 'rail' ? null : B.fence, B.metal, simplifyN(f.pts, TOL), f.height);
  }

  // Street bridges over the canal.
  for (const d of S.decks) {
    const { pts, tris, outer } = triangulate(THREE, [d.poly[0]]);
    asphalt.flat(pts, tris, d.y);
    darkConcrete.flat(pts, tris, d.y - d.depth, true);
    let u = 0;
    for (let i = 0; i < outer.length; i++) {
      const a = outer[i], b = outer[(i + 1) % outer.length];
      u += concrete.wall(a[0], a[1], b[0], b[1], d.y - d.depth, d.y, d.y - d.depth, d.y, u);
    }
  }

  // Closures: a row of barriers across, striped boards, and a sign.
  const signs = [];
  for (const c of S.closures) {
    const { concrete, metal, stripes } = of(c.road);
    const half = c.width / 2 + 0.5;
    const pts = [];
    for (let k = -1; k <= 1.0001; k += 0.1) pts.push([c.x + c.lx * half * k, c.n + c.ln * half * k, c.y]);
    extrude(concrete, pts, PROFILES.jersey);
    for (let k = -0.8; k <= 0.81; k += 0.4) {
      const bx = c.x + c.lx * half * k - c.tx * 1.5, bn = c.n + c.ln * half * k - c.tn * 1.5;
      stripes.box(bx, bn, c.y + 0.9, c.y + 1.3, c.lx, c.ln, 1.2, 0.05);
      metal.box(bx, bn, c.y, c.y + 1.3, c.lx, c.ln, 0.05, 0.05);
    }
    signs.push(closureSign(THREE, M, c));
  }

  for (const m of pieces.meshes(THREE, M)) push(out, m, 'routes');
  push(out, meshOf(THREE, concrete, M.Concrete, 'Structures_beton'), 'routes');
  push(out, meshOf(THREE, darkConcrete, M.Concrete_Dark, 'Plafonds'), 'routes');
  push(out, meshOf(THREE, tunnel, M.Tunnel, 'Tunnel_parois'), 'routes');
  push(out, meshOf(THREE, metal, M.Metal, 'Structures_metal'), 'routes');
  push(out, meshOf(THREE, fence, M.Fence, 'Clotures'), 'routes');
  push(out, meshOf(THREE, asphalt, M.Asphalt, 'Ponts_canal'), 'routes');
  push(out, meshOf(THREE, stripes, M.Marking_Red, 'Barricades'), 'routes');
  for (const s of signs) push(out, s, 'routes');
  return out;
}

/** "s5411-0 Pont de la Concorde": the id finds it in map.json, the name in the scene. */
export function roadLabel(r) {
  return r.name ? `${r.id} ${r.name}` : String(r.id);
}

function roadData(r) {
  return { kind: r.street ? 'pont-de-rue' : 'route', id: r.id, name: r.name || null, ref: r.ref || null, cls: r.cls, oneway: !!r.oneway, width: r.width };
}

/**
 * One builder per object and material, or the shared builder when not split.
 * An object made of several materials comes out as a group of meshes, one
 * per material, under the object's name.
 */
export class Pieces {
  constructor(split) { this.split = !!split; this.list = new Map(); }
  of(key, label, data, mat, fallback) {
    if (!this.split) return fallback;
    let p = this.list.get(key);
    if (!p) this.list.set(key, p = { label: null, data: null, mats: new Map() });
    if (label && !p.label) { p.label = label(); p.data = data; }
    let b = p.mats.get(mat);
    if (!b) p.mats.set(mat, b = new GeoBuilder());
    return b;
  }
  builders(mat) {
    const out = [];
    for (const p of this.list.values()) if (p.mats.has(mat)) out.push(p.mats.get(mat));
    return out;
  }
  meshes(THREE, M) {
    const out = [];
    for (const [key, p] of this.list) {
      const parts = [...p.mats].map(([mat, b]) => meshOf(THREE, b, M[mat], `${p.label || key} · ${mat}`)).filter(Boolean);
      if (!parts.length) continue;
      if (parts.length === 1) {
        parts[0].name = p.label || key;
        parts[0].userData.piece = p.data || {};
        out.push(parts[0]);
        continue;
      }
      const g = new THREE.Group();
      g.name = p.label || key;
      g.userData.piece = p.data || {};
      g.add(...parts);
      out.push(g);
    }
    return out;
  }
}

function push(out, mesh, zone) {
  if (!mesh) return;
  mesh.userData.zone = mesh.userData.zone || zone;
  out.push(mesh);
}

/** Direction and right-hand normal at each point of a polyline. */
function normals(pts) {
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    let dx = b[0] - a[0], dn = b[1] - a[1];
    const l = Math.hypot(dx, dn) || 1;
    dx /= l; dn /= l;
    return { dx, dn, rx: dn, rn: -dx };
  });
}

/**
 * A wall of given thickness along [x, n, yBottom, yTop] points: right face,
 * left face and top. If `inner` is given, the face on `side` of the wall
 * (+1 left) goes to that builder instead — tiles inside tunnels.
 */
function thickWall(b, pts, t, inner, side) {
  if (pts.length < 2) return;
  const N = normals(pts);
  const h = t / 2;
  let u = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const p = pts[i], q = pts[i + 1], np = N[i], nq = N[i + 1];
    const seg = Math.hypot(q[0] - p[0], q[1] - p[1]);
    // Right face. A wall on the left of its road (side +1) looks at the road
    // with its right face.
    const rb = inner && side === 1 ? inner : b;
    rb.wall(p[0] + np.rx * h, p[1] + np.rn * h, q[0] + nq.rx * h, q[1] + nq.rn * h, p[2], p[3], q[2], q[3], u);
    // Left face: wall from q to p on the left side faces left.
    const lb = inner && side === -1 ? inner : b;
    lb.wall(q[0] - nq.rx * h, q[1] - nq.rn * h, p[0] - np.rx * h, p[1] - np.rn * h, q[2], q[3], p[2], p[3], u);
    // Top.
    const a = b.v(p[0] - np.rx * h, p[1] - np.rn * h, p[3], 0, 0, 1, p[0], p[1]);
    const c = b.v(p[0] + np.rx * h, p[1] + np.rn * h, p[3], 0, 0, 1, p[0], p[1]);
    const d = b.v(q[0] + nq.rx * h, q[1] + nq.rn * h, q[3], 0, 0, 1, q[0], q[1]);
    const e = b.v(q[0] - nq.rx * h, q[1] - nq.rn * h, q[3], 0, 0, 1, q[0], q[1]);
    orientedQuad(b, a, c, d, e);
    u += seg;
  }
}

/** Add a quad whose winding faces up (for the top of walls). */
function orientedQuad(b, a, c, d, e, down = false) {
  // Positions are stored as (x, y, -n): check the winding seen from above.
  const P = b.pos;
  const ax = P[a * 3], az = P[a * 3 + 2], cx = P[c * 3], cz = P[c * 3 + 2], dx = P[d * 3], dz = P[d * 3 + 2];
  const cross = (cx - ax) * (dz - az) - (cz - az) * (dx - ax);
  // In (x, z) with z = -n, counter-clockwise from above has a negative cross.
  // `down` flips it, for an underside.
  if ((cross < 0) !== down) b.quad(a, c, d, e); else b.quad(a, e, d, c);
}

/** Extrude a symmetric profile along a polyline of [x, n, y] points. */
function extrude(b, pts, prof) {
  if (pts.length < 2) return;
  const N = normals(pts);
  let u = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const p = pts[i], q = pts[i + 1], np = N[i], nq = N[i + 1];
    const seg = Math.hypot(q[0] - p[0], q[1] - p[1]);
    for (const side of [1, -1]) {
      for (let k = 0; k + 1 < prof.length; k++) {
        const [w0, h0] = prof[k], [w1, h1] = prof[k + 1];
        // Face normal: outward, tilted by the profile's slope.
        const dw = w1 - w0, dh = h1 - h0;
        const L = Math.hypot(dw, dh) || 1;
        const out = dh / L, up = -dw / L;
        const nx = np.rx * side * out, nn = np.rn * side * out;
        const pa = [p[0] + np.rx * side * w0, p[1] + np.rn * side * w0, p[2] + h0];
        const pb = [q[0] + nq.rx * side * w0, q[1] + nq.rn * side * w0, q[2] + h0];
        const pc = [q[0] + nq.rx * side * w1, q[1] + nq.rn * side * w1, q[2] + h1];
        const pd = [p[0] + np.rx * side * w1, p[1] + np.rn * side * w1, p[2] + h1];
        const i0 = b.v(pa[0], pa[1], pa[2], nx, nn, up, u, h0);
        const i1 = b.v(pb[0], pb[1], pb[2], nx, nn, up, u + seg, h0);
        const i2 = b.v(pc[0], pc[1], pc[2], nx, nn, up, u + seg, h1);
        const i3 = b.v(pd[0], pd[1], pd[2], nx, nn, up, u, h1);
        // side = +1 is the right of travel: (a, b, c, d) faces right.
        if (side === 1) b.quad(i0, i1, i2, i3); else b.quad(i1, i0, i3, i2);
      }
    }
    // Cap.
    const [wt, ht] = prof[prof.length - 1];
    const a = b.v(p[0] - np.rx * wt, p[1] - np.rn * wt, p[2] + ht, 0, 0, 1, u, 0);
    const c = b.v(p[0] + np.rx * wt, p[1] + np.rn * wt, p[2] + ht, 0, 0, 1, u, 1);
    const d = b.v(q[0] + nq.rx * wt, q[1] + nq.rn * wt, q[2] + ht, 0, 0, 1, u + seg, 1);
    const e = b.v(q[0] - nq.rx * wt, q[1] - nq.rn * wt, q[2] + ht, 0, 0, 1, u + seg, 0);
    orientedQuad(b, a, c, d, e);
    u += seg;
  }
}

function railOnTop(b, pts, h) {
  const N = normals(pts);
  for (let i = 0; i + 1 < pts.length; i += 1) {
    const p = pts[i], q = pts[i + 1];
    const mx = (p[0] + q[0]) / 2, mn = (p[1] + q[1]) / 2, my = (p[2] + q[2]) / 2;
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    b.box(mx, mn, my + h - 0.05, my + h + 0.05, N[i].dx, N[i].dn, len / 2 + 0.02, 0.05);
  }
}

function guardrail(b, pts) {
  const N = normals(pts);
  let acc = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const p = pts[i], q = pts[i + 1];
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const mx = (p[0] + q[0]) / 2, mn = (p[1] + q[1]) / 2, my = (p[2] + q[2]) / 2;
    b.box(mx, mn, my + 0.45, my + 0.77, N[i].dx, N[i].dn, len / 2 + 0.02, 0.03);
    acc += len;
    if (acc >= 2) {
      acc = 0;
      b.box(p[0], p[1], p[2], p[2] + 0.75, N[i].dx, N[i].dn, 0.06, 0.06);
    }
  }
}

function fenceMesh(panel, metal, pts, height) {
  if (pts.length < 2) return;
  const N = normals(pts);
  let acc = 0, u = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const p = pts[i], q = pts[i + 1];
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (len < 0.01) continue;
    // Posts every 3 m, even along a long simplified segment.
    for (let d = (3 - acc % 3) % 3; d < len; d += 3) {
      const t = d / len;
      metal.box(p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t,
        p[2] + (q[2] - p[2]) * t + height, N[i].dx, N[i].dn, 0.04, 0.04);
    }
    acc += len;
    const mx = (p[0] + q[0]) / 2, mn = (p[1] + q[1]) / 2, my = (p[2] + q[2]) / 2;
    metal.box(mx, mn, my + height - 0.05, my + height, N[i].dx, N[i].dn, len / 2 + 0.02, 0.03);
    if (panel) {
      // One double-sided quad of chain-link, UVs in metres.
      panel.wall(p[0], p[1], q[0], q[1], p[2] + 0.05, p[2] + height, q[2] + 0.05, q[2] + height, u);
    } else {
      metal.box(mx, mn, my + height * 0.5 - 0.03, my + height * 0.5 + 0.03, N[i].dx, N[i].dn, len / 2 + 0.02, 0.025);
    }
    u += len;
  }
}

function closureSign(THREE, M, c) {
  const group = new THREE.Group();
  group.name = 'Fermeture';
  const w = Math.min(12, c.width * 0.5), h = w * 0.32;
  let mat = M.White;
  if (hasCanvas()) {
    const t = textPanel(THREE, ['FERMÉ', c.text.replace(/\s*—\s*fermé$/i, '')], { bg: '#e8a31a', fg: '#111', width: 1024, height: 320 });
    mat = new THREE.MeshStandardMaterial({ map: t, roughness: 0.6, name: 'Panneau_fermeture' });
  }
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  // Facing back down the road, towards whoever is driving into it.
  panel.position.set(c.x - c.tx * 4, c.y + 3.2, -(c.n - c.tn * 4));
  panel.rotation.y = Math.atan2(-c.tx, c.tn);
  group.add(panel);
  const postGeo = new THREE.BoxGeometry(0.15, 3.3, 0.15);
  for (const k of [-0.4, 0.4]) {
    const post = new THREE.Mesh(postGeo, M.Metal);
    post.position.set(c.x - c.tx * 4 + c.lx * w * k, c.y + 1.65, -(c.n - c.tn * 4 + c.ln * w * k));
    group.add(post);
  }
  return group;
}
