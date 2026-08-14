// Headless smoke test: serve the game, drive it, and fail loudly.
//
//   node hop/tools/smoke.mjs [--headed] [--shots DIR] [--live]
//
// By default it runs against the generated fixture (?offline=1) so the test is
// hermetic and does not hammer Overpass. Pass --live to exercise the network
// path instead.

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { startBroker } from './broker.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const HEADED = args.includes('--headed');
const LIVE = args.includes('--live');
const SHOTS = (() => {
  const i = args.indexOf('--shots');
  return i >= 0 && args[i + 1] ? path.resolve(args[i + 1]) : path.join(ROOT, '.shots');
})();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function serve(root) {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost');
        let file = path.join(root, decodeURIComponent(url.pathname));
        if (url.pathname === '/' || url.pathname === '') file = path.join(root, 'index.html');
        if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
        const body = await fs.readFile(file);
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
        res.end(body);
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
      }
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const problems = [];
const notes = [];

function note(msg) { notes.push(msg); console.log(`   ${msg}`); }
function problem(msg) { problems.push(msg); console.log(`  ✗ ${msg}`); }

async function main() {
  await fs.mkdir(SHOTS, { recursive: true });
  const { server, port } = await serve(ROOT);
  const base = `http://127.0.0.1:${port}/index.html`;
  const broker = await startBroker({ port: 0, quiet: true });

  // Use whatever Chromium the machine already has rather than downloading one;
  // CI images commonly pin a build that does not match the npm package.
  const chromePath = process.env.CHROME_PATH
    || ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/usr/bin/chromium', '/usr/bin/google-chrome']
      .find((p) => existsSync(p));

  const browser = await chromium.launch({
    headless: !HEADED,
    ...(chromePath ? { executablePath: chromePath } : {}),
    args: [
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--use-gl=angle',
      '--no-sandbox',
      '--disable-gpu-sandbox',
      '--ignore-gpu-blocklist',
      // Chromium hides local IPs behind mDNS names, which nothing resolves in
      // a container: without this the two test pages gather candidates they can
      // never use and the peer connection never comes up.
      '--disable-features=WebRtcHideLocalIpsWithMdns',
      // The multiplayer test needs two pages sending at once, and only one of
      // them can be the focused tab. Left throttled, the background one stops
      // stepping its loop, stops publishing, and gets pruned as a frozen tab —
      // a failure invented entirely by the test harness.
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ],
  });

  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  // Software rendering a few million triangles takes a quarter of a second a
  // frame, and a screenshot has to wait for one. Playwright's 30 s default
  // turns a slow machine into a failed test, which is the wrong signal.
  page.setDefaultTimeout(120000);

  // Serve the elevation tiles from disk. The test then verifies that Mount
  // Royal is actually a hill rather than hoping AWS is reachable — and it
  // stays honest on a machine with no network at all.
  await page.route('**/elevation-tiles-prod/**', async (route) => {
    const m = route.request().url().match(/terrarium\/(\d+)\/(\d+)\/(\d+)\.png/);
    if (!m) return route.abort();
    const file = path.join(ROOT, 'tools', 'fixtures', 'terrarium', m[1], m[2], `${m[3]}.png`);
    try {
      route.fulfill({ status: 200, contentType: 'image/png', body: await fs.readFile(file) });
    } catch {
      route.fulfill({ status: 404, body: '' });
    }
  });

  page.on('console', (msg) => {
    const type = msg.type();
    const text = msg.text();
    // A 404 on an optional asset is reported by the browser as a console
    // error even when the code handles it; filter those, not real errors.
    if (type === 'error' && /\/models\/|404 \(Not Found\)/.test(text)) return;
    if (type === 'error' && /elevation-tiles-prod|ERR_CONNECTION_RESET/.test(text)) return;
    if (type === 'error') problem(`console.error: ${text}`);
    else if (type === 'warning' && !/deprecat|Multiple instances/i.test(text)) {
      note(`console.warn: ${text}`);
    }
  });
  page.on('pageerror', (err) => problem(`pageerror: ${err.message}`));
  page.on('requestfailed', (req) => {
    const url = req.url();
    if (url.includes('nominatim') || url.includes('overpass')) return;
    if (url.includes('/models/')) return;              // optional assets
    if (url.includes('elevation-tiles-prod')) return;  // optional elevation
    problem(`request failed: ${url} — ${req.failure()?.errorText}`);
  });

  // Multiplayer is tested against a broker of our own rather than the public
  // one: the test then verifies the real signalling, the real peer connections
  // and the real interpolation, and it does so on a machine with no internet.
  // `ice=` empty turns STUN off — two pages on one loopback need no help.
  const net = `broker=ws://127.0.0.1:${broker.port}/peerjs&ice=`;
  const url = LIVE ? `${base}?${net}` : `${base}?offline=1&${net}`;
  console.log(`\n▶ ${url}\n`);
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });

  // --- boot ----------------------------------------------------------------
  const booted = await page.waitForFunction(() => !!window.__ruelle, null, { timeout: 15000 })
    .then(() => true).catch(() => false);
  if (!booted) {
    problem('le jeu n’a pas démarré (window.__ruelle absent)');
    await finish(browser, server, page, broker);
    return;
  }
  note('jeu démarré');

  // --- menu: key bindings and the city map picker ---------------------------
  await page.waitForTimeout(2500);
  const menuUi = await page.evaluate(() => {
    const rows = document.querySelectorAll('#keybinds .keybind').length;
    const cv = document.querySelector('#menu-map');
    let painted = 0;
    if (cv && cv.width > 4) {
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      for (let i = 0; i < d.length; i += 4 * 97) {
        if (d[i] > 40 || d[i + 1] > 40 || d[i + 2] > 40) painted++;
      }
    }
    return {
      rows, painted,
      mapShown: cv ? getComputedStyle(cv.parentElement).display !== 'none' : false,
      presets: document.querySelectorAll('#presets .preset').length,
      presetLabels: [...document.querySelectorAll('#presets .preset strong')].map((e) => e.textContent),
    };
  });
  note(`menu : ${menuUi.rows} touches remappables, ${menuUi.presets} raccourcis, carte ${menuUi.mapShown ? 'affichée' : 'masquée'} (${menuUi.painted} échantillons de rue)`);
  if (menuUi.rows < 10) problem(`panneau de commandes incomplet (${menuUi.rows} lignes)`);
  if (!menuUi.mapShown || menuUi.painted < 20) problem('la carte du menu ne dessine pas les rues');
  if (menuUi.presetLabels.some((l) => /Paris|Manhattan|Québec/.test(l))) {
    problem('des raccourcis pointent hors du jeu de données embarqué');
  }

  // --- hop into the fixture -------------------------------------------------
  await page.click('#hop-default');

  const spawned = await page.waitForFunction(
    () => window.__ruelle && window.__ruelle.spawned, null, { timeout: 45000 },
  ).then(() => true).catch(() => false);

  if (!spawned) {
    const diag = await page.evaluate(() => ({
      tiles: window.__ruelle ? window.__ruelle.world.tiles.size : -1,
      ready: window.__ruelle ? window.__ruelle.world.readyTiles : -1,
      queue: window.__ruelle ? window.__ruelle.world.buildQueue.length : -1,
      stats: window.__ruelle ? window.__ruelle.source.stats : null,
    }));
    problem(`la voiture n’a jamais été placée — ${JSON.stringify(diag)}`);
    await page.screenshot({ path: path.join(SHOTS, 'fail-spawn.png') });
    await finish(browser, server, page, broker);
    return;
  }
  note('voiture placée sur une route');

  // Let the surrounding tiles finish so screenshots show a built world.
  await page.waitForFunction(
    () => window.__ruelle.world.buildQueue.length === 0 && window.__ruelle.world.readyTiles >= 4,
    null, { timeout: 60000 },
  ).catch(() => note('toutes les tuiles ne sont pas prêtes dans le délai'));

  const built = await page.evaluate(() => ({
    tiles: window.__ruelle.world.tiles.size,
    ready: window.__ruelle.world.readyTiles,
    roads: window.__ruelle.world.allRoads().length,
    stats: window.__ruelle.source.stats,
    triangles: window.__ruelle.renderer.info.render.triangles,
    calls: window.__ruelle.renderer.info.render.calls,
  }));
  note(`tuiles ${built.ready}/${built.tiles} · ${built.roads} tronçons · ${built.triangles} tris · ${built.calls} draw calls`);
  if (built.roads === 0) problem('aucune route chargée');
  if (built.calls > 400) problem(`trop de draw calls (${built.calls})`);

  await page.screenshot({ path: path.join(SHOTS, '01-spawn.png') });

  // --- kerbs: the road has an edge ------------------------------------------
  // The point of the whole thing is relief, so the test is about heights: a
  // ribbon that came out flat would be invisible on a screenshot and would look
  // exactly like the bug it was written to fix.
  const kerbs = await page.evaluate(() => {
    const g = window.__ruelle;
    let meshes = 0, verts = 0, lo = Infinity, hi = -Infinity;
    let stray = 0;
    for (const tile of g.world.tiles.values()) {
      for (const obj of tile.objects) {
        if (!obj.isMesh || obj.material !== g.world.materials.kerb) continue;
        meshes++;
        const pos = obj.geometry.attributes.position;
        verts += pos.count;
        for (let i = 0; i < pos.count; i++) {
          const y = pos.getY(i) - g.world.groundHeight(pos.getX(i), pos.getZ(i));
          if (y < lo) lo = y;
          if (y > hi) hi = y;
          // Anything a car could trip over does not belong in a kerb.
          if (y > 0.25) stray++;
        }
      }
    }
    return { meshes, verts, lo, hi, stray, triangles: g.renderer.info.render.triangles };
  });
  note(`bordures : ${kerbs.meshes} maillages, ${kerbs.verts} sommets, `
    + `relief ${(kerbs.lo * 100).toFixed(0)} à ${(kerbs.hi * 100).toFixed(0)} cm`);
  if (kerbs.meshes === 0) problem('aucune bordure construite — la chaussée est toujours plate');
  else {
    if (kerbs.hi < 0.10) problem(`les bordures sont plates (${(kerbs.hi * 100).toFixed(0)} cm)`);
    if (kerbs.hi > 0.22) problem(`bordure de ${(kerbs.hi * 100).toFixed(0)} cm — une voiture ne monterait pas dessus`);
    if (kerbs.stray > 0) problem(`${kerbs.stray} sommets de bordure au-dessus de 25 cm`);
    if (kerbs.lo < -0.05) problem('des bordures passent sous le sol');
  }
  if (kerbs.triangles > 6_000_000) problem(`les bordures coûtent trop cher (${kerbs.triangles} tris)`);

  // --- physics, measured in simulated time ---------------------------------
  // Headless software rendering runs at a few frames a second, so wall-clock
  // driving tells us nothing about the car. Step the model directly instead.
  const bench = await page.evaluate(() => {
    const v = window.__ruelle.vehicle;
    const saved = { x: v.x, z: v.z, yaw: v.yaw };
    v.reset(saved.x, saved.z, saved.yaw);
    const flat = { throttle: 1, brake: 0, steer: 0, handbrake: false };
    const marks = {};
    for (let i = 0; i < 120 * 30; i++) {
      v.step(1 / 120, flat, []);
      const t = (i + 1) / 120;
      if (!marks.to50 && v.speedKmh >= 50) marks.to50 = t;
      if (!marks.to100 && v.speedKmh >= 100) marks.to100 = t;
    }
    const top = v.speedKmh;
    const topGear = v.gear;

    // Braking from speed.
    let brakeDist = 0;
    const before = { x: v.x, z: v.z };
    const brakeInput = { throttle: 0, brake: 1, steer: 0, handbrake: false };
    for (let i = 0; i < 120 * 12 && v.speedKmh > 1; i++) v.step(1 / 120, brakeInput, []);
    brakeDist = Math.hypot(v.x - before.x, v.z - before.z);

    // Steady-state cornering: full lock at 40 km/h should yaw, not slide flat.
    v.reset(saved.x, saved.z, saved.yaw);
    for (let i = 0; i < 120 * 6; i++) v.step(1 / 120, flat, []);
    const turn = { throttle: 0.35, brake: 0, steer: 1, handbrake: false };
    const yaw0 = v.yaw;
    let maxYaw = 0;
    for (let i = 0; i < 120 * 4; i++) {
      v.step(1 / 120, turn, []);
      maxYaw = Math.max(maxYaw, Math.abs(v.yawRate));
    }
    const corneringSpeed = v.speedKmh;
    // steer = +1 must turn right on screen. The camera's right vector for a
    // heading psi is (-cos psi, sin psi); dotting it with the new forward
    // gives sin(yaw0 - yaw1), so a right turn means the dot is positive.
    const turnedRight = Math.sin(yaw0 - v.yaw) > 0;

    // Handbrake should break rear grip and build slip angle.
    const slide = { throttle: 0.5, brake: 0, steer: 1, handbrake: true };
    let maxSlip = 0;
    for (let i = 0; i < 120 * 2; i++) {
      v.step(1 / 120, slide, []);
      maxSlip = Math.max(maxSlip, Math.abs(v.slipRear));
    }

    v.reset(saved.x, saved.z, saved.yaw);
    return { ...marks, top, topGear, brakeDist, maxYaw, corneringSpeed, maxSlip, turnedRight };
  });

  note(`0-50 ${bench.to50 ? bench.to50.toFixed(1) + ' s' : '—'} · 0-100 ${bench.to100 ? bench.to100.toFixed(1) + ' s' : '—'} · pointe ${bench.top.toFixed(0)} km/h en ${bench.topGear}e`);
  note(`freinage jusqu’à l’arrêt ${bench.brakeDist.toFixed(0)} m · virage ${bench.corneringSpeed.toFixed(0)} km/h à ${bench.maxYaw.toFixed(2)} rad/s · dérive frein à main ${bench.maxSlip.toFixed(2)} rad`);

  if (!bench.to50 || bench.to50 > 9) problem(`0-50 km/h trop lent (${bench.to50 ? bench.to50.toFixed(1) : '∞'} s)`);
  if (!bench.to100 || bench.to100 > 20) problem(`0-100 km/h trop lent (${bench.to100 ? bench.to100.toFixed(1) : '∞'} s)`);
  if (bench.top < 140 || bench.top > 260) problem(`vitesse de pointe irréaliste (${bench.top.toFixed(0)} km/h)`);
  if (bench.brakeDist < 20 || bench.brakeDist > 220) problem(`distance de freinage irréaliste (${bench.brakeDist.toFixed(0)} m)`);
  if (!bench.turnedRight) problem('la direction est inversée : « droite » fait tourner à gauche');
  else note('direction : « droite » tourne bien à droite à l’écran');
  if (bench.maxYaw < 0.25) problem(`la voiture ne tourne pas (${bench.maxYaw.toFixed(2)} rad/s)`);
  if (bench.maxSlip < 0.12) problem(`le frein à main ne décroche pas l’arrière (${bench.maxSlip.toFixed(2)} rad)`);

  // --- the real input path -------------------------------------------------
  // Software rendering runs at a few frames a second and the loop deliberately
  // drops simulation backlog, so assert on "did it move at all", with a
  // generous wall-clock budget, rather than on a distance in a fixed time.
  await page.keyboard.down('w');
  // Movement, not distance: software rendering slows sim time, so assert on
  // "the car is demonstrably rolling", whichever signal gets there first.
  const rolled = await page.waitForFunction(
    () => window.__ruelle.vehicle.odometer > 0.2 || window.__ruelle.vehicle.speedKmh > 3,
    null, { timeout: 45000 },
  ).then(() => true).catch(() => false);
  const moving = await page.evaluate(() => ({
    odo: window.__ruelle.vehicle.odometer,
    throttle: window.__ruelle.input.throttle,
    speed: window.__ruelle.vehicle.speedKmh,
  }));
  note(`clavier : accélérateur ${moving.throttle}, ${moving.odo.toFixed(0)} m, ${moving.speed.toFixed(0)} km/h`);
  if (moving.throttle < 0.9) problem('la touche W n’arrive pas au véhicule');
  if (!rolled) problem(`la voiture ne bouge pas au clavier (${moving.odo.toFixed(1)} m)`);
  await page.screenshot({ path: path.join(SHOTS, '02-driving.png') });

  // Corner hard, then handbrake, and make sure nothing goes non-finite.
  await page.keyboard.down('d');
  await page.waitForTimeout(1800);
  await page.keyboard.down(' ');
  await page.waitForTimeout(1200);
  await page.keyboard.up(' ');
  await page.keyboard.up('d');
  await page.waitForTimeout(1500);

  const state = await page.evaluate(() => {
    const v = window.__ruelle.vehicle;
    return {
      finite: [v.x, v.z, v.yaw, v.u, v.v, v.yawRate, v.rpm].every(Number.isFinite),
      speed: v.speedKmh,
      skid: v.skid,
    };
  });
  if (!state.finite) problem('état du véhicule non fini après virage + frein à main');
  else note(`virage + frein à main : ${state.speed.toFixed(1)} km/h, dérive ${state.skid.toFixed(2)}`);
  await page.screenshot({ path: path.join(SHOTS, '03-cornering.png') });

  // Straight-line top speed sanity.
  await page.waitForTimeout(6000);
  const fast = await page.evaluate(() => window.__ruelle.vehicle.speedKmh);
  note(`vitesse après ~11 s : ${fast.toFixed(1)} km/h`);
  await page.keyboard.up('w');

  // --- collisions ----------------------------------------------------------
  const crash = await page.evaluate(async () => {
    const g = window.__ruelle;
    const v = g.vehicle;
    const before = { x: v.x, z: v.z };
    // Aim at whatever is beside the road and hold the throttle.
    v.yaw += Math.PI / 2;
    v.u = 22;
    await new Promise((r) => setTimeout(r, 2500));
    return {
      moved: Math.hypot(v.x - before.x, v.z - before.z),
      finite: Number.isFinite(v.x) && Number.isFinite(v.z),
      impact: v.lastImpact,
    };
  });
  if (!crash.finite) problem('état non fini après collision');
  else note(`test de collision : ${crash.moved.toFixed(1)} m parcourus, dernier impact ${crash.impact.toFixed(1)}`);

  // --- night ---------------------------------------------------------------
  await page.evaluate(() => {
    window.__ruelle.settings.timeOfDay = 22.5;
  });
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(SHOTS, '04-night.png') });
  const night = await page.evaluate(() => ({
    night: window.__ruelle.sky.night,
    emissive: window.__ruelle.world.materials.wall.emissiveIntensity,
    pool: window.__ruelle.world.materials.lightPool.opacity,
  }));
  note(`nuit ${night.night.toFixed(2)} · fenêtres ${night.emissive.toFixed(2)} · halos ${night.pool.toFixed(2)}`);
  if (night.night < 0.8) problem('22 h 30 ne produit pas une nuit');

  // --- cameras -------------------------------------------------------------
  await page.evaluate(() => { window.__ruelle.settings.timeOfDay = 9.5; });
  for (const [mode, file] of [['hood', '05-hood.png'], ['orbit', '06-orbit.png']]) {
    await page.evaluate((m) => { window.__ruelle.cameraMode = m; }, mode);
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(SHOTS, file) });
  }
  await page.evaluate(() => { window.__ruelle.cameraMode = 'chase'; });

  // --- time trial ----------------------------------------------------------
  const trial = await page.evaluate(async () => {
    const g = window.__ruelle;
    const v = g.vehicle;
    g.trial.placeGate(v.x, v.z, v.yaw);
    const s1 = g.trial.state;
    // Move well clear, then drop the finish.
    v.x += Math.sin(v.yaw) * 120;
    v.z += Math.cos(v.yaw) * 120;
    g.trial.placeGate(v.x, v.z, v.yaw);
    return { afterStart: s1, afterFinish: g.trial.state, share: !!g.trial.shareUrl() };
  });
  if (trial.afterStart !== 'placing' || trial.afterFinish !== 'armed') {
    problem(`machine à états du chrono inattendue : ${JSON.stringify(trial)}`);
  } else {
    note('chrono : portes posées, parcours armé, lien de partage généré');
  }
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SHOTS, '07-gates.png') });

  // --- full-screen map ------------------------------------------------------
  const fullMap = await page.evaluate(() => {
    const g = window.__ruelle;
    g.openMap();
    const open = g.mapOpen && document.querySelector('#mapview').classList.contains('visible');
    const cv = document.querySelector('#mapview-canvas');
    let painted = 0;
    if (cv && cv.width > 4) {
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      for (let i = 0; i < d.length; i += 4 * 397) {
        if (d[i] > 40 || d[i + 1] > 40 || d[i + 2] > 40) painted++;
      }
    }
    g.closeMap();
    return { open, painted, closed: !g.mapOpen };
  });
  note(`carte plein écran : ouverture ${fullMap.open}, ${fullMap.painted} échantillons, fermeture ${fullMap.closed}`);
  if (!fullMap.open || fullMap.painted < 20 || !fullMap.closed) problem('la carte plein écran ne fonctionne pas');

  // --- no other vehicles ----------------------------------------------------
  const traffic = await page.evaluate(() => {
    let instances = 0;
    for (const t of window.__ruelle.world.tiles.values()) {
      if (t.propMeshes) instances += t.propMeshes.colliders.length;
    }
    return instances;
  });
  if (traffic > 0) problem(`des voitures garées sont encore générées (${traffic / 4} objets)`);
  else note('aucun autre véhicule dans le monde');

  // --- terrain --------------------------------------------------------------
  const relief = await page.evaluate(() => {
    const g = window.__ruelle;
    const t = g.world.terrain;
    let loaded = 0, failed = 0;
    for (const v of t.tiles.values()) {
      if (v === 'failed') failed++; else if (v !== 'pending') loaded++;
    }
    // Mount Royal's summit against the Plateau, in metres.
    const summit = t.height(45.5040, -73.5875);
    const flat = t.height(45.5265, -73.5795);
    return { loaded, failed, summit, flat, enabled: t.enabled };
  });
  note(`relief : ${relief.loaded} tuiles d'altitude, ${relief.failed} échouées · mont Royal ${relief.summit.toFixed(0)} m contre ${relief.flat.toFixed(0)} m au Plateau`);
  if (relief.enabled && relief.loaded > 0 && Math.abs(relief.summit - relief.flat) < 15) {
    problem('le relief est chargé mais le mont Royal reste plat');
  }

  // The ground has to be continuous. Reading not-yet-loaded elevation as sea
  // level puts a forty-metre cliff at the edge of the data — the city drops
  // through the floor and the car is left on a mesa. Real terrain never steps
  // that hard over fifty metres, so a big jump means missing data, not a hill.
  const continuity = await page.evaluate(() => {
    const g = window.__ruelle;
    const v = g.vehicle;
    let worst = 0, at = null;
    const STEP = 50;
    for (let dz = -400; dz <= 400; dz += STEP) {
      let prev = null;
      for (let dx = -400; dx <= 400; dx += STEP) {
        const h = g.world.groundHeight(v.x + dx, v.z + dz);
        if (prev !== null && Math.abs(h - prev) > worst) {
          worst = Math.abs(h - prev);
          at = [dx, dz];
        }
        prev = h;
      }
    }
    return { worst, at, anchored: g.world.terrain.baselineReady, baseline: g.world.terrain.baseline };
  });
  // The horizon has to carry the relief too. A flat one erases the mountain
  // you are standing beside — from a car most of the frame is distance, and
  // the distance is this mesh, not the built tiles. It also has to stay under
  // every bit of ground you can see, or it hides the street.
  const horizon = await page.evaluate(() => {
    const g = window.__ruelle;
    const b = g.world.backdrop;
    const pos = b.geometry.attributes.position;
    let lo = Infinity, hi = -Infinity, above = 0, worst = 0;
    for (let i = 0; i < pos.count; i++) {
      const h = pos.getZ(i);
      if (h < lo) lo = h;
      if (h > hi) hi = h;
      const gh = g.world.groundHeight(b.position.x + pos.getX(i), b.position.z - pos.getY(i));
      const over = (h + b.position.y) - gh;
      if (over > 0) { above++; if (over > worst) worst = over; }
    }
    return { relief: hi - lo, drop: b.position.y, above, worst, verts: pos.count };
  });
  note(`horizon : ${horizon.verts} sommets, ${horizon.relief.toFixed(0)} m de dénivelé, `
    + `${horizon.drop.toFixed(0)} m sous le sol, ${horizon.above} au-dessus`);
  if (horizon.above > 0) {
    problem(`le plan d’horizon perce le sol (${horizon.above} sommets, jusqu’à ${horizon.worst.toFixed(0)} m)`);
  }
  if (relief.enabled && relief.loaded > 0 && horizon.relief < 20) {
    problem('l’horizon est plat alors que le relief est chargé — la montagne disparaît au loin');
  }

  note(`continuité du sol : plus gros saut ${continuity.worst.toFixed(1)} m sur 50 m`
    + ` · ancrage ${continuity.anchored ? `${continuity.baseline.toFixed(0)} m` : 'provisoire'}`);
  if (relief.enabled && relief.loaded > 0 && !continuity.anchored) {
    problem('l’altitude de référence n’a jamais été résolue');
  }
  if (continuity.worst > 25) {
    problem(`falaise de ${continuity.worst.toFixed(0)} m dans le sol — données d’altitude manquantes lues comme le niveau de la mer`);
  }

  // --- skill chain ----------------------------------------------------------
  const scoring = await page.evaluate(async () => {
    const g = window.__ruelle;
    const s = g.score;
    s.reset();
    // A committed drift: sideways, at speed, for a second and a half.
    const v = g.vehicle;
    for (let i = 0; i < 180; i++) {
      v.slipRear = 0.42;
      v.speed_ = 0;
      Object.defineProperty(v, 'speed', { value: 24, configurable: true });
      v.lastImpact = 0;
      s.update(1 / 120, v, Infinity);
    }
    const drifted = s.chain;
    const mult = s.multiplier;
    // A near miss at speed.
    v.slipRear = 0;
    s.update(1 / 120, v, 1.2);
    const afterMiss = s.chain;
    // Then a crash, which must cost the lot.
    v.lastImpact = 6;
    s.update(1 / 120, v, Infinity);
    const afterCrash = s.chain;
    delete v.speed;
    s.reset();
    return { drifted, mult, gainedOnMiss: afterMiss - drifted, afterCrash };
  });
  note(`score : dérive ${Math.round(scoring.drifted)} pts (×${scoring.mult}), frôlement +${Math.round(scoring.gainedOnMiss)}, chaîne après crash ${scoring.afterCrash}`);
  if (scoring.drifted < 100) problem('la dérive ne rapporte rien');
  if (scoring.gainedOnMiss < 50) problem('le frôlement ne rapporte rien');
  if (scoring.afterCrash !== 0) problem('un impact ne coûte pas la chaîne');

  // --- birds ----------------------------------------------------------------
  // Column-major 4×4: the translation sits at 12, 13, 14 of each instance.
  // Sampling on a wall-clock timer is no good here — software rendering runs
  // at about five frames a second, so a short window can contain no frames at
  // all and a perfectly healthy flock looks frozen. Wait on the flock's own
  // clock instead.
  const birdBefore = await page.evaluate(() => ({
    t: window.__ruelle.birds.time,
    p: Array.from(window.__ruelle.birds.body.instanceMatrix.array.slice(12, 15)),
  }));
  const stepped = await page.waitForFunction(
    (t0) => window.__ruelle.birds.time > t0 + 0.4, birdBefore.t, { timeout: 15000 },
  ).then(() => true).catch(() => false);
  if (!stepped) problem('l’horloge des oiseaux n’avance pas');
  const flock = await page.evaluate((before) => {
    const b = window.__ruelle.birds;
    const c = Array.from(b.body.instanceMatrix.array.slice(12, 15));
    return {
      count: b.body.count,
      elapsed: b.time - before.t,
      moved: Math.hypot(c[0] - before.p[0], c[1] - before.p[1], c[2] - before.p[2]),
      // Height above the ground *under the bird*, not under the car: with
      // real relief the two differ by tens of metres.
      altitude: c[1] - window.__ruelle.world.groundHeight(c[0], c[2]),
      meshes: b.group.children.length,
    };
  }, birdBefore);
  note(`oiseaux : ${flock.count} en vol, ${flock.meshes} maillages, `
    + `${flock.moved.toFixed(1)} m en ${flock.elapsed.toFixed(1)} s, altitude ${flock.altitude.toFixed(0)} m`);
  if (flock.count < 4) problem('aucun oiseau en vol de jour');
  if (flock.moved < 0.1) problem('les oiseaux ne bougent pas');
  if (flock.altitude < 10) problem('les oiseaux volent trop bas');

  // Night: they should go home.
  await page.evaluate(() => { window.__ruelle.settings.timeOfDay = 23.5; });
  const roosted = await page.waitForFunction(
    () => window.__ruelle.birds.body.count === 0, null, { timeout: 15000 },
  ).then(() => true).catch(() => false);
  await page.evaluate(() => { window.__ruelle.settings.timeOfDay = 9.5; });
  if (!roosted) problem('les oiseaux volent encore en pleine nuit');
  else note('oiseaux : aucun en vol la nuit');

  // --- generated challenge --------------------------------------------------
  const challenge = await page.evaluate(async () => {
    const g = window.__ruelle;
    const v = g.vehicle;
    const home = { x: v.x, z: v.z };
    const ok = g.challenges.generate(v.x, v.z, g.world.allRoads(), 'Test');
    if (!ok) return { ok };
    const route = g.challenges.route.map((p) => ({ x: p.x, z: p.z }));
    const budget = g.challenges.timeLeft;
    // Legs must be reachable distances apart, not points on top of each other.
    let shortest = Infinity;
    let prev = { x: v.x, z: v.z };
    for (const p of route) {
      shortest = Math.min(shortest, Math.hypot(p.x - prev.x, p.z - prev.z));
      prev = p;
    }
    // Teleport through the route and confirm each checkpoint registers.
    const seen = [];
    for (const p of route) {
      v.x = p.x; v.z = p.z;
      g.challenges.update(1 / 60, v);
      seen.push(g.challenges.index);
    }
    const state = g.challenges.state;
    const total = g.score.total;
    g.challenges.cancel();
    // Put the car back where it was: teleporting a kilometre away leaves the
    // tile ring and every pedestrian stranded, and the next tests read those.
    v.x = home.x; v.z = home.z;
    g.world.update(v.x, v.z);
    return { ok, legs: route.length, budget, shortest, seen, state, total };
  });
  if (!challenge.ok) {
    problem('impossible de générer un défi sur une carte chargée');
  } else {
    note(`défi : ${challenge.legs} étapes, ${Math.round(challenge.budget)} s alloués, `
      + `plus courte ${Math.round(challenge.shortest)} m, état final ${challenge.state}`);
    if (challenge.legs < 2) problem('défi trop court');
    if (challenge.shortest < 60) problem('deux points de passage se chevauchent');
    if (challenge.state !== 'done') problem('parcourir tout le trajet ne termine pas le défi');
    if (!(challenge.total > 0)) problem('un défi terminé ne rapporte aucun point');
  }

  // --- pedestrians ----------------------------------------------------------
  const walkers = await page.waitForFunction(
    () => window.__ruelle.people.torso.count >= 5, null, { timeout: 25000 },
  ).then(() => true).catch(() => false);
  if (!walkers) {
    problem('personne ne marche sur les trottoirs');
  } else {
    const crowd = await page.evaluate(async () => {
      const g = window.__ruelle;
      const p = g.people;
      const first = p.people.find((q) => q.active);
      const before = { x: first.x, z: first.z };
      const t0 = p.people.filter((q) => q.active).length;
      await new Promise((r) => setTimeout(r, 900));
      // Nobody should still be loaded on the far side of the neighbourhood.
      let far = 0;
      for (const q of p.people) {
        if (!q.active) continue;
        if (Math.hypot(q.x - g.vehicle.x, q.z - g.vehicle.z) > 200) far++;
      }
      return {
        active: t0,
        parts: p.group.children.length,
        moved: Math.hypot(first.x - before.x, first.z - before.z),
        far,
      };
    });
    note(`piétons : ${crowd.active} actifs, ${crowd.parts} maillages, `
      + `le premier a fait ${crowd.moved.toFixed(2)} m, ${crowd.far} hors de portée`);
    if (crowd.active < 5) problem(`trop peu de piétons (${crowd.active})`);
    // Recycling is spread over frames on purpose, so a few stragglers a frame
    // after a teleport are expected; a majority stranded is not.
    if (crowd.far > crowd.active / 2) problem('les piétons ne sont pas recyclés autour de la voiture');
  }

  // --- hedges and bushes ----------------------------------------------------
  const green = await page.evaluate(() => {
    let shrubs = 0;
    for (const t of window.__ruelle.world.tiles.values()) {
      if (t.propMeshes && t.propMeshes.shrubCount) shrubs += t.propMeshes.shrubCount;
    }
    return shrubs;
  });
  note(`buissons et haies : ${green} instances`);
  if (green < 1) problem('aucun buisson généré dans les parcs');

  // --- tree species by neighbourhood ---------------------------------------
  // The point of the species field is that it sits between "every tree the
  // same" and "every tree random": neighbours agree, distant streets do not.
  // Both ends have to be measured, because either one alone passes for a
  // constant function.
  const flora = await page.evaluate(async () => {
    const { speciesAt } = await import('/src/world/props.js');
    const N = 6;
    const agree = (d) => {
      let same = 0;
      for (let i = 0; i < 4000; i++) {
        const x = (Math.random() - 0.5) * 8000;
        const z = (Math.random() - 0.5) * 8000;
        if (speciesAt(x, z, N) === speciesAt(x + d, z, N)) same++;
      }
      return same / 4000;
    };
    const tally = {};
    let trees = 0;
    for (const t of window.__ruelle.world.tiles.values()) {
      if (!t.propMeshes || !t.propMeshes.treeSpecies) continue;
      trees += t.propMeshes.treeCount;
      for (const [s, n] of Object.entries(t.propMeshes.treeSpecies)) {
        tally[s] = (tally[s] || 0) + n;
      }
    }
    return {
      near: agree(12), far: agree(900), chance: 1 / N,
      stable: speciesAt(1234.5, -678.25, N) === speciesAt(1234.5, -678.25, N),
      trees, kinds: Object.keys(tally).length,
    };
  });
  note(`essences d'arbres : ${(flora.near * 100).toFixed(0)} % identiques à 12 m, `
    + `${(flora.far * 100).toFixed(0)} % à 900 m (hasard ${(flora.chance * 100).toFixed(0)} %) · `
    + `${flora.trees} arbres, ${flora.kinds} essences présentes`);
  if (!flora.stable) problem("le champ d'essences n'est pas déterministe");
  if (flora.near < 0.6) problem(`essences trop dispersées : ${(flora.near * 100).toFixed(0)} % seulement à 12 m`);
  if (flora.far > flora.chance + 0.08) problem(`essences corrélées trop loin : ${(flora.far * 100).toFixed(0)} % à 900 m`);
  if (flora.trees > 40 && flora.kinds < 2) problem('une seule essence dans tout le monde chargé');

  // --- photo mode -----------------------------------------------------------
  const photo = await page.evaluate(async () => {
    const g = window.__ruelle;
    g.photo.toggle(g.car.group.position);
    const on = g.photo.active;
    const hudHidden = getComputedStyle(document.querySelector('#hud')).display === 'none';
    const barVisible = document.querySelector('#photo').classList.contains('visible');
    // Orbit a quarter turn and make sure the camera actually goes round.
    const p0 = g.camera.position.clone();
    g.photo.yaw += Math.PI / 2;
    g.photo.update(g.car.group.position);
    const swung = g.camera.position.distanceTo(p0);
    const url = await g.photo.capture();
    g.photo.set(false);
    return {
      on, hudHidden, barVisible, swung,
      shot: typeof url === 'string' && url.startsWith('blob:'),
      off: !g.photo.active,
      hudBack: getComputedStyle(document.querySelector('#hud')).display !== 'none',
    };
  });
  note(`mode photo : actif ${photo.on}, hud masqué ${photo.hudHidden}, orbite ${photo.swung.toFixed(1)} m, fichier ${photo.shot}`);
  if (!photo.on || !photo.barVisible) problem('le mode photo ne s’active pas');
  if (!photo.hudHidden) problem('le hud reste visible en mode photo');
  if (photo.swung < 1) problem('la caméra photo ne tourne pas');
  if (!photo.shot) problem('le mode photo ne produit pas d’image');
  if (!photo.off || !photo.hudBack) problem('impossible de sortir du mode photo');

  // --- engine character -----------------------------------------------------
  // The whole point of a synthesised engine is that a swap changes the sound
  // for free. That only holds if the cylinder count actually reaches the audio
  // graph, so check the number the oscillators are being tuned to.
  const engine = await page.evaluate(async () => {
    const g = window.__ruelle;
    await g.audio.resume().catch(() => {});
    if (!g.audio.ready) return { skipped: true };
    const read = () => g.audio._nodes.oscs.find((o) => o.ratio === 1).osc.frequency.value;
    const state = {
      rpm: 4000, throttle: 1, speed: 20, skid: 0, load: 1, redline: 7000,
      exhaust: 1, induction: 0,
    };
    g.audio.update({ ...state, cylinders: 4 }, 1);
    await new Promise((r) => setTimeout(r, 260));
    const four = read();
    g.audio.update({ ...state, cylinders: 8 }, 1);
    await new Promise((r) => setTimeout(r, 260));
    const eight = read();
    return { four, eight, spec: g.vehicle.spec.cylinders };
  });
  if (engine.skipped) {
    note('moteur : contexte audio indisponible en headless, non vérifié');
  } else {
    note(`moteur : 4 cyl à ${engine.four.toFixed(0)} Hz, 8 cyl à ${engine.eight.toFixed(0)} Hz`
      + ` (spec ${engine.spec})`);
    if (!(engine.eight > engine.four * 1.5)) {
      problem('changer le nombre de cylindres ne change pas le son');
    }
  }

  // --- underglow ------------------------------------------------------------
  // Wait on the sky's own state, not on a clock: `night` eases toward its
  // target, so at four frames a second a fixed wait can sample it at nought.
  await page.evaluate(() => {
    const g = window.__ruelle;
    g.settings.underglow = true;
    g.settings.underglowColor = 'purple';
    g.settings.timeOfDay = 23;
  });
  await page.waitForFunction(() => window.__ruelle.sky.night > 0.8, null, { timeout: 30000 })
    .catch(() => {});
  const glowNight = await page.evaluate(() => {
    const mesh = window.__ruelle.car.group.children.find(
      (c) => c.material && c.material.blending === 2
        && c.geometry && c.geometry.type === 'PlaneGeometry');
    if (!mesh) return null;
    return { on: mesh.visible, o: mesh.material.opacity, c: mesh.material.color.getHex() };
  });
  await page.evaluate(() => { window.__ruelle.settings.timeOfDay = 12; });
  await page.waitForFunction(() => window.__ruelle.sky.night < 0.1, null, { timeout: 30000 })
    .catch(() => {});
  const glow = await page.evaluate(() => {
    const g = window.__ruelle;
    const mesh = g.car.group.children.find(
      (c) => c.material && c.material.blending === 2
        && c.geometry && c.geometry.type === 'PlaneGeometry');
    g.settings.underglow = false;
    g.settings.timeOfDay = 10.5;
    return { day: mesh ? mesh.visible : null, found: !!mesh };
  });
  glow.night = glowNight;
  if (!glow.found) {
    problem('aucun néon sous caisse sur la voiture');
  } else {
    note(`néons : nuit visible ${glow.night.on} (opacité ${glow.night.o.toFixed(2)}, `
      + `couleur ${glow.night.c.toString(16)}), jour visible ${glow.day}`);
    if (!glow.night.on || glow.night.o < 0.2) problem('les néons ne s’allument pas la nuit');
    if (glow.day) problem('les néons restent allumés en plein jour');
  }

  // --- multiplayer, two real browsers -------------------------------------
  // Nothing here is mocked. Two pages claim two seats in a room through the
  // broker, negotiate a WebRTC connection, and send each other snapshots; the
  // assertions are about what one page can see of the other's car.
  const ROOM = 'SMOKE1';
  let second = null;
  try {
    await page.evaluate((room) => window.__ruelle.net.join(room), ROOM);
    const hosted = await page.waitForFunction(
      () => window.__ruelle.net.state === 'online', null, { timeout: 20000 },
    ).then(() => true).catch(() => false);
    if (!hosted) problem('impossible de prendre une place dans un salon');
    else note(`salon ${ROOM} : place prise`);

    // The second player arrives by invitation link, which is the path a real
    // player takes — so the link itself is under test too.
    // Small on purpose: software rasterising costs per pixel, and this page
    // exists to send position packets, not to be looked at.
    second = await browser.newPage({ viewport: { width: 320, height: 240 } });
    second.setDefaultTimeout(120000);
    second.on('pageerror', (err) => problem(`pageerror (2e joueur) : ${err.message}`));
    await second.route('**/elevation-tiles-prod/**', (route) => route.fulfill({ status: 404, body: '' }));

    // Park the first page's loop while the second boots and the two negotiate.
    // Under swiftshader a frame costs a quarter of a second of pure CPU, and two
    // pages rendering at once means neither gets anywhere: the second cannot even
    // reach DOMContentLoaded, because a module script builds the whole game
    // before firing it. Signalling, the peer connection and the snapshot buffers
    // are all event-driven and need no render loop, so nothing under test is lost
    // — and it comes back on before anything on screen is asserted.
    await page.evaluate(() => window.__ruelle.loop.stop());
    await second.goto(
      `${base}?offline=1&quality=low&${net}&room=${ROOM}`,
      { waitUntil: 'domcontentloaded', timeout: 120000 },
    );
    await second.waitForFunction(() => !!window.__ruelle, null, { timeout: 60000 });
    // It only needs a projection to publish against, not a finished city.
    await second.evaluate(() => {
      window.__ruelle.settings.playerName = 'Deuxième';
      window.__ruelle.net.setName('Deuxième');
      window.__ruelle.hop(45.5265, -73.5795, 'Test', true);
    });

    const met = await page.waitForFunction(
      () => window.__ruelle.net.cars().length === 1, null, { timeout: 90000 },
    ).then(() => true).catch(() => false);
    await page.evaluate(() => window.__ruelle.loop.start());

    if (!met) {
      const why = await page.evaluate(() => ({
        state: window.__ruelle.net.state,
        players: window.__ruelle.net.players.size,
        peers: window.__ruelle.net.mesh ? window.__ruelle.net.mesh.peers.size : -1,
      }));
      problem(`les deux joueurs ne se voient pas — ${JSON.stringify(why)}`);
    } else {
      // Drive the second car to a known spot and check where the first sees it.
      const target = await second.evaluate(() => {
        const v = window.__ruelle.vehicle;
        v.x = 140; v.z = -60; v.yaw = 1.1; v.u = 12;
        return { x: v.x, z: v.z, yaw: v.yaw };
      });
      const agreed = await page.waitForFunction((t) => {
        const c = window.__ruelle.net.cars()[0];
        return !!c && Math.hypot(c.x - t.x, c.z - t.z) < 12;
      }, target, { timeout: 20000 }).then(() => true).catch(() => false);

      // The car and its HUD row are built during render, so give the loop —
      // restarted a moment ago, and running at about four frames a second —
      // time to draw one.
      await page.waitForFunction(
        () => window.__ruelle.remoteCars.slots.size === 1
          && document.querySelectorAll('#players .player-row').length === 2,
        null, { timeout: 30000 },
      ).catch(() => { /* asserted below with a real message */ });

      const view = await page.evaluate(() => {
        const g = window.__ruelle;
        const c = g.net.cars()[0] || null;
        return {
          gone: !c,
          name: c ? c.name : '—',
          x: c ? c.x : NaN, z: c ? c.z : NaN,
          colour: c ? c.colour : 0,
          meshes: g.remoteCars.slots.size,
          plate: g.remoteCars.group.children.length,
          roster: g.net.roster().length,
          rows: document.querySelectorAll('#players .player-row').length,
        };
      });
      if (view.gone) problem('le 2e joueur disparaît après s’être connecté');
      const off = Math.hypot(view.x - target.x, view.z - target.z);
      note(`2e joueur : « ${view.name} », vu à ${off.toFixed(1)} m de sa vraie position, `
        + `${view.meshes} voiture(s) instanciée(s), ${view.rows} lignes de HUD`);
      if (!agreed) problem(`la position du 2e joueur est fausse de ${off.toFixed(0)} m`);
      if (view.name !== 'Deuxième') problem(`le nom du 2e joueur n’arrive pas (« ${view.name} »)`);
      if (view.meshes !== 1) problem('aucune voiture n’est instanciée pour le 2e joueur');
      if (view.plate < 2) problem('la plaque de nom du 2e joueur manque');
      if (view.roster !== 2) problem(`la liste des joueurs en compte ${view.roster}`);
      if (view.rows !== 2) problem(`le HUD affiche ${view.rows} joueurs au lieu de 2`);

      // Snapshots must keep coming, not arrive once and stop.
      //
      // Deliberately not a rate. The sender is paced by simulated time, and the
      // fixed-step loop drops its backlog when a frame costs a quarter of a
      // second — so under software rendering fifteen packets a second correctly
      // becomes one or two. Asserting a rate here would measure swiftshader.
      // What has to hold is that the stream continues.
      // Park this page again while measuring. Receiving is event-driven, so the
      // count is unaffected — but the sender is a whole second game engine on
      // the same couple of cores, and starving it is measuring the harness.
      await page.evaluate(() => window.__ruelle.loop.stop());
      const flowing = await page.evaluate(async () => {
        const p = [...window.__ruelle.net.players.values()][0];
        if (!p) return { packets: 0, seconds: 0, lost: true };
        const before = p.buffer.lastSeq;
        const t0 = performance.now();
        while (performance.now() - t0 < 25000) {
          if (p.buffer.lastSeq - before >= 4) break;
          await new Promise((r) => setTimeout(r, 200));
        }
        return { packets: p.buffer.lastSeq - before, seconds: (performance.now() - t0) / 1000 };
      });
      await page.evaluate(() => window.__ruelle.loop.start());
      note(`flux : ${flowing.packets} paquets en ${flowing.seconds.toFixed(1)} s`
        + ' (cadence bridée par le rendu logiciel)');
      if (flowing.packets < 4) {
        problem(`le flux de position s’arrête (${flowing.packets} paquets en ${flowing.seconds.toFixed(0)} s)`);
      }

      // Two cars cannot occupy the same metre of road.
      const bumped = await page.evaluate(async () => {
        const g = window.__ruelle;
        const v = g.vehicle;
        const c = g.net.cars()[0];
        v.x = c.x; v.z = c.z; v.yaw = c.yaw; v.u = 0; v.v = 0;
        const { collideWithRemote } = await import('/src/net/remote.js');
        collideWithRemote(v, g.net.cars());
        const after = g.net.cars()[0];
        return Math.hypot(v.x - after.x, v.z - after.z);
      });
      note(`collision entre joueurs : séparés de ${bumped.toFixed(2)} m`);
      if (bumped < 0.3) problem('les voitures des joueurs se traversent');

      await page.screenshot({ path: path.join(SHOTS, '08-multijoueur.png') });
    }

    // Leaving has to be noticed, and has to take the car off the screen.
    await second.close();
    second = null;
    const cleared = await page.waitForFunction(
      () => window.__ruelle.net.count === 0 && window.__ruelle.remoteCars.slots.size === 0,
      null, { timeout: 25000 },
    ).then(() => true).catch(() => false);
    if (!cleared) problem('la voiture d’un joueur parti reste sur la carte');
    else note('départ d’un joueur : voiture retirée');

    await page.evaluate(() => window.__ruelle.net.leave());
  } catch (err) {
    problem(`multijoueur : ${err.message}`);
  } finally {
    if (second) await second.close().catch(() => {});
  }

  // --- frame rate ----------------------------------------------------------
  const fps = await page.evaluate(() => window.__ruelle.loop.fps);
  note(`fps (rendu logiciel headless) : ${fps.toFixed(1)}`);

  // --- hopping resets the horizon -------------------------------------------
  // Last, because it reloads the world: the anchor moves a hundred and sixty
  // metres between the Plateau and the summit, and the horizon carries baked
  // heights, so a hop that does not invalidate it leaves a mesh hanging in the
  // air over the city. That is exactly the bug this is here to catch.
  const rehop = await page.evaluate(async () => {
    const g = window.__ruelle;
    g.hop(45.5088, -73.5878, 'Mont Royal', true);
    // Wait on the elevation layer, not on a clock: in software rendering the
    // page runs at four frames a second and a fixed wait is a coin toss.
    for (let i = 0; i < 160; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const t = g.world.terrain.stats();
      // Not just "the data has landed" — "a frame has since redisplaced the
      // horizon with it". The mesh is rebuilt inside world.update(), so at
      // four frames a second the two are seconds apart.
      const seen = g.world._backdropTiles === t.loaded;
      if (i > 8 && !t.pending && g.world.terrain.baselineReady && seen) break;
    }
    const b = g.world.backdrop;
    const pos = b.geometry.attributes.position;
    let above = 0, worst = 0;
    for (let i = 0; i < pos.count; i++) {
      const gh = g.world.groundHeight(b.position.x + pos.getX(i), b.position.z - pos.getY(i));
      const over = (pos.getZ(i) + b.position.y) - gh;
      if (over > 0) { above++; if (over > worst) worst = over; }
    }
    return { above, worst, baseline: g.world.terrain.baseline };
  });
  note(`horizon après un saut au mont Royal : ancrage ${rehop.baseline.toFixed(0)} m, `
    + `${rehop.above} sommets au-dessus du sol`);
  if (rehop.above > 0) {
    problem(`sauter ne réinitialise pas l’horizon (${rehop.above} sommets, jusqu’à ${rehop.worst.toFixed(0)} m)`);
  }

  // --- memory: drive far enough to retire tiles ----------------------------
  const before = await page.evaluate(() => window.__ruelle.world.tiles.size);
  await page.evaluate(async () => {
    const g = window.__ruelle;
    for (let i = 0; i < 40; i++) {
      g.vehicle.x += 90;
      g.world.update(g.vehicle.x, g.vehicle.z);
      await new Promise((r) => setTimeout(r, 30));
    }
  });
  await page.waitForTimeout(1500);
  const after = await page.evaluate(() => window.__ruelle.world.tiles.size);
  // Driving in a straight line leaves a corridor behind: everything within a
  // Chebyshev radius of KEEP_RADIUS (3) of the finish that was ever created,
  // which is 7 columns by the build ring's 5 rows = 35. Anything materially
  // above that means retirement has stopped happening.
  note(`tuiles actives avant/après 3,6 km : ${before} → ${after}`);
  if (after > 38) problem(`les tuiles ne sont pas recyclées (${after} actives)`);

  await finish(browser, server, page);
}

async function finish(browser, server, page, broker) {
  if (page) {
    await page.screenshot({ path: path.join(SHOTS, '99-final.png') }).catch(() => {});
  }
  await browser.close();
  server.close();
  if (broker) broker.close();

  console.log('\n──────────────────────────────────────────');
  if (problems.length) {
    console.log(`✗ ${problems.length} problème(s)`);
    for (const p of problems) console.log(`  · ${p}`);
    console.log(`\ncaptures : ${SHOTS}`);
    process.exit(1);
  }
  console.log(`✓ tout est vert — ${notes.length} vérifications`);
  console.log(`captures : ${SHOTS}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
