// Export for Unity: one binary glTF per zone, plus map.json with everything
// the level logic needs (centrelines with heights, districts, landmarks,
// spawns, races). Runs in the page (E key) and in node (tools/export.mjs).
//
// Frame: the map is x east, n north, y up; three.js holds it as (x, y, -n).
// The zones are turned half a turn about Y on the way out, so the glTF holds
// (-east, up, north) — and glTFast, which mirrors X into Unity's left-handed
// frame, lands on Unity +X = east, +Z = north, 1 unit = 1 metre.

import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { simplifyN } from '../map/geom.js';

/** @returns [{ name, data: ArrayBuffer | string }] */
export async function exportZones(THREE, world) {
  world.root.updateMatrixWorld(true);
  const zones = new Map();
  world.root.traverse((o) => {
    if (!o.isMesh || !o.visible) return;
    let zone = null;
    for (let p = o; p; p = p.parent) {
      if (p.userData.exportSkip) return;
      if (!zone && p.userData.zone) zone = p.userData.zone;
    }
    zone = zone || 'divers';
    if (!zones.has(zone)) {
      const g = new THREE.Group();
      g.name = zone;
      g.rotation.y = Math.PI;
      zones.set(zone, g);
    }
    const copy = o.isInstancedMesh
      ? new THREE.InstancedMesh(o.geometry, o.material, o.count)
      : new THREE.Mesh(o.geometry, o.material);
    if (o.isInstancedMesh) copy.instanceMatrix = o.instanceMatrix;
    copy.name = o.name || o.material.name || 'maillage';
    o.matrixWorld.decompose(copy.position, copy.quaternion, copy.scale);
    zones.get(zone).add(copy);
  });
  const exporter = new GLTFExporter();
  const files = [];
  for (const [zone, group] of zones) {
    const data = await exporter.parseAsync(group, { binary: true, onlyVisible: true });
    files.push({ name: `mtl-${zone}.glb`, data });
  }
  files.push({ name: 'map.json', data: JSON.stringify(mapJson(world), null, 1) });
  return files;
}

/** The level data, in the map frame (documented in the file itself). */
export function mapJson(world) {
  const L = world.layout, M = world.map;
  const r1 = (v) => Math.round(v * 10) / 10;
  return {
    meta: { ...M.meta, unity: 'Unity X = x (est), Unity Z = n (nord), Unity Y = y ; 1 unité = 1 m' },
    world: M.world,
    roads: L.roads.map((r) => ({
      id: r.id, name: r.name, cls: r.cls, width: r.width, lanes: r.lanes, median: !!r.median,
      loop: r.loop, closedEnd: r.closedEnd,
      points: simplifyN(r.samples.map((p) => [p.x, p.n, p.y]), 0.05).map(([x, n, y]) => [r1(x), r1(y), r1(n)]),
      tunnel: r.tunnel || null,
    })),
    streets: L.streets.map((s) => ({ name: s.name, cls: s.cls, width: s.width, points: s.path.map(([x, n]) => [r1(x), 0, r1(n)]) })),
    districts: L.districts.filter((d) => d.ring).map((d) => ({ id: d.id, name: d.name, style: d.style, ring: d.ring.map(([x, n]) => [r1(x), r1(n)]) })),
    landmarks: M.landmarks.map((l) => ({ id: l.id, name: l.name, type: l.type, x: l.x, z: l.n, heading: l.heading })),
    spawns: M.spawns.map((s) => ({ id: s.id, name: s.name, x: s.x, y: s.y ?? 0, z: s.n, heading: s.heading })),
    races: M.races.map((r) => ({ ...r, points: r.points.map(([x, n]) => [x, n]) })),
  };
}

/** Browser only: hand a file to the user. */
export function download(name, data) {
  const blob = new Blob([data], { type: typeof data === 'string' ? 'application/json' : 'model/gltf-binary' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
