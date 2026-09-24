// The checks to run before every commit, on the real map: the data builds,
// nothing solid stands on a street, and the car drives it — Décarie, the
// Métropolitaine, the Ville-Marie tunnel, the mountain, the bridge, the
// circuit, and a few hundred ordinary streets picked at random.
//
//   node mtl/tools/check.mjs              → node only (~40 s)
//   node mtl/tools/check.mjs --browser    → plus the real page in headless
//                                           Chromium: loads, no errors, drives
//   node mtl/tools/check.mjs --zone centre --echelle 85
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
import { pointInRing, ringBBox, hash01 } from '../src/map/geom.js';
import { Driver } from '../src/game/drive.js';
import { loadSourceNode } from './lib/source-node.mjs';
import { serve } from './lib/serve.mjs';
import { loadPlaywright } from './lib/playwright.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const BROWSER = args.includes('--browser');
const settings = { zone: arg('--zone', 'anneau'), echelle: Number(arg('--echelle', 100)) };
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
  const road = route(name, x, n, heading, max);
  if (!road) {
    // Outside this zone: nothing to drive.
    const inZone = x * s >= layout.map.world.x0 && x * s <= layout.map.world.x1 && n * s >= layout.map.world.n0 && n * s <= layout.map.world.n1;
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

// ---------------------------------------------------------------- browser --

if (BROWSER) {
  const { server, url } = await serve(ROOT);
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const tl = Date.now();
  await page.goto(`${url}/index.html?spawn=decarie&zone=${settings.zone}&echelle=${settings.echelle}`);
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
