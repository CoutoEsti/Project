// The whole world, from the real data to a three.js scene graph, for one zone
// at one scale. Every mesh is tagged with the tile it belongs to
// (userData.tile) and what it is (userData.layer): the renderer culls and
// thins by tile, the Unity export writes one file per tile and layer.

import { buildMap } from '../map/real.js';
import { compile } from '../map/layout.js';
import { buildStructures } from '../map/structures.js';
import { tiling, byTile } from '../map/tiles.js';
import { prepareBuildings } from '../map/buildings.js';
import { placeStreetLamps, placeTrees } from '../map/props.js';
import { streetMarkings, roadMarkings } from '../map/markings.js';
import { pointInRing, ringBBox } from '../map/geom.js';
import { createMaterials } from './materials.js';
import { buildGround, buildOutside } from './ground.js';
import { buildStreets } from './streets.js';
import { buildRoads, buildStructureMeshes } from './roads.js';
import { buildBuildings } from './buildings.js';
import { buildLamps, buildTrees } from './props.js';
import { buildMarkings } from './markings.js';
import { buildLandmarks, buildJacquesCartier, landmarkFootprints } from './landmarks.js';
import { buildSigns } from './signs.js';

/**
 * @param THREE  the three.js namespace (world modules never import it)
 * @param source loadSource() output (map/source.js)
 * @param opts   { settings: { zone, echelle }, textures: bool, outside: bool,
 *                 onStep: (label) => void, pause: () => Promise — lets the
 *                 page repaint between steps }
 */
export async function buildWorld(THREE, source, opts = {}) {
  const T = {};
  const pause = opts.pause || (() => Promise.resolve());
  const step = async (label, fn) => {
    if (opts.onStep) opts.onStep(label);
    await pause();
    const t0 = now();
    const r = fn();
    T[label] = Math.round(now() - t0);
    return r;
  };
  const settings = opts.settings || { zone: 'centre', echelle: 100 };
  const map = await step('carte', () => buildMap(source, settings));
  const layout = await step('plan', () => compile(map));
  const structures = await step('structures', () => buildStructures(layout));
  const tiles = tiling(map);
  const styleAt = (x, n) => map.styleNear(x, n);
  let buildings = await step('bâtiments', () => prepareBuildings(map, layout, tiles, styleAt));
  const M = await step('matériaux', () => createMaterials(THREE, opts));

  const root = new THREE.Group();
  root.name = `MTL_${settings.zone}_${settings.echelle}`;
  const add = (o) => {
    for (const x of Array.isArray(o) ? o : [o]) if (x) root.add(x);
  };
  const stats = {};
  await step('sol', () => {
    const g = buildGround(THREE, layout, M, tiles);
    stats.ground = g.stats;
    add(g.meshes);
    if (opts.outside !== false) add(buildOutside(THREE, layout, M));
  });
  await step('rues', () => {
    const st = buildStreets(THREE, layout, M, tiles);
    stats.streets = st.stats;
    add(st.meshes);
  });
  await step('routes', () => {
    add(tagAll(buildRoads(THREE, layout, structures, M), 'routes'));
    add(tagAll(buildStructureMeshes(THREE, layout, structures, M), 'ouvrages'));
  });

  // Landmarks first: the data's own buildings under a model make way for it.
  const animated = [];
  const landmarks = await step('repères', () => {
    const lm = buildLandmarks(THREE, map, layout, M);
    add(tagAll(lm.objects, 'reperes'));
    animated.push(...lm.animated);
    const jc = buildJacquesCartier(THREE, layout, M);
    if (jc) add(tagAll([jc], 'reperes'));
    add(tagAll(buildSigns(THREE, map, layout, M), 'panneaux'));
    return lm.objects;
  });
  const footprints = await step('emprises', () => landmarkFootprints(THREE, landmarks));
  const boxes = footprints.map((f) => ({ f, bb: ringBBox(f.ring) }));
  const under = (b) => boxes.some(({ f, bb }) => {
    if (b.cx < bb.x0 - 150 || b.cx > bb.x1 + 150 || b.cn < bb.n0 - 150 || b.cn > bb.n1 + 150) return false;
    return pointInRing(b.cx, b.cn, f.ring) || b.ring.some(([x, n]) => pointInRing(x, n, f.ring));
  });
  buildings = buildings.filter((b) => !under(b));

  await step('maillage bâtiments', () => add(buildBuildings(THREE, buildings, M)));
  const oldTown = (x, n) => styleAt(x, n) === 'oldstone';
  const lamps = await step('lampadaires', () => placeStreetLamps(layout, structures, oldTown));
  const { trees, mapped } = await step('arbres', () => placeTrees(layout, structures, map, lamps));
  stats.trees = { total: trees.length, mapped };
  const strips = await step('marquage', () => [...streetMarkings(layout, structures), ...roadMarkings(layout)]);
  await step('maillage mobilier', () => {
    const allLamps = [...structures.lamps, ...lamps];
    for (const [key, list] of byTile(tiles, allLamps, (l) => [l.x, l.n])) add(buildLamps(THREE, list, M, key));
    for (const [key, list] of byTile(tiles, trees, (t) => [t.x, t.n])) add(buildTrees(THREE, list, M, key));
    for (const [key, list] of byTile(tiles, strips, (s) => s.pts[0])) add(buildMarkings(THREE, list, M, key));
  });

  // Small things per tile, for the renderer to drop when the tile is far.
  const details = new Map();
  root.traverse((o) => {
    if (!o.userData.detail || !o.userData.tile) return;
    let list = details.get(o.userData.tile);
    if (!list) { list = []; details.set(o.userData.tile, list); }
    list.push(o);
  });

  return {
    root, map, layout, structures, buildings, lamps, trees, landmarks, footprints,
    materials: M, timings: T, animated, tiles, details, stats, settings,
  };
}

function tagAll(list, layer) {
  for (const o of list) if (o && !o.userData.layer) o.userData.layer = layer;
  return list;
}

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
