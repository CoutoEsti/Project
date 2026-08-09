// Free roam with a stopwatch: drop a start gate anywhere, drop a finish gate
// anywhere, and the road between them becomes a course.
//
// Your best run is recorded as a ghost — position and heading at 30 Hz — and
// replayed as a translucent car on every subsequent attempt. Everything lives
// in localStorage and in the URL, so a course can be shared without a server:
// the link carries the two gates, the recipient's browser carries their own
// ghost.

import * as THREE from 'three';
import { createCar } from '../vehicle/model.js';
import { load, save } from '../core/store.js';

const GATE_HALF_WIDTH = 11;
const SAMPLE_RATE = 30;          // ghost samples per second
const MAX_SAMPLES = SAMPLE_RATE * 60 * 12;   // twelve minutes is plenty

export const TrialState = {
  IDLE: 'idle',              // no course
  PLACING_FINISH: 'placing', // start dropped, waiting for the finish
  ARMED: 'armed',            // course exists, waiting for you to cross the start
  RUNNING: 'running',
  FINISHED: 'finished',
};

export class TimeTrial {
  constructor(opts) {
    this.scene = opts.scene;
    this.projection = opts.projection;
    this.onEvent = opts.onEvent || (() => {});

    this.state = TrialState.IDLE;
    this.start = null;      // {x, z, yaw}
    this.finish = null;
    this.courseId = null;
    this.best = null;       // {time, samples}
    this.elapsed = 0;
    this.lastTime = null;
    this.improved = false;

    this._samples = [];
    this._sampleTimer = 0;
    this._prev = { x: 0, z: 0 };
    this._hasPrev = false;

    this.group = new THREE.Group();
    this.group.name = 'trial';
    this.scene.add(this.group);

    this.ghostCar = createCar(THREE, { color: 0x7fd4ff, ghost: true });
    this.ghostCar.group.visible = false;
    this.group.add(this.ghostCar.group);
    this.ghostTime = 0;
    this.ghostActive = false;
    this.groundAt = null;
  }

  setProjection(projection) {
    this.projection = projection;
  }

  /** One button does both gates, then resets. */
  placeGate(x, z, yaw) {
    if (this.state === TrialState.IDLE || this.state === TrialState.FINISHED) {
      this.clear(true);
      this.start = { x, z, yaw };
      this.state = TrialState.PLACING_FINISH;
      this._buildGateMesh(this.start, 'start');
      this.onEvent({ type: 'start-placed' });
      return;
    }
    if (this.state === TrialState.PLACING_FINISH) {
      const dx = x - this.start.x, dz = z - this.start.z;
      if (Math.hypot(dx, dz) < 40) {
        this.onEvent({ type: 'too-close' });
        return;
      }
      this.finish = { x, z, yaw };
      this._buildGateMesh(this.finish, 'finish');
      this.courseId = this._courseId();
      this.best = load(`best:${this.courseId}`, null);
      this.state = TrialState.ARMED;
      this.onEvent({ type: 'course-ready', best: this.best ? this.best.time : null });
      return;
    }
    // Placing a gate mid-run abandons the run and starts over.
    this.clear();
    this.placeGate(x, z, yaw);
  }

  clear(keepBest = false) {
    for (let i = this.group.children.length - 1; i >= 0; i--) {
      const child = this.group.children[i];
      if (child === this.ghostCar.group) continue;
      this.group.remove(child);
      child.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material && o.material.dispose) o.material.dispose();
      });
    }
    this.start = null;
    this.finish = null;
    this.state = TrialState.IDLE;
    this.elapsed = 0;
    this._samples = [];
    this.ghostCar.group.visible = false;
    this.ghostActive = false;
    if (!keepBest) {
      this.courseId = null;
      this.best = null;
      this.lastTime = null;
    }
  }

  /**
   * @param {number} dt
   * @param {{x:number,z:number,yaw:number,speed:number}} car
   */
  update(dt, car) {
    if (!this._hasPrev) {
      this._prev.x = car.x;
      this._prev.z = car.z;
      this._hasPrev = true;
      return;
    }

    const crossedStart = this.start && this._crossed(this.start, car);
    const crossedFinish = this.finish && this._crossed(this.finish, car);

    if (this.state === TrialState.ARMED && crossedStart) {
      this.state = TrialState.RUNNING;
      this.elapsed = 0;
      this._samples = [];
      this._sampleTimer = 0;
      this.ghostTime = 0;
      this.ghostActive = !!(this.best && this.best.samples && this.best.samples.length);
      this.ghostCar.group.visible = this.ghostActive;
      this.improved = false;
      this.onEvent({ type: 'started' });
    } else if (this.state === TrialState.RUNNING) {
      this.elapsed += dt;

      this._sampleTimer += dt;
      if (this._sampleTimer >= 1 / SAMPLE_RATE && this._samples.length < MAX_SAMPLES * 4) {
        this._sampleTimer -= 1 / SAMPLE_RATE;
        this._samples.push(
          Math.round(car.x * 20) / 20,
          Math.round(car.z * 20) / 20,
          Math.round(car.yaw * 500) / 500,
        );
      }

      if (this.ghostActive) {
        this.ghostTime += dt;
        this._poseGhost(this.ghostTime);
      }

      if (crossedFinish) {
        this.state = TrialState.FINISHED;
        this.lastTime = this.elapsed;
        const previous = this.best ? this.best.time : null;
        if (previous == null || this.elapsed < previous) {
          this.improved = true;
          this.best = { time: this.elapsed, samples: this._samples.slice() };
          save(`best:${this.courseId}`, this.best);
        }
        this.ghostCar.group.visible = false;
        this.ghostActive = false;
        this.onEvent({
          type: 'finished',
          time: this.elapsed,
          best: this.best ? this.best.time : null,
          improved: this.improved,
          delta: previous != null ? this.elapsed - previous : null,
        });
      }
    }

    this._prev.x = car.x;
    this._prev.z = car.z;
  }

  /** Re-arm for another attempt without moving the gates. */
  rearm() {
    if (!this.start || !this.finish) return;
    this.state = TrialState.ARMED;
    this.elapsed = 0;
    this._samples = [];
    this.ghostCar.group.visible = false;
    this.ghostActive = false;
  }

  _poseGhost(t) {
    const s = this.best.samples;
    const frames = s.length / 3;
    if (frames < 2) return;
    const idx = t * SAMPLE_RATE;
    if (idx >= frames - 1) {
      // Ghost has finished: park it at the line and fade it out.
      this.ghostCar.group.visible = false;
      return;
    }
    const i = Math.floor(idx);
    const f = idx - i;
    const x = s[i * 3] + (s[(i + 1) * 3] - s[i * 3]) * f;
    const z = s[i * 3 + 1] + (s[(i + 1) * 3 + 1] - s[i * 3 + 1]) * f;
    let y0 = s[i * 3 + 2], y1 = s[(i + 1) * 3 + 2];
    // Shortest way round the circle, so the ghost never spins on a wrap.
    let d = y1 - y0;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    this.ghostCar.group.position.set(x, this.groundAt ? this.groundAt(x, z) : 0, z);
    this.ghostCar.group.rotation.y = y0 + d * f;
    this.ghostCar.group.visible = true;
  }

  /** Did the car cross this gate's line since the last frame? */
  _crossed(gate, car) {
    const nx = Math.cos(gate.yaw), nz = -Math.sin(gate.yaw);   // gate's right vector
    const ax = gate.x - nx * GATE_HALF_WIDTH, az = gate.z - nz * GATE_HALF_WIDTH;
    const bx = gate.x + nx * GATE_HALF_WIDTH, bz = gate.z + nz * GATE_HALF_WIDTH;
    return segmentsIntersect(this._prev.x, this._prev.z, car.x, car.z, ax, az, bx, bz);
  }

  _courseId() {
    const p = this.projection;
    const a = p.toLatLon(this.start.x, this.start.z);
    const b = p.toLatLon(this.finish.x, this.finish.z);
    return [a.lat, a.lon, b.lat, b.lon].map((v) => v.toFixed(5)).join(',');
  }

  /** A link that recreates this course anywhere. */
  shareUrl() {
    if (!this.start || !this.finish) return null;
    const p = this.projection;
    const a = p.toLatLon(this.start.x, this.start.z);
    const b = p.toLatLon(this.finish.x, this.finish.z);
    const url = new URL(window.location.href);
    url.searchParams.set('lat', a.lat.toFixed(6));
    url.searchParams.set('lon', a.lon.toFixed(6));
    url.searchParams.set('course', [
      a.lat.toFixed(6), a.lon.toFixed(6), this.start.yaw.toFixed(3),
      b.lat.toFixed(6), b.lon.toFixed(6), this.finish.yaw.toFixed(3),
    ].join(','));
    if (this.best) url.searchParams.set('target', this.best.time.toFixed(2));
    return url.toString();
  }

  /** Restore a course from a shared link. */
  loadFromParams(params) {
    const raw = params.get('course');
    if (!raw) return false;
    const parts = raw.split(',').map(Number);
    if (parts.length < 6 || parts.some((v) => !Number.isFinite(v))) return false;
    const p = this.projection;
    const a = p.toWorld(parts[0], parts[1]);
    const b = p.toWorld(parts[3], parts[4]);
    this.clear();
    this.start = { x: a.x, z: a.z, yaw: parts[2] };
    this.finish = { x: b.x, z: b.z, yaw: parts[5] };
    this._buildGateMesh(this.start, 'start');
    this._buildGateMesh(this.finish, 'finish');
    this.courseId = this._courseId();
    this.best = load(`best:${this.courseId}`, null);
    this.state = TrialState.ARMED;
    const target = Number(params.get('target'));
    this.sharedTarget = Number.isFinite(target) ? target : null;
    return true;
  }

  _buildGateMesh(gate, kind) {
    const colour = kind === 'start' ? 0x35c46a : 0xe8503a;
    const g = new THREE.Group();
    g.position.set(gate.x, this.groundAt ? this.groundAt(gate.x, gate.z) : 0, gate.z);
    g.rotation.y = gate.yaw;

    const postGeo = new THREE.BoxGeometry(0.34, 6.2, 0.34);
    const postMat = new THREE.MeshLambertMaterial({ color: colour });
    for (const sx of [-GATE_HALF_WIDTH, GATE_HALF_WIDTH]) {
      const post = new THREE.Mesh(postGeo, postMat);
      post.position.set(sx, 3.1, 0);
      g.add(post);
    }

    const bar = new THREE.Mesh(
      new THREE.BoxGeometry(GATE_HALF_WIDTH * 2 + 0.34, 0.75, 0.30),
      postMat,
    );
    bar.position.set(0, 6.0, 0);
    g.add(bar);

    // A translucent curtain so the gate reads from a distance and from an angle.
    const curtain = new THREE.Mesh(
      new THREE.PlaneGeometry(GATE_HALF_WIDTH * 2, 5.6),
      new THREE.MeshBasicMaterial({
        color: colour, transparent: true, opacity: 0.16,
        side: THREE.DoubleSide, depthWrite: false,
      }),
    );
    curtain.position.set(0, 2.9, 0);
    g.add(curtain);

    // A painted line on the tarmac, which is what you actually aim at.
    const line = new THREE.Mesh(
      new THREE.PlaneGeometry(GATE_HALF_WIDTH * 2, 0.7),
      new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: 0.85 }),
    );
    line.rotation.x = -Math.PI / 2;
    line.position.set(0, 0.03, 0);
    g.add(line);

    this.group.add(g);
  }

  dispose() {
    this.clear();
    this.ghostCar.dispose();
    this.scene.remove(this.group);
  }
}

function segmentsIntersect(ax, az, bx, bz, cx, cz, dx, dz) {
  const r1 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
  const r2 = (bx - ax) * (dz - az) - (bz - az) * (dx - ax);
  const r3 = (dx - cx) * (az - cz) - (dz - cz) * (ax - cx);
  const r4 = (dx - cx) * (bz - cz) - (dz - cz) * (bx - cx);
  return ((r1 > 0) !== (r2 > 0)) && ((r3 > 0) !== (r4 > 0));
}

export function formatTime(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return '--:--.--';
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}
