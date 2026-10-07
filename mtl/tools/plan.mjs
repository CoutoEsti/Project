// The level-design plan: the map drawn from above, straight from the data.
//
//   node mtl/tools/plan.mjs --png           → mtl/docs/plan.png (needs Playwright)
//   node mtl/tools/plan.mjs                 → mtl/docs/plan.svg (several Mo)
//   node mtl/tools/plan.mjs --zone centre --echelle 85
//   node mtl/tools/plan.mjs --crop x0,n0,x1,n1 --out FILE --scale 1.2
//
// Montréal north is up. The relief in bands, the water, the parks, the
// streets in grey, and the roads by level: blue below the street, dashed in
// a tunnel, orange to red above it — what a level designer needs to read at a
// glance on a map with a trench, a tunnel and viaducts.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMap } from '../src/map/real.js';
import { compile } from '../src/map/layout.js';
import { resolveSettings } from '../src/map/zones.js';
import { resolveSpawn } from '../src/game/spawn.js';
import { loadSourceNode } from './lib/source-node.mjs';
import { loadPlaywright } from './lib/playwright.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const PNG = args.includes('--png');
const OUT = path.resolve(arg('--out', path.join(ROOT, 'docs', 'plan.svg')));
const CROP = arg('--crop', null);
const LABELS = !args.includes('--no-labels');

const file = JSON.parse(await fs.readFile(path.join(ROOT, 'carte.json'), 'utf8').catch(() => '{}'));
const params = new URLSearchParams();
if (arg('--zone', null)) params.set('zone', arg('--zone', null));
if (arg('--echelle', null)) params.set('echelle', arg('--echelle', null));
const settings = resolveSettings(file, params);

const t0 = performance.now();
const map = buildMap(await loadSourceNode(), settings);
const L = compile(map);
const s = map.scale;
const W = map.world;
const [x0, n0, x1, n1] = CROP ? CROP.split(',').map((v) => Number(v) * s) : [W.x0, W.n0, W.x1, W.n1];
const SCALE = Number(arg('--scale', CROP ? 1 : 2400 / Math.max(x1 - x0, n1 - n0)));   // px per metre
const w = (x1 - x0) * SCALE, h = (n1 - n0) * SCALE;
const X = (x) => ((x - x0) * SCALE).toFixed(1);
const Y = (n) => ((n1 - n) * SCALE).toFixed(1);
const inView = (x, n, pad = 50) => x > x0 - pad && x < x1 + pad && n > n0 - pad && n < n1 + pad;
const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;');

const out = [];
out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${w.toFixed(0)}" height="${h.toFixed(0)}" viewBox="0 0 ${w.toFixed(0)} ${h.toFixed(0)}" font-family="Helvetica, Arial, sans-serif">`);
out.push(`<defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="#16283d"/><line x1="0" y1="0" x2="0" y2="6" stroke="#2d6fa8" stroke-width="2"/></pattern></defs>`);
out.push(`<rect width="100%" height="100%" fill="#2a2a30"/>`);

// Relief in 10 m bands (scaled), coarse cells.
const cell = Math.max(10 * s, 6 / SCALE);
const bands = [];
for (let x = x0; x < x1; x += cell) {
  for (let n = n0; n < n1; n += cell) {
    const hgt = L.terrain.height(x + cell / 2, n + cell / 2) / s;
    const b = Math.max(0, Math.min(20, Math.floor(hgt / 10)));
    const r = 42 + b * 6, g = 42 + b * 7, bl = 46 + b * 4;
    bands.push(`<rect x="${X(x)}" y="${Y(n + cell)}" width="${(cell * SCALE + 0.6).toFixed(1)}" height="${(cell * SCALE + 0.6).toFixed(1)}" fill="rgb(${r},${g},${bl})"/>`);
  }
}
out.push(`<g>${bands.join('')}</g>`);

const polyPath = (poly) => poly.map((ring) => 'M' + ring.map(([x, n]) => `${X(x)},${Y(n)}`).join('L') + 'Z').join('');
out.push(`<g fill="#3f6b3a" fill-opacity="0.8">${map.greens.map((g) => g.poly.map((p) => `<path d="${polyPath(p)}" fill-rule="evenodd"/>`).join('')).join('')}</g>`);
out.push(`<g fill="#1d3552">${map.water.map((wt) => wt.poly.map((p) => `<path d="${polyPath(p)}" fill-rule="evenodd"/>`).join('')).join('')}</g>`);
out.push(`<path d="${L.holes.map(polyPath).join('')}" fill="url(#hatch)" fill-rule="evenodd" stroke="#7fb4e6" stroke-width="0.6"/>`);

// Streets.
const st = [];
for (const street of L.streets) {
  if (!street.path.some(([x, n]) => inView(x, n))) continue;
  const d = 'M' + street.path.map(([x, n]) => `${X(x)},${Y(n)}`).join('L');
  const col = street.cls === 'alley' ? '#55555c' : street.cls === 'boulevard' || street.cls === 'avenue' ? '#9a9aa2' : '#76767e';
  st.push(`<path d="${d}" stroke="${col}" stroke-width="${Math.max(0.6, street.width * SCALE).toFixed(2)}"/>`);
}
out.push(`<g fill="none" stroke-linecap="round" stroke-linejoin="round">${st.join('')}</g>`);

// Roads by level relative to the ground under them; lowest first.
const pieces = [];
for (const r of L.roads) {
  const S = r.samples;
  let cur = null;
  for (let i = 0; i < S.length; i++) {
    const p = S[i];
    const rel = p.y - p.gs;
    const k = p.tunnel ? 'tunnel' : rel < -0.5 ? 'sunken' : rel > 1.5 ? 'up' : 'grade';
    const band = k === 'up' ? Math.min(5, Math.floor(rel / 8)) : 0;
    const key = k + band;
    if (!cur || cur.key !== key) {
      if (cur) { cur.pts.push(p); pieces.push(cur); }
      cur = { key, k, band, pts: cur ? [S[i - 1], p] : [p], road: r };
    } else cur.pts.push(p);
  }
  if (cur) pieces.push(cur);
}
const order = { tunnel: 0, sunken: 1, grade: 2, up: 3 };
pieces.sort((a, b) => order[a.k] - order[b.k] || a.band - b.band);
const upColour = ['#e9b44c', '#ee9b3f', '#f07f35', '#ef6630', '#e64a2c', '#d62f2a'];
for (const pc of pieces) {
  const d = 'M' + pc.pts.map((p) => `${X(p.x)},${Y(p.n)}`).join('L');
  const wpx = Math.max(1.2, pc.road.width * SCALE);
  if (pc.k === 'tunnel') {
    out.push(`<path d="${d}" fill="none" stroke="#0e1a28" stroke-width="${wpx}" stroke-opacity="0.85"/>`);
    out.push(`<path d="${d}" fill="none" stroke="#5aa0e0" stroke-width="${Math.max(1, wpx * 0.3)}" stroke-dasharray="6,4"/>`);
  } else {
    const col = pc.k === 'sunken' ? '#3c7fbf' : pc.k === 'grade' ? (pc.road.cls === 'circuit' ? '#d8d0c0' : '#c8c8c8') : upColour[pc.band];
    out.push(`<path d="${d}" fill="none" stroke="#1a1a1e" stroke-width="${wpx + 1.4}" stroke-linejoin="round"/>`);
    out.push(`<path d="${d}" fill="none" stroke="${col}" stroke-width="${wpx}" stroke-linejoin="round"/>`);
  }
}
for (const r of L.roads) {
  for (const [on, i] of [[r.closedEnd, r.samples.length - 1], [r.closedStart, 0]]) {
    if (!on) continue;
    const p = r.samples[i];
    out.push(`<circle cx="${X(p.x)}" cy="${Y(p.n)}" r="3" fill="#c62828" stroke="#fff" stroke-width="0.8"/>`);
  }
}

if (LABELS) {
  for (const q of L.quartiers || []) {
    if (!inView(q.x, q.n, 0) || q.type === 'macrohood' || q.type === 'locality') continue;
    out.push(`<text x="${X(q.x)}" y="${Y(q.n)}" font-size="11" font-weight="700" fill="#fff" fill-opacity="0.6" text-anchor="middle" letter-spacing="1">${esc(q.nom.toUpperCase())}</text>`);
  }
  for (const lm of map.landmarks) {
    if (!inView(lm.x, lm.n, 0)) continue;
    out.push(`<circle cx="${X(lm.x)}" cy="${Y(lm.n)}" r="4" fill="#ffd54f" stroke="#222" stroke-width="1.2"/>`);
    out.push(`<text x="${(Number(X(lm.x)) + 7).toFixed(1)}" y="${(Number(Y(lm.n)) + 4).toFixed(1)}" font-size="10" font-weight="700" fill="#fff5c4" stroke="#1a1a1a" stroke-width="3" paint-order="stroke">${esc(lm.name)}</text>`);
  }
  for (const sp of map.spawns) {
    const p = resolveSpawn(L, sp);
    if (!p || !inView(p.x, p.n, 0)) continue;
    const dx = Math.sin(p.heading) * 10, dy = -Math.cos(p.heading) * 10;
    out.push(`<line x1="${X(p.x)}" y1="${Y(p.n)}" x2="${(Number(X(p.x)) + dx).toFixed(1)}" y2="${(Number(Y(p.n)) + dy).toFixed(1)}" stroke="#00e5ff" stroke-width="3"/><circle cx="${X(p.x)}" cy="${Y(p.n)}" r="3.5" fill="#00e5ff"/>`);
  }
}

// Scale bar, north arrow, legend.
const bar = 1000 * s;
const bx = 24, by = h - 28;
out.push(`<g font-size="12" fill="#fff"><rect x="${bx}" y="${by}" width="${bar * SCALE}" height="6" fill="#fff"/><rect x="${bx}" y="${by}" width="${bar * SCALE / 2}" height="6" fill="#222"/><text x="${bx}" y="${by - 6}">0</text><text x="${bx + bar * SCALE}" y="${by - 6}" text-anchor="end">1 km réel</text></g>`);
out.push(`<g transform="translate(${w - 40},46)" fill="#fff"><path d="M0,-26 L10,8 L0,2 L-10,8 Z"/><text y="24" font-size="11" text-anchor="middle">Nord</text><text y="37" font-size="9" text-anchor="middle" fill-opacity="0.7">de Montréal</text></g>`);
if (!CROP) {
  const lg = [['#3c7fbf', 'Sous la rue (tranchée)'], ['#5aa0e0', 'Tunnel'], ['#c8c8c8', 'Niveau du sol'], ['#ee9b3f', 'Surélevé'], ['#d62f2a', 'Très haut (> 40 m)'], ['#ffd54f', 'Repère'], ['#00e5ff', 'Départ']];
  out.push(`<g transform="translate(24,24)"><rect width="250" height="${54 + lg.length * 20}" fill="#111" fill-opacity="0.75" rx="6"/><text x="12" y="22" font-size="14" font-weight="700" fill="#fff">MTL — ${esc(map.meta.nomZone)}, ${settings.echelle} %</text><text x="12" y="40" font-size="10" fill="#bbb">© les contributeurs d’OpenStreetMap (ODbL)</text>`);
  lg.forEach(([c, t], i) => out.push(`<rect x="12" y="${54 + i * 20}" width="26" height="10" fill="${c}"/><text x="46" y="${63 + i * 20}" font-size="12" fill="#eee">${t}</text>`));
  out.push('</g>');
}
out.push('</svg>');

const svg = out.join('\n');
await fs.mkdir(path.dirname(OUT), { recursive: true });
if (!PNG) {
  await fs.writeFile(OUT, svg);
  console.log(`plan: ${OUT} (${w.toFixed(0)}×${h.toFixed(0)} px, ${(svg.length / 1e6).toFixed(1)} Mo, ${((performance.now() - t0) / 1000).toFixed(1)} s)`);
} else {
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: Math.ceil(w), height: Math.ceil(h) } });
  await page.setContent(`<html><body style="margin:0;background:#000">${svg}</body></html>`, { timeout: 300000 });
  const png = OUT.replace(/\.svg$/, '.png');
  await page.screenshot({ path: png, fullPage: true, timeout: 300000 });
  await browser.close();
  console.log(`png: ${png}`);
}
