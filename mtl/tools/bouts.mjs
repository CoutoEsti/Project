// Road ends left open: where a road stops, is there anything to drive onto?
// Probes a metre apart across the end, a metre past it, each looking for
// another road as drawn (layout.roadCover: trimmed ends, tapers and joints
// included), a street or its sidewalk at the same height, or bare ground at
// that height. An end where some probes find none of these has a corner in
// the air; where none do, it stops dead. An end that only gives onto grass
// at its own level is listed apart: no drop, but no road either.
// For each, what lies near and what OpenStreetMap joins at its node, to tell
// a data dead end from a junction the profiles failed to meet.
//
//   node mtl/tools/bouts.mjs                 → counts and the partly open list
//   node mtl/tools/bouts.mjs --all --json f  → every end, written to f

import fs from 'node:fs';
import * as THREE from '../vendor/three.module.min.js';
import { buildWorld } from '../src/world/build.js';
import { segDist2 } from '../src/map/geom.js';
import { loadSourceNode } from './lib/source-node.mjs';

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const settings = { zone: arg('--zone', 'anneau'), echelle: Number(arg('--echelle', 100)) };
const ALL = args.includes('--all');
const DY = 0.6;          // a step the car climbs, as in map/surface.js

const source = await loadSourceNode();
const world = await buildWorld(THREE, source, { settings, outside: false });
const { layout } = world;
const cover = layout.roadCover;
const T = layout.terrain;
const tmp = [], hs = [];

const SIDEWALK = { boulevard: 3.6, avenue: 3.2, street: 2.6, narrow: 1.8, plaza: 0, alley: 0 };   // world/streets.js
const scale = layout.map.scale || 1;

function probe(x, n, y) {
  for (const h of cover.heights(x, n, hs)) if (Math.abs(h - y) <= DY) return 'road';
  if (Math.abs(T.height(x, n) - y) > DY) return null;
  // A street's sidewalk is driven onto too: a kerb, not a hole.
  for (const st of layout.streetsAt(x, n, 4 * scale, tmp)) {
    const walk = (SIDEWALK[st.cls] ?? 2.4) * scale;
    if (layout.streetsAt(x, n, walk, []).includes(st)) return 'street';
  }
  // Bare ground at the road's level: no drop, only asphalt giving onto grass.
  return 'grass';
}

// OpenStreetMap's own answer: which ways share the node a road ends on.
const byNode = new Map();
for (const w of source.roads) {
  for (const c of [w.a, w.b]) {
    if (c < 0) continue;
    if (!byNode.has(c)) byNode.set(c, []);
    byNode.get(c).push(w);
  }
}
const drawn = new Map();
for (const r of layout.roads) drawn.set(r.osm, (drawn.get(r.osm) || []).concat(r.id));
const onGround = new Set(layout.streets.map((st) => st.osm));

/** The ways meeting at the node a road ends on, and what became of each here. */
function topology(r, end) {
  const S = r.samples, p = end === 'start' ? S[0] : S[S.length - 1];
  const w = source.roads[r.osm];
  if (!w) return '';
  // A street's lifted piece ends on the node only where the way itself ends.
  const at = [[w.a, w.pts[0]], [w.b, w.pts[w.pts.length - 1]]]
    .find(([c, q]) => c >= 0 && Math.hypot(q[0] * scale - p.x, q[1] * scale - p.n) < 3 * scale);
  if (!at) return r.street ? 'suite de sa rue' : 'nœud hors de la pièce';
  const others = byNode.get(at[0]).filter((o) => o !== w);
  // A way that runs on through the node keeps it among its points, not its ends.
  const [qx, qn] = at[1];
  for (const o of source.roads) {
    if (o === w || others.includes(o)) continue;
    if (o.pts.some(([x, n]) => Math.abs(x - qx) < 0.5 && Math.abs(n - qn) < 0.5)) others.push(o);
  }
  if (!others.length) return 'cul-de-sac dans OSM';
  return others.map((o) => `${o.kind === 'link' ? 'bretelle' : o.cls} ${o.id}${o.name ? ` ${o.name}` : ''} → ${drawn.has(o.id) ? drawn.get(o.id).join('+') : onGround.has(o.id) ? 'rue' : 'absent'}`).join(', ');
}

/** What lies near an open end: the closest other road and street, and how far up or down. */
function around(r, p) {
  let road = null, street = null;
  for (const o of layout.roads) {
    if (o === r) continue;
    for (const q of o.samples) {
      const d = Math.hypot(q.x - p.x, q.n - p.n) - (q.h ?? o.half);
      if (d < 25 && (!road || d < road.d)) road = { id: o.id, name: o.name || '', d, dy: q.y - p.y };
    }
  }
  for (const st of layout.streetsAt(p.x, p.n, 25, [])) {
    let d = Infinity, at = null;
    const P = st.path;
    for (let i = 0; i + 1 < P.length; i++) {
      const { d2, t } = segDist2(p.x, p.n, P[i][0], P[i][1], P[i + 1][0], P[i + 1][1]);
      if (d2 < d * d) { d = Math.sqrt(d2); at = [P[i][0] + (P[i + 1][0] - P[i][0]) * t, P[i][1] + (P[i + 1][1] - P[i][1]) * t]; }
    }
    d -= st.half;
    if (!street || d < street.d) street = { name: st.name || st.cls, d, dy: T.height(at[0], at[1]) - p.y };
  }
  const f = (v) => (v > 0 ? '+' : '') + v.toFixed(1);
  return [road && `route ${road.id} ${road.name} à ${road.d.toFixed(0)} m, ${f(road.dy)} m`, street && `rue ${street.name} à ${street.d.toFixed(0)} m, ${f(street.dy)} m`].filter(Boolean).join(' ; ');
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
      id: r.id, way: r.osm, name: r.name || '', cls: r.cls, end, closed,
      x: Math.round(p.x), n: Math.round(p.n), y: Math.round(p.y * 10) / 10,
      ground: Math.round((p.y - T.height(p.x, p.n)) * 10) / 10,
      miss: Math.round((miss / total) * 100), grass: Math.round((grass / total) * 100), missing, near: around(r, p), osm: topology(r, end),
    });
  }
}

const open = ends.filter((e) => e.miss > 0);
const partial = open.filter((e) => e.miss < 90);
const dead = open.filter((e) => e.miss >= 90);
const grass = ends.filter((e) => !e.miss);
console.log(`${settings.zone} à ${settings.echelle} % — ${ends.length} bouts sans route au-delà : ${open.length} sur le vide (${partial.length} en partie, ${dead.length} en entier), `
  + `${grass.length} sur le gazon ; ${ends.filter((e) => e.closed).length} fermés d'une barrière`);
for (const e of ALL ? ends : partial) {
  const what = e.miss ? `${e.miss} % ouvert` : `${e.grass} % sur le gazon`;
  console.log(`${e.id} ${e.end} ${e.cls} ${e.name} (${e.x}, ${e.n}) y ${e.y} sol ${e.ground > 0 ? '+' : ''}${e.ground} — ${what}${e.closed ? ', fermé' : ''} [${e.missing.join(' ')}] — ${e.near || 'rien autour'} — OSM : ${e.osm}`);
}
const out = arg('--json', null);
if (out) fs.writeFileSync(out, JSON.stringify(ends, null, 1));
