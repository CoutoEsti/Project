// MTL — the map, driven. Loads real Montréal, builds the chosen zone at the
// chosen scale, puts a car in it, and lets you drive it or fly over it.
//
// Settings come from carte.json, then the address overrides them:
//   ?zone=centre|anneau  &echelle=100|85|70   (or #centre-85 in the preview)
// Other parameters:
//   ?spawn=<id>           start driving at a spawn point (see map/montreal.js)
//   ?fly=1  or  #vol      start in free flight, over the whole map
//   ?cam=x,n,h,tx,tn,th   start in free flight, camera and target (map frame)
//   ?day=1                start by day
//   ?low=1                phone settings: no bloom, lower resolution

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { buildWorld } from './world/build.js';
import { createSky } from './world/sky.js';
import { loadSource, fetchReader } from './map/source.js';
import { ZONES, ECHELLES, resolveSettings } from './map/zones.js';
import { resolveSpawn } from './game/spawn.js';
import { createSurface } from './map/surface.js';
import { buildSolids } from './map/collide.js';
import { Driver, zoneAt } from './game/drive.js';
import { FlyCamera, OVERVIEW } from './game/flycam.js';
import { ChaseCamera } from './game/camera.js';
import { Input, wantsTouch } from './game/input.js';
import { Hud } from './game/hud.js';
import { createCar } from './game/car.js';
import { EngineAudio } from './game/audio.js';

const params = new URLSearchParams(location.search);
// The preview only passes a bare #anchor: tokens like #centre-85-vol.
const hashTokens = location.hash.replace(/^#/, '').split(/[-_.~]/).filter(Boolean);
for (const t of hashTokens) {
  if (ZONES[t]) params.set('zone', t);
  else if (/^\d+$/.test(t)) params.set('echelle', t);
  else if (t === 'vol') params.set('fly', '1');
  else if (t === 'jour') params.set('day', '1');
}
const LOW = params.has('low') || /iPhone|iPad|Android/i.test(navigator.userAgent);
const STEP = 1 / 120;           // physics rate, independent of the display
const MAX_STEPS = 8;            // at most this much catch-up per frame
const $ = (id) => document.getElementById(id);

const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: !LOW, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, LOW ? 1.25 : 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.info.autoReset = false;       // the composer renders several passes

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.3, 12000);
const sky = createSky(THREE, scene, renderer);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.7, 0.4, 0.88);
composer.addPass(bloom);
composer.addPass(new OutputPass());

// --- the world ---------------------------------------------------------------
const stepLabel = $('loading-step');
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
let fileSettings = {};
try {
  const r = await fetch('carte.json');
  if (r.ok) fileSettings = await r.json();
} catch (e) { /* no file: the defaults */ }
const settings = resolveSettings(fileSettings, params);
stepLabel.textContent = 'données';
const source = await loadSource(fetchReader('data/'));
const world = await buildWorld(THREE, source, {
  settings, onStep: (s) => { stepLabel.textContent = s; }, pause: nextFrame,
});
scene.add(world.root);
stepLabel.textContent = 'collisions';
await nextFrame();
const { layout, structures } = world;
const surface = createSurface(layout, structures);
const solids = buildSolids(layout, structures, world.buildings, {
  lamps: world.lamps, trees: world.trees, footprints: world.footprints,
});
const game = { layout, structures, surface, solids };

// --- the car -----------------------------------------------------------------
const driver = new Driver(game);
const car = createCar(THREE, { color: 0xd9a441 });
car.group.name = 'Voiture';
scene.add(car.group);
// One spot light for the headlights. It stays in the scene by day at zero
// intensity: adding and removing a light recompiles every material.
const headlight = new THREE.SpotLight(0xfff1d6, 0, 110, 0.52, 0.55, 1.1);
scene.add(headlight, headlight.target);
const audio = new EngineAudio();

const chase = new ChaseCamera(camera, game);
const input = new Input(window);
input.onGesture = () => { audio.resume(); };
const hud = new Hud(layout, {
  root: $('hud'), zone: $('zone'), road: $('road'), kmh: $('kmh'),
  minimap: $('minimap'), bigmap: $('bigmap'), bigmapCanvas: $('bigmap-canvas'),
});
if (wantsTouch()) {
  $('touch').hidden = false;
  $('help').hidden = $('help-fly').hidden = true;
  input.bindTouch($('touch'));
}

// --- night and day -----------------------------------------------------------
let night = !params.has('day');
let fogBase = 0;
function setNight(v) {
  night = v;
  sky.set(night ? 'night' : 'day');
  world.materials.setNight(night);
  bloom.enabled = night && !LOW;
  renderer.toneMappingExposure = night ? 1.15 : 1.0;
  fogBase = scene.fog.density;
}
setNight(night);

// --- free flight -------------------------------------------------------------
const fly = new FlyCamera(camera, canvas, game);
let flying = false;
function setFlying(v) {
  if (v === flying) return;
  flying = v;
  fly.enabled = v;
  input.enabled = !v;
  document.body.classList.toggle('fly', v);
  for (const b of document.querySelectorAll('[data-mode]')) b.classList.toggle('on', (b.dataset.mode === 'fly') === v);
  if (v) {
    fly.enter();
    toast(wantsTouch() ? 'Vol libre — glisse pour regarder, ▲▼ pour avancer' : 'Vol libre — O : vue d’ensemble · G : poser la voiture ici', 3.5);
  } else {
    chase.snap(pose);
  }
}
for (const b of document.querySelectorAll('[data-mode]')) {
  b.addEventListener('click', () => { setFlying(b.dataset.mode === 'fly'); b.blur(); });
}

// --- map settings: zone and scale ------------------------------------------------
{
  const zoneSel = $('set-zone'), scaleSel = $('set-echelle');
  for (const [id, z] of Object.entries(ZONES)) zoneSel.add(new Option(z.nom, id));
  for (const e of ECHELLES) scaleSel.add(new Option(`${e} %`, String(e)));
  if (!ECHELLES.includes(settings.echelle)) scaleSel.add(new Option(`${settings.echelle} %`, String(settings.echelle)));
  zoneSel.value = settings.zone;
  scaleSel.value = String(settings.echelle);
  const describe = () => { $('set-zone-desc').textContent = ZONES[zoneSel.value].description; };
  zoneSel.addEventListener('change', describe);
  describe();
  $('settings-open').addEventListener('click', (e) => { $('settings').hidden = false; e.currentTarget.blur(); });
  $('settings-close').addEventListener('click', () => { $('settings').hidden = true; });
  $('settings-form').addEventListener('submit', (e) => {
    e.preventDefault();
    // The preview keeps only a bare #anchor; a local server keeps both.
    const tokens = [zoneSel.value, scaleSel.value];
    if (flying) tokens.push('vol');
    if (!night) tokens.push('jour');
    location.hash = tokens.join('-');
    location.reload();
  });
}

// --- pose: the physics state, interpolated for display -------------------------
const prev = {}, cur = {}, pose = { x: 0, n: 0, y: 0, heading: 0, pitch: 0, roll: 0, speed: 0, slide: 0 };
function capture(o) {
  o.x = driver.x; o.n = driver.n; o.y = driver.y; o.heading = driver.heading;
  o.pitch = driver.pitch; o.roll = driver.roll;
}
function settle() {
  capture(cur);
  capture(prev);
  Object.assign(pose, cur);
  chase.snap(pose);
}
function blend(a) {
  pose.x = prev.x + (cur.x - prev.x) * a;
  pose.n = prev.n + (cur.n - prev.n) * a;
  pose.y = prev.y + (cur.y - prev.y) * a;
  let dh = cur.heading - prev.heading;
  if (dh > Math.PI) dh -= Math.PI * 2; else if (dh < -Math.PI) dh += Math.PI * 2;
  pose.heading = prev.heading + dh * a;
  pose.pitch = prev.pitch + (cur.pitch - prev.pitch) * a;
  pose.roll = prev.roll + (cur.roll - prev.roll) * a;
  pose.speed = driver.speed;
  pose.slide = driver.vehicle.v;
}

function spawnAt(id) {
  const list = layout.map.spawns;
  const order = [list.find((p) => p.id === id), ...list].filter(Boolean);
  for (const spec of order) {
    const p = resolveSpawn(layout, spec);
    if (!p) continue;
    driver.place(p.x, p.n, p.heading, p.y);
    settle();
    return spec.id;
  }
  // No named start in this zone: the middle of the map.
  const W = layout.map.world;
  driver.teleport((W.x0 + W.x1) / 2, (W.n0 + W.n1) / 2);
  settle();
  return null;
}
spawnAt(params.get('spawn') || 'decarie');

hud.onTeleport = (x, n) => {
  hud.closeMap();
  if (flying) { fly.centreOn(x, n); return; }
  driver.teleport(x, n);
  settle();
};

// --- messages ------------------------------------------------------------------
let toastTimer = 0;
function toast(text, seconds = 2.2) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  toastTimer = seconds;
}

async function exportWorld() {
  toast('Export glTF en cours…', 30);
  try {
    const { exportZones, download } = await import('./export/gltf.js');
    const files = await exportZones(THREE, world);
    for (const f of files) download(f.name, f.data);
    toast(`${files.length} fichiers exportés (glTF + map.json)`, 4);
  } catch (e) {
    console.error(e);
    toast(`Export impossible : ${e.message}`, 5);
  }
}

function act(action) {
  switch (action) {
    case 'reset': if (!flying) { driver.respawn(); settle(); } break;
    case 'camera': if (!flying) chase.cycle(); break;
    case 'map': hud.toggleMap(info()); break;
    case 'close': hud.closeMap(); break;
    case 'night': setNight(!night); break;
    case 'fly': setFlying(!flying); break;
    case 'overview': setFlying(true); fly.overview(); break;
    case 'drop': {
      // Land the car on the road under the middle of the view, and drive.
      if (!flying) break;
      const t = fly.target() || { x: fly.x, n: fly.n };
      driver.teleport(t.x, t.n);
      settle();
      setFlying(false);
      break;
    }
    case 'export': exportWorld(); break;
    case 'help': $('help').hidden = $('help-fly').hidden = !$('help').hidden; break;
    default: break;
  }
}

/** In flight: the point in the middle of the view, or under the camera. */
function flyFocus() {
  const t = fly.target();
  if (!t) return { x: fly.x, n: fly.n };
  const W = layout.map.world;
  return { x: Math.min(W.x1, Math.max(W.x0, t.x)), n: Math.min(W.n1, Math.max(W.n0, t.n)) };
}

// Where the car is, for the HUD: cheap fields every frame, lookups at 5 Hz.
let whereTimer = 0, zoneName = null, where = null;
function info() {
  if (flying) {
    // The HUD follows what the camera looks at; the minimap widens with height.
    const p = flyFocus();
    // High up, a district banner at every glance would be noise.
    return { x: p.x, n: p.n, heading: fly.yaw, kmh: 0, zone: fly.h < 250 ? zoneName : null, where: null,
      span: Math.min(3200, Math.max(520, fly.h * 3)) };
  }
  return { x: pose.x, n: pose.n, heading: pose.heading, kmh: driver.kmh, zone: zoneName, where };
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
});

function setNear(v) {
  if (Math.abs(camera.near - v) < 0.05) return;
  camera.near = v;
  camera.updateProjectionMatrix();
}

// Far tiles drop their small things (trees, lamps, paint); the far plane
// follows the view: a few kilometres from the street, the whole island from
// the air.
let detailTimer = 0;
function updateDetails(dt) {
  detailTimer -= dt;
  if (detailTimer > 0) return;
  detailTimer = 0.25;
  const s = layout.map.scale;
  const cx = camera.position.x, cn = -camera.position.z;
  const alt = Math.max(0, camera.position.y - layout.terrain.height(cx, cn));
  const reach = (flying ? 700 + alt * 1.5 : 1100) * Math.max(0.7, s);
  for (const [key, list] of world.details) {
    const b = world.tiles.bounds(key);
    const dx = Math.max(b.x0 - cx, 0, cx - b.x1), dn = Math.max(b.n0 - cn, 0, cn - b.n1);
    const show = Math.hypot(dx, dn) < reach;
    for (const o of list) o.visible = show;
  }
  const far = flying ? 40000 : 7000;
  if (camera.far !== far) { camera.far = far; camera.updateProjectionMatrix(); }
}

// --- the loop --------------------------------------------------------------------
let frames = 0, acc = 0, last = performance.now();
const clock = new THREE.Clock();
function frame(now) {
  const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
  last = now;
  renderer.info.reset();

  input.poll();
  for (const a of input.consume()) act(a);

  // Fixed-rate physics: however fast the screen refreshes, the car sees the
  // same 120 steps a second.
  acc += dt;
  let steps = 0;
  while (acc >= STEP && steps < MAX_STEPS) {
    Object.assign(prev, cur);
    input.step(STEP);
    driver.step(STEP, input);
    capture(cur);
    acc -= STEP;
    steps++;
  }
  if (steps === MAX_STEPS) acc = 0;
  if (driver.lost) {
    driver.respawn();
    settle();
    toast('Replacé sur la route');
  }
  blend(acc / STEP);

  // Car.
  const v = driver.vehicle;
  car.group.position.set(pose.x, pose.y, -pose.n);
  car.group.rotation.set(-(pose.pitch + v.bodyPitch), Math.PI - pose.heading, -pose.roll, 'YXZ');
  car.setSteer(-v.steerAngle);
  car.setSpin(v.wheelSpin);
  car.setLights(night, input.brake > 0.1 && v.u > 0.5);
  car.setUnderglow(night, 0x22ccff, 1);
  const fx = Math.sin(pose.heading), fn = Math.cos(pose.heading);
  headlight.position.set(pose.x + fx * 2.1, pose.y + 0.8, -(pose.n + fn * 2.1));
  headlight.target.position.set(pose.x + fx * 28, pose.y - 0.4, -(pose.n + fn * 28));
  headlight.target.updateMatrixWorld();
  headlight.intensity = night ? 260 : 0;

  // Camera. From above, the fog thins out, or the map would vanish in it.
  if (flying) {
    const T = input.touch;
    fly.touch.fwd = T.throttle - T.brake;
    fly.touch.turn = T.steer;
    fly.touch.up = input.fly.up;
    fly.update(dt, input.keys);
    scene.fog.density = fogBase * Math.min(1, Math.max(0.06, 1 - (fly.h - 40) / 900));
    // Push the near plane out with height: from 3 km up, 0.3 m of near
    // plane leaves no depth precision and the river flickers through the land.
    setNear(Math.min(25, Math.max(0.3, (fly.h - fly.ground(fly.x, fly.n)) * 0.01)));
  } else {
    chase.update(dt, pose);
    scene.fog.density = fogBase;
    setNear(0.3);
  }

  updateDetails(dt);

  // Sound.
  audio.update({
    rpm: v.rpm, throttle: input.throttle, speed: v.speed, skid: v.skid, load: v.load,
    redline: v.spec.redline, cylinders: v.spec.cylinders, exhaust: v.spec.exhaust, induction: v.spec.induction,
  }, dt);
  if (driver.impact > 1.5) audio.impact(driver.impact);
  if (driver.landing > 3) audio.impact(driver.landing * 0.7);
  driver.impact = 0;
  driver.landing = 0;

  // HUD.
  whereTimer -= dt;
  if (whereTimer <= 0) {
    whereTimer = 0.2;
    zoneName = flying ? zoneAt(layout, flyFocus().x, flyFocus().n) : driver.zone();
    where = flying ? null : driver.where();
  }
  hud.update(dt, info());
  if (toastTimer > 0) {
    toastTimer -= dt;
    if (toastTimer <= 0) $('toast').classList.remove('show');
  }

  const t = clock.getElapsedTime();
  for (const a of world.animated) a.update(t);
  sky.follow(camera);
  composer.render();
  frames++;
  requestAnimationFrame(frame);
}

hud.show();
$('loading').classList.add('done');
if (params.has('cam')) {
  const c = params.get('cam').split(',').map(Number);
  setFlying(true);
  fly.lookAt(...c);
} else if (params.has('fly') || location.hash === '#vol') {
  setFlying(true);
  const o = OVERVIEW;
  fly.lookAt(o.x, o.n, o.h, o.tx, o.tn, o.th);
}
requestAnimationFrame(frame);

// Hooks for the headless checks and the screenshot tool.
window.__mtl = {
  ready: true,
  world,
  game,
  driver,
  renderer,
  camera,
  scene,
  setNight,
  frames: () => frames,
  /** Free-flight view from (x, n, h) towards (tx, tn, th), map frame. */
  look(x, n, h, tx, tn, th) {
    if (!flying) setFlying(true);
    fly.lookAt(x, n, h, tx, tn, th);
  },
  fly,
  act,
  /** Drive view: put the car somewhere (heading in degrees). */
  place(x, n, headingDeg, y) {
    if (flying) setFlying(false);
    driver.place(x, n, (headingDeg * Math.PI) / 180, y);
    settle();
  },
  spawn(id) { if (flying) setFlying(false); spawnAt(id); },
  /** Run the physics on its own for `seconds` with fixed pedals. */
  simulate(seconds, pedals = {}) {
    const I = { throttle: 0, brake: 0, steer: 0, handbrake: false, ...pedals };
    const n = Math.round(seconds / STEP);
    let maxImpact = 0, airTime = 0, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      driver.step(STEP, I);
      maxImpact = Math.max(maxImpact, driver.impact);
      driver.impact = 0;
      if (driver.airborne) airTime += STEP;
      minY = Math.min(minY, driver.y);
      maxY = Math.max(maxY, driver.y);
    }
    settle();
    return { ...this.state(), maxImpact, airTime, minY, maxY };
  },
  state() {
    return {
      x: driver.x, n: driver.n, y: driver.y, heading: (driver.heading * 180) / Math.PI, kmh: driver.kmh,
      kind: driver.kind, road: driver.road ? driver.road.id : null, zone: driver.zone(), where: driver.where(),
      airborne: driver.airborne, lost: driver.lost,
    };
  },
  stats() {
    const i = renderer.info;
    return { calls: i.render.calls, triangles: i.render.triangles, geometries: i.memory.geometries, textures: i.memory.textures, timings: world.timings };
  },
};
