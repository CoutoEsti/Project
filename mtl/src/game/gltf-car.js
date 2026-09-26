// Loading a car from a glTF file, and making it behave like the built-in one.
//
// Ported from Ruelle (hop/src/vehicle/gltf.js): the rest of the game talks to
// the same small contract createCar() in car.js returns — group, setSteer,
// setSpin, setLights, setUnderglow — and does not care whether the car was
// authored in Blender or lofted from cross-sections. This module adapts any
// glTF to that contract: it measures the model, normalises its size and
// orientation, finds the wheels by name, and repaints untextured placeholder
// art to the game's chosen colour.
//
// mtl/vendor ships no Draco decoder (only hop does), so this loader never
// registers a DRACOLoader: a Draco-compressed file fails to parse, and that
// failure is caught and reported as one clear message before falling back to
// the generated car.

import { GLTFLoader } from '../../vendor/jsm/loaders/GLTFLoader.js';

const TARGET_LENGTH = 4.30; // metres, matching the generated car / physics wheelbase

// Nodes whose name looks like a wheel, in English or French.
const WHEEL_PATTERN = /wheel|tyre|tire|rim|roue|pneu|jante/i;
const FRONT_PATTERN = /front|fore|avant|_f[lr]?\b|_av|f[lr]$|\bfw/i;
const REAR_PATTERN = /rear|back|arriere|arrière|_r[lr]?\b|_ar|r[lr]$|\brw/i;
const GLASS_PATTERN = /glass|window|windshield|windscreen|vitre|verre|pare.?brise/i;
const LIGHT_PATTERN = /head.?l(ight|amp)|phare|tail.?l(ight|amp)|feu/i;

let loader = null;

function getLoader() {
  if (!loader) loader = new GLTFLoader();
  return loader;
}

/**
 * @param {object} THREE
 * @param {string} url
 * @param {object} opts {color:number}
 * @returns {Promise<object|null>} the same shape createCar() returns, or null
 */
export async function loadCarModel(THREE, url, opts = {}) {
  // Probe before loading: shipping no model is the normal case, and a bare
  // GLTFLoader 404 shows up as a console error, which is noise in a build
  // that is working exactly as intended.
  try {
    const head = await fetch(url, { method: 'HEAD' });
    if (!head.ok) return null;
  } catch {
    return null;
  }

  let gltf;
  try {
    gltf = await getLoader().loadAsync(url);
  } catch (err) {
    if (/DRACOLoader/i.test(String(err && err.message))) {
      console.warn(
        `[mtl] ${url} est compressé avec Draco, non pris en charge ici ` +
        '(mtl/vendor n\'a pas le décodeur) : ré-exporte sans Draco, par ' +
        'exemple depuis Blender sans l\'option de compression, ou repasse-le ' +
        'par hop/tools/prepare-model.mjs en sautant l\'étape draco. ' +
        'On garde la voiture générée.',
      );
    } else {
      console.warn('[mtl] modèle 3D illisible, on garde la voiture générée', err);
    }
    return null;
  }

  const root = gltf.scene || (gltf.scenes && gltf.scenes[0]);
  if (!root) return null;

  // --- normalise size and orientation --------------------------------------
  // Authored cars point in every direction and come in every unit. Measure the
  // bounding box, assume the longest horizontal axis is the length, and rotate
  // it to face +Z — which is where the physics expects the nose (see car.js).
  root.updateWorldMatrix(true, true);
  const box = new THREE.Box3().setFromObject(root);
  const size = new THREE.Vector3();
  box.getSize(size);
  if (!(size.x > 0) || !(size.z > 0)) return null;

  const inner = new THREE.Group();
  if (size.x > size.z) {
    // Longest axis is X: turn it to lie along Z.
    inner.rotation.y = Math.PI / 2;
  }
  const length = Math.max(size.x, size.z);
  const scale = TARGET_LENGTH / length;

  const group = new THREE.Group();
  inner.add(root);
  inner.scale.setScalar(scale);
  group.add(inner);

  // Sit the wheels on the road: drop the model so its lowest point is y=0.
  root.position.y -= box.min.y;
  // Centre it horizontally on the physics origin.
  const centre = new THREE.Vector3();
  box.getCenter(centre);
  root.position.x -= centre.x;
  root.position.z -= centre.z;

  // --- find the parts we can animate ---------------------------------------
  const wheels = [];
  const glass = [];
  const lights = [];
  const bodies = [];

  root.traverse((node) => {
    if (!node.isMesh && !node.isGroup && !node.isObject3D) return;
    const name = node.name || '';
    if (WHEEL_PATTERN.test(name)) {
      const front = FRONT_PATTERN.test(name) && !REAR_PATTERN.test(name);
      // Only take the outermost node of a wheel: a rim inside a tyre would
      // otherwise get spun twice.
      if (!wheels.some((w) => isAncestor(w.node, node))) {
        wheels.push({ node, front, baseRotation: node.rotation.clone() });
      }
      return;
    }
    if (!node.isMesh) return;
    if (GLASS_PATTERN.test(name)) glass.push(node);
    else if (LIGHT_PATTERN.test(name)) lights.push(node);
    else bodies.push(node);
  });

  // --- upgrade the materials ------------------------------------------------
  const paint = new THREE.Color(opts.color ?? 0xc0392b);
  let repainted = false;

  for (const mesh of bodies) {
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of materials) {
      if (!m || !m.isMeshStandardMaterial) continue;
      m.envMapIntensity = 1.1;
      // A model with no textures at all is almost certainly untextured
      // primary-colour placeholder art: give it the game's paint.
      if (!m.map && !repainted && m.color && m.color.getHex() !== 0x000000) {
        m.color.copy(paint);
        m.metalness = Math.min(0.3, m.metalness ?? 0.2);
        m.roughness = 0.35;
        repainted = true;
      }
    }
  }
  for (const mesh of glass) {
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of materials) {
      if (!m || !m.isMeshStandardMaterial) continue;
      m.roughness = 0.06;
      m.metalness = 0.2;
      m.envMapIntensity = 1.5;
    }
  }

  const lightMats = [];
  for (const mesh of lights) {
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of materials) {
      if (!m) continue;
      if (m.emissive) lightMats.push({ material: m, tail: /tail|arriere|arrière|_ar|feu.?rouge/i.test(mesh.name) });
    }
  }

  const frontWheels = wheels.filter((w) => w.front);
  const spinAxis = 'x';

  // Underglow, same as the generated car has: an authored model that silently
  // lost a feature the procedural one had is exactly the kind of gap nobody
  // notices until someone turns the setting on and nothing happens.
  const glowMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(0x22ccff),
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const glowGeo = new THREE.PlaneGeometry(3.4, 6.2);
  glowGeo.rotateX(-Math.PI / 2);
  const glow = new THREE.Mesh(glowGeo, glowMat);
  glow.position.y = 0.06;
  glow.renderOrder = 3;
  glow.visible = false;
  group.add(glow);

  return {
    group,
    wheels,
    source: 'gltf',
    setUnderglow(on, colour, night = 1) {
      glow.visible = !!on && night > 0.15;
      if (!glow.visible) return;
      if (colour != null) glowMat.color.setHex(colour);
      glowMat.opacity = 0.4 * Math.min(1, (night - 0.15) / 0.35);
    },
    setSteer(angle) {
      for (const w of frontWheels) w.node.rotation.y = w.baseRotation.y + angle;
    },
    setSpin(radians) {
      for (const w of wheels) w.node.rotation[spinAxis] = w.baseRotation[spinAxis] + radians;
    },
    setLights(on, braking) {
      if (!lightMats.length) return;
      for (const l of lightMats) {
        l.material.emissiveIntensity = l.tail ? (braking ? 2.4 : (on ? 0.7 : 0.1)) : (on ? 2.0 : 0);
      }
    },
    dispose() {
      group.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) if (m && m.dispose) m.dispose();
      });
    },
    stats: {
      length: length * scale,
      wheels: wheels.length,
      steered: frontWheels.length,
      triangles: countTriangles(root),
    },
  };
}

function isAncestor(maybeAncestor, node) {
  let p = node.parent;
  while (p) {
    if (p === maybeAncestor) return true;
    p = p.parent;
  }
  return false;
}

function countTriangles(root) {
  let n = 0;
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const g = o.geometry;
    n += (g.index ? g.index.count : g.attributes.position.count) / 3;
  });
  return Math.round(n);
}
