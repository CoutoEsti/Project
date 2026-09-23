// The whole world, from the map data to a three.js scene graph. Every mesh is
// tagged with the zone it belongs to (userData.zone), which is what the glTF
// export splits on.

import MAP from '../map/montreal.js';
import { compile } from '../map/layout.js';
import { buildStructures } from '../map/structures.js';
import { generateBuildings } from '../map/buildings.js';
import { createMaterials } from './materials.js';
import { buildLand, buildBlocks, buildWater, buildOutside, buildTerrain } from './ground.js';
import { buildRoads, buildStructureMeshes } from './roads.js';
import { buildBuildings } from './buildings.js';
import { placeStreetLamps, placeTrees } from '../map/props.js';
import { streetMarkings, roadMarkings } from '../map/markings.js';
import { buildLamps, buildTrees } from './props.js';
import { buildMarkings } from './markings.js';
import { buildLandmarks, buildJacquesCartier } from './landmarks.js';
import { buildSigns } from './signs.js';

// How far procedural buildings keep from each landmark, in metres.
const PLOT = {
  pvm: 62, gauchetiere: 45, arena: 85, basilica: 55, cityhall: 50, bonsecours: 70, clocktower: 20,
  wheel: 35, silo: 110, fiveroses: 45, habitat: 90, biosphere: 60, coaster: 90, casino: 60,
  championswall: 10, stadium: 190, biodome: 80, cross: 20, chalet: 45, oratory: 85, market: 70, atwater: 55,
};

export function landmarkPlots(landmarks) {
  return landmarks.map((l) => ({ x: l.x, n: l.n, r: PLOT[l.type] || 40, id: l.id }));
}

/**
 * @param THREE the three.js namespace (world modules never import it)
 * @param opts  { textures: bool, outside: bool, onStep: (label) => void,
 *                pause: () => Promise — lets the page repaint between steps }
 */
export async function buildWorld(THREE, opts = {}) {
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
  const layout = await step('plan', () => compile(MAP));
  const structures = await step('structures', () => buildStructures(layout));
  const plots = landmarkPlots(MAP.landmarks);
  const { buildings } = await step('bâtiments', () => generateBuildings(layout, plots));
  const M = await step('matériaux', () => createMaterials(THREE, opts));

  const root = new THREE.Group();
  root.name = 'MTL';
  const add = (o) => {
    for (const x of Array.isArray(o) ? o : [o]) if (x) root.add(x);
  };
  await step('sol', () => {
    add(buildLand(THREE, layout, M));
    add(buildBlocks(THREE, layout, M));
    add(buildWater(THREE, layout, M));
    if (opts.outside !== false) add(buildOutside(THREE, layout, M));
    add(buildTerrain(THREE, layout, M));
  });
  await step('routes', () => {
    add(buildRoads(THREE, layout, structures, M));
    add(buildStructureMeshes(THREE, layout, structures, M));
  });
  await step('maillage bâtiments', () => add(buildBuildings(THREE, buildings, M)));
  const lamps = await step('lampadaires', () => placeStreetLamps(layout, structures));
  const trees = await step('arbres', () => placeTrees(layout, structures, lamps));
  const strips = await step('marquage', () => [...streetMarkings(layout, structures), ...roadMarkings(layout)]);
  await step('maillage mobilier', () => {
    add(buildLamps(THREE, [...structures.lamps, ...lamps], M));
    add(buildTrees(THREE, trees, M));
    add(buildMarkings(THREE, strips, M));
  });

  const animated = [];
  const landmarks = await step('repères', () => {
    const lm = buildLandmarks(THREE, MAP, layout, M);
    add(lm.objects);
    animated.push(...lm.animated);
    add(buildJacquesCartier(THREE, layout, M));
    add(buildSigns(THREE, MAP, layout, M));
    return lm.objects;
  });
  return { root, layout, structures, buildings, lamps, trees, landmarks, materials: M, timings: T, animated, map: MAP };
}

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
