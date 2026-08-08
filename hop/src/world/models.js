// Optional authored assets, loaded once at boot.
//
// Everything in the game has a procedural fallback, so the registry starts
// empty and the world builds exactly as before. Drop a file in models/ and the
// matching prop switches over — no configuration, no code change.
//
// Props are instanced, which means an authored model has to be reduced to a
// flat list of {geometry, material} parts with their transforms already baked
// in. A glTF tree is typically a trunk mesh and a foliage mesh with different
// materials; each becomes its own InstancedMesh sharing the same per-tree
// matrices, so a thousand trees still cost two draw calls.

import * as THREE from 'three';
import { GLTFLoader } from '../../vendor/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from '../../vendor/jsm/loaders/DRACOLoader.js';

const DRACO_PATH = new URL('../../vendor/jsm/libs/draco/', import.meta.url).href;

/** What the game will look for, and how tall each thing should end up. */
export const PROP_MODELS = {
  tree: { file: 'tree.glb', targetHeight: 8.5, heightJitter: 0.35 },
  lamp: { file: 'lamp.glb', targetHeight: 6.2, heightJitter: 0.04 },
  bench: { file: 'bench.glb', targetHeight: 0.9, heightJitter: 0.05 },
};

const registry = new Map();
let loader = null;

function getLoader() {
  if (loader) return loader;
  loader = new GLTFLoader();
  const draco = new DRACOLoader();
  draco.setDecoderPath(DRACO_PATH);
  loader.setDRACOLoader(draco);
  return loader;
}

/** The parts registered for a prop kind, or null if none was shipped. */
export function propParts(kind) {
  return registry.get(kind) || null;
}

export function hasPropModel(kind) {
  return registry.has(kind);
}

/**
 * Try to load every optional prop model. Resolves once all probes have
 * settled; a missing file is the normal case and is not an error.
 *
 * @param {string} baseUrl directory holding the models
 * @returns {Promise<string[]>} the kinds that were actually loaded
 */
export async function preloadPropModels(baseUrl) {
  const loaded = [];
  await Promise.all(Object.entries(PROP_MODELS).map(async ([kind, spec]) => {
    const url = new URL(spec.file, baseUrl).href;
    try {
      const head = await fetch(url, { method: 'HEAD' });
      if (!head.ok) return;
    } catch {
      return;
    }
    try {
      const gltf = await getLoader().loadAsync(url);
      const parts = flatten(gltf.scene, spec.targetHeight);
      if (parts.length) {
        registry.set(kind, parts);
        loaded.push(kind);
      }
    } catch (err) {
      console.warn(`[ruelle] modèle ${spec.file} illisible, on garde le procédural`, err);
    }
  }));
  return loaded;
}

/**
 * Collapse a loaded scene into instanceable parts.
 *
 * Each mesh's world transform is baked into a cloned geometry, then the whole
 * set is scaled so the model stands `targetHeight` metres tall and sits with
 * its base at y=0. That way the placement code never has to know anything
 * about how the asset was authored.
 */
function flatten(scene, targetHeight) {
  scene.updateWorldMatrix(true, true);

  const box = new THREE.Box3().setFromObject(scene);
  const size = new THREE.Vector3();
  box.getSize(size);
  if (!(size.y > 0)) return [];

  const scale = targetHeight / size.y;
  const centre = new THREE.Vector3();
  box.getCenter(centre);

  // Bake: world matrix, then recentre horizontally and drop onto the ground,
  // then scale. Done as one matrix so geometry is only rewritten once.
  const fix = new THREE.Matrix4()
    .makeScale(scale, scale, scale)
    .multiply(new THREE.Matrix4().makeTranslation(-centre.x, -box.min.y, -centre.z));

  const parts = [];
  scene.traverse((node) => {
    if (!node.isMesh || !node.geometry) return;
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    // Multi-material meshes use geometry groups; instancing needs one material
    // per draw, so only the first group survives. Authored props almost never
    // hit this, and splitting them properly is not worth the code.
    const geometry = node.geometry.clone();
    geometry.applyMatrix4(new THREE.Matrix4().multiplyMatrices(fix, node.matrixWorld));
    geometry.computeBoundingSphere();

    const material = materials[0];
    if (material) {
      material.envMapIntensity = 1.0;
      // Foliage is nearly always alpha-cut; blending it would need sorting we
      // cannot do across thousands of instances.
      if (material.transparent && material.alphaTest === 0) {
        material.transparent = false;
        material.alphaTest = 0.42;
      }
      material.side = material.alphaTest > 0 ? THREE.DoubleSide : material.side;
    }
    parts.push({ geometry, material, castShadow: true });
  });

  return parts;
}

/** Triangle count of a registered prop, for diagnostics. */
export function propTriangles(kind) {
  const parts = registry.get(kind);
  if (!parts) return 0;
  let n = 0;
  for (const p of parts) {
    const g = p.geometry;
    n += (g.index ? g.index.count : g.attributes.position.count) / 3;
  }
  return Math.round(n);
}
