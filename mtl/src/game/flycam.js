// Free flight: leave the car and fly over the map, to check it or to see it
// whole from outside. Not a physics object — a camera with a keyboard, a mouse
// and a gamepad on it, that only refuses to go under the ground.
//
// Speed follows altitude, the way map viewers do it: slow among the streets,
// fast over the city, so one set of keys works from 3 m to 3 km.

const KEYS = {
  fwd: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  up: ['Space'],
  down: ['ShiftLeft', 'ShiftRight'],
};

const PITCH_MIN = -Math.PI / 2 + 0.01;
const PITCH_MAX = Math.PI / 2 - 0.05;
const H_MAX = 4000;

/** Above the whole map, from the south: the island, the river and the islands at once. */
export const OVERVIEW = { x: 380, n: -3700, h: 2700, tx: 380, tn: 150, th: 0 };

export class FlyCamera {
  /**
   * @param camera three.js PerspectiveCamera
   * @param dom    the canvas: drags on it turn the view
   * @param game   { surface } to stay above the ground
   */
  constructor(camera, dom, game) {
    this.camera = camera;
    this.game = game;
    this.enabled = false;
    this.x = 0; this.n = 0; this.h = 100;
    this.yaw = 0;                // clockwise from Montréal north, like the car
    this.pitch = -0.5;           // negative: looking down
    this.vel = { x: 0, n: 0, h: 0 };
    this.anim = null;            // a glide to a pose (overview, map click)
    this.touch = { fwd: 0, turn: 0, up: 0 };
    this._drag = null;

    dom.addEventListener('pointerdown', (e) => {
      if (!this.enabled) return;
      this._drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
      dom.setPointerCapture(e.pointerId);
    });
    dom.addEventListener('pointermove', (e) => {
      const d = this._drag;
      if (!this.enabled || !d || d.id !== e.pointerId) return;
      const k = 0.0042;
      this.yaw += (e.clientX - d.x) * k;
      this.pitch = clamp(this.pitch - (e.clientY - d.y) * k, PITCH_MIN, PITCH_MAX);
      d.x = e.clientX; d.y = e.clientY;
      this.anim = null;
    });
    const end = (e) => { if (this._drag && this._drag.id === e.pointerId) this._drag = null; };
    dom.addEventListener('pointerup', end);
    dom.addEventListener('pointercancel', end);
    dom.addEventListener('wheel', (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      // Along the view: towards what is under the cursor's line of sight.
      const step = -Math.sign(e.deltaY) * Math.max(4, this.h * 0.18);
      const [fx, fn, fh] = this.forward();
      this.x += fx * step; this.n += fn * step; this.h += fh * step;
      this.anim = null;
    }, { passive: false });
  }

  /** Take over from wherever the camera is now. */
  enter() {
    const c = this.camera;
    this.x = c.position.x; this.n = -c.position.z; this.h = c.position.y;
    const d = c.getWorldDirection(c.position.clone());
    this.yaw = Math.atan2(d.x, -d.z);
    this.pitch = clamp(Math.asin(clamp(d.y, -1, 1)), PITCH_MIN, PITCH_MAX);
    this.vel.x = this.vel.n = this.vel.h = 0;
    this.anim = null;
    this._drag = null;
  }

  /** Point the camera from (x, n, h) at (tx, tn, th); glide there when `glide`. */
  lookAt(x, n, h, tx, tn, th, glide = false) {
    const dx = tx - x, dn = tn - n, dh = th - h;
    const yaw = Math.atan2(dx, dn);
    const pitch = clamp(Math.atan2(dh, Math.hypot(dx, dn)), PITCH_MIN, PITCH_MAX);
    this.vel.x = this.vel.n = this.vel.h = 0;
    if (glide) {
      this.anim = { from: { x: this.x, n: this.n, h: this.h, yaw: this.yaw, pitch: this.pitch },
        to: { x, n, h, yaw: this.yaw + wrap(yaw - this.yaw), pitch }, t: 0, dur: 1.6 };
    } else {
      Object.assign(this, { x, n, h, yaw, pitch });
      this.anim = null;
    }
    this.apply();
  }

  overview() {
    const o = OVERVIEW;
    this.lookAt(o.x, o.n, o.h, o.tx, o.tn, o.th, true);
  }

  /** Put the point (x, n) in the middle of the view, keeping height and angle. */
  centreOn(x, n) {
    const h = Math.max(this.h, 150);
    const pitch = Math.min(this.pitch, -0.35);
    const back = h / Math.tan(-pitch);
    const fx = Math.sin(this.yaw), fn = Math.cos(this.yaw);
    this.vel.x = this.vel.n = this.vel.h = 0;
    this.anim = { from: { x: this.x, n: this.n, h: this.h, yaw: this.yaw, pitch: this.pitch },
      to: { x: x - fx * back, n: n - fn * back, h, yaw: this.yaw, pitch }, t: 0, dur: 1.2 };
  }

  forward() {
    const cp = Math.cos(this.pitch);
    return [Math.sin(this.yaw) * cp, Math.cos(this.yaw) * cp, Math.sin(this.pitch)];
  }

  /** Where the line of sight meets the street plane, or null above the horizon. */
  target() {
    const [fx, fn, fh] = this.forward();
    if (fh > -0.02) return null;
    const t = this.h / -fh;
    return { x: this.x + fx * t, n: this.n + fn * t };
  }

  /**
   * @param dt    render delta: the camera is presentation, not physics
   * @param keys  the set of held key codes (Input.keys)
   */
  update(dt, keys) {
    if (this.anim) {
      const a = this.anim;
      a.t = Math.min(1, a.t + dt / a.dur);
      const e = a.t * a.t * (3 - 2 * a.t);
      for (const k of ['x', 'n', 'h', 'yaw', 'pitch']) this[k] = a.from[k] + (a.to[k] - a.from[k]) * e;
      if (a.t >= 1) this.anim = null;
    }

    const held = (name) => KEYS[name].some((c) => keys.has(c));
    const pad = readPad();
    const T = this.touch;
    let f = (held('fwd') ? 1 : 0) - (held('back') ? 1 : 0) + T.fwd + pad.fwd;
    let s = (held('right') ? 1 : 0) - (held('left') ? 1 : 0) + pad.side;
    let u = (held('up') ? 1 : 0) - (held('down') ? 1 : 0) + T.up + pad.up;
    this.yaw += (T.turn * 1.4 + pad.yaw * 2) * dt;
    this.pitch = clamp(this.pitch + pad.pitch * 1.4 * dt, PITCH_MIN, PITCH_MAX);
    f = clamp(f, -1, 1); s = clamp(s, -1, 1); u = clamp(u, -1, 1);
    if (f || s || u) this.anim = null;

    // Horizontal moves ignore the pitch: looking down and pressing forward
    // skims over the city instead of diving into it.
    const speed = clamp(10 + Math.max(0, this.h) * 0.9, 10, 1400);
    const fx = Math.sin(this.yaw), fn = Math.cos(this.yaw);
    const want = { x: (fx * f + fn * s) * speed, n: (fn * f - fx * s) * speed, h: u * speed * 0.7 };
    const k = Math.min(1, dt * 9);
    for (const c of ['x', 'n', 'h']) this.vel[c] += (want[c] - this.vel[c]) * k;
    this.x += this.vel.x * dt;
    this.n += this.vel.n * dt;
    this.h += this.vel.h * dt;

    const floor = this.ground(this.x, this.n) + 1.5;
    this.h = clamp(this.h, floor, H_MAX);
    this.apply();
  }

  ground(x, n) {
    const s = this.game.surface;
    if (!s) return 0;
    const y = s.at(x, n, 1e4).y;
    return Number.isFinite(y) ? y : 0;
  }

  apply() {
    const [fx, fn, fh] = this.forward();
    const c = this.camera;
    c.position.set(this.x, this.h, -this.n);
    c.lookAt(this.x + fx * 100, this.h + fh * 100, -(this.n + fn * 100));
    if (c.fov !== 60) { c.fov = 60; c.updateProjectionMatrix(); }
  }
}

const DEADZONE = 0.15;
function axis(v) { return Math.abs(v) < DEADZONE ? 0 : (v - Math.sign(v) * DEADZONE) / (1 - DEADZONE); }

/** Standard mapping: left stick moves, right stick looks, triggers climb. */
function readPad() {
  const out = { fwd: 0, side: 0, up: 0, yaw: 0, pitch: 0 };
  const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
  const gp = [...pads].find((p) => p && p.connected);
  if (!gp) return out;
  const a = gp.axes, b = (i) => (gp.buttons[i] ? gp.buttons[i].value : 0);
  out.side = axis(a[0] || 0);
  out.fwd = -axis(a[1] || 0);
  out.yaw = axis(a[2] || 0);
  out.pitch = -axis(a[3] || 0);
  out.up = b(7) - b(6);
  return out;
}

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function wrap(a) { return Math.atan2(Math.sin(a), Math.cos(a)); }
