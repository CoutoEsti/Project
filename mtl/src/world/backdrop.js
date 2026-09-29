// The city that seems to go on past the zone's edge. Beyond the invisible wall
// (map/collide.js), nothing to drive on, everything to look at:
//
//   the blocks    the real buildings outside the zone, gathered into boxes
//                 (map/backdrop.js) — one mesh, flat-shaded, coloured a little
//                 lighter with height so the haze does the rest. No collision.
//   the skyline   a painted panel round the horizon, following the camera, in
//                 the fog's own colour. Towers stand in the direction of the
//                 real downtown.
//
// The ground under all of it is buildOutside() (world/ground.js): the coarse
// real relief and the river. Two draw calls and about 10 triangles a block
// (budget: under 10 calls, 200 k triangles). Receives THREE, never imports it.

import * as T from './textures.js';

const lin = (c) => Math.pow(c, 2.2);
const PANEL_RADIUS = 6500;
const PANEL_HEIGHT = 900;

/**
 * @returns { objects: Object3D[], stats: { boxes, triangles, drawCalls } }
 */
export function buildBackdrop(THREE, layout, M, opts = {}) {
  const objects = [];
  const stats = { boxes: 0, triangles: 0, drawCalls: 0 };
  const cells = layout.map.backdrop;
  if (cells && cells.count) {
    const mesh = blocks(THREE, layout, cells);
    objects.push(mesh);
    stats.boxes = cells.count;
    stats.triangles = cells.count * 10;
    stats.drawCalls++;
  }
  if (opts.textures !== false && T.hasCanvas()) {
    objects.push(skylinePanel(THREE, layout));
    stats.triangles += 192;
    stats.drawCalls++;
  }
  return { objects, stats };
}

function blocks(THREE, layout, cells) {
  const H = layout.terrain.height;
  const n = cells.count, d = cells.data;
  const pos = new Float32Array(n * 8 * 3), col = new Float32Array(n * 8 * 3);
  const idx = new Uint32Array(n * 30);
  let seed = 12345;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  for (let k = 0; k < n; k++) {
    const x = d[k * 5], nn = d[k * 5 + 1], w = d[k * 5 + 2] / 2, dd = d[k * 5 + 3] / 2, h = d[k * 5 + 4];
    const corners = [[x - w, nn - dd], [x + w, nn - dd], [x + w, nn + dd], [x - w, nn + dd]];
    // Stand on the lowest ground under the box, sink a little into the slope.
    let low = Infinity;
    for (const [cx, cn] of corners) low = Math.min(low, H(cx, cn));
    const top = H(x, nn) + h;
    // A cool grey, lighter and bluer with height, a little different each.
    const tall = Math.min(1, h / 120);
    const v = 0.5 + 0.14 * tall + (rnd() - 0.5) * 0.07;
    const r = lin(v * 0.97), g = lin(v), b = lin(v * 1.06);
    for (let c = 0; c < 8; c++) {
      const [cx, cn] = corners[c % 4];
      const o = (k * 8 + c) * 3;
      pos[o] = cx; pos[o + 1] = c < 4 ? low - 3 : top; pos[o + 2] = -cn;
      const shade = c < 4 ? 0.55 : 1;
      col[o] = r * shade; col[o + 1] = g * shade; col[o + 2] = b * shade;
    }
    const o = k * 30, v0 = k * 8;
    let q = o;
    idx[q++] = v0 + 4; idx[q++] = v0 + 5; idx[q++] = v0 + 6;
    idx[q++] = v0 + 4; idx[q++] = v0 + 6; idx[q++] = v0 + 7;
    for (let s = 0; s < 4; s++) {
      const a = v0 + s, bb = v0 + ((s + 1) % 4);
      idx[q++] = a; idx[q++] = bb; idx[q++] = bb + 4;
      idx[q++] = a; idx[q++] = bb + 4; idx[q++] = a + 4;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeBoundingSphere();
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  mat.name = 'Decor';
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'Decor_villes';
  mesh.matrixAutoUpdate = false;
  mesh.userData.layer = 'alentours';
  mesh.userData.exportSkip = true;
  mesh.userData.decor = true;
  return mesh;
}

/** The painted horizon: a cylinder round the camera, open at both ends, seen from inside. */
function skylinePanel(THREE, layout) {
  // Downtown lies at the frame's origin: put the towers in that direction from the zone's middle.
  const W = layout.map.world;
  const cx = (W.x0 + W.x1) / 2, cn = (W.n0 + W.n1) / 2;
  const s = layout.map.scale || 1;
  const far = Math.hypot(cx, cn) / s;
  // A cylinder's vertex at angle t sits at (X, Z) = (sin t, cos t), and u = t / 2π; a map direction (dx, dn) is (X, Z) = (dx, -dn).
  const theta = Math.atan2(-cx, cn);
  const u = ((theta / (Math.PI * 2)) % 1 + 1) % 1;
  const tex = T.skyline(THREE, { towers: far > 1500 ? u : 0.5, tall: far > 1500 ? 1 : 0.7 });
  const mat = new THREE.MeshBasicMaterial({
    map: tex, transparent: true, side: THREE.BackSide, depthWrite: false, fog: false, toneMapped: false,
  });
  mat.name = 'Horizon';
  const geo = new THREE.CylinderGeometry(PANEL_RADIUS, PANEL_RADIUS, PANEL_HEIGHT, 96, 1, true);
  geo.translate(0, PANEL_HEIGHT / 2 - 60, 0);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'Horizon_skyline';
  mesh.frustumCulled = false;
  mesh.renderOrder = -5;
  mesh.userData.layer = 'alentours';
  mesh.userData.exportSkip = true;
  mesh.userData.decor = true;
  // It rides with the camera, and takes the fog's colour, a little darker by
  // day and a little lighter by night, so the silhouettes read against the sky.
  const tint = new THREE.Color();
  mesh.onBeforeRender = (renderer, scene, camera) => {
    mesh.position.set(camera.position.x, 0, camera.position.z);
    mesh.updateMatrixWorld();
    if (scene.fog) {
      const lum = scene.fog.color.r * 0.3 + scene.fog.color.g * 0.59 + scene.fog.color.b * 0.11;
      tint.copy(scene.fog.color).multiplyScalar(lum > 0.2 ? 0.9 : 1.5);
      mat.color.copy(tint);
    }
  };
  return mesh;
}
