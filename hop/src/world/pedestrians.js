// People on the sidewalk.
//
// The user asked for "des bots pour mettre de la vie", and this is the honest
// version of that: figures walking the pavement, not traffic. A street with
// nobody on it reads as evacuated, and Montréal in particular is a city you
// mostly experience as pedestrians moving past storefronts.
//
// They are set dressing and are deliberately not solid. Giving them collision
// would make them obstacles, and obstacles you can hit at 90 km/h is a
// different game than the one being built here.
//
// Like the birds, the animation is matrices rather than skinning: a torso and
// two legs as three InstancedMeshes, with the legs counter-swinging. Skeletal
// animation for forty extras would cost a loader, a rig and a per-frame
// skinning pass to be no more readable from a moving car.

import * as THREE from 'three';

const COUNT = 44;
const RECYCLE_RANGE = 150;   // metres from the camera before a walker is reused
const SPAWN_MIN = 40;
const SPAWN_MAX = 130;

const SHIRT_COLORS = [
  [0.72, 0.24, 0.22], [0.17, 0.29, 0.48], [0.90, 0.88, 0.84], [0.20, 0.22, 0.26],
  [0.36, 0.50, 0.33], [0.82, 0.66, 0.28], [0.50, 0.28, 0.52], [0.28, 0.47, 0.52],
];

function tint(geo, rgb) {
  const n = geo.attributes.position.count;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    colors[i * 3] = rgb[0];
    colors[i * 3 + 1] = rgb[1];
    colors[i * 3 + 2] = rgb[2];
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geo;
}

function mergePositions(geos) {
  let total = 0;
  for (const g of geos) total += g.attributes.position.count;
  const pos = new Float32Array(total * 3);
  const nrm = new Float32Array(total * 3);
  const col = new Float32Array(total * 3);
  const idx = [];
  let v = 0;
  for (const g of geos) {
    const p = g.attributes.position;
    const nAttr = g.attributes.normal;
    const c = g.attributes.color;
    pos.set(p.array, v * 3);
    if (nAttr) nrm.set(nAttr.array, v * 3);
    if (c) col.set(c.array, v * 3);
    const index = g.index;
    if (index) for (let i = 0; i < index.count; i++) idx.push(index.getX(i) + v);
    else for (let i = 0; i < p.count; i++) idx.push(i + v);
    v += p.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.setIndex(idx);
  return out;
}

/**
 * Torso and arms. Kept separate from the head because the instance colour
 * multiplies the vertex colour, so anything sharing a mesh with the shirt
 * would be dyed the same — a red shirt would come with a red face.
 */
function torsoGeometry() {
  const parts = [];
  const chest = new THREE.BoxGeometry(0.36, 0.56, 0.22);
  chest.translate(0, 1.14, 0);
  parts.push(tint(chest, [1, 1, 1]));       // per-instance colour lands here

  for (const side of [-1, 1]) {
    const arm = new THREE.BoxGeometry(0.09, 0.5, 0.11);
    arm.translate(side * 0.22, 1.13, 0);
    parts.push(tint(arm, [1, 1, 1]));
  }
  return mergePositions(parts);
}

/** Head and hair, at fixed colours. */
function headGeometry() {
  const head = new THREE.SphereGeometry(0.115, 7, 5);
  head.translate(0, 1.55, 0);
  tint(head, [0.62, 0.46, 0.36]);
  const hair = new THREE.SphereGeometry(0.122, 7, 4, 0, Math.PI * 2, 0, Math.PI * 0.55);
  hair.translate(0, 1.56, 0);
  tint(hair, [0.16, 0.13, 0.11]);
  return mergePositions([head, hair]);
}

/** One leg, pivoting at the hip so a rotation about X is a stride. */
function legGeometry(side) {
  const leg = new THREE.BoxGeometry(0.13, 0.84, 0.15);
  leg.translate(side * 0.09, -0.42, 0);
  tint(leg, [0.20, 0.22, 0.28]);
  const shoe = new THREE.BoxGeometry(0.14, 0.09, 0.25);
  shoe.translate(side * 0.09, -0.82, 0.04);
  tint(shoe, [0.10, 0.10, 0.12]);
  const g = mergePositions([leg, shoe]);
  // Lift the pivot to hip height; the instance transform puts the feet down.
  g.translate(0, 0.86, 0);
  return g;
}

export class Pedestrians {
  /**
   * @param {THREE.Scene} scene
   * @param {object} opts {count, groundAt}
   */
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.count = opts.count ?? COUNT;
    this.groundAt = opts.groundAt || (() => 0);
    this._dummy = new THREE.Object3D();
    this._colour = new THREE.Color();

    const material = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.material = material;

    this.torsoGeo = torsoGeometry();
    this.headGeo = headGeometry();
    this.leftGeo = legGeometry(-1);
    this.rightGeo = legGeometry(1);

    this.torso = new THREE.InstancedMesh(this.torsoGeo, material, this.count);
    this.head = new THREE.InstancedMesh(this.headGeo, material, this.count);
    this.left = new THREE.InstancedMesh(this.leftGeo, material, this.count);
    this.right = new THREE.InstancedMesh(this.rightGeo, material, this.count);

    this.group = new THREE.Group();
    this.group.name = 'pedestrians';
    for (const m of [this.torso, this.head, this.left, this.right]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      m.count = 0;                 // nothing until there are streets to walk
      this.group.add(m);
    }
    scene.add(this.group);

    this.people = [];
    for (let i = 0; i < this.count; i++) {
      this.people.push({
        active: false,
        x: 0, z: 0, yaw: 0,
        speed: 1.1,
        phase: Math.random() * Math.PI * 2,
        colour: SHIRT_COLORS[i % SHIRT_COLORS.length],
        life: 0,
      });
    }
    this._colourDirty = true;
  }

  setShadows(on) {
    for (const m of [this.torso, this.head, this.left, this.right]) m.castShadow = !!on;
  }

  setVisible(on) { this.group.visible = !!on; }

  /**
   * Put a walker on the pavement of some street near the focus point.
   * Returns false when there is nothing suitable, which is normal while tiles
   * are still streaming in.
   */
  _place(p, roads, fx, fz) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const road = roads[(Math.random() * roads.length) | 0];
      if (!road || !road.spec || road.points.length < 2) continue;
      // Nobody strolls along a motorway shoulder.
      if (road.spec.kind === 'major' && road.spec.width > 14) continue;

      const seg = (Math.random() * (road.points.length - 1)) | 0;
      const a = road.points[seg];
      const b = road.points[seg + 1];
      const t = Math.random();
      const cx = a.x + (b.x - a.x) * t;
      const cz = a.z + (b.z - a.z) * t;

      const d = Math.hypot(cx - fx, cz - fz);
      if (d < SPAWN_MIN || d > SPAWN_MAX) continue;

      const dx = b.x - a.x, dz = b.z - a.z;
      const len = Math.hypot(dx, dz) || 1;
      const tx = dx / len, tz = dz / len;
      // On the pavement, not the carriageway.
      const side = Math.random() < 0.5 ? 1 : -1;
      const off = road.spec.width / 2 + road.spec.sidewalk * 0.5;

      p.x = cx - tz * side * off;
      p.z = cz + tx * side * off;
      // Walking along the street, either way.
      const forward = Math.random() < 0.5 ? 1 : -1;
      p.dirX = tx * forward;
      p.dirZ = tz * forward;
      p.yaw = Math.atan2(p.dirX, p.dirZ);
      p.speed = 0.9 + Math.random() * 0.7;
      p.phase = Math.random() * Math.PI * 2;
      p.colour = SHIRT_COLORS[(Math.random() * SHIRT_COLORS.length) | 0];
      p.life = 0;
      p.active = true;
      this._colourDirty = true;
      return true;
    }
    return false;
  }

  /**
   * @param {number} dt
   * @param {Array} roads   world-space roads near the player
   * @param {{x:number,z:number}} focus
   */
  update(dt, roads, focus) {
    if (!this.group.visible || !roads || !roads.length) return;

    const d = this._dummy;
    let n = 0;
    // Refill a few a frame rather than all of them at once: crossing a tile
    // boundary can invalidate the whole crowd, and forty placements in one
    // frame is a visible hitch. Three is fast enough that a full turnover
    // finishes inside a quarter of a second at any playable frame rate.
    let refills = 3;

    for (const p of this.people) {
      if (p.active) {
        p.life += dt;
        p.x += p.dirX * p.speed * dt;
        p.z += p.dirZ * p.speed * dt;
        if (Math.hypot(p.x - focus.x, p.z - focus.z) > RECYCLE_RANGE) p.active = false;
      }
      if (!p.active) {
        if (refills > 0 && this._place(p, roads, focus.x, focus.z)) refills--;
        else continue;
      }

      const y = this.groundAt(p.x, p.z);
      const stride = Math.sin(p.life * p.speed * 5.2 + p.phase) * 0.55;
      // A little bob in time with the stride. Without it they glide.
      const bob = Math.abs(Math.cos(p.life * p.speed * 5.2 + p.phase)) * 0.035;

      d.position.set(p.x, y + bob, p.z);
      d.scale.set(1, 1, 1);
      d.rotation.set(0, p.yaw, 0, 'YXZ');
      d.updateMatrix();
      this.torso.setMatrixAt(n, d.matrix);
      this.head.setMatrixAt(n, d.matrix);

      d.rotation.set(stride, p.yaw, 0, 'YXZ');
      d.updateMatrix();
      this.left.setMatrixAt(n, d.matrix);

      d.rotation.set(-stride, p.yaw, 0, 'YXZ');
      d.updateMatrix();
      this.right.setMatrixAt(n, d.matrix);

      if (this._colourDirty) {
        this._colour.setRGB(p.colour[0], p.colour[1], p.colour[2]);
        this.torso.setColorAt(n, this._colour);
      }
      n++;
    }

    this.torso.count = n;
    this.head.count = n;
    this.left.count = n;
    this.right.count = n;
    this.torso.instanceMatrix.needsUpdate = true;
    this.head.instanceMatrix.needsUpdate = true;
    this.left.instanceMatrix.needsUpdate = true;
    this.right.instanceMatrix.needsUpdate = true;
    if (this._colourDirty && this.torso.instanceColor) {
      this.torso.instanceColor.needsUpdate = true;
      this._colourDirty = false;
    }
  }

  /** Everyone goes home when the world moves under them. */
  reset() {
    for (const p of this.people) p.active = false;
    this.torso.count = this.head.count = this.left.count = this.right.count = 0;
  }

  dispose() {
    this.scene.remove(this.group);
    this.torsoGeo.dispose();
    this.headGeo.dispose();
    this.leftGeo.dispose();
    this.rightGeo.dispose();
    this.material.dispose();
  }
}
