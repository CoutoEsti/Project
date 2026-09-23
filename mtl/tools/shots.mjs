// Screenshots from fixed viewpoints, for reviewing the map without a GPU at
// hand.
//
//   node mtl/tools/shots.mjs                    → mtl/.shots/*.png
//   node mtl/tools/shots.mjs --out DIR --only decarie,tunnel --day
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

// [name, camera x, n, h, target x, n, h]
export const VIEWS = [
  ['survol', -300, -1500, 900, 0, 300, 0],
  ['centre-ville', -700, -700, 160, -150, -60, 60],
  ['vieux-montreal', 350, -820, 40, 200, -560, 15],
  ['decarie', -1760, -80, 30, -1800, 500, -8],
  ['echangeur-decarie', -1300, 1200, 120, -1700, 1650, 5],
  ['metropolitaine', -400, 1720, 18, 400, 1790, 10],
  ['tunnel', -500, -385, -5.5, -300, -382, -6.5],
  ['turcot', -1300, -700, 90, -1700, -300, 10],
  ['mont-royal', 400, 700, 140, -300, 900, 60],
  ['plateau', 700, 560, 25, 600, 760, 8],
  ['stade', 1900, 150, 120, 2450, 520, 40],
  ['pont-jacques-cartier', 800, -500, 60, 1150, -900, 40],
  ['iles', 200, -1100, 260, 700, -1600, 0],
  ['stade-proche', 2200, 150, 60, 2450, 520, 60],
  ['croix', -150, 700, 95, -300, 880, 80],
  ['pvm', 100, -400, 120, -210, -80, 120],
  ['vieux-port', 250, -1000, 45, 300, -650, 20],
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
  await page.goto(`${url}/index.html${DAY ? '?day=1' : ''}`);
  await page.waitForFunction(() => window.__mtl && window.__mtl.ready, null, { timeout: 180000 });
  console.log(`chargé en ${((Date.now() - t0) / 1000).toFixed(1)} s`, JSON.stringify(await page.evaluate(() => window.__mtl.world.timings)));
  for (const [name, ...v] of VIEWS) {
    if (ONLY && !ONLY.split(',').includes(name)) continue;
    await page.evaluate((v) => window.__mtl.look(...v), v);
    const f0 = await page.evaluate(() => window.__mtl.frames());
    await page.waitForFunction((f) => window.__mtl.frames() > f + 2, f0, { timeout: 120000 });
    const file = path.join(OUT, `${name}${DAY ? '-jour' : ''}.png`);
    await page.screenshot({ path: file });
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
