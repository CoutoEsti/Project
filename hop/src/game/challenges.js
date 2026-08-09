// Challenges, generated from the map you happen to be standing on.
//
// The time trial asks you to place your own gates, which is great once you
// know a neighbourhood and useless the first time you arrive somewhere. This
// does the opposite: it reads the road network around the car and hands you a
// route through it. No authoring, no per-city content, and it works just as
// well in a Montréal alley as it will anywhere else the game ever loads.
//
// Waypoints are chosen by throwing a point out into the city at a target
// distance and snapping it to the nearest street. Snapping is what keeps the
// route drivable: a random point is usually a rooftop or a river, and the
// nearest road to it is neither.

import * as THREE from 'three';
import { nearestRoadPoint } from '../world/roads.js';
import { load, save } from '../core/store.js';

const REACH = 14;            // metres: close enough to count as arrived
const LEG_MIN = 190;
const LEG_MAX = 430;
// 34 km/h average. Generous on paper — city blocks, lights and one wrong turn
// eat it fast, which is exactly the tension worth having.
const PACE = 9.4;
const SLACK = 12;

export const ChallengeState = {
  IDLE: 'idle',
  RUNNING: 'running',
  DONE: 'done',
  FAILED: 'failed',
};

export class Challenges {
  /**
   * @param {object} opts {scene, onEvent}
   */
  constructor(opts) {
    this.scene = opts.scene;
    this.onEvent = opts.onEvent || (() => {});
    this.groundAt = opts.groundAt || (() => 0);

    this.state = ChallengeState.IDLE;
    this.route = [];             // [{x, z}]
    this.index = 0;
    this.timeLeft = 0;
    this.elapsed = 0;
    this.label = '';
    this.district = '';

    this.group = new THREE.Group();
    this.group.name = 'challenge';
    this.group.visible = false;
    this.scene.add(this.group);

    // One marker, moved to the active checkpoint, rather than one per
    // waypoint: only the next one is ever meant to be visible, and showing the
    // whole route turns a drive into a dot-to-dot.
    const ringGeo = new THREE.TorusGeometry(4.6, 0.28, 8, 28);
    ringGeo.rotateX(Math.PI / 2);
    this.ringMat = new THREE.MeshBasicMaterial({
      color: 0xffc857, transparent: true, opacity: 0.9, depthWrite: false,
    });
    this.ring = new THREE.Mesh(ringGeo, this.ringMat);
    this.ring.renderOrder = 4;
    this.group.add(this.ring);

    const colGeo = new THREE.CylinderGeometry(4.4, 4.4, 26, 20, 1, true);
    colGeo.translate(0, 13, 0);
    this.colMat = new THREE.MeshBasicMaterial({
      color: 0xffc857,
      transparent: true,
      opacity: 0.14,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.column = new THREE.Mesh(colGeo, this.colMat);
    this.column.renderOrder = 4;
    this.group.add(this.column);

    this.best = load('challenges', {}) || {};
    this._spin = 0;
  }

  /** Best time recorded for a given leg count, in this district. */
  bestFor(district, legs) {
    const key = `${district}|${legs}`;
    return this.best[key] ?? null;
  }

  /**
   * Lay out a route from where the car is standing.
   *
   * @param {number} x
   * @param {number} z
   * @param {Array} roads   world-space road segments
   * @param {string} district  a label to file the record under
   * @returns {boolean} false if the map here is too sparse for a route
   */
  generate(x, z, roads, district = '') {
    if (!roads || !roads.length) return false;

    const legs = 3 + Math.floor(Math.random() * 3);   // 3..5
    const route = [];
    let cx = x, cz = z;
    // Start out in a random direction, then keep turning by a bounded amount
    // so the route is a loop through the neighbourhood and not a straight line
    // out of town.
    let heading = Math.random() * Math.PI * 2;

    for (let i = 0; i < legs; i++) {
      let placed = null;
      for (let attempt = 0; attempt < 14 && !placed; attempt++) {
        const dist = LEG_MIN + Math.random() * (LEG_MAX - LEG_MIN);
        const turn = (Math.random() - 0.5) * 2.2 + (attempt * 0.7);
        const a = heading + turn;
        const tx = cx + Math.cos(a) * dist;
        const tz = cz + Math.sin(a) * dist;
        const snap = nearestRoadPoint(roads, tx, tz, { preferWide: false, maxDistance: 130 });
        if (!snap) continue;
        // Reject anything that folded back on top of a point we already have.
        let tooClose = Math.hypot(snap.x - cx, snap.z - cz) < LEG_MIN * 0.55;
        for (const p of route) {
          if (Math.hypot(snap.x - p.x, snap.z - p.z) < 90) tooClose = true;
        }
        if (tooClose) continue;
        placed = { x: snap.x, z: snap.z };
        heading = Math.atan2(placed.z - cz, placed.x - cx);
      }
      if (!placed) break;
      route.push(placed);
      cx = placed.x;
      cz = placed.z;
    }

    if (route.length < 2) return false;

    // The budget is the route's own length at a city pace, not a flat number:
    // a short route being trivially easy is worse than one being hard.
    let total = Math.hypot(route[0].x - x, route[0].z - z);
    for (let i = 1; i < route.length; i++) {
      total += Math.hypot(route[i].x - route[i - 1].x, route[i].z - route[i - 1].z);
    }

    this.route = route;
    this.index = 0;
    this.elapsed = 0;
    this.timeLeft = total / PACE + SLACK;
    this.distance = total;
    this.district = district;
    this.state = ChallengeState.RUNNING;
    this.group.visible = true;
    this._moveMarker();
    this.onEvent({
      type: 'started',
      legs: route.length,
      distance: total,
      seconds: this.timeLeft,
      best: this.bestFor(district, route.length),
    });
    return true;
  }

  cancel() {
    if (this.state !== ChallengeState.RUNNING) return;
    this.state = ChallengeState.IDLE;
    this.group.visible = false;
    this.onEvent({ type: 'cancelled' });
  }

  /** Metres to the active checkpoint, or null when nothing is running. */
  distanceTo(x, z) {
    if (this.state !== ChallengeState.RUNNING) return null;
    const p = this.route[this.index];
    if (!p) return null;
    return Math.hypot(p.x - x, p.z - z);
  }

  /** The active checkpoint, for the minimap. */
  get target() {
    return this.state === ChallengeState.RUNNING ? this.route[this.index] : null;
  }

  _moveMarker() {
    const p = this.route[this.index];
    if (!p) return;
    const y = this.groundAt(p.x, p.z);
    this.ring.position.set(p.x, y + 1.4, p.z);
    this.column.position.set(p.x, y, p.z);
  }

  /**
   * @param {number} dt
   * @param {{x:number, z:number}} car
   */
  update(dt, car) {
    this._spin += dt;
    this.ring.rotation.z = this._spin * 0.8;
    // A slow breath on the column, so a checkpoint is findable in peripheral
    // vision without being a strobe.
    this.colMat.opacity = 0.10 + Math.sin(this._spin * 2.1) * 0.045;

    if (this.state !== ChallengeState.RUNNING) return;

    this.elapsed += dt;
    this.timeLeft -= dt;
    if (this.timeLeft <= 0) {
      this.state = ChallengeState.FAILED;
      this.group.visible = false;
      this.onEvent({ type: 'failed', reached: this.index, legs: this.route.length });
      return;
    }

    const p = this.route[this.index];
    if (!p) return;
    if (Math.hypot(p.x - car.x, p.z - car.z) > REACH) return;

    this.index++;
    if (this.index < this.route.length) {
      // Reaching a checkpoint buys time. Without it a single missed turn ends
      // the run, and the run is meant to be about driving, not about luck.
      this.timeLeft += 6;
      this._moveMarker();
      this.onEvent({
        type: 'checkpoint', index: this.index, legs: this.route.length,
        timeLeft: this.timeLeft,
      });
      return;
    }

    this.state = ChallengeState.DONE;
    this.group.visible = false;
    const key = `${this.district}|${this.route.length}`;
    const previous = this.best[key] ?? null;
    const improved = previous === null || this.elapsed < previous;
    if (improved) {
      this.best[key] = this.elapsed;
      save('challenges', this.best);
    }
    this.onEvent({
      type: 'finished',
      time: this.elapsed,
      legs: this.route.length,
      distance: this.distance,
      previous,
      improved,
      // Distance and pace both pay, so a long route beats a short one and
      // driving it well beats crawling round it.
      points: Math.round(this.distance * 1.2 + Math.max(0, this.timeLeft) * 45),
    });
  }

  dispose() {
    this.scene.remove(this.group);
    this.ring.geometry.dispose();
    this.column.geometry.dispose();
    this.ringMat.dispose();
    this.colMat.dispose();
  }
}
