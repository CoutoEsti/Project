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
    ],
  });

  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

  page.on('console', (msg) => {
    const type = msg.type();
    const text = msg.text();
    if (type === 'error') problem(`console.error: ${text}`);
    else if (type === 'warning' && !/deprecat|Multiple instances/i.test(text)) {
      note(`console.warn: ${text}`);
    }
  });
  page.on('pageerror', (err) => problem(`pageerror: ${err.message}`));
  page.on('requestfailed', (req) => {
    const url = req.url();
    if (url.includes('nominatim') || url.includes('overpass')) return;
    problem(`request failed: ${url} — ${req.failure()?.errorText}`);
  });

  const url = LIVE ? base : `${base}?offline=1`;
  console.log(`\n▶ ${url}\n`);
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });

  // --- boot ----------------------------------------------------------------
  const booted = await page.waitForFunction(() => !!window.__ruelle, null, { timeout: 15000 })
    .then(() => true).catch(() => false);
  if (!booted) {
    problem('le jeu n’a pas démarré (window.__ruelle absent)');
    await finish(browser, server, page);
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
    await finish(browser, server, page);
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
  const rolled = await page.waitForFunction(
    () => window.__ruelle.vehicle.odometer > 0.5, null, { timeout: 30000 },
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

  // --- frame rate ----------------------------------------------------------
  const fps = await page.evaluate(() => window.__ruelle.loop.fps);
  note(`fps (rendu logiciel headless) : ${fps.toFixed(1)}`);

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
  note(`tuiles actives avant/après 3,6 km : ${before} → ${after}`);
  if (after > 30) problem(`les tuiles ne sont pas recyclées (${after} actives)`);

  await finish(browser, server, page);
}

async function finish(browser, server, page) {
  if (page) {
    await page.screenshot({ path: path.join(SHOTS, '99-final.png') }).catch(() => {});
  }
  await browser.close();
  server.close();

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
