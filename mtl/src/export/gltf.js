// Export for Unity: one binary glTF per layer (ground, streets, roads,
// structures, trees…) and the buildings per 1 km tile, plus map.json with
// everything the level logic needs (centrelines with heights, districts,
// landmarks, spawns). Runs in the page (E key: one .zip) and in node
// (tools/export.mjs, which can also cut every layer by tile with --tuiles).
//
// Frame: the map is x east, n north, y up; three.js holds it as (x, y, -n).
// The groups are turned half a turn about Y on the way out, so the glTF holds
// (-east, up, north) — and glTFast, which mirrors X into Unity's left-handed
// frame, lands on Unity +X = east, +Z = north, 1 unit = 1 metre.

import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { simplifyN } from '../map/geom.js';
import { resolveSpawn } from '../game/spawn.js';

/**
 * @param opts { tiles: bool } every layer by tile, not just the buildings
 * @returns [{ name, data: ArrayBuffer | string }]
 */
export async function exportZones(THREE, world, opts = {}) {
  world.root.updateMatrixWorld(true);
  const zones = new Map();
  // Lamp heads and lit signs are brighter than white so the bloom catches
  // them. glTF caps a base colour at 1: the excess goes out as emission
  // (KHR_materials_emissive_strength), which Unity's bloom reads the same way.
  const swaps = new Map();
  const exportable = (m) => {
    if (!m || !m.color) return m;
    const k = Math.max(m.color.r, m.color.g, m.color.b);
    if (k <= 1) return m;
    if (!swaps.has(m)) {
      const c = m.color.clone().multiplyScalar(1 / k);
      swaps.set(m, new THREE.MeshStandardMaterial({
        name: m.name, color: c, emissive: c, emissiveIntensity: k, map: m.map || null, emissiveMap: m.map || null,
        transparent: m.transparent, opacity: m.opacity, side: m.side, roughness: 0.6, metalness: 0,
      }));
    }
    return swaps.get(m);
  };
  world.root.traverse((o) => {
    if (!o.isMesh) return;
    let layer = null, tile = null;
    for (let p = o; p; p = p.parent) {
      if (p.userData.exportSkip) return;
      if (!layer && p.userData.layer) layer = p.userData.layer;
      if (!tile && p.userData.tile) tile = p.userData.tile;
    }
    // Buildings always go by tile (a whole zone of them is hundreds of
    // megabytes); the rest by layer, or by tile too when asked. Far tiles
    // hide their small things in the page: exported anyway.
    const split = tile && (opts.tiles || layer === 'batiments');
    const zone = (layer || 'divers') + (split ? `_${tile}` : '');
    if (!zones.has(zone)) {
      const g = new THREE.Group();
      g.name = zone;
      g.rotation.y = Math.PI;
      zones.set(zone, g);
    }
    const mat = Array.isArray(o.material) ? o.material.map(exportable) : exportable(o.material);
    const copy = o.isInstancedMesh
      ? new THREE.InstancedMesh(o.geometry, mat, o.count)
      : new THREE.Mesh(o.geometry, mat);
    if (o.isInstancedMesh) copy.instanceMatrix = o.instanceMatrix;
    copy.name = o.name || o.material.name || 'maillage';
    o.matrixWorld.decompose(copy.position, copy.quaternion, copy.scale);
    zones.get(zone).add(copy);
  });
  const exporter = new GLTFExporter();
  const files = [];
  for (const [zone, group] of zones) {
    const data = await exporter.parseAsync(group, { binary: true, onlyVisible: false });
    files.push({ name: `mtl-${zone}.glb`, data });
  }
  files.push({ name: 'map.json', data: JSON.stringify(mapJson(world), null, 1) });
  return files;
}

/** The level data, in Unity's frame (documented in the file itself). */
export function mapJson(world) {
  const L = world.layout, M = world.map, T = L.terrain;
  const r1 = (v) => Math.round(v * 10) / 10;
  // Runs of tunnel samples, as arc lengths along the road.
  const tunnels = (r) => {
    const out = [];
    let s0 = null;
    for (const p of r.samples) {
      if (p.tunnel && s0 === null) s0 = p.s;
      if (!p.tunnel && s0 !== null) { out.push([r1(s0), r1(p.s)]); s0 = null; }
    }
    if (s0 !== null) out.push([r1(s0), r1(r.length)]);
    return out.length ? out : null;
  };
  const deg = (rad) => Math.round((((rad * 180) / Math.PI) % 360 + 360) % 360);
  return {
    meta: {
      ...M.meta,
      unity: 'Unity X = x (est), Unity Z = n (nord), Unity Y = y (haut) ; 1 unité = 1 m ; caps en degrés, sens horaire depuis le nord de Montréal',
    },
    settings: { zone: M.settings.zone, echelle: M.settings.echelle, scale: M.scale },
    world: M.world,
    roads: L.roads.map((r) => ({
      id: r.id, name: r.name, ref: r.ref || null, cls: r.cls, width: r1(r.width), lanes: r.lanes, oneway: !!r.oneway,
      loop: r.loop, closedStart: r.closedStart, closedEnd: r.closedEnd,
      points: simplifyN(r.samples.map((p) => [p.x, p.n, p.y]), 0.05).map(([x, n, y]) => [r1(x), r1(y), r1(n)]),
      tunnels: tunnels(r),
    })),
    streets: L.streets.map((s) => ({
      name: s.name, cls: s.cls, width: r1(s.width), oneway: !!s.oneway,
      points: s.path.map(([x, n]) => [r1(x), r1(T.height(x, n)), r1(n)]),
    })),
    districts: (L.quartiers || []).map((q) => ({ name: q.nom, type: q.type || null, style: q.style || null, x: r1(q.x), z: r1(q.n) })),
    landmarks: (world.landmarks || []).map((g) => ({
      id: g.userData.landmark, name: g.name, x: r1(g.position.x), y: r1(g.position.y), z: r1(-g.position.z), heading: deg(-g.rotation.y),
    })),
    spawns: M.spawns.map((sp) => {
      const p = resolveSpawn(L, sp);
      return p ? { id: sp.id, name: sp.name, x: r1(p.x), y: r1(p.y), z: r1(p.n), heading: deg(p.heading) } : null;
    }).filter(Boolean),
    races: M.races.map((r) => ({ ...r, points: r.points.map(([x, n]) => [r1(x), r1(T.height(x, n)), r1(n)]) })),
  };
}

/** Browser only: hand a file to the user. */
export function download(name, data, type = typeof data === 'string' ? 'application/json' : 'model/gltf-binary') {
  const blob = new Blob([data], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
