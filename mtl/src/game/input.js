// Keyboard, gamepad and touch, funnelled into one control state.
//
// Analogue values (throttle, brake, steer) are read by the physics step, and
// the keyboard's steering is smoothed there too, at the fixed rate: how fast
// the wheel turns must not depend on the framerate. Everything else is an
// action, edge-triggered and consumed once by the frame loop.

const KEYS = {
  throttle: ['KeyW', 'ArrowUp'],
  brake: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  handbrake: ['Space'],
};

const ACTIONS = {
  KeyR: 'reset', KeyC: 'camera', KeyM: 'map', KeyN: 'night', KeyF: 'fly', KeyE: 'export',
  KeyH: 'help', Escape: 'close',
};

// Standard gamepad mapping: A handbrake, X reset, Y camera, Start map.
const PAD_ACTIONS = { 2: 'reset', 3: 'camera', 9: 'map', 8: 'night' };
const DEADZONE = 0.12;

export class Input {
  constructor(target = window) {
    this.keys = new Set();
    this.pressed = [];
    this.throttle = 0;
    this.brake = 0;
    this.steer = 0;
    this.handbrake = false;
    this.enabled = true;
    this.touch = { throttle: 0, brake: 0, steer: 0, handbrake: false, active: false };
    this.pad = { throttle: 0, brake: 0, steer: 0, handbrake: false, active: false };
    this._padPrev = [];
    this.onGesture = null;          // first user gesture: audio may start

    target.addEventListener('keydown', (e) => {
      if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      this._gesture();
      const action = ACTIONS[e.code];
      if (action && !e.repeat) this.pressed.push(action);
      if (isDriving(e.code)) e.preventDefault();
      this.keys.add(e.code);
    });
    target.addEventListener('keyup', (e) => this.keys.delete(e.code));
    target.addEventListener('blur', () => this.keys.clear());
    target.addEventListener('pointerdown', () => this._gesture());
  }

  _gesture() {
    if (this.onGesture) { const f = this.onGesture; this.onGesture = null; f(); }
  }

  /** Actions pressed since the last call, oldest first. */
  consume() {
    const out = this.pressed;
    this.pressed = [];
    return out;
  }

  held(name) {
    for (const code of KEYS[name]) if (this.keys.has(code)) return true;
    return false;
  }

  /** Once per frame: poll the gamepad (the browser has no events for axes). */
  poll() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = [...pads].find((p) => p && p.connected);
    const P = this.pad;
    if (!gp) { P.active = false; return; }
    const ax = gp.axes[0] || 0;
    const steer = Math.abs(ax) < DEADZONE ? 0 : (ax - Math.sign(ax) * DEADZONE) / (1 - DEADZONE);
    const b = (i) => gp.buttons[i] || { pressed: false, value: 0 };
    P.steer = steer;
    P.throttle = Math.max(b(7).value, b(7).pressed ? 1 : 0);
    P.brake = Math.max(b(6).value, b(6).pressed ? 1 : 0);
    P.handbrake = b(0).pressed || b(1).pressed;
    P.active = P.active || Math.abs(steer) > 0 || P.throttle > 0.05 || P.brake > 0.05;
    gp.buttons.forEach((btn, i) => {
      if (btn.pressed && !this._padPrev[i]) {
        this._gesture();
        if (PAD_ACTIONS[i]) this.pressed.push(PAD_ACTIONS[i]);
      }
      this._padPrev[i] = btn.pressed;
    });
  }

  /** One physics step: merge the sources, smooth the keyboard's steering. */
  step(dt) {
    if (!this.enabled) {
      this.throttle = 0; this.brake = 0; this.handbrake = false;
      this.steer += (0 - this.steer) * Math.min(1, dt * 8);
      return;
    }
    const T = this.touch, P = this.pad;
    const kThrottle = this.held('throttle') ? 1 : 0;
    const kBrake = this.held('brake') ? 1 : 0;
    this.throttle = Math.max(kThrottle, T.throttle, P.throttle);
    this.brake = Math.max(kBrake, T.brake, P.brake);
    this.handbrake = this.held('handbrake') || T.handbrake || P.handbrake;

    const kSteer = (this.held('right') ? 1 : 0) - (this.held('left') ? 1 : 0);
    if (P.active && Math.abs(P.steer) > 0) {
      this.steer = P.steer;
    } else if (T.active && T.steer !== 0) {
      this.steer = T.steer;
    } else {
      // Towards the key quickly, back to centre quicker: a tap is a small
      // correction, not a full lock.
      const rate = kSteer === 0 ? 7 : Math.sign(kSteer) !== Math.sign(this.steer) ? 9 : 4.2;
      const d = kSteer - this.steer;
      this.steer += Math.sign(d) * Math.min(Math.abs(d), rate * dt);
    }
  }

  /** Wire the on-screen stick, pedals and buttons. */
  bindTouch(root) {
    const T = this.touch;
    const stick = root.querySelector('#stick'), knob = root.querySelector('#knob');
    let stickId = null, cx = 0;
    const R = 50;
    const moveKnob = (dx) => { knob.style.transform = `translateX(${dx}px)`; };
    stick.addEventListener('pointerdown', (e) => {
      stickId = e.pointerId;
      const r = stick.getBoundingClientRect();
      cx = r.left + r.width / 2;
      stick.setPointerCapture(e.pointerId);
      T.active = true;
      const dx = Math.max(-R, Math.min(R, e.clientX - cx));
      T.steer = dx / R;
      moveKnob(dx);
    });
    stick.addEventListener('pointermove', (e) => {
      if (e.pointerId !== stickId) return;
      const dx = Math.max(-R, Math.min(R, e.clientX - cx));
      T.steer = dx / R;
      moveKnob(dx);
    });
    const release = (e) => {
      if (e.pointerId !== stickId) return;
      stickId = null;
      T.steer = 0;
      moveKnob(0);
    };
    stick.addEventListener('pointerup', release);
    stick.addEventListener('pointercancel', release);

    const pedal = (id, key) => {
      const el = root.querySelector(id);
      if (!el) return;
      const on = (v) => (e) => {
        e.preventDefault();
        T.active = true;
        if (key === 'handbrake') T.handbrake = v; else T[key] = v ? 1 : 0;
        el.classList.toggle('on', v);
      };
      el.addEventListener('pointerdown', on(true));
      el.addEventListener('pointerup', on(false));
      el.addEventListener('pointerleave', on(false));
      el.addEventListener('pointercancel', on(false));
    };
    pedal('#gas', 'throttle');
    pedal('#brake', 'brake');
    pedal('#handbrake', 'handbrake');
    for (const el of root.querySelectorAll('[data-action]')) {
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        this.pressed.push(el.dataset.action);
      });
    }
  }
}

function isDriving(code) {
  for (const list of Object.values(KEYS)) if (list.includes(code)) return true;
  return false;
}

/** A touch screen with no fine pointer: show the on-screen controls. */
export function wantsTouch() {
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  return coarse && (navigator.maxTouchPoints || 0) > 0;
}
