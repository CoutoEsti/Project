// Screenshots from the real Montréal dataset, for judging how it actually
// looks. The smoke test runs on the synthetic fixture on purpose — it must be
// hermetic — but the fixture is not what anyone plays.
//
//   node tools/shots.mjs [--time 10.5] [--weather clear] [--out .shots/live]

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const OUT = path.resolve(ROOT, arg('out', '.shots/live'));

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary', '.wasm': 'application/wasm',
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const file = path.join(ROOT, decodeURIComponent(url.pathname));
    const body = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
await fs.mkdir(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox',
    '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));

// Elevation tiles: serve the committed fixtures, the network is not reachable.
await page.route('**/elevation-tiles-prod/**', async (route) => {
  const m = route.request().url().match(/terrarium\/(\d+)\/(\d+)\/(\d+)\.png/);
  if (!m) return route.abort();
  try {
    const file = path.join(ROOT, 'tools', 'fixtures', 'terrarium', m[1], m[2], `${m[3]}.png`);
    return route.fulfill({ body: await fs.readFile(file), contentType: 'image/png' });
  } catch { return route.abort(); }
});

await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => !!window.__ruelle, null, { timeout: 30000 });

const PLACES = [
  ['plateau', 45.5265, -73.5795],
  ['centre-ville', 45.5017, -73.5673],
  ['mont-royal', 45.5088, -73.5878],
];

for (const [name, lat, lon] of PLACES) {
  await page.evaluate(([la, lo]) => window.__ruelle.hop(la, lo, 'Montréal'), [lat, lon]);
  const ok = await page.waitForFunction(() => window.__ruelle.spawned, null, { timeout: 60000 })
    .then(() => true).catch(() => false);
  if (!ok) { console.log(`${name}: pas d'apparition`); continue; }
  // Let the tile queue drain so the shot is of a built world.
  await page.waitForTimeout(9000);

  for (const [mode, hour] of [['chase', 10.5], ['orbit', 17.6], ['hood', 10.5]]) {
    await page.evaluate(([m, h]) => {
      window.__ruelle.cameraMode = m;
      window.__ruelle.settings.timeOfDay = h;
    }, [mode, hour]);
    await page.waitForTimeout(2500);
    await page.screenshot({ path: path.join(OUT, `${name}-${mode}.png`) });
  }

  const stats = await page.evaluate(() => {
    const r = window.__ruelle.renderer.info.render;
    let ready = 0;
    for (const t of window.__ruelle.world.tiles.values()) if (t.state === 'ready') ready++;
    return { tris: r.triangles, calls: r.calls, ready, total: window.__ruelle.world.tiles.size };
  });
  console.log(`${name}: ${stats.ready}/${stats.total} tuiles, ${stats.tris} tris, ${stats.calls} draw calls`);
}

await browser.close();
server.close();
console.log(`captures : ${OUT}`);
process.exit(0);
