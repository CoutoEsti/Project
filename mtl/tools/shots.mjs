// Screenshots from fixed viewpoints, for reviewing the map without a GPU at
// hand.
//
//   node mtl/tools/shots.mjs                    → mtl/.shots/*.png
//   node mtl/tools/shots.mjs --out DIR --only decarie,plateau --day --zone centre --echelle 85
//   node mtl/tools/shots.mjs --views vues.json   (a list of [name, x, n, h, tx, tn, th], as VIEWS,
//                                                or [name, 'car', x, n, heading°, y]: the drive view)
//   node mtl/tools/shots.mjs --jonctions         → the junctions of JUNCTIONS instead
//
// Chromium runs headless on SwiftShader when there is no GPU: slow, but the
// pictures are the real renderer's.

import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { serve } from './lib/serve.mjs';
import { loadPlaywright } from './lib/playwright.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const OUT = path.resolve(arg('--out', path.join(ROOT, '.shots')));
const ONLY = arg('--only', null);
const DAY = args.includes('--day');
const W = Number(arg('--w', 1280)), H = Number(arg('--h', 720));

// [name, camera x, n, h, target x, n, h]: real metres in the street-grid
// frame (scaled in the page), heights above the ground under each point.
export const VIEWS = [
  ['survol', null],
  ['centre-ville', -500, -500, 180, 0, 0, 40],
  ['vieux-montreal', 700, -1150, 60, 1000, -900, 10],
  ['vieux-port', 1100, -1600, 60, 1400, -1200, 10],
  ['pvm', -200, -600, 140, 216, -214, 80],
  ['decarie', -3830, 3600, 30, -3845, 3100, 0],
  ['metropolitaine', 0, 6500, 60, 800, 6600, 10],
  ['turcot', -3500, -1200, 200, -4300, -500, 0],
  ['mont-royal', 800, 900, 250, 0, 1300, 80],
  ['croix', 600, 1000, 120, 192, 1360, 60],
  ['plateau', 1800, 1700, 30, 2100, 2000, 5],
  ['stade', 5600, 1200, 150, 6275, 1720, 40],
  ['pont-jacques-cartier', 2600, 300, 80, 3300, -600, 40],
  ['iles', 1800, -1600, 300, 2600, -2500, 0],
];

// Fixed places where roads meet: tools/avant-apres.mjs shoots them before and
// after a change to the map.
export const JUNCTIONS = [
  ['decarie-centre', -3830, 3600, 30, -3845, 3100, 0],
  // Down in the trench, over the median: heights are above the relief, so
  // negative ones are below the trench's rim.
  ['decarie-terre-plein', -3830, 3430, -2, -3830, 3395, -7.5],
  ['decarie-nord', -3700, 4700, 40, -3770, 4550, 0],
  ['decarie-savane', -3580, 5820, 45, -3634, 5700, 0],
  ['turcot', -4150, -250, 90, -4300, -500, 0],
  ['ville-marie-turcot', -3650, 60, 50, -3744, -22, 0],
  ['bonaventure', 150, -1600, 50, 71, -1702, 15],
  ['concorde', 2200, -2200, 50, 2313, -2318, 8],
  ['jacques-cartier-ile', 3250, -1300, 50, 3405, -1490, 8],
];

/**
 * Loads the game served from `root` once and shoots each view.
 * @param clean  hide the page's panels over the scene
 * @returns [{ name, file }]
 */
export async function shoot({ root, views, out, day = false, query = {}, w = 1280, h = 720, only = null, clean = false, log = console.log }) {
  await fs.mkdir(out, { recursive: true });
  const { server, url } = await serve(root);
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  const errors = [], shots = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  try {
    const t0 = Date.now();
    const q = new URLSearchParams();
    if (day) q.set('day', '1');
    for (const [k, v] of Object.entries(query)) if (v != null) q.set(k, v);
    await page.goto(`${url}/index.html?${q}`);
    await page.waitForFunction(() => window.__mtl && window.__mtl.ready, null, { timeout: 300000 });
    log(`chargé en ${((Date.now() - t0) / 1000).toFixed(1)} s`, JSON.stringify(await page.evaluate(() => window.__mtl.world.timings)));
    // clean: the scene alone, without the panels, the mini-map and the
    // district names, which would cover what is being compared.
    if (clean) {
      await page.evaluate(() => {
        const c = document.querySelector('canvas');
        for (const el of document.body.querySelectorAll('*')) if (el !== c && !el.contains(c)) el.style.visibility = 'hidden';
      });
    }
    for (const [name, ...v] of views) {
      if (only && !only.includes(name)) continue;
      await page.evaluate((v) => {
        const m = window.__mtl;
        if (v[0] === null) { m.act('overview'); m.fly.overview(false); return; }
        // ['car', x, n, heading in degrees, y]: the drive view, the car put
        // there — the only way into a tunnel (free flight stays above ground).
        if (v[0] === 'car') { const s = m.game.layout.map.scale; m.place(v[1] * s, v[2] * s, v[3], v[4] * s); return; }
        const L = m.game.layout, s = L.map.scale, T = L.terrain;
        const [x, n, h, tx, tn, th] = v;
        m.look(x * s, n * s, T.height(x * s, n * s) + h, tx * s, tn * s, T.height(tx * s, tn * s) + th);
      }, v);
      const f0 = await page.evaluate(() => window.__mtl.frames());
      await page.waitForFunction((f) => window.__mtl.frames() > f + 2, f0, { timeout: 120000 });
      const file = path.join(out, `${name}${day ? '-jour' : ''}.png`);
      await page.screenshot({ path: file, timeout: 180000 });
      const st = await page.evaluate(() => window.__mtl.stats());
      log(`${name}: ${st.calls} appels, ${(st.triangles / 1000).toFixed(0)} k triangles`);
      shots.push({ name, file });
    }
  } finally {
    if (errors.length) log('ERREURS:\n' + errors.join('\n'));
    await browser.close();
    server.close();
  }
  return shots;
}

async function main() {
  const views = arg('--views', null) ? JSON.parse(await fs.readFile(arg('--views', null), 'utf8'))
    : args.includes('--jonctions') ? JUNCTIONS : VIEWS;
  await shoot({
    root: ROOT, views, out: OUT, day: DAY, w: W, h: H, only: ONLY ? ONLY.split(',') : null,
    query: { zone: arg('--zone', null), forme: arg('--forme', null), echelle: arg('--echelle', null) },
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
