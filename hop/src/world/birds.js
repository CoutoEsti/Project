// Birds.
//
// A city with an empty sky reads as a diorama. Half a dozen shapes turning
// slowly overhead is the cheapest thing in this whole project that makes the
// place feel inhabited — three draw calls, no collision, no AI.
//
// They are not boids. Real flocking looks wrong at this scale: from a car you
// see gulls riding a thermal, which is a wide lazy circle with a wobble on it,
// and a circle is something you can write in closed form and never have to
// debug. Each bird gets its own radius, altitude, phase and flap rate, and the
// flock as a whole drifts to stay near whoever is watching.
//
// The flapping is done with matrices rather than a shader: one InstancedMesh
// per wing, rolled in opposite directions about the body axis. That keeps the
// whole thing inside the vanilla three.js instancing path.

import * as THREE from 'three';

const COUNT = 46;
const MIN_ALT = 26;
const MAX_ALT = 64;

/** Deterministic noise, so a flock looks the same on every reload. */
function hash01(n) {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * One wing, extending along +X from a pivot at the origin.
 *
 * Swept back and tapered, with the trailing edge notched — the silhouette is
 * the entire read at this distance, so it is the only thing worth shaping.
 */
function wingGeometry() {
  const geo = new THREE.BufferGeometry();
  // x: spanwise, z: chordwise (+Z is forward), y: flat.
  const v = new Float32Array([
    0.00, 0, 0.16,
    0.00, 0, -0.20,
    0.52, 0, -0.30,

    0.00, 0, 0.16,
    0.52, 0, -0.30,
    0.52, 0, -0.05,

    0.52, 0, -0.05,
    0.52, 0, -0.30,
    1.00, 0, -0.34,
  ]);
  geo.setAttribute('position', new THREE.BufferAttribute(v, 3));
  geo.computeVertexNormals();
  return geo;
}

function bodyGeometry() {
  const geo = new THREE.ConeGeometry(0.11, 0.86, 5);
  // Point it forward: the cone is built along +Y.
  geo.rotateX(Math.PI / 2);
  return geo;
}

export class Birds {
  /**
   * @param {THREE.Scene} scene
   * @param {object} [opts] {count}
   */
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.count = opts.count ?? COUNT;
    this.time = 0;
    this.centre = new THREE.Vector3(0, 44, 0);
    this._dummy = new THREE.Object3D();
    this._placed = false;

    const material = new THREE.MeshStandardMaterial({
      color: 0x2b3138,
      roughness: 0.92,
      metalness: 0,
      side: THREE.DoubleSide,
    });
    this.material = material;

    this.wingGeo = wingGeometry();
    this.bodyGeo = bodyGeometry();

    this.leftWing = new THREE.InstancedMesh(this.wingGeo, material, this.count);
    this.rightWing = new THREE.InstancedMesh(this.wingGeo, material, this.count);
    this.body = new THREE.InstancedMesh(this.bodyGeo, material, this.count);

    this.group = new THREE.Group();
    this.group.name = 'birds';
    for (const m of [this.leftWing, this.rightWing, this.body]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;      // they orbit the camera; the bounds lie
      m.castShadow = false;
      m.receiveShadow = false;
      this.group.add(m);
    }
    scene.add(this.group);

    this.birds = [];
    for (let i = 0; i < this.count; i++) {
      const a = hash01(i * 3.7);
      const b = hash01(i * 9.1 + 4);
      const c = hash01(i * 5.3 + 11);
      this.birds.push({
        radius: 34 + a * 96,
        phase: b * Math.PI * 2,
        // Slower on the wider orbits, so nothing visibly races round a circle.
        rate: (0.055 + c * 0.05) * (70 / (34 + a * 96)),
        alt: MIN_ALT + hash01(i * 2.9 + 7) * (MAX_ALT - MIN_ALT),
        bobPhase: hash01(i * 7.7 + 2) * Math.PI * 2,
        flapPhase: hash01(i * 11.3) * Math.PI * 2,
        // Bigger birds beat slower. It is a real thing and it reads.
        scale: 0.8 + hash01(i * 4.1 + 3) * 0.9,
        dir: hash01(i * 13.1) > 0.35 ? 1 : -1,
      });
      this.birds[i].flapRate = 7.4 / this.birds[i].scale;
    }
  }

  setVisible(on) { this.group.visible = !!on; }

  /**
   * @param {number} dt seconds
   * @param {THREE.Vector3|{x:number,z:number}} focus usually the camera
   * @param {number} [night] 0..1, from the sky — birds roost after dusk
   */
  update(dt, focus, night = 0) {
    if (!this.group.visible) return;
    this.time += dt;

    // The flock drifts toward the viewer instead of being pinned to them, so
    // you can drive out from under it and watch it catch up.
    if (!this._placed) {
      this.centre.set(focus.x, 44, focus.z);
      this._placed = true;
    } else {
      const k = 1 - Math.pow(0.86, dt);
      this.centre.x += (focus.x - this.centre.x) * k;
      this.centre.z += (focus.z - this.centre.z) * k;
    }

    // Fewer of them out at night, and none in the dark.
    const awake = Math.round(this.count * (1 - Math.min(1, night * 1.35)));
    for (const m of [this.leftWing, this.rightWing, this.body]) m.count = awake;
    if (!awake) return;

    const d = this._dummy;
    for (let i = 0; i < awake; i++) {
      const b = this.birds[i];
      const angle = b.phase + this.time * b.rate * b.dir;
      const x = this.centre.x + Math.cos(angle) * b.radius;
      const z = this.centre.z + Math.sin(angle) * b.radius;
      const y = b.alt + Math.sin(this.time * 0.35 + b.bobPhase) * 3.2;

      // Tangent to the circle. World forward is (sin ψ, cos ψ), so a heading
      // of ψ = atan2(dx, dz) points the body along its own path.
      const dx = -Math.sin(angle) * b.dir;
      const dz = Math.cos(angle) * b.dir;
      const heading = Math.atan2(dx, dz);

      // Bank into the turn — a constant, since the radius is constant.
      const bank = 0.34 * b.dir;
      const flap = Math.sin(this.time * b.flapRate + b.flapPhase) * 0.62;

      d.position.set(x, y, z);
      d.scale.setScalar(b.scale);

      d.rotation.set(0, heading, bank, 'YXZ');
      d.updateMatrix();
      this.body.setMatrixAt(i, d.matrix);

      d.rotation.set(0, heading, bank - flap, 'YXZ');
      d.updateMatrix();
      this.rightWing.setMatrixAt(i, d.matrix);

      // The mirrored wing: negative X scale flips the geometry across the
      // body, and the opposite roll makes both wings beat downward together.
      d.scale.set(-b.scale, b.scale, b.scale);
      d.rotation.set(0, heading, bank + flap, 'YXZ');
      d.updateMatrix();
      this.leftWing.setMatrixAt(i, d.matrix);
    }

    this.body.instanceMatrix.needsUpdate = true;
    this.leftWing.instanceMatrix.needsUpdate = true;
    this.rightWing.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    this.scene.remove(this.group);
    this.wingGeo.dispose();
    this.bodyGeo.dispose();
    this.material.dispose();
  }
}
