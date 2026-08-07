// Keyboard, gamepad and touch, funnelled into one analogue control state.
//
// Steering is smoothed towards the target rather than snapping, so a keyboard
// still gives a usable analogue-ish feel. Gamepad axes bypass the smoothing
// because the stick is already analogue.

const KEY_BINDINGS = {
  throttle: ['KeyW', 'ArrowUp'],
  brake: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  handbrake: ['Space'],
  reset: ['KeyR'],
  camera: ['KeyC'],
  horn: ['KeyH'],
  lights: ['KeyL'],
};

export class Input {
  constructor(target = window) {
    this.keys = new Set();
    this.pressed = new Set();      // edge-triggered, cleared each frame
    this.throttle = 0;
    this.brake = 0;
    this.steer = 0;
    this.handbrake = false;
    this.touchActive = false;
    this.enabled = true;
    this._touch = { throttle: 0, brake: 0, steer: 0, handbrake: false };
    this._gamepadIndex = null;

    this._onKeyDown = (e) => {
      if (!this.enabled) return;
      if (e.target instanceof HTMLElement) {
        const tag = e.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      }
      if (!this.keys.has(e.code)) this.pressed.add(e.code);
      this.keys.add(e.code);
      if (SWALLOW.has(e.code)) e.preventDefault();
    };
    this._onKeyUp = (e) => { this.keys.delete(e.code); };
    this._onBlur = () => { this.keys.clear(); };

    target.addEventListener('keydown', this._onKeyDown);
    target.addEventListener('keyup', this._onKeyUp);
    target.addEventListener('blur', this._onBlur);
    window.addEventListener('gamepadconnected', (e) => { this._gamepadIndex = e.gamepad.index; });
    window.addEventListener('gamepaddisconnected', () => { this._gamepadIndex = null; });
  }

  /** True once, on the frame a key went down. */
  justPressed(action) {
    const codes = KEY_BINDINGS[action] || [action];
    return codes.some((c) => this.pressed.has(c));
  }

  held(action) {
    const codes = KEY_BINDINGS[action] || [action];
    return codes.some((c) => this.keys.has(c));
  }

  /** Feed touch controls from the on-screen pads. */
  setTouch(state) {
    Object.assign(this._touch, state);
    this.touchActive = true;
  }

  clearTouch() {
    this._touch.throttle = 0;
    this._touch.brake = 0;
    this._touch.steer = 0;
    this._touch.handbrake = false;
  }

  /** Call once per rendered frame, before the physics steps. */
  sample(dt) {
    let throttle = this.held('throttle') ? 1 : 0;
    let brake = this.held('brake') ? 1 : 0;
    let handbrake = this.held('handbrake');
    let steerTarget = (this.held('right') ? 1 : 0) - (this.held('left') ? 1 : 0);
    let analogueSteer = null;

    const pad = this._readGamepad();
    if (pad) {
      throttle = Math.max(throttle, pad.throttle);
      brake = Math.max(brake, pad.brake);
      handbrake = handbrake || pad.handbrake;
      if (Math.abs(pad.steer) > 0.02) analogueSteer = pad.steer;
    }

    if (this._touch.throttle || this._touch.brake || this._touch.steer || this._touch.handbrake) {
      throttle = Math.max(throttle, this._touch.throttle);
      brake = Math.max(brake, this._touch.brake);
      handbrake = handbrake || this._touch.handbrake;
      if (Math.abs(this._touch.steer) > 0.02) analogueSteer = this._touch.steer;
    }

    this.throttle = throttle;
    this.brake = brake;
    this.handbrake = handbrake;

    if (analogueSteer !== null) {
      this.steer = analogueSteer;
    } else {
      // Digital input: ease in, snap back quickly when released.
      const rate = steerTarget === 0 ? 7.0 : 3.6;
      const d = steerTarget - this.steer;
      const step = rate * dt;
      this.steer += Math.abs(d) <= step ? d : Math.sign(d) * step;
    }
    this.steer = Math.max(-1, Math.min(1, this.steer));
  }

  /** Clear edge-triggered state. Call at the very end of the frame. */
  endFrame() {
    this.pressed.clear();
  }

  _readGamepad() {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
    const pads = navigator.getGamepads();
    if (!pads) return null;
    let pad = this._gamepadIndex != null ? pads[this._gamepadIndex] : null;
    if (!pad) pad = Array.prototype.find.call(pads, (p) => p && p.connected);
    if (!pad) return null;

    const dead = (v) => (Math.abs(v) < 0.12 ? 0 : v);
    const btn = (i) => (pad.buttons[i] ? pad.buttons[i].value : 0);
    return {
      steer: dead(pad.axes[0] || 0),
      throttle: Math.max(btn(7), btn(0)),
      brake: Math.max(btn(6), btn(2)),
      handbrake: btn(1) > 0.5 || btn(5) > 0.5,
    };
  }
}

// Keys we stop the browser from acting on (scrolling, quick-find, …).
const SWALLOW = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space',
]);

export { KEY_BINDINGS };
