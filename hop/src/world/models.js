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

/**
 * A pack: one file holding a whole set, laid out side by side.
 *
 * This is how assets are actually sold — thirty objects on a grid in a single
 * glTF, sharing one texture set. Splitting that into tree.glb … tree6.glb would
 * copy the textures into every file, which is the expensive half of the
 * download; loading it once and cutting it up in memory costs nothing and keeps
 * the materials shared.
 *
 * Nothing here reads object names. A pack from a different author will call its
 * trees something else, and names like `Tree_Branches_01.002` say nothing about
 * which trunk they belong to anyway. What is reliable is the layout: the parts
 * of one object sit on top of each other, and separate objects are spaced out.
 */
const PACK_FILE = 'tree-pack.glb';

/** Cluster tall enough to be a tree, in metres, measured in the pack's own scale. */
const PACK_TREE_MIN_HEIGHT = 6;

/**
 * Two pieces belong to the same object when they overlap from above.
 *
 * A trunk and its canopy are centimetres apart with footprints that contain one
 * another; two neighbouring trees in the grid are metres apart. The factor puts
 * the threshold in the wide gap between those two cases — in this pack, pieces
 * that belong together are 0.3 m apart against a limit of 2 m, and the closest
 * distinct pair is 11.7 m apart against a limit of 6.3 m.
 */
const PACK_MERGE = 0.55;

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

  // A pack wins over individual files: shipping both would be ambiguous, and
  // the pack is the one that carries several species.
  const packed = await loadTreePack(baseUrl);
  if (packed.length) {
    registry.set('tree', packed);
    loaded.push('tree');
  }

  await Promise.all(Object.entries(PROP_MODELS).map(async ([kind, spec]) => {
    if (registry.has(kind)) return;
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
 * Load `tree-pack.glb`, if it is there, and cut it into one species per object.
 * Returns a list of part-lists, tallest first, or [] when there is no pack.
 */
async function loadTreePack(baseUrl) {
  const url = new URL(PACK_FILE, baseUrl).href;
  try {
    const head = await fetch(url, { method: 'HEAD' });
    if (!head.ok) return [];
  } catch {
    return [];
  }

  let scene;
  try {
    scene = (await getLoader().loadAsync(url)).scene;
  } catch (err) {
    console.warn('[ruelle] pack d’arbres illisible, on garde le procédural', err);
    return [];
  }
  scene.updateWorldMatrix(true, true);

  // Exporters wrap everything in a chain of single-child nodes; the level worth
  // splitting is the first one that actually branches.
  let host = scene;
  while (host.children.length === 1) host = host.children[0];

  const pieces = [];
  for (const child of host.children) {
    const box = new THREE.Box3().setFromObject(child);
    if (box.isEmpty()) continue;
    const size = new THREE.Vector3();
    const centre = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(centre);
    pieces.push({ child, centre, size, radius: Math.max(size.x, size.z) / 2 });
  }
  if (!pieces.length) return [];

  const groups = clusterByFootprint(pieces);

  const species = [];
  for (const group of groups) {
    let height = 0;
    for (const p of group) height = Math.max(height, p.size.y);
    if (height < PACK_TREE_MIN_HEIGHT) continue;    // a rock or a bush, not a tree
    const parts = flattenRoots(group.map((p) => p.child), PROP_MODELS.tree.targetHeight);
    if (parts.length) species.push({ parts, height });
  }

  // Tallest first, so a build that keeps only some of them keeps real trees
  // rather than saplings — and so the order is stable between sessions, which
  // the species field depends on.
  species.sort((a, b) => b.height - a.height);
  const out = species.map((s) => s.parts);
  if (out.length) {
    console.info(`[ruelle] pack d’arbres : ${out.length} essences sur ${groups.length} objets`);
  }
  return out;
}

/** Union-find over pieces that overlap seen from above. */
function clusterByFootprint(pieces) {
  const parent = pieces.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));

  for (let i = 0; i < pieces.length; i++) {
    for (let j = i + 1; j < pieces.length; j++) {
      const a = pieces[i], b = pieces[j];
      const d = Math.hypot(a.centre.x - b.centre.x, a.centre.z - b.centre.z);
      if (d < PACK_MERGE * (a.radius + b.radius)) parent[find(i)] = find(j);
    }
  }

  const byRoot = new Map();
  for (let i = 0; i < pieces.length; i++) {
    const r = find(i);
    if (!byRoot.has(r)) byRoot.set(r, []);
    byRoot.get(r).push(pieces[i]);
  }
  return [...byRoot.values()];
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
  return flattenRoots([scene], targetHeight);
}

/**
 * The same, over several roots that together make one object — a trunk and its
 * canopy cut out of a pack are two siblings, and they have to be measured and
 * scaled as a unit or the canopy ends up floating beside its own trunk.
 */
function flattenRoots(roots, targetHeight) {
  const box = new THREE.Box3();
  for (const root of roots) box.union(new THREE.Box3().setFromObject(root));
  if (box.isEmpty()) return [];

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
  const visit = (node) => {
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
  };
  for (const root of roots) root.traverse(visit);

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
