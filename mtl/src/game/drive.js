// The car in the city. Ruelle's tyre model drives in the plane; this adds what
// a city with a trench, a tunnel and a viaduct needs on top of it: which
// surface the wheels stand on, when they leave it, what the car hits at its
// own height, and where to put it back when it ends up somewhere it should not.
//
// Vertical rules, all at the fixed physics rate:
//   - grounded, the car stands on its surface; a step down to another surface
//     smaller than a kerb is absorbed by the suspension, a bigger one is a drop;
//   - its vertical speed is the ground's, from the slope along its motion: the
//     road's own profile on a road, nose and tail probes on the mountain;
//   - a crest taken faster than gravity can hold the car down launches it,
//     and so does the end of a ramp; airborne, it falls until it meets a
//     surface at or above it.

import { Vehicle } from './vehicle.js';
import { resolveCollisions } from '../map/collide.js';
import { stretchAt, projectOnRoad } from '../map/layout.js';
import { segDist2 } from '../map/geom.js';

const G = 9.81;
const CLIMB = 0.6;          // highest step the wheels can climb onto
const KERB = 0.25;          // a step down the suspension swallows without a hop
const GRIP_DELAY = 0.08;    // seconds in the air before the tyres let go
const PROBE = 1.6;          // slope probes, metres ahead of and behind the centre
const LIFT = 1.05;          // a crest lifts the car past this many g
const FLOOR = -80;          // below this the car is lost (the river is at 0)

export class Driver {
  /**
   * @param world { layout, surface, solids }
   * @param spec  vehicle overrides (see vehicle.js)
   */
  constructor(world, spec = {}) {
    this.layout = world.layout;
    this.surface = world.surface;
    this.solids = world.solids;
    this.vehicle = new Vehicle(spec);
    this.y = 0;
    this.vy = 0;
    this.grounded = true;
    this.air = 0;
    this.slope = 0;
    this.pitch = 0;
    this.roll = 0;
    this.kind = 'land';
    this.road = null;
    this.s = 0;
    this.impact = 0;          // strongest wall hit since the frame loop last read it
    this.landing = 0;         // same, for touchdowns (m/s downwards)
    this.wet = 0;             // seconds spent in the water
    this.lost = false;        // true when the car needs putting back
    this._in = { throttle: 0, brake: 0, steer: 0, handbrake: false, airborne: false };
    this._c = { x: 0, n: 0, vx: 0, vn: 0, yawRate: 0 };
  }

  get x() { return this.vehicle.x; }
  get n() { return this.vehicle.n; }
  get heading() { return this.vehicle.yaw; }
  get speed() { return this.vehicle.speed; }
  get kmh() { return this.vehicle.speedKmh; }
  get airborne() { return !this.grounded; }

  /**
   * Put the car at (x, n) facing `heading` (radians, compass), on the highest
   * surface at or just above `y` — or the top surface when y is not given.
   */
  place(x, n, heading, y) {
    let g = y === undefined ? this.surface.at(x, n, 400, 0) : this.surface.at(x, n, y, 1.5);
    if (!Number.isFinite(g.y)) g = this.surface.at(x, n, 400, 0);
    this.vehicle.reset(x, n, heading);
    this.y = Number.isFinite(g.y) ? g.y : 0;
    this.vy = 0;
    this.grounded = true;
    this.air = 0;
    this.slope = 0;
    this.pitch = 0;
    this.roll = 0;
    this.kind = g.kind;
    this.road = g.road;
    this.s = g.s;
    this.wet = 0;
    this.lost = false;
  }

  /** Back on the nearest road or street, at the car's level, same direction. */
  respawn() {
    const p = nearestDrivable(this.layout, this.x, this.n, this.y, this.heading, true);
    if (p) this.place(p.x, p.n, p.heading, p.y);
  }

  /** Teleport near a point picked on the map. */
  teleport(x, n) {
    const p = nearestDrivable(this.layout, x, n, null, this.heading, false);
    if (p) this.place(p.x, p.n, p.heading, p.y);
  }

  /** One fixed physics step. */
  step(dt, input) {
    const v = this.vehicle;
    const I = this._in;
    I.throttle = input.throttle;
    I.brake = input.brake;
    I.steer = input.steer;
    I.handbrake = input.handbrake;
    I.airborne = this.air > GRIP_DELAY;
    v.step(dt, I);
    // Gravity along the slope: a car coasts down the mountain, and needs
    // throttle to climb out of the trench. Faded out near a standstill, where
    // a real car sits on its brakes instead of creeping backwards.
    if (this.grounded) v.u -= Math.sin(this.slope) * G * dt * Math.min(1, Math.abs(v.u) / 1.5);

    // Walls, barriers, pillars and buildings, at the car's own height.
    const c = this._c;
    c.x = v.x; c.n = v.n; c.vx = v.vx; c.vn = v.vn; c.yawRate = v.yawRate;
    const hit = resolveCollisions(this.solids, c, v.yaw, this.y);
    if (c.x !== v.x || c.n !== v.n) {
      v.x = c.x;
      v.n = c.n;
      v.setWorldVelocity(c.vx, c.vn);
      v.yawRate = c.yawRate;
      if (hit > this.impact) this.impact = hit;
      v.lastImpact = hit;
    }

    this._vertical(dt);
    this._attitude(dt);

    if (this.kind === 'water') this.wet += dt; else this.wet = 0;
    if (this.y < FLOOR || this.wet > 0.6) this.lost = true;
  }

  _vertical(dt) {
    const v = this.vehicle, S = this.surface;
    if (this.grounded) {
      const g = S.at(v.x, v.n, this.y, CLIMB);
      // The ground fell away by more than the suspension takes: a drop.
      if (!Number.isFinite(g.y) || g.y < this.y - KERB) { this._takeOff(dt, true); return; }
      const sameRoad = g.kind === 'road' && g.road === this.road;
      this._stand(g);
      const vy = this._groundRate(g);
      // A crest taken faster than gravity can hold the car down.
      if (sameRoad && (vy - this.vy) / dt < -LIFT * G) { this._takeOff(dt, false); return; }
      this.vy = vy;
    } else {
      this.air += dt;
      this.vy -= G * dt;
      const y1 = this.y + this.vy * dt;
      // Anything between where the car was and where it is now catches it.
      const top = Math.max(this.y, y1) + 0.05;
      const g = S.at(v.x, v.n, y1, top - y1);
      if (Number.isFinite(g.y) && g.y >= y1) {
        this._stand(g);
        const vy = this._groundRate(g);
        this.landing = Math.max(this.landing, vy - this.vy);
        this.vy = vy;
        this.grounded = true;
      } else {
        this.y = y1;
      }
    }
  }

  _stand(g) {
    this.y = g.y;
    this.kind = g.kind;
    this.road = g.road;
    this.s = g.s;
    this.air = 0;
    this._g = g;
  }

  /**
   * Vertical speed of the ground under the car, and the slope along its
   * heading (for gravity and for the body's pitch). On a road both come from
   * the road's profile, which is smooth by construction; elsewhere from two
   * probes, nose and tail.
   */
  _groundRate(g) {
    const v = this.vehicle;
    const fx = Math.sin(v.yaw), fn = Math.cos(v.yaw);
    if (g.kind === 'road') {
      const r = g.road, p = r.samples[g.i];
      const grade = roadGrade(r, g.i, g.t);
      this.slope = Math.atan(grade * (fx * p.tx + fn * p.tn));
      return grade * (v.vx * p.tx + v.vn * p.tn);
    }
    if (g.kind === 'terrain') {
      const a = this.surface.at(v.x + fx * PROBE, v.n + fn * PROBE, this.y + 0.4, CLIMB);
      const b = this.surface.at(v.x - fx * PROBE, v.n - fn * PROBE, this.y + 0.4, CLIMB);
      const ya = Number.isFinite(a.y) && Math.abs(a.y - this.y) < 1.2 ? a.y : this.y;
      const yb = Number.isFinite(b.y) && Math.abs(b.y - this.y) < 1.2 ? b.y : this.y;
      this.slope = Math.atan2(ya - yb, PROBE * 2);
      return v.u * Math.tan(this.slope);
    }
    this.slope = 0;
    return 0;
  }

  /** Leave the ground with the vertical speed the car already has. */
  _takeOff(dt, integrate) {
    this.grounded = false;
    if (integrate) {
      this.vy -= G * dt;
      this.y += this.vy * dt;
    }
    this.air = dt;
    this.kind = 'air';
    this.road = null;
  }

  /** The body's pitch and roll for the renderer. */
  _attitude(dt) {
    const v = this.vehicle;
    // In the air the nose drops slowly, the way a car leaves a ramp.
    if (!this.grounded) this.slope += (-0.12 - this.slope) * Math.min(1, dt * 0.9);
    this.pitch += (this.slope - this.pitch) * Math.min(1, dt * 12);
    // Real lateral acceleration (the tyre force), not the body-frame
    // derivative: the body leans out of the turn.
    const ay = v.accelLat + v.u * v.yawRate;
    const targetRoll = Math.max(-1, Math.min(1, ay / G)) * 0.06;
    this.roll += (targetRoll - this.roll) * Math.min(1, dt * 7);
  }

  /** Name of what is under the car, for the HUD: { name, ref, kind }. */
  where() {
    if (this.road) {
      const r = this.road;
      const i = Math.max(0, Math.min(r.samples.length - 1, Math.round(this.s / 2)));
      const st = stretchAt(r, sampleIndex(r, this.s, i));
      return { name: st.name, ref: st.ref || r.ref || null, kind: r.cls };
    }
    if (this.y < -1) return null;
    // At a crossing two streets claim the car: the one it drives along wins.
    const fx = Math.sin(this.heading), fn = Math.cos(this.heading);
    let best = null, bestDot = -1;
    for (const st of this.layout.streetsAt(this.x, this.n, 1, [])) {
      if (st.cls === 'apron') continue;
      const P = st.path;
      let dot = 0, bd = Infinity;
      for (let i = 0; i + 1 < P.length; i++) {
        const { d2 } = segDist2(this.x, this.n, P[i][0], P[i][1], P[i + 1][0], P[i + 1][1]);
        if (d2 >= bd) continue;
        bd = d2;
        const L = Math.hypot(P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1]) || 1;
        dot = Math.abs(((P[i + 1][0] - P[i][0]) * fx + (P[i + 1][1] - P[i][1]) * fn) / L);
      }
      if (dot > bestDot) { bestDot = dot; best = st; }
    }
    return best ? { name: best.name, ref: null, kind: 'street' } : null;
  }

  /** The district under the car, or the mountain. */
  zone() { return zoneAt(this.layout, this.x, this.n); }
}

/**
 * The neighbourhood's name at a point: the nearest named place, a
 * neighbourhood winning over the borough around it when both are close.
 */
export function zoneAt(L, x, n) {
  let best = null, bd = Infinity;
  for (const q of L.quartiers || []) {
    const w = q.type === 'macrohood' || q.type === 'locality' ? 2.5 : 1;
    const d = Math.hypot(q.x - x, q.n - n) * w;
    if (d < bd) { bd = d; best = q; }
  }
  return best ? best.nom : null;
}

/**
 * A road's grade at segment i, fraction t: central differences at the
 * samples, interpolated, cached on the road.
 */
function roadGrade(r, i, t) {
  let G2 = r._grades;
  if (!G2) {
    const S = r.samples;
    G2 = r._grades = new Float32Array(S.length);
    for (let k = 0; k < S.length; k++) {
      const a = S[Math.max(0, k - 1)], b = S[Math.min(S.length - 1, k + 1)];
      G2[k] = b.s > a.s ? (b.y - a.y) / (b.s - a.s) : 0;
    }
  }
  const j = Math.min(i + 1, G2.length - 1);
  return G2[i] + (G2[j] - G2[i]) * t;
}

/** Sample index nearest to arc length s (samples are ~2 m apart). */
function sampleIndex(road, s, guess) {
  const S = road.samples;
  let i = guess;
  while (i > 0 && S[i].s > s) i--;
  while (i + 1 < S.length && S[i + 1].s <= s) i++;
  return i;
}

/**
 * The nearest point a car can be put on: a road ribbon or a street, with the
 * heading along it closest to `heading`, in the right-hand lane.
 * With `y` given, surfaces far from that level cost more: R in the tunnel puts
 * you back in the tunnel, not on the street above it.
 */
export function nearestDrivable(layout, x, n, y, heading, keepLevel) {
  let best = null;
  const consider = (cand, score) => { if (!best || score < best.score) best = { ...cand, score }; };
  for (const r of layout.roads) {
    const hit = projectOnRoad(r, x, n);
    if (!hit) continue;
    const a = r.samples[hit.i];
    const level = y === null || y === undefined ? 0 : Math.abs(hit.y - y) * (keepLevel ? 4 : 0.2);
    consider({ road: r, x: a.x + (r.samples[hit.i + 1].x - a.x) * hit.t, n: a.n + (r.samples[hit.i + 1].n - a.n) * hit.t,
      y: hit.y, tx: a.tx, tn: a.tn, width: r.width }, hit.d + level - (keepLevel ? 0 : 6));
  }
  for (const st of layout.streets) {
    if (st.cls === 'apron' || st.cls === 'plaza') continue;
    const P = st.path;
    for (let i = 0; i + 1 < P.length; i++) {
      const A = P[i], B = P[i + 1];
      if (Math.min(A[0], B[0]) - 300 > x || Math.max(A[0], B[0]) + 300 < x) continue;
      if (Math.min(A[1], B[1]) - 300 > n || Math.max(A[1], B[1]) + 300 < n) continue;
      const { d2, t } = segDist2(x, n, A[0], A[1], B[0], B[1]);
      const px = A[0] + (B[0] - A[0]) * t, pn = A[1] + (B[1] - A[1]) * t;
      const L = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1;
      const gy = layout.terrain.inside(px, pn) ? layout.terrain.height(px, pn) : 0;
      const level = y === null || y === undefined ? 0 : Math.abs(gy - y) * (keepLevel ? 4 : 0.2);
      consider({ road: null, x: px, n: pn, y: gy, tx: (B[0] - A[0]) / L, tn: (B[1] - A[1]) / L, width: st.width },
        Math.sqrt(d2) + level);
    }
  }
  if (!best) return null;
  // Along the road, the way the car was already going.
  let tx = best.tx, tn = best.tn;
  if (tx * Math.sin(heading) + tn * Math.cos(heading) < 0) { tx = -tx; tn = -tn; }
  // Right-hand lane: a quarter of the width to the right of travel.
  const off = best.width >= 12 ? best.width / 4 : 0;
  return { x: best.x + tn * off, n: best.n - tx * off, y: best.y, heading: Math.atan2(tx, tn), road: best.road };
}
