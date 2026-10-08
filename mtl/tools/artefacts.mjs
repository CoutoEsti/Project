// The artefacts a driver sees: something solid standing on the asphalt (a
// wall, a barrier, a pillar or a building across a road or a street, at the
// height of the car on it), and holes (a place inside a road or a street
// where the wheels find nothing at its level).
//
//   node mtl/tools/artefacts.mjs                       → counts, the worst places
//   node mtl/tools/artefacts.mjs --zone coeur --all    → every place
//   node mtl/tools/artefacts.mjs --json f              → every place, written to f
//
// Obstacles: every wall, barrier, fence, pillar and building edge, sampled
// every metre. A sample counts when it stands more than a metre inside a
// road or street ribbon and its height range covers a car on that surface
// (map/collide.js: 0.28 to 1.45 m over it). An obstacle on its own road's edge
// is not inside by a metre and does not count.
// Holes: across every road and street, a probe every 2 m along and every
// 1.5 m across, a metre in from the edges; a hole where the surface under the
// car (map/surface.js) is void or more than 0.6 m below the road there.
// Places are merged within 15 m.

import fs from 'node:fs';
import * as THREE from '../vendor/three.module.min.js';
import { buildWorld } from '../src/world/build.js';
import { createSurface } from '../src/map/surface.js';
import { pillarColumns } from '../src/map/structures.js';
import { segDist2 } from '../src/map/geom.js';
import { loadSourceNode } from './lib/source-node.mjs';

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const settings = { zone: arg('--zone', 'anneau'), echelle: Number(arg('--echelle', 100)) };
const ALL = args.includes('--all');
const IN = Number(arg('--in', 1.0));   // metres inside a ribbon before something counts
const CAR_BOTTOM = 0.28, CAR_TOP = 1.45;

const world = await buildWorld(THREE, await loadSourceNode(), { settings, outside: false });
const { layout, structures } = world;
const { index } = structures;
const T = layout.terrain;
const surface = createSurface(layout, structures);
const scale = layout.map.scale || 1;
const name = (r) => (r ? `${r.id}${r.name ? ' ' + r.name : ''}` : '?');

// --- what drives at (x, n): roads at their height, streets on the relief ---
const hits = [], stTmp = [];
function drivable(x, n) {
  const out = [];
  for (const h of index.surfacesAt(x, n, -IN, hits)) if (!h.covered) out.push({ y: h.y, what: name(h.road), road: h.road });
  for (const st of layout.streetsAt(x, n, -IN, stTmp)) if (st.cls !== 'plaza') out.push({ y: T.height(x, n), what: `rue ${st.name || st.id || ''}`, street: st });
  return out;
}

// --- obstacles --------------------------------------------------------------
const places = { obstacle: [], hole: [] };
function record(kind, x, n, y, what, on, len) {
  const list = places[kind];
  for (const p of list) {
    if (p.what === what && p.on === on && Math.hypot(p.x - x, p.n - n) < 15) { p.len += len; return; }
  }
  list.push({ kind, x, n, y, what, on, len });
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
const lerp = (u, v, t) => u + (v - u) * t;
function alongside(r, x, n, ux, un) {
  const h = index.surfacesAt(x, n, 0, []).find((o) => o.road === r);
  if (!h) return false;
  const p = r.samples[h.i];
  return Math.abs(p.tx * ux + p.tn * un) > 0.85;
}
const byId = new Map(layout.roads.map((r) => [r.id, r]));
for (const w of structures.walls) {
  for (let i = 0; i + 1 < w.pts.length; i++) {
    const p = w.pts[i], q = w.pts[i + 1];
    probeSegment(p, q, (t) => lerp(p[2], q[2], t), (t) => lerp(p[3], q[3], t), `mur ${w.kind} de ${name(byId.get(w.road))}`, null);
  }
}
const H = { jersey: 1.07, median: 1.07, parapet: 1.1, circuit: 1.2, guardrail: 0.8 };
for (const b of structures.barriers) {
  const h = H[b.kind] || 0.9;
  for (let i = 0; i + 1 < b.pts.length; i++) {
    const p = b.pts[i], q = b.pts[i + 1];
    probeSegment(p, q, (t) => lerp(p[2], q[2], t) - 0.2, (t) => lerp(p[2], q[2], t) + h, `glissière ${b.kind} de ${name(byId.get(b.road))}`, b.kind === 'median' ? byId.get(b.road) : null);
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
      record('obstacle', cx, cn, d.y, `pilier de ${name(byId.get(p.road))}`, d.what, 1);
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

// --- holes ------------------------------------------------------------------
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
    probeAcross(p.x, p.n, p.lx, p.ln, p.h ?? r.half, p.y, name(r));
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

// --- report -----------------------------------------------------------------
const sum = (l) => l.reduce((a, p) => a + p.len, 0);
console.log(`${settings.zone} à ${settings.echelle} % — ${places.obstacle.length} obstacles sur la chaussée (${sum(places.obstacle).toFixed(0)} m), `
  + `${places.hole.length} trous (${sum(places.hole).toFixed(0)} m²)`);
const kinds = new Map();
for (const p of places.obstacle) {
  const k = p.what.replace(/ (de|r?\d).*$/, '').replace(/ \d+.*$/, '');
  kinds.set(k, (kinds.get(k) || 0) + 1);
}
console.log('  obstacles par genre : ' + [...kinds].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', '));
const show = (l) => (ALL ? l : l.slice(0, 25)).forEach((p) => console.log(
  `  ${p.kind === 'hole' ? 'trou' : 'obstacle'} (${Math.round(p.x / scale)}, ${Math.round(p.n / scale)}) y ${p.y.toFixed(1)} — ${p.what} sur ${p.on}, ${p.len.toFixed(0)} ${p.kind === 'hole' ? 'm²' : 'm'}`));
places.obstacle.sort((a, b) => b.len - a.len);
places.hole.sort((a, b) => b.len - a.len);
show(places.obstacle);
show(places.hole);
if (arg('--json', null)) fs.writeFileSync(arg('--json', null), JSON.stringify(places, null, 1));
