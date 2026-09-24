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
  const footprints = await step('emprises', () => clearStreets(layout, landmarks, landmarkFootprints(THREE, landmarks)));
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

/**
 * A landmark placed by hand, or grown by the scale, can end up across a real
 * street or road. Slide it (and turn it if need be), the nearest way first,
 * until none of its footprints touches a carriageway at its level; a model
 * with no free spot within 120 m stays put.
 */
function clearStreets(layout, objects, footprints) {
  const s = layout.map.scale || 1;
  const SEARCH = 120 * s;
  // Every point a model must not cover near (x, n): the centreline and both
  // edges of each carriageway at the model's level, every 2 m.
  const obstacles = (x, n, reach, y0) => {
    const out = [];
    const R = reach + SEARCH;
    for (const r of layout.roads) {
      const h = Math.max(0, r.half - 1);
      for (const p of r.samples) {
        if (Math.abs(p.x - x) > R || Math.abs(p.n - n) > R) continue;
        if (p.y > y0 + 5 || p.y < y0 - 3) continue;
        out.push([p.x, p.n], [p.x + p.lx * h, p.n + p.ln * h], [p.x - p.lx * h, p.n - p.ln * h]);
      }
    }
    for (const st of layout.streets) {
      if (st.cls === 'plaza' || st.cls === 'alley') continue;
      const P = st.path, h = Math.max(0, st.half - 1);
      if (!P.some(([px, pn]) => Math.abs(px - x) < R + 200 && Math.abs(pn - n) < R + 200)) continue;
      for (let i = 0; i + 1 < P.length; i++) {
        const ex = P[i + 1][0] - P[i][0], en = P[i + 1][1] - P[i][1], len = Math.hypot(ex, en) || 1;
        const lx = -en / len, ln = ex / len;
        for (let d = 0; d <= len; d += 2) {
          const px = P[i][0] + (ex * d) / len, pn = P[i][1] + (en * d) / len;
          if (Math.abs(px - x) > R || Math.abs(pn - n) > R) continue;
          out.push([px, pn], [px + lx * h, pn + ln * h], [px - lx * h, pn - ln * h]);
        }
      }
    }
    return out;
  };
  const blocks = (ring, dx, dn, pts) => {
    const bb = ringBBox(ring);
    for (const [x, n] of pts) {
      const u = x - dx, v = n - dn;
      if (u < bb.x0 || u > bb.x1 || v < bb.n0 || v > bb.n1) continue;
      if (pointInRing(u, v, ring)) return true;
    }
    return false;
  };
  // A footprint turned by `turn` degrees (clockwise) about (ox, on).
  const turned = (ring, ox, on, turn) => {
    if (!turn) return ring;
    const c = Math.cos((turn * Math.PI) / 180), sn = Math.sin((turn * Math.PI) / 180);
    return ring.map(([x, n]) => [ox + (x - ox) * c + (n - on) * sn, on - (x - ox) * sn + (n - on) * c]);
  };
  for (const g of objects) {
    const mine = footprints.filter((f) => f.id === g.userData.landmark);
    if (!mine.length) continue;
    const ox = g.position.x, on = -g.position.z;
    let reach = 0;
    for (const f of mine) for (const [x, n] of f.ring) reach = Math.max(reach, Math.hypot(x - ox, n - on));
    const pts = obstacles(ox, on, reach, Math.min(...mine.map((f) => f.y0)));
    if (!mine.some((f) => blocks(f.ring, 0, 0, pts))) continue;
    let found = null;
    for (let r = 0; r <= SEARCH && !found; r += 3 * s) {
      for (const turn of [0, 90, -90, 45, -45, 180]) {
        const rings = mine.map((f) => turned(f.ring, ox, on, turn));
        for (let a = 0; a < (r ? 16 : 1) && !found; a++) {
          const dx = Math.cos((a * Math.PI) / 8) * r, dn = Math.sin((a * Math.PI) / 8) * r;
          if (!rings.some((ring) => blocks(ring, dx, dn, pts))) found = [dx, dn, turn];
        }
        if (found) break;
      }
    }
    if (!found) continue;
    const [dx, dn, turn] = found;
    const x = ox + dx, n = on + dn;
    const dy = layout.terrain.height(x, n) - g.position.y;
    g.position.set(x, g.position.y + dy, -n);
    g.rotation.y -= (turn * Math.PI) / 180;
    g.updateMatrixWorld(true);
    for (const f of mine) {
      f.ring = turned(f.ring, ox, on, turn).map(([px, pn]) => [px + dx, pn + dn]);
      f.y0 += dy; f.y1 += dy;
    }
  }
  return footprints;
}

function tagAll(list, layer) {
  for (const o of list) if (o && !o.userData.layer) o.userData.layer = layer;
  return list;
}

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
