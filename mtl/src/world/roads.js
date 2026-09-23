// Road surfaces and everything the structure pass inferred: walls, barriers,
// pillars, tunnel ceilings, fences, closures, street bridges. Pure meshing —
// every decision was already taken in map/structures.js.

import { GeoBuilder, triangulate, meshOf } from './builder.js';
import { textPanel, hasCanvas } from './textures.js';
import { simplifyN } from '../map/geom.js';
import { pillarColumns } from '../map/structures.js';

const TOL = 0.04;   // metres: invisible, and a straight wall costs two quads

// Barrier cross-sections: [half-width, height] from the base up.
const PROFILES = {
  jersey: [[0.3, 0], [0.28, 0.075], [0.1, 0.33], [0.08, 0.81]],
  median: [[0.3, 0], [0.28, 0.075], [0.1, 0.33], [0.08, 0.81]],
  parapet: [[0.22, 0], [0.22, 0.98], [0.16, 1.04]],
  circuit: [[0.25, 0], [0.25, 1.15], [0.2, 1.2]],
};

export function buildRoads(THREE, layout, S, M) {
  const out = [];
  const top = new GeoBuilder();
  const under = new GeoBuilder();
  const circuit = new GeoBuilder();
  for (const r of layout.roads) {
    const [i0, i1] = drawRange(r);
    const b = r.cls === 'circuit' ? circuit : top;
    ribbon(b, r.samples, i0, i1, (p) => p.y, r.half, false);
    // Undersides where the deck is carried on pillars.
    let run = [];
    const flush = () => {
      if (run.length >= 2) ribbon(under, run, 0, run.length - 1, (p) => p.y - r.rules.deck, r.half, true);
      run = [];
    };
    for (let i = i0; i <= i1; i++) {
      if (r.samples[i].carry === 'deck') run.push(r.samples[i]); else flush();
    }
    flush();
  }
  push(out, meshOf(THREE, top, M.Asphalt, 'Routes'), 'routes');
  push(out, meshOf(THREE, circuit, M.Asphalt, 'Circuit'), 'ile-notre-dame');
  push(out, meshOf(THREE, under, M.Concrete_Dark, 'Dessous_tabliers'), 'routes');
  return out;
}

/** Terrain roads are trimmed where they run into their major road. */
function drawRange(r) {
  let i0 = 0, i1 = r.samples.length - 1;
  for (const j of r.junctions || []) {
    if (j.end === 'start') while (i0 < i1 && r.samples[i0].s < j.sTrim) i0++;
    else while (i1 > i0 && r.samples[i1].s > j.sTrim) i1--;
  }
  return [Math.max(0, i0 - 1), Math.min(r.samples.length - 1, i1 + 1)];
}

function ribbon(b, S, i0, i1, yOf, half, down) {
  let prevL = -1, prevR = -1;
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
    const lx = p.x + p.lx * half, ln = p.n + p.ln * half;
    const rx = p.x - p.lx * half, rn = p.n - p.ln * half;
    const L = b.v(lx, ln, y, nx, nn, ny, lx, ln);
    const R = b.v(rx, rn, y, nx, nn, ny, rx, rn);
    if (prevL >= 0) {
      if (down) b.quad(prevL, L, R, prevR);
      else b.quad(prevL, prevR, R, L);
    }
    prevL = L; prevR = R;
  }
}

// ------------------------------------------------------------ structures --

export function buildStructureMeshes(THREE, layout, S, M) {
  const out = [];
  const concrete = new GeoBuilder();
  const tunnel = new GeoBuilder();
  const metal = new GeoBuilder();
  const fence = new GeoBuilder();
  const darkConcrete = new GeoBuilder();
  const asphalt = new GeoBuilder();
  const stripes = new GeoBuilder();

  // Walls: thick polylines, both faces and a top. Tunnel walls are tiled on
  // the face that looks at the road.
  for (const w of S.walls) {
    const tunnelWall = w.kind === 'tunnel';
    thickWall(concrete, simplifyN(w.pts, TOL), w.thickness, tunnelWall ? tunnel : null, w.side);
  }

  // Barriers.
  for (const bar of S.barriers) {
    if (bar.kind === 'guardrail') { guardrail(metal, bar.pts); continue; }
    const prof = PROFILES[bar.kind] || PROFILES.jersey;
    const pts = simplifyN(bar.pts, TOL);
    extrude(concrete, pts, prof);
    if (bar.kind === 'parapet') railOnTop(metal, pts, 1.18);
  }

  // Pillars: a column and, under wide decks, a hammerhead cap.
  for (const p of S.pillars) {
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
    const r = layout.roadById[c.road];
    const seg = r.samples.slice(c.i0, c.i1 + 1);
    const ys = c.ys;
    ribbon(darkConcrete, seg, 0, seg.length - 1, (p) => ys[p.i - c.i0] ?? ys[0], r.half + c.margin + 0.3, true);
  }

  // Cover faces where the trench opens again under a street.
  for (const f of S.fascias) {
    const dx = f.b[0] - f.a[0], dn = f.b[1] - f.a[1];
    const len = Math.hypot(dx, dn) || 1;
    const ux = dx / len, un = dn / len;
    concrete.box((f.a[0] + f.b[0]) / 2, (f.a[1] + f.b[1]) / 2, f.y0 - 0.4, f.y1, ux, un, len / 2, 0.35);
  }

  // Fences: posts, rails and chain-link.
  for (const f of S.fences) fenceMesh(f.kind === 'rail' ? null : fence, metal, simplifyN(f.pts, TOL), f.height);

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
function orientedQuad(b, a, c, d, e) {
  // Positions are stored as (x, y, -n): check the winding seen from above.
  const P = b.pos;
  const ax = P[a * 3], az = P[a * 3 + 2], cx = P[c * 3], cz = P[c * 3 + 2], dx = P[d * 3], dz = P[d * 3 + 2];
  const cross = (cx - ax) * (dz - az) - (cz - az) * (dx - ax);
  // In (x, z) with z = -n, counter-clockwise from above has a negative cross.
  if (cross < 0) b.quad(a, c, d, e); else b.quad(a, e, d, c);
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
