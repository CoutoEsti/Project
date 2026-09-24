// Screenshots from fixed viewpoints, for reviewing the map without a GPU at
// hand.
//
//   node mtl/tools/shots.mjs                    → mtl/.shots/*.png
//   node mtl/tools/shots.mjs --out DIR --only decarie,plateau --day --zone centre --echelle 85
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

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const { server, url } = await serve(ROOT);
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const t0 = Date.now();
  const q = new URLSearchParams();
  if (DAY) q.set('day', '1');
  if (arg('--zone', null)) q.set('zone', arg('--zone', null));
  if (arg('--echelle', null)) q.set('echelle', arg('--echelle', null));
  await page.goto(`${url}/index.html?${q}`);
  await page.waitForFunction(() => window.__mtl && window.__mtl.ready, null, { timeout: 300000 });
  console.log(`chargé en ${((Date.now() - t0) / 1000).toFixed(1)} s`, JSON.stringify(await page.evaluate(() => window.__mtl.world.timings)));
  for (const [name, ...v] of VIEWS) {
    if (ONLY && !ONLY.split(',').includes(name)) continue;
    await page.evaluate((v) => {
      const m = window.__mtl;
      if (v[0] === null) { m.act('overview'); m.fly.overview(false); return; }
      const L = m.game.layout, s = L.map.scale, T = L.terrain;
      const [x, n, h, tx, tn, th] = v;
      m.look(x * s, n * s, T.height(x * s, n * s) + h, tx * s, tn * s, T.height(tx * s, tn * s) + th);
    }, v);
    const f0 = await page.evaluate(() => window.__mtl.frames());
    await page.waitForFunction((f) => window.__mtl.frames() > f + 2, f0, { timeout: 120000 });
    const file = path.join(OUT, `${name}${DAY ? '-jour' : ''}.png`);
    await page.screenshot({ path: file, timeout: 180000 });
    const st = await page.evaluate(() => window.__mtl.stats());
    console.log(`${name}: ${st.calls} appels, ${(st.triangles / 1000).toFixed(0)} k triangles`);
  }
  if (errors.length) console.log('ERREURS:\n' + errors.join('\n'));
  await browser.close();
  server.close();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
