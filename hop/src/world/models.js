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

/**
 * What the game will look for, and how tall each thing should end up.
 *
 * `variants` is how many numbered files are probed: tree.glb, tree2.glb,
 * tree3.glb and so on. Whichever exist become the species the placement code
 * can draw from — one file still works exactly as before, and there is nothing
 * to configure when a second one appears.
 */
export const PROP_MODELS = {
  tree: { file: 'tree.glb', targetHeight: 8.5, heightJitter: 0.35, variants: 6 },
  lamp: { file: 'lamp.glb', targetHeight: 6.2, heightJitter: 0.04 },
  bench: { file: 'bench.glb', targetHeight: 0.9, heightJitter: 0.05 },
};

/** tree.glb, tree2.glb, tree3.glb … */
function variantFiles(spec) {
  const n = spec.variants || 1;
  if (n <= 1) return [spec.file];
  const dot = spec.file.lastIndexOf('.');
  const stem = spec.file.slice(0, dot);
  const ext = spec.file.slice(dot);
  const out = [spec.file];
  for (let i = 2; i <= n; i++) out.push(`${stem}${i}${ext}`);
  return out;
}

// kind -> array of part-lists, one per variant that was actually found.
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

/** The parts of one variant, or null if none was shipped. */
export function propParts(kind, variant = 0) {
  const list = registry.get(kind);
  if (!list || !list.length) return null;
  return list[variant % list.length];
}

/** How many variants of a prop were found. Zero means none. */
export function propVariantCount(kind) {
  const list = registry.get(kind);
  return list ? list.length : 0;
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
    const files = variantFiles(spec);
    // Probe all variants at once, then keep them in file order: the species
    // field indexes into this list, so the same file must always land on the
    // same index or a neighbourhood would change species between sessions.
    const variants = await Promise.all(files.map(async (file) => {
      const url = new URL(file, baseUrl).href;
      try {
        const head = await fetch(url, { method: 'HEAD' });
        if (!head.ok) return null;
      } catch {
        return null;
      }
      try {
        const gltf = await getLoader().loadAsync(url);
        const parts = flatten(gltf.scene, spec.targetHeight);
        return parts.length ? parts : null;
      } catch (err) {
        console.warn(`[ruelle] modèle ${file} illisible, on garde le procédural`, err);
        return null;
      }
    }));

    const found = variants.filter(Boolean);
    if (found.length) {
      registry.set(kind, found);
      loaded.push(kind);
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

/** Triangle count of a registered prop, summed over its variants. */
export function propTriangles(kind) {
  const list = registry.get(kind);
  if (!list) return 0;
  let n = 0;
  for (const parts of list) {
    for (const p of parts) {
      const g = p.geometry;
      n += (g.index ? g.index.count : g.attributes.position.count) / 3;
    }
  }
  return Math.round(n);
}
