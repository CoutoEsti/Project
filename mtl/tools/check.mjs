// The checks to run before every commit: the map is valid, nothing solid
// stands on a street, and the car drives it — the whole ring at speed, the
// trench, the tunnel, the viaduct, the mountain, the bridge, the circuit.
//
//   node mtl/tools/check.mjs              → node only (~15 s)
//   node mtl/tools/check.mjs --browser    → plus the real page in headless
//                                           Chromium: loads, no errors, drives
//
// Driving is measured, not eyeballed: an autopilot follows each road in the
// right-hand lane and every impact, every jump and every metre off the road
// surface is counted against a threshold.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from '../vendor/three.module.min.js';
import { buildWorld } from '../src/world/build.js';
import { landmarkFootprints } from '../src/world/landmarks.js';
import { validate, formatFindings } from '../src/map/validate.js';
import { createSurface } from '../src/map/surface.js';
import { buildSolids } from '../src/map/collide.js';
import { projectOnRoad, SPACING } from '../src/map/layout.js';
import { pointInRing } from '../src/map/geom.js';
import { Driver } from '../src/game/drive.js';
import { serve } from './lib/serve.mjs';
import { loadPlaywright } from './lib/playwright.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BROWSER = process.argv.includes('--browser');
const STEP = 1 / 120;
const results = [];

function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ok ' : 'ÉCHEC'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

// ------------------------------------------------------------------ world --

const t0 = performance.now();
const world = await buildWorld(THREE, {});
const { layout, structures } = world;
const footprints = landmarkFootprints(THREE, world.landmarks);
const surface = createSurface(layout, structures);
const solids = buildSolids(layout, structures, world.buildings, { lamps: world.lamps, trees: world.trees, footprints });
const game = { layout, structures, surface, solids };
console.log(`monde construit en ${((performance.now() - t0) / 1000).toFixed(1)} s — ${world.buildings.length} bâtiments, ${solids.count} obstacles\n`);

// --------------------------------------------------------------- the data --

{
  const findings = validate(layout);
  check('validation de la carte', findings.length === 0, findings.length ? `\n${formatFindings(findings)}` : '0 anomalie');
}

{
  // A landmark's footprint must leave every street corridor and every road
  // ribbon at its level free: test the centreline and both edges.
  const bad = [];
  const covers = (f, x, n) => pointInRing(x, n, f.ring);
  for (const f of footprints) {
    const hits = new Set();
    for (const st of layout.streets) {
      if (st.cls === 'apron' || st.cls === 'plaza') continue;
      const P = st.path;
      for (let i = 0; i + 1 < P.length; i++) {
        const dx = P[i + 1][0] - P[i][0], dn = P[i + 1][1] - P[i][1], len = Math.hypot(dx, dn);
        const lx = -dn / len, ln = dx / len, h = st.width / 2 - 0.5;
        for (let d = 0; d <= len; d += 2) {
          const x = P[i][0] + (dx * d) / len, n = P[i][1] + (dn * d) / len;
          if (covers(f, x, n) || covers(f, x + lx * h, n + ln * h) || covers(f, x - lx * h, n - ln * h)) { hits.add(st.name); break; }
        }
      }
    }
    for (const r of layout.roads) {
      for (const p of r.samples) {
        if (Math.abs(p.y - (f.y0 + 0.5)) > 4) continue;
        const h = r.half - 0.5;
        if (covers(f, p.x, p.n) || covers(f, p.x + p.lx * h, p.n + p.ln * h) || covers(f, p.x - p.lx * h, p.n - p.ln * h)) { hits.add(r.name); break; }
      }
    }
    if (hits.size) bad.push(`${f.id} sur ${[...hits].join(', ')}`);
  }
  check('aucun repère sur une rue', bad.length === 0, bad.join(' ; ') || `${footprints.length} emprises`);
}

// ---------------------------------------------------------------- driving --

const driver = new Driver(game);
const spec = driver.vehicle.spec;

{
  const bad = [];
  for (const s of layout.map.spawns) {
    driver.place(s.x, s.n, (s.heading * Math.PI) / 180, s.y ?? 0);
    const want = s.y ?? 0;
    if (Math.abs(driver.y - want) > 0.3 || !['road', 'land', 'block', 'terrain', 'deck'].includes(driver.kind)) {
      bad.push(`${s.id}: y ${driver.y.toFixed(2)} (${driver.kind})`);
    }
    // Two seconds at rest: nothing pushes it, nothing drops it.
    const x = driver.x, n = driver.n;
    for (let i = 0; i < 240; i++) driver.step(STEP, { throttle: 0, brake: 0, steer: 0, handbrake: false });
    if (Math.hypot(driver.x - x, driver.n - n) > 0.2 || Math.abs(driver.y - want) > 0.3) bad.push(`${s.id}: bouge seul`);
  }
  check('points de départ', bad.length === 0, bad.join(' ; ') || `${layout.map.spawns.length} départs posés et stables`);
}

/** Pedals held for a while on a straight: returns the step count until `until` is true. */
function hold(pedals, until, maxSeconds = 30) {
  const I = { throttle: 0, brake: 0, steer: 0, handbrake: false, ...pedals };
  for (let i = 1; i <= maxSeconds / STEP; i++) {
    driver.step(STEP, I);
    if (until(i)) return i;
  }
  return -1;
}

{
  // 0-100 and 100-0 in the Décarie trench: 1.1 km dead straight.
  driver.place(-1793, 150, 0, -8);
  const steps = hold({ throttle: 1 }, () => driver.kmh >= 100);
  const t = steps * STEP;
  check('0 à 100 km/h', steps > 0 && t > 5 && t < 10, `${t.toFixed(2)} s (tranchée Décarie)`);
  const n0 = driver.n;
  const stop = hold({ brake: 1 }, () => driver.vehicle.u < 0.3);
  const dist = driver.n - n0;
  check('freinage 100 à 0', stop > 0 && dist < 55, `${dist.toFixed(1)} m`);
  check('reste au fond de la tranchée', Math.abs(driver.y + 8) < 0.05, `y = ${driver.y.toFixed(2)}`);
}

/**
 * Follow a road in its right-hand lane with a pure-pursuit steering law and a
 * speed set by the curvature ahead. Returns what happened on the way.
 */
function autopilot(road, { dir = 1, s0 = 0, s1 = road.length, vmax = 36, aLat = 7, lane = null } = {}) {
  const S = road.samples;
  const off = lane ?? (road.width >= 12 ? road.width / 4 : 0);
  const kappa = S.map((p, i) => {
    const q = S[Math.min(S.length - 1, i + 1)];
    let d = Math.atan2(q.tx, q.tn) - Math.atan2(p.tx, p.tn);
    d = Math.atan2(Math.sin(d), Math.cos(d));
    return Math.abs(d) / SPACING;
  });
  const idx = (s) => Math.max(0, Math.min(S.length - 1, Math.round(s / SPACING)));
  const lanePoint = (i) => {
    const p = S[i];
    const tx = p.tx * dir, tn = p.tn * dir;
    return [p.x + tn * off, p.n - tx * off, Math.atan2(tx, tn)];
  };
  let i = idx(dir > 0 ? s0 : s1);
  const [x, n, h] = lanePoint(i);
  driver.place(x, n, h, S[i].y);
  const I = { throttle: 0, brake: 0, steer: 0, handbrake: false };
  const out = { impact: 0, air: 0, dy: 0, dyAt: null, lateral: 0, time: 0, done: false, vmaxSeen: 0 };
  let still = 0;
  for (let step = 0; step < 900 / STEP; step++) {
    // Progress along the road, searched near the last position.
    let best = i, bd = Infinity;
    for (let k = Math.max(0, i - 30); k < Math.min(S.length, i + 30); k++) {
      const [lx, ln] = lanePoint(k);
      const d = (lx - driver.x) ** 2 + (ln - driver.n) ** 2;
      if (d < bd) { bd = d; best = k; }
    }
    i = best;
    const s = S[i].s;
    if ((dir > 0 && s >= s1 - 4) || (dir < 0 && s <= s0 + 4)) { out.done = true; break; }
    const v = driver.speed;
    const Ld = 8 + v * 0.55;
    const j = Math.max(0, Math.min(S.length - 1, i + dir * Math.round(Ld / SPACING)));
    const [txp, tnp] = lanePoint(j);
    let a = Math.atan2(txp - driver.x, tnp - driver.n) - driver.heading;
    a = Math.atan2(Math.sin(a), Math.cos(a));
    const delta = Math.atan2(2 * spec.wheelbase * Math.sin(a), Ld);
    const limit = spec.maxSteer * (0.28 + 0.72 / (1 + v / 20));
    I.steer = Math.max(-1, Math.min(1, delta / limit));
    // Slow for the sharpest bend within braking distance.
    const look = Math.round((v * v / 12 + 30) / SPACING);
    let k = 0;
    for (let m = 0; m <= look; m++) k = Math.max(k, kappa[Math.max(0, Math.min(S.length - 1, i + dir * m))]);
    const target = Math.min(vmax, Math.sqrt(aLat / Math.max(k, 1e-4)));
    I.throttle = Math.max(0, Math.min(1, (target - v) * 0.6));
    I.brake = Math.max(0, Math.min(1, (v - target) * 0.35));
    driver.step(STEP, I);
    out.time += STEP;
    out.vmaxSeen = Math.max(out.vmaxSeen, driver.kmh);
    out.impact = Math.max(out.impact, driver.impact);
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

function drive(name, road, opts, limits = {}) {
  const r = autopilot(layout.roadById[road], opts);
  // dy: two mountain roads meeting ease into each other over a few metres;
  // a step of up to 30 cm there is a kerb, not a wall.
  const lim = { impact: 2, air: 0.3, dy: 0.3, lateral: 3.5, ...limits };
  const ok = r.done && r.impact <= lim.impact && r.air <= lim.air && r.dy <= lim.dy && r.lateral <= lim.lateral;
  const detail = `${r.done ? '' : `arrêté en ${r.at} — `}${r.time.toFixed(0)} s, pointe ${r.vmaxSeen.toFixed(0)} km/h, choc max ${r.impact.toFixed(1)} m/s, `
    + `en l'air ${r.air.toFixed(2)} s, écart vertical ${r.dy.toFixed(2)} m${r.dyAt ? ` en ${r.dyAt}` : ''}, écart latéral ${r.lateral.toFixed(1)} m`;
  check(name, ok, detail);
  return r;
}

drive('la boucle, sens horaire (A-40 → Décarie → tunnel)', 'ring', { dir: 1 });
drive('la boucle, sens inverse', 'ring', { dir: -1 });
drive('Camillien-Houde, montée', 'camillien-houde', { dir: 1, vmax: 22 });
drive('Remembrance, descente', 'remembrance', { dir: 1, vmax: 22 });
drive('Côte-des-Neiges', 'cote-des-neiges', { dir: 1, vmax: 22 });
drive('pont Jacques-Cartier', 'pont-jacques-cartier', { dir: 1, s1: layout.roadById['pont-jacques-cartier'].length - 60 });
drive('circuit Gilles-Villeneuve, un tour', 'circuit', { dir: 1, vmax: 45, aLat: 9 });
drive('Ville-Marie, sortie Peel (vers le centre-ville)', 'ville-marie-e-sortie-peel', { dir: 1, vmax: 20 });
drive('Ville-Marie, entrée Peel (vers Turcot)', 'ville-marie-o-entree-peel', { dir: 1, vmax: 20 });

{
  // Nose into the trench wall at 60 km/h: stopped by it, still in the trench.
  driver.place(-1793, 600, Math.PI / 2, -8);
  hold({ throttle: 1 }, () => driver.kmh > 60 || driver.impact > 0, 10);
  let impact = 0;
  hold({ throttle: 1 }, () => { impact = Math.max(impact, driver.impact); driver.impact = 0; return false; }, 3);
  check('mur de la tranchée', impact > 3 && driver.x < -1770 && Math.abs(driver.y + 8) < 0.1,
    `choc ${impact.toFixed(1)} m/s, x = ${driver.x.toFixed(1)}, y = ${driver.y.toFixed(2)}`);
}

{
  // Queen-Mary crosses Décarie on a slab: a car on it stays at street level.
  driver.place(-1950, 450, Math.PI / 2, 0);
  let minY = Infinity, maxY = -Infinity, impact = 0;
  hold({ throttle: 0.8 }, () => {
    minY = Math.min(minY, driver.y); maxY = Math.max(maxY, driver.y);
    impact = Math.max(impact, driver.impact); driver.impact = 0;
    return driver.x > -1650;
  }, 30);
  check('Queen-Mary par-dessus la tranchée', driver.x > -1650 && minY > -0.1 && maxY < 0.3 && impact < 1,
    `x = ${driver.x.toFixed(0)}, y entre ${minY.toFixed(2)} et ${maxY.toFixed(2)}, choc ${impact.toFixed(1)} m/s`);
}

{
  // Saint-Laurent passes under the Métropolitaine: the car stays on the
  // street, and no pillar stands in its way.
  driver.place(343, 1500, 0, 0);
  let maxY = -Infinity, impact = 0;
  hold({ throttle: 0.8 }, () => {
    maxY = Math.max(maxY, driver.y);
    impact = Math.max(impact, driver.impact); driver.impact = 0;
    return driver.n > 2000;
  }, 40);
  check('Saint-Laurent sous la Métropolitaine', driver.n > 2000 && maxY < 0.3 && impact < 1,
    `n = ${driver.n.toFixed(0)}, y max ${maxY.toFixed(2)}, choc ${impact.toFixed(1)} m/s`);
}

{
  // Street over the tunnel: Robert-Bourassa crosses the Ville-Marie on top
  // of it; a car on it stays at street level.
  driver.place(-136, -150, Math.PI, 0);
  let minY = Infinity;
  hold({ throttle: 0.6 }, () => { minY = Math.min(minY, driver.y); return driver.n < -420; }, 30);
  check('rue au-dessus du tunnel', driver.n < -420 && minY > -0.1, `n = ${driver.n.toFixed(0)}, y min ${minY.toFixed(2)}`);
}

{
  // Rue Guy crosses the open Ville-Marie trench on a slab.
  driver.place(-704, -200, Math.PI, 0);
  let minY = Infinity, maxY = -Infinity, impact = 0;
  hold({ throttle: 0.6 }, () => {
    minY = Math.min(minY, driver.y); maxY = Math.max(maxY, driver.y);
    impact = Math.max(impact, driver.impact); driver.impact = 0;
    return driver.n < -500;
  }, 30);
  check('Guy par-dessus la Ville-Marie', driver.n < -500 && minY > -0.1 && maxY < 0.3 && impact < 1,
    `n = ${driver.n.toFixed(0)}, y entre ${minY.toFixed(2)} et ${maxY.toFixed(2)}, choc ${impact.toFixed(1)} m/s`);
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
  await page.goto(`${url}/index.html?spawn=decarie`);
  await page.waitForFunction(() => window.__mtl && window.__mtl.ready, null, { timeout: 240000 });
  await page.waitForFunction(() => window.__mtl.frames() > 3, null, { timeout: 120000 });
  const load = (Date.now() - tl) / 1000;
  const stats = await page.evaluate(() => window.__mtl.stats());
  check('la page se charge', true, `${load.toFixed(1)} s (SwiftShader), ${stats.calls} appels, ${(stats.triangles / 1e6).toFixed(2)} M triangles`);
  const r = await page.evaluate(() => window.__mtl.simulate(12, { throttle: 1 }));
  check('conduite dans la page', r.kmh > 90 && Math.abs(r.y + 8) < 0.1 && r.road === 'ring', `${r.kmh.toFixed(0)} km/h, y = ${r.y.toFixed(2)}, ${r.where ? r.where.name : '?'}`);
  // Keys are handled by the frame loop, and a SwiftShader frame is slow.
  await page.keyboard.press('KeyM');
  const mapOpen = await page.waitForFunction(() => !document.getElementById('bigmap').hidden, null, { timeout: 30000 })
    .then(() => true, () => false);
  await page.screenshot({ path: path.join(ROOT, '.shots', 'carte.png') }).catch(() => {});
  await page.keyboard.press('KeyM');
  check('grande carte (M)', mapOpen, mapOpen ? 'ouverte' : 'ne s’ouvre pas');
  {
    // Free flight: F leaves the car, Space climbs, G lands the car on the
    // road in the middle of the view and gives the wheel back.
    await page.keyboard.press('KeyF');
    const on = await page.waitForFunction(() => document.body.classList.contains('fly'), null, { timeout: 30000 })
      .then(() => true, () => false);
    const h0 = await page.evaluate(() => window.__mtl.fly.h);
    await page.keyboard.down('Space');
    await page.waitForFunction((h) => window.__mtl.fly.h > h + 20, h0, { timeout: 60000 }).catch(() => {});
    await page.keyboard.up('Space');
    const h1 = await page.evaluate(() => window.__mtl.fly.h);
    await page.evaluate(() => window.__mtl.look(-900, -600, 120, -700, -380, 0));
    await page.keyboard.press('KeyG');
    const back = await page.waitForFunction(() => !document.body.classList.contains('fly'), null, { timeout: 30000 })
      .then(() => true, () => false);
    const st = await page.evaluate(() => window.__mtl.state());
    const d = Math.hypot(st.x + 700, st.n + 380);
    check('vol libre (F, Espace, G)', on && h1 > h0 + 20 && back && d < 15,
      `monté de ${(h1 - h0).toFixed(0)} m, voiture posée à ${d.toFixed(1)} m du centre de la vue (${st.where ? st.where.name : '?'})`);
  }
  check('aucune erreur dans la page', errors.length === 0, errors.slice(0, 5).join(' | ') || '0');
  await browser.close();
  server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} contrôles passent.`);
process.exit(failed.length ? 1 : 0);
