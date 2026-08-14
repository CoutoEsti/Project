// The other players, on screen.
//
// One procedural car per peer — the same 400-triangle model the local car falls
// back to, so seven of them cost less than a single building. They are pooled
// and reused: a player who drops and rejoins gets the same mesh back rather than
// allocating a new one mid-drive.
//
// Deliberately *not* called ghosts. The game already has ghosts, they are the
// translucent replay of your own best lap, and confusing the two would be
// confusing exactly where it matters — which of those cars can I hit.

import { createCar } from '../vehicle/model.js';

/** Past this, another car is a couple of pixels. Keep it, stop drawing it. */
const DRAW_RANGE = 700;

/** Half-length and radius of the capsule that stands in for a car body. */
const BODY_HALF = 1.10;
const BODY_RADIUS = 0.95;

/** Above the roof, in metres. High enough to clear the car, low enough to own it. */
const PLATE_HEIGHT = 2.35;

export class RemoteCars {
  /**
   * @param {object} THREE
   * @param {THREE.Scene} scene
   * @param {object} opts {groundAt(x,z), shadows}
   */
  constructor(THREE, scene, opts = {}) {
    this.THREE = THREE;
    this.scene = scene;
    this.groundAt = opts.groundAt || (() => 0);
    this.shadows = !!opts.shadows;

    this.group = new THREE.Group();
    this.group.name = 'remote-cars';
    scene.add(this.group);

    this.slots = new Map();   // peer id -> {car, plate, name, colour}
  }

  /**
   * Put every remote car where the interpolator says it is.
   * @param {Array} cars from Multiplayer.cars()
   * @param {THREE.Vector3} viewer camera position, for culling and plate facing
   * @param {number} night 0..1, so their headlights come on with yours
   */
  update(cars, viewer, night = 0) {
    const seen = new Set();

    for (const c of cars) {
      seen.add(c.id);
      const slot = this._slotFor(c);

      const dx = c.x - viewer.x;
      const dz = c.z - viewer.z;
      const far = Math.hypot(dx, dz) > DRAW_RANGE;
      slot.car.group.visible = !far;
      slot.plate.visible = !far;
      if (far) continue;

      const y = this.groundAt(c.x, c.z);
      slot.car.group.position.set(c.x, y, c.z);
      slot.car.group.rotation.set(0, c.yaw, 0, 'YXZ');
      slot.car.setSteer(c.steer);
      // A held pose means the packet is late; freezing the wheels is the honest
      // reading and it is invisible, whereas wheels spinning under a stationary
      // car is the classic tell that a game is guessing.
      if (c.moving) slot.car.setSpin(c.spin);
      slot.car.setLights(c.lights || night > 0.35, c.braking);

      slot.plate.position.set(c.x, y + PLATE_HEIGHT, c.z);
    }

    for (const [id, slot] of [...this.slots]) {
      if (!seen.has(id)) this._release(id, slot);
    }
  }

  _slotFor(c) {
    let slot = this.slots.get(c.id);
    if (!slot) {
      const car = createCar(this.THREE, { color: c.colour });
      car.group.traverse((o) => { if (o.isMesh) o.castShadow = this.shadows; });
      this.group.add(car.group);
      const plate = this._makePlate(c.name);
      this.group.add(plate);
      slot = { car, plate, name: c.name, colour: c.colour };
      this.slots.set(c.id, slot);
    } else if (slot.name !== c.name) {
      // Renaming is rare enough to be worth a whole new texture.
      this.group.remove(slot.plate);
      disposePlate(slot.plate);
      slot.plate = this._makePlate(c.name);
      this.group.add(slot.plate);
      slot.name = c.name;
    }
    return slot;
  }

  /** A name, drawn into a canvas and hung above the roof as a sprite. */
  _makePlate(name) {
    const THREE = this.THREE;
    const pad = 16;
    const cv = document.createElement('canvas');
    const ctx = cv.getContext('2d');
    ctx.font = '600 44px system-ui, sans-serif';
    const text = String(name || '…');
    const w = Math.ceil(ctx.measureText(text).width) + pad * 2;
    cv.width = Math.max(64, w);
    cv.height = 72;

    const g = cv.getContext('2d');
    g.font = '600 44px system-ui, sans-serif';
    g.textBaseline = 'middle';
    g.fillStyle = 'rgba(12,16,20,0.72)';
    roundRect(g, 0, 6, cv.width, 60, 14);
    g.fill();
    g.fillStyle = '#f2f5f7';
    g.fillText(text, pad, 37);

    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, transparent: true, depthTest: true, depthWrite: false,
    }));
    // Sprites are sized in world metres; keep the text about 45 cm tall so it
    // is readable across an intersection and not a billboard from a block away.
    sprite.scale.set((cv.width / cv.height) * 0.62, 0.62, 1);
    sprite.renderOrder = 4;
    return sprite;
  }

  _release(id, slot) {
    this.slots.delete(id);
    this.group.remove(slot.car.group);
    slot.car.dispose();
    this.group.remove(slot.plate);
    disposePlate(slot.plate);
  }

  clear() {
    for (const [id, slot] of [...this.slots]) this._release(id, slot);
  }

  dispose() {
    this.clear();
    this.scene.remove(this.group);
  }
}

/**
 * Make the local car bounce off the others.
 *
 * Nobody is authoritative here, and that is a deliberate choice: each client
 * pushes *only itself* out of the overlap, so there is no rubber-banding fight
 * over who was really where. Both cars run the same test against the same pair
 * of positions, so both agree on which way to move, and the result looks like a
 * shared collision without a single packet being exchanged about it.
 *
 * The car is a capsule rather than a circle. A circle wide enough to cover the
 * body would be almost two metres across, which is wider than the gap between
 * two lanes: cars would shove each other apart merely by driving side by side.
 *
 * @param {object} v the local Vehicle, already stepped this frame
 * @param {Array} cars from Multiplayer.cars()
 * @returns {number} impact strength, 0 if nothing was touched
 */
export function collideWithRemote(v, cars) {
  if (!cars.length) return 0;
  const reach = BODY_HALF * 2 + BODY_RADIUS * 2;
  let strongest = 0;

  const fx = Math.sin(v.yaw), fz = Math.cos(v.yaw);

  for (const c of cars) {
    let dx = c.x - v.x;
    let dz = c.z - v.z;
    if (Math.abs(dx) > reach || Math.abs(dz) > reach) continue;

    // Closest points between the two spines, approximated by projecting each
    // centre onto the other's axis. Exact enough for two boxes of the same size.
    const cfx = Math.sin(c.yaw), cfz = Math.cos(c.yaw);
    const tSelf = clamp(dx * fx + dz * fz, -BODY_HALF, BODY_HALF);
    const tOther = clamp(-(dx * cfx + dz * cfz), -BODY_HALF, BODY_HALF);

    const ax = v.x + fx * tSelf, az = v.z + fz * tSelf;
    const bx = c.x + cfx * tOther, bz = c.z + cfz * tOther;

    dx = ax - bx;
    dz = az - bz;
    const dist = Math.hypot(dx, dz);
    const overlap = BODY_RADIUS * 2 - dist;
    if (overlap <= 0) continue;

    const nx = dist > 1e-4 ? dx / dist : 1;
    const nz = dist > 1e-4 ? dz / dist : 0;

    // Half the overlap each: the other client is removing the other half.
    v.x += nx * overlap * 0.5;
    v.z += nz * overlap * 0.5;

    // Kill the part of our velocity that is driving into them, and give a
    // little of it back as a bounce.
    const vx = fx * v.u + Math.cos(v.yaw) * v.v;
    const vz = fz * v.u - Math.sin(v.yaw) * v.v;
    const closing = vx * nx + vz * nz;
    if (closing < 0) {
      const kick = closing * 1.35;
      const nvx = vx - nx * kick;
      const nvz = vz - nz * kick;
      v.u = nvx * fx + nvz * fz;
      v.v = nvx * Math.cos(v.yaw) - nvz * Math.sin(v.yaw);
      strongest = Math.max(strongest, -closing);
    }
  }
  return strongest;
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function disposePlate(sprite) {
  if (sprite.material.map) sprite.material.map.dispose();
  sprite.material.dispose();
}

export { DRAW_RANGE };
