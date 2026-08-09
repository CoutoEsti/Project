// Photo mode.
//
// Worth more than it looks. A driving game gets shown to people through
// screenshots, and a screenshot needs three things this game did not have: a
// camera you can place, an interface that gets out of the way, and a file at
// the end. Forza Horizon's photo mode did more for that series than most of
// its cars did.
//
// The car is frozen rather than paused: the simulation keeps ticking with zero
// input, so nothing in the world state goes stale and leaving photo mode never
// produces a jolt.

import * as THREE from 'three';

const MIN_RADIUS = 3;
const MAX_RADIUS = 90;

export class PhotoMode {
  /**
   * @param {object} opts {root, camera, renderer, scene, onRender}
   */
  constructor(opts) {
    this.root = opts.root;
    this.camera = opts.camera;
    this.renderer = opts.renderer;
    this.scene = opts.scene;
    this.onRender = opts.onRender || (() => {});
    this.onShot = opts.onShot || (() => {});
    this.lastShot = null;

    this.active = false;
    this.yaw = 0.6;
    this.pitch = 0.25;
    this.radius = 12;
    this.target = new THREE.Vector3();
    this.fov = 55;

    this._dragging = false;
    this._lastX = 0;
    this._lastY = 0;
    this._pointers = new Map();
    this._pinch = 0;

    this.el = this.root.querySelector('#photo');
    this.canvas = this.renderer.domElement;
    this._bind();
  }

  _bind() {
    const canvas = this.canvas;

    canvas.addEventListener('pointerdown', (e) => {
      if (!this.active) return;
      this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this._dragging = true;
      this._lastX = e.clientX;
      this._lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    });

    canvas.addEventListener('pointermove', (e) => {
      if (!this.active || !this._dragging) return;
      if (this._pointers.has(e.pointerId)) {
        this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      }
      // Two fingers pinch the distance; one orbits.
      if (this._pointers.size >= 2) {
        const [a, b] = [...this._pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (this._pinch) this.radius *= this._pinch / Math.max(1, d);
        this._pinch = d;
        this.radius = Math.max(MIN_RADIUS, Math.min(MAX_RADIUS, this.radius));
        return;
      }
      this.yaw -= (e.clientX - this._lastX) * 0.006;
      this.pitch = Math.max(-0.25, Math.min(1.35,
        this.pitch + (e.clientY - this._lastY) * 0.005));
      this._lastX = e.clientX;
      this._lastY = e.clientY;
    });

    const release = (e) => {
      this._pointers.delete(e.pointerId);
      if (this._pointers.size < 2) this._pinch = 0;
      if (!this._pointers.size) this._dragging = false;
    };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);

    canvas.addEventListener('wheel', (e) => {
      if (!this.active) return;
      e.preventDefault();
      this.radius = Math.max(MIN_RADIUS, Math.min(MAX_RADIUS,
        this.radius * (1 + Math.sign(e.deltaY) * 0.12)));
    }, { passive: false });

    const shoot = this.root.querySelector('#photo-shoot');
    if (shoot) shoot.addEventListener('click', () => this.capture());
    const close = this.root.querySelector('#photo-close');
    if (close) close.addEventListener('click', () => this.set(false));

    const fovEl = this.root.querySelector('#photo-fov');
    if (fovEl) {
      fovEl.addEventListener('input', () => { this.fov = Number(fovEl.value); });
    }
  }

  toggle(carPosition) { this.set(!this.active, carPosition); }

  set(on, carPosition) {
    this.active = !!on;
    document.body.classList.toggle('photo-mode', this.active);
    if (this.el) this.el.classList.toggle('visible', this.active);
    if (this.active && carPosition) {
      this.target.copy(carPosition);
      this.radius = 12;
      this.pitch = 0.25;
    }
  }

  /** Point the camera. Called instead of the chase camera while active. */
  update(carPosition) {
    // Follow the car if it is still rolling to a stop, but softly, so a
    // composed shot does not slide away underneath you.
    this.target.lerp(carPosition, 0.08);
    const cp = Math.cos(this.pitch);
    this.camera.position.set(
      this.target.x + Math.sin(this.yaw) * cp * this.radius,
      this.target.y + Math.sin(this.pitch) * this.radius + 1.2,
      this.target.z + Math.cos(this.yaw) * cp * this.radius,
    );
    this.camera.lookAt(this.target.x, this.target.y + 0.9, this.target.z);
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  /**
   * Render once and hand back a PNG.
   *
   * The read has to happen in the same tick as the draw: without
   * preserveDrawingBuffer the colour buffer is gone by the next frame, and
   * asking for it costs memory bandwidth on every frame of normal play.
   */
  capture() {
    this.onRender();
    const canvas = this.renderer.domElement;
    this.onShot();
    return new Promise((resolve) => {
      canvas.toBlob((blob) => {
        if (!blob) return resolve(null);
        const url = URL.createObjectURL(blob);
        this.lastShot = url;
        const a = document.createElement('a');
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        a.href = url;
        a.download = `ruelle-${stamp}.png`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        resolve(url);
      }, 'image/png');
    });
  }
}
