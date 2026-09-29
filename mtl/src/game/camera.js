// Chase camera. Ruelle's spring behind the car, plus the two things a city in
// three levels needs: it never goes through a wall (a ray against the same
// solids the car hits), and it never goes through a ceiling — in the tunnel
// and under a street crossing the trench, it drops under the slab.

import { rayClearance } from '../map/collide.js';
import { ceilingY } from '../map/structures.js';

const MODES = {
  chase: { back: 7.4, up: 3.0, look: 1.35, ahead: 7 },
  far: { back: 11.5, up: 4.6, look: 1.2, ahead: 9 },
  hood: null,
};
export const CAMERA_MODES = Object.keys(MODES);

// Right-drag orbit: how far the camera may tilt above or below its resting
// elevation (never under the road, never straight overhead), and how quickly
// it swings back behind the car once the button is released.
const ORBIT_ELEV_MIN = 0.06;     // rad above the car's look point
const ORBIT_ELEV_MAX = 1.35;     // ~77°: high, but never vertical
const ORBIT_RETURN = 2.6;        // 1/s, exponential

export class ChaseCamera {
  /**
   * @param camera three.js PerspectiveCamera
   * @param world  { layout, surface, solids, structures }
   */
  constructor(camera, world) {
    this.camera = camera;
    this.world = world;
    this.mode = 'chase';
    this.pos = { x: 0, n: 0, y: 0 };
    this.fov = 60;
    this._tmp = [];
    this.orbit = { yaw: 0, pitch: 0, held: false };
  }

  /** Right button pressed (true) or released (false). */
  orbitHold(held) {
    const o = this.orbit;
    if (!held) o.yaw = Math.atan2(Math.sin(o.yaw), Math.cos(o.yaw));   // return the short way
    o.held = held;
  }

  /** Right-drag by (yaw, pitch) radians: positive yaw swings the view right, positive pitch raises the camera. */
  orbitBy(yaw, pitch) {
    const o = this.orbit;
    o.yaw += yaw;
    o.pitch = Math.max(-1.2, Math.min(1.2, o.pitch + pitch));
  }

  cycle() {
    const i = CAMERA_MODES.indexOf(this.mode);
    this.mode = CAMERA_MODES[(i + 1) % CAMERA_MODES.length];
  }

  /** Jump behind the car without easing (after a spawn or a teleport). */
  snap(pose) {
    this.orbit.yaw = this.orbit.pitch = 0;
    const m = MODES[this.mode] || MODES.chase;
    this.pos.x = pose.x - Math.sin(pose.heading) * m.back;
    this.pos.n = pose.n - Math.cos(pose.heading) * m.back;
    this.pos.y = pose.y + m.up;
  }

  /**
   * @param dt    render delta (the camera is presentation, not physics)
   * @param pose  { x, n, y, heading, speed, slide } interpolated car pose
   */
  update(dt, pose) {
    const cam = this.camera;
    const speedT = Math.min(1, pose.speed / 45);
    const fx = Math.sin(pose.heading), fn = Math.cos(pose.heading);
    const m = MODES[this.mode];

    if (!m) {
      // Bonnet camera: rigid, just above the windscreen base.
      const ceil = this.ceilingAt(pose.x, pose.n, pose.y);
      const y = Math.min(pose.y + 1.25, ceil - 0.2);
      cam.position.set(pose.x + fx * 0.6, y, -(pose.n + fn * 0.6));
      cam.lookAt(pose.x + fx * 30, y - 0.25 + Math.sin(pose.pitch || 0) * 30, -(pose.n + fn * 30));
      this._fov(dt, 68 + speedT * 10);
      return;
    }

    // The orbit relaxes back to zero once the button is up. It is presentation,
    // so it runs on the render delta like the rest of the camera.
    const o = this.orbit;
    if (!o.held) {
      const r = Math.exp(-ORBIT_RETURN * dt);
      o.yaw *= r;
      o.pitch *= r;
      if (Math.abs(o.yaw) < 1e-3 && Math.abs(o.pitch) < 1e-3) { o.yaw = 0; o.pitch = 0; }
    }
    // 0 at rest, 1 well away from it: fades the look-ahead and the slide bias
    // out so an orbit looks at the car itself.
    const away = Math.min(1, Math.hypot(o.yaw, o.pitch) / 0.35);

    // A spring behind the car, pulled back with speed, biased outward in a
    // slide so a drift stays readable. The rest position is a point on a
    // sphere around the car's look point; the orbit only turns and tilts it.
    const back = m.back + speedT * 2.6;
    const up = m.up + speedT * 0.5;
    const rx = fn, rn = -fx;
    const slide = Math.max(-1, Math.min(1, (pose.slide || 0) / 9)) * (1 - away);
    const rise = up - m.look;
    const radius = Math.hypot(back, rise);
    const elev = Math.max(ORBIT_ELEV_MIN, Math.min(ORBIT_ELEV_MAX, Math.atan2(rise, back) + o.pitch));
    const flat = radius * Math.cos(elev);
    const ha = pose.heading + o.yaw;
    const tx = pose.x - Math.sin(ha) * flat + rx * slide * 1.9;
    const tn = pose.n - Math.cos(ha) * flat + rn * slide * 1.9;
    const ty = pose.y + m.look + radius * Math.sin(elev);
    const k = 1 - Math.pow(0.0016, dt);
    this.pos.x += (tx - this.pos.x) * k;
    this.pos.n += (tn - this.pos.n) * k;
    this.pos.y += (ty - this.pos.y) * (1 - Math.pow(0.004, dt));

    let cx = this.pos.x, cn = this.pos.n;
    // Pull in to the last clear point before any wall between car and camera.
    const t = rayClearance(this.world.solids, pose.x, pose.n, cx, cn, pose.y + 1.2);
    if (t < 1) {
      cx = pose.x + (cx - pose.x) * t;
      cn = pose.n + (cn - pose.n) * t;
    }
    // Above the ground under the camera, below any ceiling over it.
    const g = this.world.surface.at(cx, cn, pose.y + 2, 1.5);
    let cy = Math.max(this.pos.y, (Number.isFinite(g.y) ? g.y : pose.y) + 1.2);
    const ceil = Math.min(this.ceilingAt(cx, cn, pose.y), this.ceilingAt(pose.x, pose.n, pose.y));
    if (cy > ceil - 0.5) cy = Math.max(pose.y + 1.1, ceil - 0.5);
    cam.position.set(cx, cy, -cn);
    const ly = pose.y + m.look;
    const ahead = m.ahead * (1 - away);
    cam.lookAt(pose.x + fx * ahead, Math.min(ly, ceil - 0.8), -(pose.n + fn * ahead));
    this._fov(dt, 60 + speedT * 12);
  }

  /**
   * Lowest ceiling over (x, n) for a car at height y: a covered road sample
   * near that level (tunnel, or a street deck over the trench). Infinity when
   * open to the sky.
   */
  ceilingAt(x, n, y) {
    let ceil = Infinity;
    for (const s of this.world.structures.index.surfacesAt(x, n, 3, this._tmp)) {
      if (!s.covered || Math.abs(s.y - y) > 2.5) continue;
      ceil = Math.min(ceil, ceilingY(s));
    }
    return ceil;
  }

  _fov(dt, target) {
    this.fov += (target - this.fov) * Math.min(1, dt * 3);
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }
}
