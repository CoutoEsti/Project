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
  }

  cycle() {
    const i = CAMERA_MODES.indexOf(this.mode);
    this.mode = CAMERA_MODES[(i + 1) % CAMERA_MODES.length];
  }

  /** Jump behind the car without easing (after a spawn or a teleport). */
  snap(pose) {
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

    // A spring behind the car, pulled back with speed, biased outward in a
    // slide so a drift stays readable.
    const back = m.back + speedT * 2.6;
    const up = m.up + speedT * 0.5;
    const rx = fn, rn = -fx;
    const slide = Math.max(-1, Math.min(1, (pose.slide || 0) / 9));
    const tx = pose.x - fx * back + rx * slide * 1.9;
    const tn = pose.n - fn * back + rn * slide * 1.9;
    const k = 1 - Math.pow(0.0016, dt);
    this.pos.x += (tx - this.pos.x) * k;
    this.pos.n += (tn - this.pos.n) * k;
    this.pos.y += (pose.y + up - this.pos.y) * (1 - Math.pow(0.004, dt));

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
    cam.lookAt(pose.x + fx * m.ahead, Math.min(ly, ceil - 0.8), -(pose.n + fn * m.ahead));
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
