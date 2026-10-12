// The checks to run before every commit, on the real map: the data builds,
// nothing solid stands on a street, and the car drives it — Décarie, the
// Métropolitaine, the Ville-Marie tunnel, the mountain, the bridge, the
// circuit, and a few hundred ordinary streets picked at random.
//
//   node mtl/tools/check.mjs              → node only (~40 s)
//   node mtl/tools/check.mjs --browser    → plus the real page in headless
//                                           Chromium: loads, no errors, drives
//   node mtl/tools/check.mjs --zone centre --echelle 85
//   node mtl/tools/check.mjs --forme <code>   → a drawn zone (?forme= of zones.html)
//
// Driving is measured, not eyeballed: an autopilot follows each motorway from
// one OpenStreetMap way to the next in the right-hand lane, and every impact,
// every jump and every metre off the road surface is counted against a
// threshold.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from '../vendor/three.module.min.js';
import { buildWorld } from '../src/world/build.js';
import { validate } from '../src/map/validate.js';
import { createSurface } from '../src/map/surface.js';
import { buildSolids } from '../src/map/collide.js';
import { projectOnRoad, SPACING } from '../src/map/layout.js';
import { resolveSpawn } from '../src/game/spawn.js';
import { pointInRing, ringBBox, hash01, segDist2 } from '../src/map/geom.js';
import { Driver } from '../src/game/drive.js';
import { buildNetwork, span, pointOn, lightAt, insideBox } from '../src/traffic/network.js';
import { createDensity } from '../src/traffic/density.js';
import { Traffic, TrafficReplica, TICK, CAR_LENGTH } from '../src/traffic/sim.js';
import { loadSourceNode } from './lib/source-node.mjs';
import { serve } from './lib/serve.mjs';
import { loadPlaywright } from './lib/playwright.mjs';
import { decodeShape } from '../src/map/zones.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const BROWSER = args.includes('--browser');
const settings = { zone: arg('--zone', 'anneau'), echelle: Number(arg('--echelle', 100)) };
if (arg('--forme', null)) Object.assign(settings, { zone: 'perso', forme: decodeShape(arg('--forme', null)) });
const STEP = 1 / 120;
const TRACE = !!process.env.TRACE;
const ONLY = arg('--only', null);
const results = [];

function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ok ' : 'ÉCHEC'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

// ------------------------------------------------------------------ world --

const t0 = performance.now();
const source = await loadSourceNode();
const world = await buildWorld(THREE, source, { settings });
const { layout, structures } = world;
const s = layout.map.scale;
const surface = createSurface(layout, structures);
const solids = buildSolids(layout, structures, world.buildings, { lamps: world.lamps, trees: world.trees, footprints: world.footprints });
const game = { layout, structures, surface, solids };
console.log(`zone ${settings.zone} à ${settings.echelle} % construite en ${((performance.now() - t0) / 1000).toFixed(1)} s — `
  + `${layout.streets.length} rues, ${layout.roads.length} routes, ${world.buildings.length} bâtiments, ${solids.count} obstacles\n`);

// --------------------------------------------------------------- the data --

{
  // OpenStreetMap gives layers, not heights: the profiles are inferred, and
  // some crossings come out lower or tighter than the real ones (listed, for
  // information). What must hold: every height is a number, and no road has
  // a slope a car cannot drive (25 %).
  const findings = validate(layout);
  const by = {};
  for (const f of findings) by[f.kind] = (by[f.kind] || 0) + 1;
  const nan = layout.roads.filter((r) => r.samples.some((p) => !Number.isFinite(p.y)));
  let worst = { g: 0 };
  for (const r of layout.roads) {
    const S = r.samples;
    for (let i = 1; i < S.length; i++) {
      const g = Math.abs(S[i].y - S[i - 1].y) / Math.max(0.1, S[i].s - S[i - 1].s);
      if (g > worst.g) worst = { g, r, p: S[i] };
    }
  }
  check('profils des routes', !nan.length && worst.g < 0.25,
    `${nan.length ? `${nan.length} routes sans hauteur — ` : ''}pente max ${(worst.g * 100).toFixed(0)} %${worst.r ? ` (${worst.r.name || worst.r.id}, ${Math.round(worst.p.x)}, ${Math.round(worst.p.n)})` : ''} ; `
    + `à revoir : ${Object.entries(by).map(([k, v]) => `${v} ${k}`).join(', ') || 'rien'}`);
}

{
  // Where a road ends on a street, not on another road nor at the zone's
  // edge, it ends at the street's height: a deck stopping in the air over the
  // street it joins is a wall to drive into. OpenStreetMap gives a bridge's
  // ramps to the ways beside it; map/real.js joins them back. A few remain
  // where the data's street forks right after the bridge, or where coming
  // down would pass under a highway too low.
  const high = [];
  let ends = 0;
  for (const r of layout.roads) {
    if (r.loop) continue;
    for (const [k, closed] of [[0, r.closedStart], [r.samples.length - 1, r.closedEnd]]) {
      const p = r.samples[k];
      if (closed || !layout.streetsAt(p.x, p.n, 0, []).length) continue;
      if (layout.roads.some((o) => o !== r && (projectOnRoad(o, p.x, p.n)?.d ?? Infinity) <= o.half + r.half * 0.6)) continue;
      ends++;
      const step = p.y - layout.terrain.height(p.x, p.n);
      if (Math.abs(step) > 3) high.push(`${r.name || r.id} ${step > 0 ? '+' : ''}${step.toFixed(1)} m (${Math.round(p.x)}, ${Math.round(p.n)})`);
    }
  }
  check('les routes se posent sur les rues', high.length <= 20,
    `${ends - high.length}/${ends} bouts au niveau de la rue à 3 m près${high.length ? ` — ${high.slice(0, 4).join(' ; ')}` : ''}`);
}

{
  // Along one side of a road, one wall hands over to the next (retaining
  // wall, tunnel wall under a street, skirt, fascia): they must overlap, not
  // stop a metre or two short of each other — through that slot, under a
  // street crossing Décarie, one saw the city.
  const bySide = new Map();
  for (const w of structures.walls) {
    if (!w.road) continue;
    const key = `${w.road}:${w.side}`;
    if (!bySide.has(key)) bySide.set(key, []);
    bySide.get(key).push(w.pts);
  }
  // Measured along the wall that follows, ahead of the end: side by side (a
  // retaining wall giving way to a skirt a metre further out) is an
  // overlap, and a wall behind the end is not the next one.
  let slots = 0;
  const where = [];
  for (const list of bySide.values()) {
    for (const pts of list) {
      for (const [e, f] of [[pts[0], pts[1]], [pts[pts.length - 1], pts[pts.length - 2]]]) {
        let best = null;
        for (const other of list) {
          if (other === pts) continue;
          for (let i = 0; i + 1 < other.length; i++) {
            const a = other[i], b = other[i + 1];
            const { d2 } = segDist2(e[0], e[1], a[0], a[1], b[0], b[1]);
            if (!best || d2 < best.d2) best = { d2, a, b };
          }
        }
        if (!best || best.d2 > 16) continue;
        const { a, b } = best;
        const mx = (a[0] + b[0]) / 2 - e[0], mn = (a[1] + b[1]) / 2 - e[1];
        if (mx * (e[0] - f[0]) + mn * (e[1] - f[1]) <= 0) continue;
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        const u = ((e[0] - a[0]) * (b[0] - a[0]) + (e[1] - a[1]) * (b[1] - a[1])) / len;
        if (Math.max(-u, u - len) > 0.3) { slots++; if (where.length < 4) where.push(`(${Math.round(e[0])}, ${Math.round(e[1])})`); }
      }
    }
  }
  check('murs sans fente', slots === 0, `${slots} fentes entre deux murs d'une même route${where.length ? ` — ${where.join(' ')}` : ''}`);
}

{
  // A landmark's footprint must leave every street and every road free.
  const bad = [];
  for (const f of world.footprints) {
    const hits = new Set();
    const bb = ringBBox(f.ring);
    const reach = Math.hypot(bb.x1 - bb.x0, bb.n1 - bb.n0) / 2;
    for (const st of layout.streetsAt((bb.x0 + bb.x1) / 2, (bb.n0 + bb.n1) / 2, reach, [])) {
      if (st.cls === 'plaza') continue;
      const P = st.path;
      for (let i = 0; i + 1 < P.length && !hits.has(st.name); i++) {
        const dx = P[i + 1][0] - P[i][0], dn = P[i + 1][1] - P[i][1], len = Math.hypot(dx, dn) || 1;
        for (let d = 0; d <= len; d += 2) {
          if (pointInRing(P[i][0] + (dx * d) / len, P[i][1] + (dn * d) / len, f.ring)) { hits.add(st.name); break; }
        }
      }
    }
    if (hits.size) bad.push(`${f.id} sur ${[...hits].join(', ')}`);
  }
  check('aucun repère sur une rue', bad.length === 0, bad.join(' ; ') || `${world.footprints.length} emprises`);
}

// ---------------------------------------------------------------- driving --

const driver = new Driver(game);
const spec = driver.vehicle.spec;

{
  const bad = [];
  let placed = 0;
  for (const sp of layout.map.spawns) {
    const p = resolveSpawn(layout, sp);
    if (!p) { bad.push(`${sp.id}: introuvable`); continue; }
    driver.place(p.x, p.n, p.heading, p.y);
    if (Math.abs(driver.y - p.y) > 0.3 || !['road', 'terrain'].includes(driver.kind)) {
      bad.push(`${sp.id}: y ${driver.y.toFixed(2)} au lieu de ${p.y.toFixed(2)} (${driver.kind})`);
      continue;
    }
    // Two seconds at rest: nothing pushes it, nothing drops it.
    const x = driver.x, n = driver.n, y = driver.y;
    for (let i = 0; i < 240; i++) driver.step(STEP, { throttle: 0, brake: 0, steer: 0, handbrake: false });
    if (Math.hypot(driver.x - x, driver.n - n) > 0.3 || Math.abs(driver.y - y) > 0.3) bad.push(`${sp.id}: bouge seul`);
    else placed++;
  }
  check('points de départ', bad.length === 0, bad.join(' ; ') || `${placed} départs posés et stables`);
}

/**
 * A motorway as one road: from the way nearest (x, n) going `heading`, follow
 * the connectors from way to way — the same name first, straight on rather
 * than onto a ramp — for up to `max` metres. Returns a road-like object with
 * samples, or null.
 */
function route(name, x, n, heading, max = 6000) {
  x *= s; n *= s; max *= s;
  const hx = Math.sin((heading * Math.PI) / 180), hn = Math.cos((heading * Math.PI) / 180);
  let first = null, bd = Infinity;
  for (const r of layout.roads) {
    if (r.name !== name) continue;
    r.samples.forEach((p, i) => {
      const d = Math.hypot(p.x - x, p.n - n);
      const dir = p.tx * hx + p.tn * hn >= 0 ? 1 : -1;
      if (dir < 0 && r.oneway) return;
      if (d < bd) { bd = d; first = { r, dir, from: i }; }
    });
  }
  if (!first || bd > 400 * s) return streetRoute(name, x, n, hx, hn, max);
  const legs = [first];
  const used = new Set([first.r]);
  let len = 0;
  for (;;) {
    const cur = legs[legs.length - 1];
    const S = cur.r.samples;
    len += cur.dir > 0 ? cur.r.length - S[cur.from].s : S[cur.from].s;
    if (len >= max) break;
    if (cur.dir > 0 ? cur.r.closedEnd : cur.r.closedStart) break;
    const conn = cur.dir > 0 ? cur.r.b : cur.r.a;
    if (conn === undefined || conn < 0) break;
    const end = cur.dir > 0 ? S[S.length - 1] : S[0];
    const tx = end.tx * cur.dir, tn = end.tn * cur.dir;
    let next = null, score = -Infinity;
    for (const o of layout.roads) {
      if (used.has(o)) continue;
      let dir = 0;
      if (o.a === conn && !(o.closedStart)) dir = 1;
      else if (o.b === conn && !o.oneway && !o.closedEnd) dir = -1;
      if (!dir) continue;
      const q = dir > 0 ? o.samples[0] : o.samples[o.samples.length - 1];
      const align = q.tx * dir * tx + q.tn * dir * tn;
      const sc = align + (o.name === cur.r.name ? 1 : 0) + (o.cls === cur.r.cls ? 0.5 : 0);
      if (align > 0.5 && sc > score) { score = sc; next = { r: o, dir, from: dir > 0 ? 0 : o.samples.length - 1 }; }
    }
    if (!next) break;
    legs.push(next);
    used.add(next.r);
  }
  // Stitch the samples, reversing the ways driven against their direction.
  const samples = [];
  for (const leg of legs) {
    const S = leg.r.samples;
    const idx = [];
    if (leg.dir > 0) for (let i = leg.from; i < S.length; i++) idx.push(i);
    else for (let i = leg.from; i >= 0; i--) idx.push(i);
    for (const i of idx) {
      const p = S[i];
      const q = { x: p.x, n: p.n, y: p.y, tx: p.tx * leg.dir, tn: p.tn * leg.dir, lx: p.lx * leg.dir, ln: p.ln * leg.dir, s: 0 };
      const last = samples[samples.length - 1];
      if (last && Math.hypot(q.x - last.x, q.n - last.n) < 0.5) continue;
      q.s = last ? last.s + Math.hypot(q.x - last.x, q.n - last.n) : 0;
      samples.push(q);
      if (q.s >= max) break;
    }
    if (samples.length && samples[samples.length - 1].s >= max) break;
  }
  const width = Math.min(...legs.map((l) => l.r.width));
  return { name, samples, length: samples[samples.length - 1].s, width, half: width / 2, legs: legs.length };
}

/** A street lying on the relief, as a route: one way, sampled every 2 m. */
function streetRoute(name, x, n, hx, hn, max) {
  let best = null, bd = Infinity;
  for (const st of layout.streets) {
    if (st.name !== name) continue;
    for (const p of st.path) {
      const d = Math.hypot(p[0] - x, p[1] - n);
      if (d < bd) { bd = d; best = st; }
    }
  }
  if (!best || bd > 400 * s) return null;
  let P = best.path;
  const A = P[0], B = P[P.length - 1];
  if ((B[0] - A[0]) * hx + (B[1] - A[1]) * hn < 0) {
    if (best.oneway) return null;
    P = [...P].reverse();
  }
  const T = layout.terrain;
  const samples = [];
  for (let i = 0; i + 1 < P.length; i++) {
    const a = P[i], b = P[i + 1];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 1e-3) continue;
    const tx = (b[0] - a[0]) / L, tn = (b[1] - a[1]) / L;
    for (let d = 0; d < L; d += SPACING) {
      const px = a[0] + tx * d, pn = a[1] + tn * d;
      const last = samples[samples.length - 1];
      samples.push({ x: px, n: pn, y: T.height(px, pn), tx, tn, lx: -tn, ln: tx, s: last ? last.s + Math.hypot(px - last.x, pn - last.n) : 0 });
    }
  }
  const cut = samples.filter((p) => p.s <= max);
  return { name, samples: cut, length: cut[cut.length - 1].s, width: best.width, half: best.width / 2, legs: 1 };
}

/**
 * Follow a route in its right-hand lane with a pure-pursuit steering law and a
 * speed set by the curvature ahead. `pedals(out)` may take over the pedals
 * (0-100, braking). Returns what happened on the way.
 */
function autopilot(road, { vmax = 30, aLat = 6, pedals = null, maxTime = 600 } = {}) {
  const S = road.samples;
  // Right-hand lane of a carriageway; a street's centre when it is narrow.
  const off = road.width >= 11 ? road.width / 4 : 0;
  const kappa = S.map((p, i) => {
    const q = S[Math.min(S.length - 1, i + 1)];
    let d = Math.atan2(q.tx, q.tn) - Math.atan2(p.tx, p.tn);
    d = Math.atan2(Math.sin(d), Math.cos(d));
    return Math.abs(d) / Math.max(0.5, q.s - p.s);
  });
  const lanePoint = (i) => {
    const p = S[i];
    return [p.x + p.tn * off, p.n - p.tx * off, Math.atan2(p.tx, p.tn)];
  };
  let i = 0;
  const [x, n, h] = lanePoint(0);
  driver.place(x, n, h, S[0].y);
  const I = { throttle: 0, brake: 0, steer: 0, handbrake: false };
  const out = { impact: 0, air: 0, dy: 0, dyAt: null, lateral: 0, time: 0, done: false, vmaxSeen: 0 };
  let still = 0;
  for (let step = 0; step < maxTime / STEP; step++) {
    let best = i, bd = Infinity;
    for (let k = Math.max(0, i - 30); k < Math.min(S.length, i + 30); k++) {
      const [lx, ln] = lanePoint(k);
      const d = (lx - driver.x) ** 2 + (ln - driver.n) ** 2;
      if (d < bd) { bd = d; best = k; }
    }
    i = best;
    if (S[i].s >= road.length - 25) { out.done = true; break; }
    const v = driver.speed;
    const Ld = 8 + v * 0.55;
    let j = i;
    while (j + 1 < S.length && S[j].s - S[i].s < Ld) j++;
    const [txp, tnp] = lanePoint(j);
    let a = Math.atan2(txp - driver.x, tnp - driver.n) - driver.heading;
    a = Math.atan2(Math.sin(a), Math.cos(a));
    const delta = Math.atan2(2 * spec.wheelbase * Math.sin(a), Ld);
    const limit = spec.maxSteer * (0.28 + 0.72 / (1 + v / 20));
    I.steer = Math.max(-1, Math.min(1, delta / limit));
    // Slow for the sharpest bend within braking distance.
    const look = v * v / 10 + 30;
    let k = 0;
    for (let m = i; m < S.length && S[m].s - S[i].s < look; m++) k = Math.max(k, kappa[m]);
    const target = Math.min(vmax, Math.sqrt(aLat / Math.max(k, 1e-4)));
    I.throttle = Math.max(0, Math.min(1, (target - v) * 0.6));
    I.brake = Math.max(0, Math.min(1, (v - target) * 0.35));
    if (pedals && pedals(out, I, S[i].s) === 'stop') break;
    const k0 = driver.kind, r0 = driver.road && driver.road.id;
    driver.step(STEP, I);
    if (TRACE && (driver.kind !== k0 || (driver.road && driver.road.id) !== r0)) console.log('    trace', k0, r0, '→', driver.kind, driver.road && driver.road.id, [driver.x, driver.n, driver.y].map((v) => v.toFixed(1)).join(', '), `${driver.kmh.toFixed(0)} km/h`);
    out.time += STEP;
    out.vmaxSeen = Math.max(out.vmaxSeen, driver.kmh);
    out.impact = Math.max(out.impact, driver.impact);
    if (driver.impact > 1 && !out.hitAt) out.hitAt = [Math.round(driver.x), Math.round(driver.n), +driver.y.toFixed(1)];
    driver.impact = 0;
    if (driver.airborne) out.air += STEP;
    else {
      const hit = projectOnRoad(road, driver.x, driver.n);
      if (hit && hit.d < road.half) {
        const dy = Math.abs(driver.y - hit.y);
        if (dy > out.dy) { out.dy = dy; out.dyAt = [Math.round(driver.x), Math.round(driver.n)]; }
      }
    }
    out.lateral = Math.max(out.lateral, Math.sqrt(bd));
    still = driver.speed < 1 ? still + STEP : 0;
    if (still > 8 || driver.lost) break;
  }
  out.at = [Math.round(driver.x), Math.round(driver.n), +driver.y.toFixed(1)];
  return out;
}

function drive(label, [name, x, n, heading, max], opts = {}, limits = {}) {
  if (ONLY && !label.includes(ONLY)) return null;
  // Outside this zone: nothing to drive (a drawn zone's bounding box is not
  // the zone: the start of Décarie lies in the box of `coeur`, not in it).
  const Z = layout.map.zone;
  const inZone = Z ? Z.contains(x * s, n * s)
    : x * s >= layout.map.world.x0 && x * s <= layout.map.world.x1 && n * s >= layout.map.world.n0 && n * s <= layout.map.world.n1;
  const road = inZone ? route(name, x, n, heading, max) : null;
  if (!road) {
    check(label, !inZone, inZone ? `${name} introuvable` : 'hors de la zone');
    return null;
  }
  const r = autopilot(road, opts);
  const lim = { impact: 2, air: 0.3, dy: 0.35, lateral: 3.5, ...limits };
  const ok = r.done && r.impact <= lim.impact && r.air <= lim.air && r.dy <= lim.dy && r.lateral <= lim.lateral;
  const detail = `${(road.length / 1000).toFixed(1)} km, ${road.legs} tronçons — ${r.done ? '' : `arrêté en ${r.at} — `}`
    + `${r.time.toFixed(0)} s, pointe ${r.vmaxSeen.toFixed(0)} km/h, choc max ${r.impact.toFixed(1)} m/s${r.hitAt ? ` en ${r.hitAt}` : ''}, `
    + `en l'air ${r.air.toFixed(2)} s, écart vertical ${r.dy.toFixed(2)} m${r.dyAt ? ` en ${r.dyAt}` : ''}, écart latéral ${r.lateral.toFixed(1)} m`;
  check(label, ok, detail);
  return r;
}

// Routes: [name, x, n (real metres, grid frame), heading, length].
const DECARIE_S = ['Autoroute Décarie', -3400, 5500, 180, 4000];
const DECARIE_N = ['Autoroute Décarie', -3950, 1000, 0, 4000];

{
  // 0-100 then 100-0, in the Décarie trench.
  let t100 = -1, s0 = 0, stopAt = -1;
  const road = route(...DECARIE_S);
  if (!road) check('0 à 100 km/h', settings.zone !== 'anneau', 'Décarie hors de la zone');
  else {
    const r = autopilot(road, {
      vmax: 45,
      pedals(out, I, sNow) {
        if (t100 < 0) {
          I.throttle = 1; I.brake = 0;
          if (driver.kmh >= 100) { t100 = out.time; s0 = sNow; }
        } else {
          I.throttle = 0; I.brake = 1;
          if (driver.vehicle.u < 0.3) { stopAt = sNow; return 'stop'; }
        }
        return null;
      },
    });
    check('0 à 100 km/h', t100 > 5 && t100 < 10, `${t100.toFixed(2)} s (tranchée Décarie)`);
    check('freinage 100 à 0', stopAt > 0 && stopAt - s0 < 55 * Math.max(1, 1 / s), `${(stopAt - s0).toFixed(1)} m${r.impact > 1 ? `, choc ${r.impact.toFixed(1)}` : ''}`);
  }
}

drive('Décarie vers le sud (tranchée)', DECARIE_S, { vmax: 30 });
drive('Décarie vers le nord', DECARIE_N, { vmax: 30 });
drive('Métropolitaine vers l’est (viaduc)', ['Autoroute Métropolitaine', -900, 6600, 95, 5000], { vmax: 30 });
drive('Métropolitaine vers l’ouest', ['Autoroute Métropolitaine', 5000, 5900, 275, 5000], { vmax: 30 });
drive('Ville-Marie vers l’est (tunnel)', ['Autoroute Ville-Marie', -1500, -300, 100, 3600], { vmax: 25 });
drive('Ville-Marie vers l’ouest (tunnel)', ['Autoroute Ville-Marie', 2000, -630, 270, 3600], { vmax: 25 });
drive('pont Jacques-Cartier', ['Pont Jacques-Cartier', 3150, 50, 160, 2600], { vmax: 25 });
drive('Camillien-Houde', ['Voie Camillien-Houde', 620, 1960, 270, 2000], { vmax: 16 });
drive('circuit Gilles-Villeneuve', ['Circuit Gilles-Villeneuve', 2300, -3200, 180, 4000], { vmax: 30, aLat: 8 });

{
  // Streets under the viaduct: every named street crossing the
  // Métropolitaine where it is up, followed by the autopilot 60 m either
  // side. The car stays on the street and hits nothing; the deck clears it.
  const T = layout.terrain;
  const viaduct = layout.roads.filter((r) => r.name === 'Autoroute Métropolitaine');
  const W = layout.map.world;
  const inside = (x, n) => x - W.x0 > 80 && W.x1 - x > 80 && n - W.n0 > 80 && W.n1 - n > 80;
  const cut = (a, b, c, d) => {
    const rx = b[0] - a[0], rn = b[1] - a[1], sx = d[0] - c[0], sn = d[1] - c[1];
    const den = rx * sn - rn * sx;
    if (Math.abs(den) < 1e-9) return null;
    const t = ((c[0] - a[0]) * sn - (c[1] - a[1]) * sx) / den, u = ((c[0] - a[0]) * rn - (c[1] - a[1]) * rx) / den;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
  };
  let tried = 0, low = 0;
  const bad = [];
  for (const st of layout.streets) {
    if (!st.name || st.cls === 'alley' || st.cls === 'plaza') continue;
    const P = st.path;
    for (let i = 0; i + 1 < P.length; i++) {
      for (const r of viaduct) {
        const S = r.samples;
        for (let k = 0; k + 1 < S.length; k++) {
          const t = cut(P[i], P[i + 1], [S[k].x, S[k].n], [S[k + 1].x, S[k + 1].n]);
          if (t === null) continue;
          const x = P[i][0] + (P[i + 1][0] - P[i][0]) * t, n = P[i][1] + (P[i + 1][1] - P[i][1]) * t;
          const deck = S[k].y - T.height(x, n);
          if (deck < 4 || !inside(x, n)) continue;
          if (deck < 5.2 + 1.6) low++;
          // The street as a route, 60 m before the crossing to 60 m after.
          const pts = [];
          let acc = 0;
          for (let j = i; j >= 0 && acc < 60; j--) { pts.unshift(P[j]); if (j < i) acc += Math.hypot(P[j + 1][0] - P[j][0], P[j + 1][1] - P[j][1]); }
          acc = 0;
          for (let j = i + 1; j < P.length && acc < 60; j++) { pts.push(P[j]); acc += Math.hypot(P[j][0] - P[j - 1][0], P[j][1] - P[j - 1][1]); }
          const samples = [];
          for (let q = 0; q + 1 < pts.length; q++) {
            const a = pts[q], b = pts[q + 1], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
            if (L < 1e-3) continue;
            const tx = (b[0] - a[0]) / L, tn = (b[1] - a[1]) / L;
            for (let d = 0; d < L; d += SPACING) {
              const px = a[0] + tx * d, pn = a[1] + tn * d, last = samples[samples.length - 1];
              samples.push({ x: px, n: pn, y: T.height(px, pn), tx, tn, lx: -tn, ln: tx, s: last ? last.s + Math.hypot(px - last.x, pn - last.n) : 0 });
            }
          }
          if (samples.length < 20) continue;
          tried++;
          const route = { name: st.name, samples, length: samples[samples.length - 1].s, width: st.width, half: st.width / 2, legs: 1 };
          const res = autopilot(route, { vmax: 12, maxTime: 60 });
          if (!res.done || res.impact > 1) bad.push(`${st.name} (${Math.round(x)}, ${Math.round(n)}) choc ${res.impact.toFixed(1)}${res.done ? '' : ' arrêtée'}`);
        }
      }
    }
  }
  if (!viaduct.length) check('les rues passent sous la 40', true, 'hors de la zone');
  else check('les rues passent sous la 40', tried > 10 && low === 0 && bad.length === 0,
    `${tried} rues sous le viaduc, ${low} avec moins de 6,8 m sous le tablier${bad.length ? ` ; ${bad.length} accrochent : ${bad.slice(0, 4).join(' ; ')}` : ''}`);
}

{
  // Ordinary streets, picked at random (always the same ones): put the car
  // down in the right-hand lane, leave it two seconds, then drive 60 m
  // straight on at 30 km/h. Nothing solid may stand on the carriageway.
  const pool = layout.streets.filter((st) => st.cls !== 'plaza' && st.cls !== 'alley' && st.path.length >= 2);
  const N = 300;
  let tried = 0;
  const bad = [];
  for (let k = 0; tried < N && k < N * 4; k++) {
    const st = pool[Math.floor(hash01(k, 91) * pool.length)];
    const P = st.path;
    const i = Math.floor(hash01(k, 92) * (P.length - 1));
    const A = P[i], B = P[i + 1];
    const L = Math.hypot(B[0] - A[0], B[1] - A[1]);
    if (L < 70 * s) continue;
    const tx = (B[0] - A[0]) / L, tn = (B[1] - A[1]) / L;
    const off = st.width >= 11 ? st.width / 4 : 0;
    const x = A[0] + tx * 5 + tn * off, n = A[1] + tn * 5 - tx * off;
    // Skip spots under a road deck or next to a bridge: driven above.
    if (structures.index.surfacesAt(x, n, 6, []).length) continue;
    tried++;
    driver.place(x, n, Math.atan2(tx, tn));
    let impact = 0;
    for (let t = 0; t < 240; t++) {
      driver.step(STEP, { throttle: driver.kmh < 30 ? 0.5 : 0, brake: 0, steer: 0, handbrake: false });
      impact = Math.max(impact, driver.impact); driver.impact = 0;
      if (Math.hypot(driver.x - x, driver.n - n) > 55 * s) break;
    }
    if (impact > 1 || driver.lost || driver.airborne) {
      bad.push(`${st.name || 'rue sans nom'} (${Math.round(x)}, ${Math.round(n)})${impact > 1 ? ` choc ${impact.toFixed(1)}` : ''}${driver.airborne ? ' en l’air' : ''}`);
    }
  }
  check('rues au hasard', bad.length <= Math.ceil(tried * 0.03), `${tried - bad.length}/${tried} sans obstacle${bad.length ? ` — ${bad.slice(0, 6).join(' ; ')}` : ''}`);
}

// ---------------------------------------------------------------- traffic --

{
  const t1 = performance.now();
  const net = buildNetwork(layout);
  const ms = performance.now() - t1;
  const by = {};
  for (const o of net.nodes) by[o.control] = (by[o.control] || 0) + 1;
  check('réseau de circulation', net.edges.length > 1000 && (by.signal || 0) > 50 && (by.stop || 0) > 50,
    `${net.edges.length} tronçons, ${by.signal || 0} carrefours à feux, ${by.stop || 0} arrêts, ${by.merge || 0} bretelles, en ${ms.toFixed(0)} ms`);

  // Lights: two ways that cross are never green together, at any junction
  // of a cluster (a boulevard's two carriageways are one junction).
  {
    const dirOf = (ed) => {
      const e = net.edges[ed >> 1], P = ed & 1 ? e.pts.slice().reverse() : e.pts;
      let i = P.length - 1, d = 0;
      while (i > 0 && d < 15) { d += Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]); i--; }
      return Math.atan2(P[P.length - 1][0] - P[i][0], P[P.length - 1][1] - P[i][1]);
    };
    const fold = (a) => { const d = Math.abs(a) % Math.PI; return d > Math.PI / 2 ? Math.PI - d : d; };
    const lit = net.nodes.filter((o) => o.control === 'signal');
    const bad = new Set();
    for (const o of lit) {
      const aps = [];
      for (const p of lit) {
        if (p.offset !== o.offset || Math.hypot(p.x - o.x, p.n - o.n) > 120 * s) continue;
        for (const ed of p.in) if (!insideBox(net, ed)) aps.push([p, ed, dirOf(ed)]);
      }
      for (let t = 0; t < 160 && !bad.has(o.id); t += 1) {
        const g = aps.filter(([p, ed]) => lightAt(p, ed, t) === 'g');
        for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) if (fold(g[i][2] - g[j][2]) > Math.PI / 3) bad.add(o.id);
      }
    }
    const ex = [...bad].slice(0, 3).map((id) => `(${Math.round(net.nodes[id].x)}, ${Math.round(net.nodes[id].n)})`).join(' ');
    check('feux : jamais deux verts qui se croisent', bad.size === 0, `${bad.size}/${lit.length} carrefours en conflit ${ex}`);
  }

  // Two players far apart: the host keeps one bubble around each.
  const at = (id) => { const p = resolveSpawn(layout, layout.map.spawns.find((q) => q.id === id)); return { x: p.x, n: p.n, y: p.y, heading: p.heading, speed: 0 }; };
  const players = ['centre-ville', 'plateau'].map(at);
  // For the flow itself, two bubbles whose players hover above the street:
  // a player standing in a lane holds up a queue, and that is tested apart.
  const hover = players.map((p) => ({ ...p, y: p.y + 50 }));
  const run = (seconds, seed = 1) => {
    const tr = new Traffic(net, { seed, max: 120 });
    const still = new Map();
    let worst = 0, nan = 0, steps = 0, spent = 0, speed = 0, samples = 0;
    for (let i = 0; i < seconds / TICK; i++) {
      const a = performance.now();
      tr.step(TICK, hover);
      spent += performance.now() - a;
      steps++;
      for (const c of tr.cars) {
        if (!Number.isFinite(c.x + c.n + c.y)) nan++;
        const t = c.v < 0.3 ? (still.get(c.id) || 0) + TICK : 0;
        still.set(c.id, t);
        if (t > worst) worst = t;
        speed += c.v; samples++;
      }
    }
    return { tr, worst, nan, ms: spent / steps, speed: speed / Math.max(1, samples) };
  };
  const r = run(300);
  const C = r.tr.count;
  check('trafic : 5 minutes, deux joueurs', r.nan === 0 && C.red === 0 && r.worst < 60 && r.speed > 3 && r.tr.cars.length > 60 && r.ms < 2,
    `${r.tr.cars.length} autos, ${C.through} carrefours franchis, ${C.red} feu rouge brûlé, plus long arrêt ${r.worst.toFixed(0)} s, `
    + `${(r.speed * 3.6).toFixed(0)} km/h en moyenne, ${(r.ms * 1000).toFixed(0)} µs par pas`);

  // Same seed, same players: the same traffic, step for step.
  const a = run(40, 7).tr.digest(), b = run(40, 7).tr.digest();
  check('trafic déterministe', a === b, `${a} / ${b}`);

  // What another player receives: every car, a few floats each.
  const host = r.tr, rep = new TrafficReplica(net);
  const buf = host.encode();
  rep.apply(buf);
  rep.apply(buf);
  const hp = host.poses(1), rp = rep.poses(1);
  let err = 0;
  for (let i = 0; i < hp.length; i++) err = Math.max(err, Math.hypot(hp[i].x - rp[i].x, hp[i].n - rp[i].n), Math.abs(hp[i].y - rp[i].y));
  check('trafic en réseau (hôte → joueurs)', rp.length === hp.length && err < 0.01,
    `${buf.byteLength} octets pour ${hp.length} autos (${(buf.byteLength * 20 / 1024).toFixed(0)} Ko/s à 20 Hz), écart ${(err * 1000).toFixed(1)} mm`);

  // A car brakes for a player standing in its lane, and stops short of the car.
  const tr = new Traffic(net, { seed: 3, max: 60 });
  const P0 = [players[0]];
  for (let i = 0; i < 200; i++) tr.step(TICK, P0);
  const sp = {};
  const c = tr.cars.find((o) => !o.conn && o.v > 5 && (span(net, o.ed, sp), sp.s1 - o.s > 90));
  let detail = 'aucune auto sur une ligne droite', ok = false;
  if (c) {
    span(net, c.ed, sp);
    const q = pointOn(net, c.ed, c.s + 45, c.lat, {});
    const me = [{ x: q.x, n: q.n, y: q.y, heading: q.h, speed: 0 }];
    for (let i = 0; i < 20 / TICK; i++) tr.step(TICK, me);
    const d = Math.hypot(c.x - q.x, c.n - q.n);
    ok = tr.cars.includes(c) && c.v < 0.2 && d > 4.8 && d < 12;
    detail = `arrêtée à ${d.toFixed(1)} m (centre à centre) à ${c.v.toFixed(1)} m/s`;
  }
  check('les autos s’arrêtent devant le joueur', ok, detail);

  // Cut off: on Décarie, a player swerves from the next lane into the path
  // of a car at ~65 km/h, 16 m ahead of it. Seeing only where the player is,
  // the car would brake too late and hit (~2.5 m centre to centre).
  {
    const DP = [at('decarie')];
    const tr2 = new Traffic(net, { seed: 5, max: 60 });
    const sp2 = {};
    let v = null;
    for (let i = 0; i < 1200 && !v; i++) {
      tr2.step(TICK, DP);
      v = tr2.cars.find((o) => !o.conn && o.v > 18 && (span(net, o.ed, sp2), sp2.s1 - o.s > 150));
    }
    let ok2 = false, d2 = 'aucune auto lancée sur l’autoroute';
    if (v) {
      const side = 4, cross = 6;
      const q = pointOn(net, v.ed, v.s + 16 + (v.v * side) / cross, v.lat, {});
      const right = q.h + Math.PI / 2;
      const me = { x: q.x + Math.sin(right) * side, n: q.n + Math.cos(right) * side, y: q.y, heading: q.h - Math.PI / 2, speed: cross };
      const v0 = v.v;
      let min = Infinity, horn = false;
      for (let i = 0; i < 6 / TICK; i++) {
        if (Math.hypot(me.x - q.x, me.n - q.n) > 0.3) { me.x -= Math.sin(right) * cross * TICK; me.n -= Math.cos(right) * cross * TICK; } else me.speed = 0;
        tr2.step(TICK, [me]);
        min = Math.min(min, Math.hypot(v.x - me.x, v.n - me.n));
        if (tr2.events.some((e) => e.id === v.id)) horn = true;
        tr2.events.length = 0;
      }
      ok2 = min > CAR_LENGTH + 0.5 && v.v < 1;
      d2 = `${(v0 * 3.6).toFixed(0)} km/h → arrêtée, au plus près ${min.toFixed(1)} m (centre à centre)${horn ? ', klaxon' : ''}`;
    }
    check('les autos freinent quand on leur coupe le chemin', ok2, d2);
  }

  // trafic.json: the hour, the districts and the roads set how many cars.
  {
    const cfg = { autos_max: 90, horaire: { '00:00': 0.3, '07:00': 1.5, '09:30': 1 },
      zones: [{ quartier: 'Centre-ville', densite: 1.2 }], routes: [{ nom: 'Rue Sainte-Catherine', densite: 0 }] };
    const D = createDensity(cfg, layout, net);
    const count = (hour) => {
      const t = new Traffic(net, { seed: 2, max: 150, density: D, hour });
      for (let i = 0; i < 20 * 20; i++) t.step(TICK, P0);
      return t;
    };
    const night = count(3 * 3600), rush = count(8 * 3600);
    const sc = new Traffic(net, { seed: 2, max: 150, density: D, hour: 8 * 3600 });
    sc.step(TICK, P0);
    const onIt = sc.cars.filter((c) => /^rue sainte-catherine/i.test((net.edges[c.ed >> 1].street || {}).name || '')).length;
    check('trafic.json : heures, quartiers, routes', D.warnings.length === 0 && night.cars.length < rush.cars.length / 3 && onIt === 0,
      `3 h : ${night.cars.length} autos, 8 h : ${rush.cars.length}, Sainte-Catherine à 0 : ${onIt} auto au départ${D.warnings.length ? ` — ${D.warnings.join(' ; ')}` : ''}`);
  }

  // And the player's car hits them: they are solid.
  if (c) {
    solids.dynamic = { near: (x, n, rr, out) => tr.near(x, n, rr, out) };
    const back = pointOn(net, c.ed, c.s - 25, c.lat, {});
    driver.place(back.x, back.n, back.h, back.y);
    let hit = 0;
    for (let i = 0; i < 4 / STEP; i++) {
      driver.step(STEP, { throttle: 1, brake: 0, steer: 0, handbrake: false });
      hit = Math.max(hit, driver.impact); driver.impact = 0;
    }
    const along = (driver.x - back.x) * Math.sin(back.h) + (driver.n - back.n) * Math.cos(back.h);
    solids.dynamic = null;
    check('les autos sont solides', hit > 1 && along < 25, `choc à ${(hit * 3.6).toFixed(0)} km/h, arrêtée ${(25 - along).toFixed(1)} m avant le centre de l’auto`);
  }
}

// ---------------------------------------------------------------- browser --

if (BROWSER) {
  const { server, url } = await serve(ROOT);
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    // The optional civic.glb (mtl/README.md, "La voiture") is absent in this
    // checkout by design — game/gltf-car.js probes it with a HEAD request and
    // falls back silently, but Chromium still logs the failed HTTP request
    // itself to the console; no amount of catching in page JS suppresses
    // that. Expected, not a bug — only swallow this one exact 404.
    if (/Failed to load resource.*404/.test(m.text()) && /\/models\/civic\.glb$/.test(m.location().url || '')) return;
    errors.push(m.text());
  });
  const tl = Date.now();
  await page.goto(`${url}/index.html?spawn=decarie&${settings.forme ? `forme=${arg('--forme', '')}` : `zone=${settings.zone}`}&echelle=${settings.echelle}`);
  await page.waitForFunction(() => window.__mtl && window.__mtl.ready, null, { timeout: 300000 });
  await page.waitForFunction(() => window.__mtl.frames() > 3, null, { timeout: 120000 });
  const load = (Date.now() - tl) / 1000;
  const stats = await page.evaluate(() => window.__mtl.stats());
  const settingsHidden = await page.evaluate(() => getComputedStyle(document.getElementById('settings')).display === 'none');
  check('la page se charge', settingsHidden, `${load.toFixed(1)} s (SwiftShader), ${stats.calls} appels, ${(stats.triangles / 1e6).toFixed(2)} M triangles${settingsHidden ? '' : ', le panneau Carte est ouvert'}`);
  const r = await page.evaluate(() => window.__mtl.simulate(6, { throttle: 1 }));
  check('conduite dans la page', r.kmh > 60 && !r.lost && r.maxImpact < 1, `${r.kmh.toFixed(0)} km/h, y = ${r.y.toFixed(2)}, ${r.where ? r.where.name : '?'}`);
  // Keys are handled by the frame loop, and a SwiftShader frame is slow.
  await page.keyboard.press('KeyM');
  const mapOpen = await page.waitForFunction(() => !document.getElementById('bigmap').hidden, null, { timeout: 30000 })
    .then(() => true, () => false);
  await page.keyboard.press('KeyM');
  check('grande carte (M)', mapOpen, mapOpen ? 'ouverte' : 'ne s’ouvre pas');
  {
    // Free flight: F leaves the car, Space climbs, G lands the car on the
    // street in the middle of the view and gives the wheel back.
    await page.keyboard.press('KeyF');
    const on = await page.waitForFunction(() => document.body.classList.contains('fly'), null, { timeout: 30000 })
      .then(() => true, () => false);
    const h0 = await page.evaluate(() => window.__mtl.fly.h);
    await page.keyboard.down('Space');
    await page.waitForFunction((h) => window.__mtl.fly.h > h + 20, h0, { timeout: 60000 }).catch(() => {});
    await page.keyboard.up('Space');
    const h1 = await page.evaluate(() => window.__mtl.fly.h);
    // Sainte-Catherine near Peel, from above.
    const [tx, tn] = await page.evaluate(() => {
      const L = window.__mtl.game.layout;
      let best = [0, 0], bd = Infinity;
      for (const st of L.streets) {
        if (!/Sainte-Catherine/.test(st.name)) continue;
        for (const p of st.path) { const d = Math.hypot(p[0], p[1]); if (d < bd) { bd = d; best = p; } }
      }
      const [a, b] = best;
      const T = L.terrain;
      window.__mtl.look(a - 150, b - 150, T.height(a, b) + 120, a, b, T.height(a, b));
      return best;
    });
    await page.keyboard.press('KeyG');
    const back = await page.waitForFunction(() => !document.body.classList.contains('fly'), null, { timeout: 30000 })
      .then(() => true, () => false);
    const st = await page.evaluate(() => window.__mtl.state());
    const d = Math.hypot(st.x - tx, st.n - tn);
    check('vol libre (F, Espace, G)', on && h1 > h0 + 20 && back && d < 20,
      `monté de ${(h1 - h0).toFixed(0)} m, voiture posée à ${d.toFixed(1)} m du centre de la vue (${st.where ? st.where.name : '?'})`);
  }
  check('aucune erreur dans la page', errors.length === 0, errors.slice(0, 5).join(' | ') || '0');
  await browser.close();
  server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} contrôles passent.`);
process.exit(failed.length ? 1 : 0);
