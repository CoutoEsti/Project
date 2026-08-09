// Weather, as a look rather than a simulation.
//
// The point of rain here is not water on a windscreen — it is what rain does
// to a street. Wet asphalt drops from matte to near-mirror, and every window,
// every street lamp, the whole sky suddenly lives a second time in the road.
// The environment map was already there for the glass; rain simply lets the
// ground use it too, which is the cheapest cinematic upgrade in the project.

import * as THREE from 'three';

export const WEATHER = {
  clear: {
    label: 'Dégagé',
    groundRoughness: 1.0,
    saturation: 1.0,
    brightness: 1.0,
    fogScale: 1.0,
    rain: 0,
    sunScale: 1.0,
    envScale: 1.0,
  },
  overcast: {
    label: 'Couvert',
    groundRoughness: 0.86,
    saturation: 0.72,
    brightness: 0.80,
    fogScale: 0.62,
    rain: 0,
    // A grey sky is one huge soft light: the sun all but vanishes, the ambient
    // dome takes over. Getting that swap right is what sells overcast.
    sunScale: 0.22,
    envScale: 1.35,
  },
  rain: {
    label: 'Pluie',
    groundRoughness: 0.16,
    saturation: 0.60,
    brightness: 0.66,
    fogScale: 0.45,
    rain: 1,
    sunScale: 0.12,
    envScale: 1.25,
  },
};

const STREAKS = 2600;
const BOX = 90;          // side of the volume that follows the camera
const TOP = 34;
const FALL = 46;         // metres per second
const DRIFT = 5;         // wind, metres per second

export class Weather {
  constructor(scene) {
    this.scene = scene;
    this.kind = 'clear';
    this.spec = WEATHER.clear;

    // Streaks, not droplets: a falling drop seen for a sixteenth of a second
    // is a line, and drawing it as a line is both truer and cheaper.
    const positions = new Float32Array(STREAKS * 6);
    this.velocities = new Float32Array(STREAKS);
    for (let i = 0; i < STREAKS; i++) {
      this._seed(positions, i, Math.random() * TOP);
      this.velocities[i] = 0.85 + Math.random() * 0.4;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), BOX);

    this.material = new THREE.LineBasicMaterial({
      color: 0xa8c0d4,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      fog: false,
    });

    this.mesh = new THREE.LineSegments(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.renderOrder = 3;
    scene.add(this.mesh);

    this.positions = positions;
    this._time = 0;
  }

  _seed(pos, i, y) {
    const x = (Math.random() - 0.5) * BOX;
    const z = (Math.random() - 0.5) * BOX;
    const len = 0.7 + Math.random() * 1.5;
    pos[i * 6] = x;
    pos[i * 6 + 1] = y;
    pos[i * 6 + 2] = z;
    pos[i * 6 + 3] = x - DRIFT * len * 0.04;
    pos[i * 6 + 4] = y - len;
    pos[i * 6 + 5] = z;
  }

  set(kind) {
    this.kind = WEATHER[kind] ? kind : 'clear';
    this.spec = WEATHER[this.kind];
    this.mesh.visible = this.spec.rain > 0;
    this.material.opacity = this.spec.rain * 0.5;
  }

  /**
   * @param {number} dt
   * @param {THREE.Camera} camera
   */
  update(dt, camera) {
    if (!this.spec.rain) return;
    this._time += dt;

    // The volume rides with the camera, so the same few thousand streaks cover
    // the whole city. Snapping to whole metres keeps the pattern from sliding
    // visibly when the car moves slowly.
    this.mesh.position.set(
      Math.round(camera.position.x), 0, Math.round(camera.position.z),
    );

    const pos = this.positions;
    const drop = FALL * dt;
    const drift = DRIFT * dt;
    for (let i = 0; i < STREAKS; i++) {
      const v = this.velocities[i];
      const dy = drop * v;
      const dx = drift * v;
      pos[i * 6 + 1] -= dy;
      pos[i * 6 + 4] -= dy;
      pos[i * 6] -= dx;
      pos[i * 6 + 3] -= dx;
      if (pos[i * 6 + 4] < -2) this._seed(pos, i, TOP + Math.random() * 6);
    }
    this.mesh.geometry.attributes.position.needsUpdate = true;
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
