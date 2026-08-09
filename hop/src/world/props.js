// Street furniture: lamps, trees, signals, stop signs, parked cars.
//
// This is where "it looks like a real street" is won or lost. Two rules:
//   - Use whatever OpenStreetMap actually mapped (lamps, trees, signals).
//   - Where the data is thin, synthesise along the road geometry, because an
//     empty kerb reads as broken far more than a slightly-wrong lamp spacing.
//
// Everything is instanced, so a tile with 400 lamps, 600 trees and 300 parked
// cars still costs about ten draw calls.

import { hash01 } from '../core/geo.js';
import { polylineLength, sampleAt } from './roads.js';
import { makeFoliageTexture } from './materials.js';
import { propParts, hasPropModel } from './models.js';

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/** Bake a colour into a geometry's vertex colours. */
function tint(THREE, geo, colour) {
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = colour[0];
    arr[i * 3 + 1] = colour[1];
    arr[i * 3 + 2] = colour[2];
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

/**
 * Merge indexed geometries that all carry position/normal/color.
 * (three.js ships a utility for this in its addons, which we deliberately do
 * not vendor — this is the twenty lines of it we actually need.)
 */
function merge(THREE, geos) {
  const pos = [], norm = [], col = [], idx = [];
  let offset = 0;
  for (const g of geos) {
    const p = g.attributes.position, n = g.attributes.normal, c = g.attributes.color;
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i));
      norm.push(n ? n.getX(i) : 0, n ? n.getY(i) : 1, n ? n.getZ(i) : 0);
      col.push(c ? c.getX(i) : 1, c ? c.getY(i) : 1, c ? c.getZ(i) : 1);
    }
    const index = g.getIndex();
    if (index) {
      for (let i = 0; i < index.count; i++) idx.push(index.getX(i) + offset);
    } else {
      for (let i = 0; i < p.count; i++) idx.push(i + offset);
    }
    offset += p.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(norm, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  out.setIndex(idx);
  out.computeBoundingSphere();
  return out;
}

/** Like merge(), but keeps UVs — the billboards need them. */
function mergeUv(THREE, geos) {
  const pos = [], norm = [], col = [], uv = [], idx = [];
  let offset = 0;
  for (const g of geos) {
    const p = g.attributes.position, n = g.attributes.normal;
    const c = g.attributes.color, t = g.attributes.uv;
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i));
      norm.push(n ? n.getX(i) : 0, n ? n.getY(i) : 1, n ? n.getZ(i) : 0);
      col.push(c ? c.getX(i) : 1, c ? c.getY(i) : 1, c ? c.getZ(i) : 1);
      uv.push(t ? t.getX(i) : 0, t ? t.getY(i) : 0);
    }
    const index = g.getIndex();
    if (index) for (let i = 0; i < index.count; i++) idx.push(index.getX(i) + offset);
    else for (let i = 0; i < p.count; i++) idx.push(i + offset);
    offset += p.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(norm, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  out.setIndex(idx);
  out.computeBoundingSphere();
  return out;
}

let prototypes = null;

/** Build the shared prop geometries once, then reuse them for every tile. */
function getPrototypes(THREE) {
  if (prototypes) return prototypes;

  const METAL = [0.22, 0.23, 0.25];
  const DARK = [0.13, 0.14, 0.16];

  // --- street lamp: tapered post with a gooseneck arm --------------------
  const post = new THREE.CylinderGeometry(0.075, 0.12, 6.0, 6);
  post.translate(0, 3.0, 0);
  const arm = new THREE.BoxGeometry(1.25, 0.09, 0.09);
  arm.translate(0.62, 5.95, 0);
  const lamp = merge(THREE, [tint(THREE, post, METAL), tint(THREE, arm, METAL)]);

  const head = new THREE.BoxGeometry(0.62, 0.16, 0.34);
  head.translate(1.2, 5.82, 0);
  tint(THREE, head, [1, 0.86, 0.62]);

  // --- tree ---------------------------------------------------------------
  // Trees are by far the most numerous prop — a dense Montréal tile holds
  // thousands — so every triangle here is multiplied by four figures. A
  // detail-0 icosahedron is 20 triangles and, at street scale under a canopy
  // colour, indistinguishable from the smoother version.
  const trunk = new THREE.CylinderGeometry(0.14, 0.21, 2.6, 5, 1, true);
  trunk.translate(0, 1.3, 0);
  tint(THREE, trunk, [0.30, 0.24, 0.19]);

  // Three quads crossed at 60°, each carrying an alpha-tested leaf mass. Six
  // triangles a tree instead of forty, and it reads as foliage rather than as
  // a faceted rock, because the silhouette is in the texture where it belongs.
  const canopyPlanes = [];
  for (let k = 0; k < 3; k++) {
    const q = new THREE.PlaneGeometry(5.2, 5.2);
    q.rotateY((k * Math.PI) / 3);
    q.translate(0, 3.8, 0);
    canopyPlanes.push(tint(THREE, q, [1, 1, 1]));
  }
  const canopy = mergeUv(THREE, canopyPlanes);

  // --- traffic signal -----------------------------------------------------
  const makeSignal = (lit) => {
    const p = new THREE.CylinderGeometry(0.07, 0.09, 4.6, 6);
    p.translate(0, 2.3, 0);
    const box = new THREE.BoxGeometry(0.34, 0.92, 0.28);
    box.translate(0, 4.9, 0);
    const bulb = new THREE.SphereGeometry(0.11, 8, 6);
    bulb.translate(0, lit === 'red' ? 5.2 : 4.6, 0.15);
    return merge(THREE, [
      tint(THREE, p, METAL),
      tint(THREE, box, DARK),
      tint(THREE, bulb, lit === 'red' ? [1.0, 0.16, 0.12] : [0.24, 1.0, 0.34]),
    ]);
  };

  // --- stop sign ----------------------------------------------------------
  const signPost = new THREE.CylinderGeometry(0.045, 0.045, 2.4, 5);
  signPost.translate(0, 1.2, 0);
  tint(THREE, signPost, METAL);

  const plate = new THREE.CircleGeometry(0.42, 8);
  plate.rotateY(Math.PI / 2);
  plate.translate(0.02, 2.3, 0);

  // --- parked car ---------------------------------------------------------
  const body = new THREE.BoxGeometry(4.25, 0.86, 1.78);
  body.translate(0, 0.72, 0);
  tint(THREE, body, [1, 1, 1]);           // per-instance colour replaces this

  const cabin = new THREE.BoxGeometry(2.15, 0.62, 1.62);
  cabin.translate(-0.15, 1.44, 0);
  const wheels = [];
  for (const wx of [1.35, -1.35]) {
    for (const wz of [0.86, -0.86]) {
      const w = new THREE.CylinderGeometry(0.33, 0.33, 0.22, 8);
      w.rotateX(Math.PI / 2);
      w.translate(wx, 0.33, wz);
      wheels.push(tint(THREE, w, [0.08, 0.08, 0.09]));
    }
  }
  const carTrim = merge(THREE, [tint(THREE, cabin, [0.10, 0.12, 0.15]), ...wheels]);

  // --- light pool ---------------------------------------------------------
  const pool = new THREE.PlaneGeometry(13, 13);
  pool.rotateX(-Math.PI / 2);

  prototypes = {
    lamp, head, trunk, canopy,
    signalRed: makeSignal('red'), signalGreen: makeSignal('green'),
    signPost, plate, body, carTrim, pool,
  };
  return prototypes;
}

/** The red octagon with ARRÊT on it — Québec's stop sign. */
let stopTexture = null;
function getStopTexture(THREE) {
  if (stopTexture) return stopTexture;
  const s = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, s, s);
  g.fillStyle = '#b8231f';
  g.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    const x = s / 2 + Math.cos(a) * (s / 2 - 2);
    const y = s / 2 + Math.sin(a) * (s / 2 - 2);
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.closePath();
  g.fill();
  g.strokeStyle = '#f2f0ea';
  g.lineWidth = 5;
  g.stroke();
  g.fillStyle = '#f6f4ee';
  g.font = 'bold 34px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('ARRÊT', s / 2, s / 2 + 2);

  stopTexture = new THREE.CanvasTexture(cv);
  stopTexture.colorSpace = THREE.SRGBColorSpace;
  return stopTexture;
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

const CAR_COLORS = [
  [0.75, 0.76, 0.78], [0.14, 0.15, 0.17], [0.55, 0.57, 0.60], [0.72, 0.19, 0.17],
  [0.16, 0.28, 0.48], [0.90, 0.90, 0.88], [0.25, 0.42, 0.30], [0.55, 0.42, 0.24],
  [0.32, 0.34, 0.38], [0.82, 0.72, 0.30],
];

const CANOPY_COLORS = [
  [0.33, 0.48, 0.24], [0.28, 0.44, 0.21], [0.39, 0.53, 0.27],
  [0.44, 0.55, 0.29], [0.30, 0.41, 0.23],
];

function insideBounds(b, x, z, margin = 0) {
  return x >= b.x0 - margin && x <= b.x1 + margin && z >= b.z0 - margin && z <= b.z1 + margin;
}

/**
 * @param {object} args
 * @param {Array} args.nodes    {x, z, kind}
 * @param {Array} args.roads    clipped to the tile: {points, spec}
 * @param {Map}   args.junctions
 * @param {object} args.bounds  tile rect
 * @param {object} args.opts    {trees, parkedCars, lamps, quality}
 * @returns {{group, colliders:Float32Array, lampCount:number}}
 */
export function buildProps(THREE, args) {
  const { nodes, roads, junctions, bounds } = args;
  const opts = args.opts || {};
  const P = getPrototypes(THREE);

  const lamps = [];        // {x, z, yaw}
  const trees = [];        // {x, z, scale, colour}
  const signalsRed = [];
  const signalsGreen = [];
  const stops = [];
  const cars = [];         // {x, z, yaw, colour}
  const colliders = [];

  // --- mapped features ------------------------------------------------------
  let mappedLamps = 0, mappedTrees = 0;
  for (const n of nodes) {
    if (!insideBounds(bounds, n.x, n.z)) continue;
    switch (n.kind) {
      case 'street_lamp': {
        const dir = roadDirectionNear(roads, n.x, n.z);
        lamps.push({ x: n.x, z: n.z, yaw: dir.towards });
        mappedLamps++;
        break;
      }
      case 'tree':
        trees.push({
          x: n.x, z: n.z,
          scale: 0.75 + hash01(Math.round(n.x * 13 + n.z * 7)) * 0.6,
          colour: CANOPY_COLORS[Math.floor(hash01(Math.round(n.x * 31 + n.z * 17)) * CANOPY_COLORS.length) % CANOPY_COLORS.length],
        });
        mappedTrees++;
        break;
      case 'traffic_signals': {
        const dir = roadDirectionNear(roads, n.x, n.z);
        (hash01(Math.round(n.x + n.z * 3)) > 0.5 ? signalsRed : signalsGreen)
          .push({ x: n.x, z: n.z, yaw: dir.towards });
        break;
      }
      case 'stop': {
        const dir = roadDirectionNear(roads, n.x, n.z);
        stops.push({ x: n.x, z: n.z, yaw: dir.towards });
        break;
      }
      default:
        break;
    }
  }

  // --- synthesised furniture -----------------------------------------------
  let roadMetres = 0;
  for (const r of roads) roadMetres += polylineLength(r.points);

  const wantLamps = opts.lamps !== false && mappedLamps < roadMetres / 70;
  const wantTrees = opts.trees !== false && mappedTrees < roadMetres / 40;

  const s = { x: 0, z: 0, tx: 0, tz: 0 };
  for (const road of roads) {
    const spec = road.spec;
    if (!spec) continue;
    const len = polylineLength(road.points);
    if (len < 12) continue;
    const seedBase = Math.round(road.points[0].x * 7 + road.points[0].z * 13);

    // Lamps, alternating sides every ~32 m.
    if (wantLamps && spec.kind !== 'alley') {
      const spacing = spec.kind === 'major' ? 30 : 34;
      let flip = 0;
      for (let d = spacing * 0.5; d < len - 4; d += spacing) {
        sampleAt(road.points, d, s);
        const side = (flip++ % 2 === 0) ? 1 : -1;
        const off = spec.width / 2 + spec.sidewalk * 0.55 + 0.35;
        const x = s.x - s.tz * side * off;
        const z = s.z + s.tx * side * off;
        if (!insideBounds(bounds, x, z)) continue;
        if (nearJunction(junctions, x, z, 7)) continue;
        lamps.push({ x, z, yaw: Math.atan2(s.tz * side, s.tx * side) + Math.PI });
      }
    }

    // Street trees on the residential verge.
    if (wantTrees && (spec.highway === 'residential' || spec.highway === 'unclassified'
                      || spec.highway === 'living_street' || spec.highway === 'tertiary')) {
      const spacing = 11;
      for (let d = 6; d < len - 4; d += spacing) {
        const r = hash01(seedBase + Math.round(d * 3));
        if (r < 0.28) continue;
        const side = r > 0.64 ? 1 : -1;
        sampleAt(road.points, d, s);
        const off = spec.width / 2 + spec.sidewalk + spec.verge * 0.45;
        const x = s.x - s.tz * side * off;
        const z = s.z + s.tx * side * off;
        if (!insideBounds(bounds, x, z)) continue;
        if (nearJunction(junctions, x, z, 8)) continue;
        trees.push({
          x, z,
          scale: 0.7 + hash01(seedBase + Math.round(d * 11)) * 0.7,
          colour: CANOPY_COLORS[Math.floor(hash01(seedBase + Math.round(d * 5)) * CANOPY_COLORS.length) % CANOPY_COLORS.length],
        });
      }
    }

    // Parked cars in the kerbside lane. Montréal streets are lined with them,
    // and they are what makes a residential street feel inhabited.
    if (opts.parkedCars !== false && spec.width >= 7.2 && spec.kind !== 'alley'
        && spec.highway !== 'motorway' && spec.highway !== 'trunk') {
      const density = spec.kind === 'major' ? 0.35 : 0.72;
      for (let d = 5; d < len - 6; d += 6.4) {
        for (const side of [-1, 1]) {
          const r = hash01(seedBase + Math.round(d * 17) + (side > 0 ? 991 : 0));
          if (r > density) continue;
          sampleAt(road.points, d, s);
          const off = spec.width / 2 - 1.15;
          const x = s.x - s.tz * side * off;
          const z = s.z + s.tx * side * off;
          if (!insideBounds(bounds, x, z, -2)) continue;
          if (nearJunction(junctions, x, z, 11)) continue;
          const yaw = Math.atan2(s.tx * side, -s.tz * side) + Math.PI / 2;
          const colour = CAR_COLORS[Math.floor(r * 997) % CAR_COLORS.length];
          cars.push({ x, z, yaw: Math.atan2(s.tz, s.tx), colour });
          void yaw;
          // Parked cars are solid: four segments round the body.
          pushBoxSegments(colliders, x, z, Math.atan2(s.tz, s.tx), 4.3, 1.8);
        }
      }
    }
  }

  // --- build the instanced meshes ------------------------------------------
  const group = new THREE.Group();
  const dummy = new THREE.Object3D();
  const colour = new THREE.Color();

  const addInstanced = (geo, material, items, apply) => {
    if (!items.length) return null;
    const mesh = new THREE.InstancedMesh(geo, material, items.length);
    mesh.frustumCulled = true;
    for (let i = 0; i < items.length; i++) {
      apply(dummy, items[i], i);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    group.add(mesh);
    return mesh;
  };

  const mats = args.materials;

  const lift = args.groundAt || (() => 0);
  const placeUpright = (d, it) => {
    d.position.set(it.x, lift(it.x, it.z), it.z);
    d.rotation.set(0, it.yaw || 0, 0);
    d.scale.set(1, 1, 1);
  };

  let headMesh = null;
  if (hasPropModel('lamp')) {
    for (const part of propParts('lamp')) {
      const mesh = addInstanced(part.geometry, part.material, lamps, placeUpright);
      if (mesh) mesh.castShadow = !!args.shadows;
    }
  } else {
    const lampMesh = addInstanced(P.lamp, mats.metal, lamps, placeUpright);
    headMesh = addInstanced(P.head, mats.lampHead, lamps, placeUpright);
    if (lampMesh) lampMesh.castShadow = !!args.shadows;
  }

  const poolMesh = addInstanced(P.pool, mats.lightPool, lamps, (d, it) => {
    const px = it.x + Math.cos(it.yaw) * 1.2, pz = it.z + Math.sin(it.yaw) * 1.2;
    d.position.set(px, lift(px, pz) + 0.04, pz);
    d.rotation.set(0, 0, 0);
    d.scale.set(1, 1, 1);
  });
  if (poolMesh) poolMesh.renderOrder = 2;

  const placeTree = (d, it) => {
    d.position.set(it.x, lift(it.x, it.z), it.z);
    d.rotation.set(0, hash01(Math.round(it.x * 7 + it.z * 11)) * 6.28, 0);
    d.scale.setScalar(it.scale);
  };

  if (hasPropModel('tree')) {
    // An authored tree: one InstancedMesh per material, all sharing the same
    // per-tree transforms. Its own foliage colour is better than our tint, so
    // instance colours are left alone.
    for (const part of propParts('tree')) {
      const mesh = addInstanced(part.geometry, part.material, trees, placeTree);
      if (mesh) mesh.castShadow = !!args.shadows;
    }
  } else {
    const trunkMesh = addInstanced(P.trunk, mats.vertex, trees, (d, it) => {
      d.position.set(it.x, lift(it.x, it.z), it.z);
      d.rotation.set(0, hash01(Math.round(it.x * 3 + it.z * 5)) * 6.28, 0);
      d.scale.setScalar(it.scale);
    });
    if (trunkMesh) trunkMesh.castShadow = !!args.shadows;

    const canopyMesh = addInstanced(P.canopy, mats.foliage, trees, placeTree);
    if (canopyMesh) {
      canopyMesh.castShadow = !!args.shadows;
      for (let i = 0; i < trees.length; i++) {
        colour.setRGB(trees[i].colour[0], trees[i].colour[1], trees[i].colour[2]);
        canopyMesh.setColorAt(i, colour);
      }
      if (canopyMesh.instanceColor) canopyMesh.instanceColor.needsUpdate = true;
    }
  }

  addInstanced(P.signalRed, mats.vertex, signalsRed, placeUpright);
  addInstanced(P.signalGreen, mats.vertex, signalsGreen, placeUpright);
  addInstanced(P.signPost, mats.vertex, stops, placeUpright);
  addInstanced(P.plate, mats.stopSign, stops, placeUpright);

  const bodyMesh = addInstanced(P.body, mats.vertex, cars, placeUpright);
  if (bodyMesh) {
    bodyMesh.castShadow = !!args.shadows;
    for (let i = 0; i < cars.length; i++) {
      colour.setRGB(cars[i].colour[0], cars[i].colour[1], cars[i].colour[2]);
      bodyMesh.setColorAt(i, colour);
    }
    if (bodyMesh.instanceColor) bodyMesh.instanceColor.needsUpdate = true;
  }
  addInstanced(P.carTrim, mats.vertex, cars, placeUpright);

  return {
    group,
    colliders: new Float32Array(colliders),
    lampCount: lamps.length,
    poolMesh,
    headMesh,
  };
}

function pushBoxSegments(out, cx, cz, yaw, length, width) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const hx = length / 2, hz = width / 2;
  const corners = [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]]
    .map(([x, z]) => [cx + x * c - z * s, cz + x * s + z * c]);
  for (let i = 0; i < 4; i++) {
    const a = corners[i], b = corners[(i + 1) % 4];
    out.push(a[0], a[1], b[0], b[1]);
  }
}

function nearJunction(junctions, x, z, radius) {
  const cells = Math.ceil(radius * 2.5);
  const cx = Math.round(x * 2.5), cz = Math.round(z * 2.5);
  for (let i = -cells; i <= cells; i += 1) {
    for (let j = -cells; j <= cells; j += 1) {
      if (junctions.has(`${cx + i}|${cz + j}`)) return true;
    }
  }
  return false;
}

/** Direction of the nearest road, used to aim lamps and signs at the street. */
function roadDirectionNear(roads, x, z) {
  let best = { towards: 0, dist: Infinity };
  for (const road of roads) {
    const pts = road.points;
    for (let i = 1; i < pts.length; i++) {
      const ax = pts[i - 1].x, az = pts[i - 1].z;
      const dx = pts[i].x - ax, dz = pts[i].z - az;
      const l2 = dx * dx + dz * dz;
      if (l2 < 1e-6) continue;
      let t = ((x - ax) * dx + (z - az) * dz) / l2;
      t = Math.max(0, Math.min(1, t));
      const px = ax + dx * t, pz = az + dz * t;
      const d = (px - x) ** 2 + (pz - z) ** 2;
      if (d < best.dist) best = { towards: Math.atan2(pz - z, px - x), dist: d };
    }
  }
  return best;
}

/** Materials shared by every tile's props. Built once. */
export function makePropMaterials(THREE) {
  return {
    vertex: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0 }),
    foliage: new THREE.MeshStandardMaterial({
      map: makeFoliageTexture(THREE),
      alphaTest: 0.42,
      side: THREE.DoubleSide,
      roughness: 0.92,
      metalness: 0,
      vertexColors: true,
    }),
    metal: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.8 }),
    lampHead: new THREE.MeshBasicMaterial({ vertexColors: true }),
    stopSign: new THREE.MeshBasicMaterial({
      map: getStopTexture(THREE), transparent: true, side: THREE.DoubleSide,
    }),
    lightPool: null,   // filled in by the world, which owns the night cycle
  };
}
