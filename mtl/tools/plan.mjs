// The level-design plan: the map drawn from above, straight from the data.
//
//   node mtl/tools/plan.mjs                 → mtl/docs/plan.svg
//   node mtl/tools/plan.mjs --png           → also plan.png (needs Playwright)
//   node mtl/tools/plan.mjs --crop x0,n0,x1,n1 --out FILE --scale 1.2
//
// Montréal north is up. Roads are coloured by level: blue below the street,
// grey at street level, orange to red above it — the three things a level
// designer needs to read at a glance on a map with a trench, a tunnel and a
// viaduct.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import MAP from '../src/map/montreal.js';
import { compile, stretchAt } from '../src/map/layout.js';
import { pointInMulti } from '../src/map/geom.js';
import { loadPlaywright } from './lib/playwright.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const PNG = args.includes('--png');
const OUT = path.resolve(arg('--out', path.join(ROOT, 'docs', 'plan.svg')));
const CROP = arg('--crop', null);
const SCALE = Number(arg('--scale', CROP ? 1 : 0.42));   // px per metre
const LABELS = !args.includes('--no-labels');

const STYLE_COLOURS = {
  downtown: '#5f6f91', oldstone: '#9b8b6e', plex: '#a2604c', brick: '#93604b', lofts: '#8a5847',
  walkups: '#8b7863', villas: '#7b8a64', westmount: '#7b8a64', bigbox: '#86868c', factory: '#827c74',
  industrial: '#6c6c70', yard: '#58534a', port: '#6d695d', park: '#4a7a43', plaza: '#9a9385',
  verge: '#4b6242',
};

function main() {
  const L = compile(MAP);
  const W = MAP.world;
  const [x0, n0, x1, n1] = CROP ? CROP.split(',').map(Number) : [W.x0, W.n0, W.x1, W.n1];
  const w = (x1 - x0) * SCALE, h = (n1 - n0) * SCALE;
  const X = (x) => ((x - x0) * SCALE).toFixed(1);
  const Y = (n) => ((n1 - n) * SCALE).toFixed(1);
  const inView = (bb, pad = 50) => !(bb.x1 < x0 - pad || bb.x0 > x1 + pad || bb.n1 < n0 - pad || bb.n0 > n1 + pad);

  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${w.toFixed(0)}" height="${h.toFixed(0)}" viewBox="0 0 ${w.toFixed(0)} ${h.toFixed(0)}" font-family="Helvetica, Arial, sans-serif">`);
  out.push(`<defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="#16283d"/><line x1="0" y1="0" x2="0" y2="6" stroke="#2d6fa8" stroke-width="2"/></pattern></defs>`);
  out.push(`<rect width="100%" height="100%" fill="#1d3552"/>`);

  const isWater = (x, n) => pointInMulti(x, n, L.water);
  const polyPath = (poly) => poly.map((ring) => 'M' + ring.map(([x, n]) => `${X(x)},${Y(n)}`).join('L') + 'Z').join('');
  const multiPath = (multi) => multi.map(polyPath).join('');

  // Land, then the mountain's relief as banded cells.
  out.push(`<path d="${multiPath(L.land)}" fill="#34343a" fill-rule="evenodd"/>`);
  const cell = CROP ? 6 : 12;
  const tb = L.terrain.bbox;
  const bands = [];
  for (let x = tb.x0; x < tb.x1; x += cell) {
    for (let n = tb.n0; n < tb.n1; n += cell) {
      const cx = x + cell / 2, cn = n + cell / 2;
      if (!L.terrain.inside(cx, cn)) continue;
      const hgt = L.terrain.height(cx, cn);
      const band = Math.min(11, Math.floor(hgt / 10));
      const g = 70 + band * 9, r = 40 + band * 7, b = 38 + band * 5;
      bands.push(`<rect x="${X(x)}" y="${Y(n + cell)}" width="${(cell * SCALE + 0.6).toFixed(1)}" height="${(cell * SCALE + 0.6).toFixed(1)}" fill="rgb(${r},${g},${b})"/>`);
    }
  }
  out.push(`<g>${bands.join('')}</g>`);

  // Blocks by style.
  const blocks = [];
  for (const b of L.blocks) {
    if (!inView(b.bbox)) continue;
    blocks.push(`<path d="${polyPath(b.poly)}" fill="${STYLE_COLOURS[b.style] || '#777'}" fill-rule="evenodd" stroke="#26262b" stroke-width="0.5"/>`);
  }
  out.push(`<g>${blocks.join('')}</g>`);

  // Holes in the land: open trench and tunnel portals.
  out.push(`<path d="${multiPath(L.holes)}" fill="url(#hatch)" fill-rule="evenodd" stroke="#7fb4e6" stroke-width="0.8"/>`);

  // Roads by level, lowest first, so a viaduct is drawn over what it crosses.
  const pieces = [];
  for (const r of L.roads) {
    const S = r.samples;
    let cur = null;
    // Level relative to what is underneath: a mountain road is at grade even
    // at 80 m, a bridge over the river is high even at 22.
    const below = (p) => (L.terrain.inside(p.x, p.n) ? L.terrain.height(p.x, p.n)
      : isWater(p.x, p.n) ? MAP.levels.water : 0);
    const kind = (p, rel) => (p.tunnel ? 'tunnel' : rel < -0.5 ? 'sunken' : rel > 0.6 ? 'up' : 'grade');
    for (let i = 0; i < S.length; i++) {
      const p = S[i], rel = r.follow === 'terrain' ? 0 : p.y - below(p), k = kind(p, rel);
      const band = k === 'up' ? Math.min(5, Math.floor(rel / 8)) : 0;
      const key = k + band;
      if (!cur || cur.key !== key) {
        if (cur) { cur.pts.push(p); pieces.push(cur); }
        cur = { key, k, band, y: p.y, pts: cur ? [S[i - 1], p] : [p], road: r };
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
      out.push(`<path d="${d}" fill="none" stroke="#5aa0e0" stroke-width="${Math.max(1, wpx * 0.12)}" stroke-dasharray="${6 * SCALE * 4},${4 * SCALE * 4}"/>`);
    } else {
      const col = pc.k === 'sunken' ? '#3c7fbf' : pc.k === 'grade' ? (pc.road.cls === 'circuit' ? '#d8d0c0' : '#bcbcbc') : upColour[pc.band];
      out.push(`<path d="${d}" fill="none" stroke="#1a1a1e" stroke-width="${wpx + 1.6}" stroke-linejoin="round"/>`);
      out.push(`<path d="${d}" fill="none" stroke="${col}" stroke-width="${wpx}" stroke-linejoin="round"/>`);
      if (pc.road.median && wpx > 4) out.push(`<path d="${d}" fill="none" stroke="#1a1a1e" stroke-width="${Math.max(0.6, 0.8 * SCALE)}"/>`);
    }
  }

  // Closures at the end of closed roads.
  for (const r of L.roads) {
    if (!r.closedEnd) continue;
    const p = r.samples[r.samples.length - 1];
    out.push(`<circle cx="${X(p.x)}" cy="${Y(p.n)}" r="${Math.max(3, 9 * SCALE)}" fill="#c62828" stroke="#fff" stroke-width="1.2"/>`);
  }

  if (LABELS) {
    // District names.
    for (const d of L.districts) {
      if (!d.ring) continue;
      const bb = { x0: Infinity, n0: Infinity, x1: -Infinity, n1: -Infinity };
      for (const [x, n] of d.ring) { bb.x0 = Math.min(bb.x0, x); bb.x1 = Math.max(bb.x1, x); bb.n0 = Math.min(bb.n0, n); bb.n1 = Math.max(bb.n1, n); }
      if (!inView(bb, 0)) continue;
      const cx = (bb.x0 + bb.x1) / 2, cn = (bb.n0 + bb.n1) / 2;
      const fs_ = Math.max(9, Math.min(26, Math.min(bb.x1 - bb.x0, bb.n1 - bb.n0) * SCALE * 0.13));
      out.push(`<text x="${X(cx)}" y="${Y(cn)}" font-size="${fs_.toFixed(0)}" font-weight="700" fill="#ffffff" fill-opacity="0.55" text-anchor="middle" letter-spacing="1" style="text-transform:uppercase">${esc(d.name.toUpperCase())}</text>`);
    }
    out.push(`<text x="${X(-450)}" y="${Y(1080)}" font-size="${Math.max(10, 44 * SCALE).toFixed(0)}" font-weight="700" fill="#d9f0cf" fill-opacity="0.7" text-anchor="middle">MONT-ROYAL</text>`);

    // Major street names, once each, at their middle.
    const seen = new Set();
    for (const st of L.streets) {
      if (st.cls === 'alley' || st.cls === 'apron' || !st.name || seen.has(st.name)) continue;
      if (!['boulevard', 'avenue'].includes(st.cls) && !CROP) continue;
      seen.add(st.name);
      const a = st.path[0], b = st.path[st.path.length - 1];
      const i = Math.floor(st.path.length / 2);
      const pa = st.path.length > 2 ? st.path[i - 1] : a, pb = st.path.length > 2 ? st.path[i] : b;
      const mx = (pa[0] + pb[0]) / 2, mn = (pa[1] + pb[1]) / 2;
      if (mx < x0 || mx > x1 || mn < n0 || mn > n1) continue;
      let ang = (Math.atan2(-(pb[1] - pa[1]), pb[0] - pa[0]) * 180) / Math.PI;
      if (ang > 90) ang -= 180; if (ang < -90) ang += 180;
      const fsz = CROP ? 10 : 7.5;
      out.push(`<text x="${X(mx)}" y="${Y(mn)}" transform="rotate(${ang.toFixed(1)} ${X(mx)} ${Y(mn)})" font-size="${fsz}" fill="#e8e8e8" text-anchor="middle" dy="3" stroke="#222" stroke-width="2.2" paint-order="stroke">${esc(st.name)}</text>`);
    }
    // Highway shields along the ring.
    const ring = L.roadById.ring;
    for (let i = 0; i < ring.samples.length; i += 260) {
      const p = ring.samples[i];
      const { ref } = stretchAt(ring, i);
      if (!ref || p.x < x0 || p.x > x1 || p.n < n0 || p.n > n1) continue;
      out.push(`<g transform="translate(${X(p.x)},${Y(p.n)})"><rect x="-13" y="-9" width="26" height="18" rx="3" fill="#1b5e20" stroke="#fff" stroke-width="1.5"/><text y="4.5" font-size="11" font-weight="700" fill="#fff" text-anchor="middle">${ref}</text></g>`);
    }

    // Landmarks.
    for (const lm of MAP.landmarks) {
      if (lm.x < x0 || lm.x > x1 || lm.n < n0 || lm.n > n1) continue;
      out.push(`<circle cx="${X(lm.x)}" cy="${Y(lm.n)}" r="5" fill="#ffd54f" stroke="#222" stroke-width="1.5"/>`);
      out.push(`<text x="${(Number(X(lm.x)) + 8).toFixed(1)}" y="${(Number(Y(lm.n)) + 4).toFixed(1)}" font-size="11" font-weight="700" fill="#fff5c4" stroke="#1a1a1a" stroke-width="3" paint-order="stroke">${esc(lm.name)}</text>`);
    }
    // Spawns.
    for (const sp of MAP.spawns) {
      if (sp.x < x0 || sp.x > x1 || sp.n < n0 || sp.n > n1) continue;
      const a = (sp.heading * Math.PI) / 180;
      const dx = Math.sin(a) * 9, dy = -Math.cos(a) * 9;
      out.push(`<line x1="${X(sp.x)}" y1="${Y(sp.n)}" x2="${(Number(X(sp.x)) + dx).toFixed(1)}" y2="${(Number(Y(sp.n)) + dy).toFixed(1)}" stroke="#00e5ff" stroke-width="3"/><circle cx="${X(sp.x)}" cy="${Y(sp.n)}" r="3.5" fill="#00e5ff"/>`);
    }
  }

  // Scale bar and north arrow.
  const bar = CROP ? 200 : 1000;
  const bx = 24, by = h - 28;
  out.push(`<g font-size="12" fill="#fff"><rect x="${bx}" y="${by}" width="${bar * SCALE}" height="6" fill="#fff"/><rect x="${bx}" y="${by}" width="${bar * SCALE / 2}" height="6" fill="#222"/><text x="${bx}" y="${by - 6}">0</text><text x="${bx + bar * SCALE}" y="${by - 6}" text-anchor="end">${bar} m</text></g>`);
  out.push(`<g transform="translate(${w - 40},46)" fill="#fff"><path d="M0,-26 L10,8 L0,2 L-10,8 Z"/><text y="24" font-size="11" text-anchor="middle">Nord</text><text y="37" font-size="9" text-anchor="middle" fill-opacity="0.7">de Montréal</text></g>`);
  if (!CROP) {
    const lg = [['#3c7fbf', 'Sous la rue (tranchée)'], ['#5aa0e0', 'Tunnel'], ['#bcbcbc', 'Niveau de la rue'], ['#ee9b3f', 'Surélevé'], ['#d62f2a', 'Très haut (> 40 m)']];
    out.push(`<g transform="translate(24,24)"><rect width="230" height="${34 + lg.length * 20}" fill="#111" fill-opacity="0.72" rx="6"/><text x="12" y="22" font-size="14" font-weight="700" fill="#fff">MTL — plan de la carte</text>`);
    lg.forEach(([c, t], i) => out.push(`<rect x="12" y="${34 + i * 20}" width="26" height="10" fill="${c}"/><text x="46" y="${43 + i * 20}" font-size="12" fill="#eee">${t}</text>`));
    out.push('</g>');
  }
  out.push('</svg>');
  return { svg: out.join('\n'), w, h, L };
}

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }

const { svg, w, h, L } = main();
await fs.mkdir(path.dirname(OUT), { recursive: true });
await fs.writeFile(OUT, svg);
console.log(`plan: ${OUT} (${w.toFixed(0)}×${h.toFixed(0)} px, ${L.blocks.length} îlots, compile ${L.timings.total.toFixed(0)} ms)`);

if (PNG) {
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: Math.ceil(w), height: Math.ceil(h) } });
  await page.setContent(`<html><body style="margin:0;background:#000">${svg}</body></html>`);
  const png = OUT.replace(/\.svg$/, '.png');
  await page.screenshot({ path: png, fullPage: true });
  await browser.close();
  console.log(`png: ${png}`);
}
