// Ruelle — drive the real world.
//
// This module owns the wiring: renderer, camera, world streamer, vehicle,
// audio, HUD. Everything expensive lives behind a fixed-step loop and a
// per-frame build budget, so the frame rate stays flat while tiles stream in.

import * as THREE from 'three';

import { Loop } from './core/loop.js';
import { Input } from './core/input.js';
import { loadSettings, saveSettings } from './core/store.js';
import { TileSource } from './world/source.js';
import { World } from './world/tiles.js';
import { Sky } from './world/sky.js';
import { nearestRoadPoint } from './world/roads.js';
import { Vehicle } from './vehicle/physics.js';
import { createCar, CAR_COLORS } from './vehicle/model.js';
import { EngineAudio } from './vehicle/audio.js';
import { TimeTrial, TrialState } from './game/timetrial.js';
import { Hud } from './ui/hud.js';
import { Menu } from './ui/menu.js';

const DEFAULT_PLACE = { lat: 45.5265, lon: -73.5795, label: 'Plateau-Mont-Royal, Montréal' };

class Game {
  constructor(root) {
    this.root = root;
    this.settings = loadSettings();
    this.params = new URLSearchParams(window.location.search);
    this.offline = this.params.get('offline') === '1';
    const q = this.params.get('quality');
    if (q === 'low' || q === 'medium' || q === 'high') this.settings.quality = q;

    this.canvas = root.querySelector('#viewport');
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: this.settings.quality !== 'low',
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.settings.quality === 'high' ? 2 : 1.5));
    this.renderer.shadowMap.enabled = !!this.settings.shadows;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, 1, 0.4, 5200);
    this.camera.position.set(0, 6, -12);

    this.sky = new Sky(this.scene, {
      latitude: DEFAULT_PLACE.lat,
      shadows: !!this.settings.shadows,
      shadowMap: this.settings.quality === 'high' ? 2048 : 1024,
      shadowExtent: 140,
    });

    this.source = new TileSource({
      offline: this.offline,
      onStatus: (s) => this.hud && this.hud.toast(s.message, 4200),
    });

    this.world = new World(this.scene, {
      source: this.source,
      settings: this.settings,
      onProgress: (p) => this._onWorldProgress(p),
    });

    this.vehicle = new Vehicle();
    this.car = createCar(THREE, { color: CAR_COLORS[0] });
    this.scene.add(this.car.group);

    this.audio = new EngineAudio();
    this.audio.setEnabled(!!this.settings.audio);
    this.audio.setVolume(this.settings.volume);

    this.input = new Input(window);
    this.hud = new Hud(root);
    this.trial = null;

    this.menu = new Menu(root, {
      settings: this.settings,
      onHop: (lat, lon, label) => this.hop(lat, lon, label),
      onSettings: (s, key) => this._applySettings(s, key),
    });

    this.cameraModes = ['chase', 'hood', 'orbit'];
    this.cameraMode = this.settings.camera;
    this._camPos = new THREE.Vector3(0, 8, -14);
    this._camLook = new THREE.Vector3();
    this._orbitAngle = 0;
    this.headlightsOn = false;
    this.spawned = false;
    this.placeLabel = '';
    this._spawnRetry = 0;
    this._prevSpeed = 0;

    this.loop = new Loop((dt) => this.update(dt), (alpha, dt) => this.render(alpha, dt));

    this._bindUi();
    this._resize();
    window.addEventListener('resize', () => this._resize());

    this._bootstrap();
  }

  // -------------------------------------------------------------------------

  _bootstrap() {
    // Careful: Number(null) is 0, so a missing parameter would otherwise read
    // as a perfectly valid hop into the Gulf of Guinea.
    const latRaw = this.params.get('lat');
    const lonRaw = this.params.get('lon');
    const lat = latRaw === null ? NaN : Number(latRaw);
    const lon = lonRaw === null ? NaN : Number(lonRaw);
    const hasCoords = Number.isFinite(lat) && Number.isFinite(lon)
      && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

    // A bundled dataset makes the first hop instant; its absence is fine.
    this.source.loadDataset(new URL('./data/montreal.json', document.baseURI).href)
      .then((ok) => {
        if (ok) this.menu.setHint('Jeu de données Montréal embarqué — départ instantané.');
        else if (this.offline) this.menu.setHint('Mode hors-ligne : Montréal générée.');
        else this.menu.setHint('Données OpenStreetMap en direct.');
      });

    if (hasCoords) {
      this.hop(lat, lon, this.params.get('place') || 'Position partagée', true);
    }
    this.loop.start();
  }

  _bindUi() {
    this.root.querySelector('#hop-default').addEventListener('click', () => {
      this.hop(DEFAULT_PLACE.lat, DEFAULT_PLACE.lon, DEFAULT_PLACE.label);
    });
    this.root.querySelector('#resume').addEventListener('click', () => {
      if (this.spawned) { this.menu.hide(); this.audio.resume(); }
    });
    this.root.querySelector('#share').addEventListener('click', () => this._share());

    // Touch controls
    const bindPad = (id, apply) => {
      const el = this.root.querySelector(id);
      if (!el) return;
      const on = (e) => { e.preventDefault(); apply(true); el.classList.add('down'); };
      const off = (e) => { e.preventDefault(); apply(false); el.classList.remove('down'); };
      el.addEventListener('pointerdown', on);
      el.addEventListener('pointerup', off);
      el.addEventListener('pointercancel', off);
      el.addEventListener('pointerleave', off);
    };
    bindPad('#pad-throttle', (v) => this.input.setTouch({ throttle: v ? 1 : 0 }));
    bindPad('#pad-brake', (v) => this.input.setTouch({ brake: v ? 1 : 0 }));
    bindPad('#pad-left', (v) => this.input.setTouch({ steer: v ? -1 : 0 }));
    bindPad('#pad-right', (v) => this.input.setTouch({ steer: v ? 1 : 0 }));
    bindPad('#pad-handbrake', (v) => this.input.setTouch({ handbrake: v }));

    if (matchMedia('(pointer: coarse)').matches) {
      this.root.querySelector('#touch').classList.add('visible');
    }

    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape') {
        if (this.menu.visible && this.spawned) { this.menu.hide(); this.audio.resume(); }
        else this.menu.show();
      }
    });
  }

  _resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  _applySettings(settings, key) {
    saveSettings(settings);
    if (key === 'audio') this.audio.setEnabled(settings.audio);
    if (key === 'volume') this.audio.setVolume(settings.volume);
    if (key === 'shadows') {
      this.renderer.shadowMap.enabled = !!settings.shadows;
      this.sky.sun.castShadow = !!settings.shadows;
      this.scene.traverse((o) => { if (o.isMesh) o.castShadow = !!settings.shadows && o.castShadow; });
    }
    if (key === 'quality') {
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, settings.quality === 'high' ? 2 : 1.5));
      this.hud.toast('La qualité s’applique aux nouvelles tuiles.');
    }
  }

  // -------------------------------------------------------------------------

  /** Drop into a place. Everything is rebuilt around the new origin. */
  hop(lat, lon, label, silent = false) {
    this.placeLabel = label || '';
    this.world.setOrigin(lat, lon);
    this.sky.latitude = lat;

    if (this.trial) this.trial.dispose();
    this.trial = new TimeTrial({
      scene: this.scene,
      projection: this.world.projection,
      onEvent: (e) => this._onTrialEvent(e),
    });
    if (this.params.get('course')) {
      try { this.trial.loadFromParams(this.params); } catch { /* malformed link */ }
    }

    this.vehicle.reset(0, 0, 0);
    this.spawned = false;
    this._spawnRetry = 0;
    this.hud.setPlace(label || '');
    this.hud.setStatus('Chargement du quartier…');
    this.menu.hide();
    if (!silent) this.audio.resume();
    this.world.update(0, 0);
  }

  _onWorldProgress() {
    if (!this.spawned) this._trySpawn();
  }

  /** Put the car on an actual street, once one has loaded. */
  _trySpawn() {
    const roads = this.world.allRoads();
    if (!roads.length) return;
    const target = nearestRoadPoint(roads, this.vehicle.x, this.vehicle.z);
    if (!target) return;

    // Sit in the right-hand lane rather than on the centre line.
    const offset = Math.max(1.6, target.spec.width / 4);
    const nx = -target.dirZ, nz = target.dirX;
    this.vehicle.reset(target.x + nx * offset, target.z + nz * offset, target.heading);
    this.spawned = true;
    this.hud.setStatus('');
    this.hud.toast('G : poser une porte · R : replacer sur la route · C : caméra', 5200);
  }

  _onTrialEvent(e) {
    switch (e.type) {
      case 'start-placed':
        this.hud.toast('Départ posé. Roule jusqu’à l’arrivée et appuie encore sur G.', 4200);
        break;
      case 'too-close':
        this.hud.toast('Trop près du départ — éloigne-toi d’au moins 40 m.', 3200);
        break;
      case 'course-ready':
        this.hud.toast('Parcours prêt. Franchis la ligne de départ.', 4200);
        break;
      case 'finished': {
        if (e.improved) this.hud.toast('Nouveau record personnel.', 4000);
        else if (e.delta != null) this.hud.toast(`+${e.delta.toFixed(2)} s du record.`, 4000);
        break;
      }
      default: break;
    }
  }

  _share() {
    const url = this.trial && this.trial.start && this.trial.finish
      ? this.trial.shareUrl()
      : this._positionUrl();
    if (!url) return;
    const done = () => this.hud.toast('Lien copié.', 2600);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done, () => window.prompt('Lien', url));
    } else {
      window.prompt('Lien', url);
    }
  }

  _positionUrl() {
    if (!this.world.projection) return null;
    const ll = this.world.projection.toLatLon(this.vehicle.x, this.vehicle.z);
    const url = new URL(window.location.href);
    url.search = '';
    url.searchParams.set('lat', ll.lat.toFixed(6));
    url.searchParams.set('lon', ll.lon.toFixed(6));
    if (this.placeLabel) url.searchParams.set('place', this.placeLabel);
    return url.toString();
  }

  // -------------------------------------------------------------------------

  update(dt) {
    this.input.sample(dt);

    if (!this.menu.visible && this.spawned) {
      const grids = this.world.gridsNear(this.vehicle.x, this.vehicle.z);
      this.vehicle.step(dt, {
        throttle: this.input.throttle,
        brake: this.input.brake,
        steer: this.input.steer,
        handbrake: this.input.handbrake,
      }, grids);

      if (this.vehicle.lastImpact > 1.2) this.audio.impact(this.vehicle.lastImpact);
      if (this.trial) {
        this.trial.update(dt, {
          x: this.vehicle.x, z: this.vehicle.z, yaw: this.vehicle.yaw, speed: this.vehicle.speed,
        });
      }
    } else if (this.spawned) {
      // Menu open: let the car settle rather than freezing mid-slide.
      this.vehicle.step(dt, { throttle: 0, brake: 1, steer: 0, handbrake: true },
                        this.world.gridsNear(this.vehicle.x, this.vehicle.z));
    }

    if (this.settings.autoTime) {
      this.settings.timeOfDay = (this.settings.timeOfDay + dt * 0.06) % 24;
      const slider = this.root.querySelector('#set-time');
      if (slider) slider.value = String(this.settings.timeOfDay);
    }
  }

  render(alpha, dt) {
    const v = this.vehicle;

    // --- keyboard actions --------------------------------------------------
    if (this.input.justPressed('KeyG') && this.trial && this.spawned && !this.menu.visible) {
      this.trial.placeGate(v.x, v.z, v.yaw);
    }
    if (this.input.justPressed('KeyX') && this.trial) {
      this.trial.clear();
      this.hud.toast('Parcours effacé.');
    }
    if (this.input.justPressed('reset') && this.spawned) this._respawn();
    if (this.input.justPressed('camera')) {
      const i = (this.cameraModes.indexOf(this.cameraMode) + 1) % this.cameraModes.length;
      this.cameraMode = this.cameraModes[i];
      this.settings.camera = this.cameraMode;
      saveSettings(this.settings);
    }
    if (this.input.justPressed('lights')) {
      this.headlightsOn = !this.headlightsOn;
    }

    // --- world -------------------------------------------------------------
    this.sky.setTime(this.settings.timeOfDay);
    this.sky.follow(v.x, v.z);
    this.world.setNight(this.sky.night);

    if (this.world.projection) {
      this.world.update(v.x, v.z);
      this.world.step(this.settings.quality === 'low' ? 5 : 8);
    }
    if (!this.spawned) {
      this._spawnRetry += dt;
      if (this._spawnRetry > 0.4) { this._spawnRetry = 0; this._trySpawn(); }
    }

    // --- car ---------------------------------------------------------------
    this.car.group.position.set(v.x, 0, v.z);
    this.car.group.rotation.set(v.bodyPitch, v.yaw, -v.bodyRoll, 'YXZ');
    this.car.setSteer(-v.steerAngle);
    this.car.setSpin(v.wheelSpin);
    const nightLights = this.headlightsOn || this.sky.night > 0.35;
    this.car.setLights(nightLights, this.input.brake > 0.1 && v.u > 0.5);

    this._updateCamera(dt);

    // --- audio -------------------------------------------------------------
    this.audio.update({
      rpm: v.rpm, throttle: this.input.throttle, speed: v.speed,
      skid: v.skid, load: v.load, redline: v.spec.redline,
    }, dt);

    // --- hud ---------------------------------------------------------------
    this.hud.update({
      speedKmh: v.speedKmh, rpm: v.rpm, gear: v.gear, redline: v.spec.redline,
      reversing: v.reversing, units: this.settings.units,
      fps: this.loop.fps, showFps: this.settings.showFps,
    }, dt);

    if (!this.menu.visible) {
      this.hud.drawMinimap(this.world.allRoads(), v, this.trial, dt);
      if (this.trial) {
        this.hud.setTrial({
          state: this.trial.state,
          elapsed: this.trial.elapsed,
          best: this.trial.best ? this.trial.best.time : null,
          lastTime: this.trial.lastTime,
          improved: this.trial.improved,
        });
      }
    }

    this.renderer.render(this.scene, this.camera);
    this.input.endFrame();
    void alpha;
  }

  _respawn() {
    const roads = this.world.allRoads();
    const target = nearestRoadPoint(roads, this.vehicle.x, this.vehicle.z);
    if (!target) return;
    const offset = Math.max(1.6, target.spec.width / 4);
    const nx = -target.dirZ, nz = target.dirX;
    this.vehicle.reset(target.x + nx * offset, target.z + nz * offset, target.heading);
    if (this.trial && this.trial.state === TrialState.RUNNING) this.trial.rearm();
    this.hud.toast('Replacé sur la chaussée.');
  }

  _updateCamera(dt) {
    const v = this.vehicle;
    const fx = Math.sin(v.yaw), fz = Math.cos(v.yaw);
    const speedT = Math.min(1, v.speed / 45);

    if (this.cameraMode === 'hood') {
      this.camera.position.set(v.x + fx * 0.35, 1.32, v.z + fz * 0.35);
      this._camLook.set(v.x + fx * 40, 1.1, v.z + fz * 40);
      this.camera.lookAt(this._camLook);
      this.camera.fov = 68 + speedT * 8;
      this.camera.updateProjectionMatrix();
      return;
    }

    if (this.cameraMode === 'orbit') {
      this._orbitAngle += dt * 0.25;
      const r = 13;
      this.camera.position.set(
        v.x + Math.cos(this._orbitAngle) * r, 5.5, v.z + Math.sin(this._orbitAngle) * r,
      );
      this.camera.lookAt(v.x, 1.0, v.z);
      this.camera.fov = 55;
      this.camera.updateProjectionMatrix();
      return;
    }

    // Chase: a spring behind the car, pulled back and lowered with speed, and
    // biased outward in a slide so a drift stays readable.
    const back = 7.4 + speedT * 2.6;
    const height = 3.15 + speedT * 0.5;
    const slide = Math.max(-1, Math.min(1, v.v / 9));
    const rx = Math.cos(v.yaw), rz = -Math.sin(v.yaw);

    const targetX = v.x - fx * back + rx * slide * 1.9;
    const targetZ = v.z - fz * back + rz * slide * 1.9;

    const k = 1 - Math.pow(0.0016, dt);
    this._camPos.x += (targetX - this._camPos.x) * k;
    this._camPos.z += (targetZ - this._camPos.z) * k;
    this._camPos.y += (height - this._camPos.y) * (1 - Math.pow(0.004, dt));

    // Never let the camera sink into the road or clip through a wall behind.
    this.camera.position.set(this._camPos.x, Math.max(1.4, this._camPos.y), this._camPos.z);
    this._camLook.set(v.x + fx * 7, 1.35, v.z + fz * 7);
    this.camera.lookAt(this._camLook);
    this.camera.fov = 60 + speedT * 12;
    this.camera.updateProjectionMatrix();
  }
}

// ---------------------------------------------------------------------------

function fail(message, detail) {
  const el = document.querySelector('#fatal');
  if (!el) return;
  el.querySelector('#fatal-message').textContent = message;
  el.querySelector('#fatal-detail').textContent = detail || '';
  el.classList.add('visible');
}

function start() {
  try {
    const test = document.createElement('canvas');
    const gl = test.getContext('webgl2') || test.getContext('webgl');
    if (!gl) {
      fail('WebGL est indisponible.',
           'Active l’accélération matérielle dans les réglages du navigateur, puis recharge.');
      return;
    }
  } catch (err) {
    fail('WebGL est indisponible.', String(err));
    return;
  }

  try {
    window.__ruelle = new Game(document.body);
  } catch (err) {
    console.error(err);
    fail('Le jeu n’a pas pu démarrer.', String((err && err.message) || err));
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start);
} else {
  start();
}
