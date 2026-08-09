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
import { propParts, hasPropModel, propVariantCount } from './models.js';

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

  // --- shrub --------------------------------------------------------------
  // Two crossed quads rather than three: a bush is smaller than a tree and
  // seen from closer to eye level, where the third plane only shows up as a
  // seam. Four triangles, and hedges run to hundreds of them a street.
  const shrubPlanes = [];
  for (let k = 0; k < 2; k++) {
    const q = new THREE.PlaneGeometry(1.85, 1.5);
    q.rotateY((k * Math.PI) / 2);
    q.translate(0, 0.72, 0);
    shrubPlanes.push(tint(THREE, q, [1, 1, 1]));
  }
  const shrub = mergeUv(THREE, shrubPlanes);

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
    lamp, head, trunk, canopy, shrub,
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

// ---------------------------------------------------------------------------
// Tree species, by neighbourhood
// ---------------------------------------------------------------------------
//
// Montréal does not plant at random. A street was planted in one go, so it is
// silver maples for six blocks and then honey locusts for the next six — and
// the boroughs kept records of it. Picking a species per tree from a hash gets
// the variety but loses that, and the result reads as noise; picking one
// species for the whole city loses the variety. So the species comes from a
// low-frequency field instead of from the tree.
//
// The field is a jittered Voronoi: each cell of the grid hashes to a site
// somewhere inside itself, and a tree takes the species of the nearest site.
// Jittering matters — an unjittered grid gives straight species boundaries on
// exact multiples of the cell size, which is instantly readable as a grid.
const DISTRICT_CELL = 240;   // metres between species sites, ~two blocks
const STRAY_SHARE = 0.12;    // trees that take the runner-up species instead

/**
 * Which species belongs at this point.
 *
 * Deterministic in world metres, so a tree on a tile seam gets the same answer
 * from both tiles and no species boundary ever falls on a tile boundary.
 *
 * @param {number} x world metres
 * @param {number} z world metres
 * @param {number} count how many species are available
 * @returns {number} index in [0, count)
 */
export function speciesAt(x, z, count) {
  if (count <= 1) return 0;
  const cx = Math.floor(x / DISTRICT_CELL);
  const cz = Math.floor(z / DISTRICT_CELL);

  let bestD = Infinity, bestSeed = 0;
  let nextD = Infinity, nextSeed = 0;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const gx = cx + dx, gz = cz + dz;
      const seed = Math.imul(gx, 73856093) ^ Math.imul(gz, 19349663);
      const sx = (gx + hash01(seed)) * DISTRICT_CELL;
      const sz = (gz + hash01(seed ^ 0x5f356495)) * DISTRICT_CELL;
      const d = (sx - x) ** 2 + (sz - z) ** 2;
      if (d < bestD) {
        nextD = bestD; nextSeed = bestSeed;
        bestD = d; bestSeed = seed;
      } else if (d < nextD) {
        nextD = d; nextSeed = seed;
      }
    }
  }

  // A handful of trees take the neighbouring district's species. Without this
  // the boundaries are too clean to be believable: real streets have the odd
  // survivor from whatever was there before the replanting.
  const stray = hash01(Math.imul(Math.round(x * 8), 83492791) ^ Math.round(z * 8));
  const seed = (stray < STRAY_SHARE && nextD < Infinity) ? nextSeed : bestSeed;
  return Math.floor(hash01(seed ^ 0x2545f491) * count) % count;
}

/**
 * Per-species look for the procedural tree — used when no model was shipped,
 * and as the shape jitter on top of an authored one. Loosely: maple, ash,
 * hackberry, linden, spruce, honey locust.
 */
const SPECIES_LOOK = [
  { canopy: [0.33, 0.48, 0.24], spread: 1.10, lift: 1.00 },
  { canopy: [0.28, 0.44, 0.21], spread: 0.92, lift: 1.12 },
  { canopy: [0.39, 0.53, 0.27], spread: 1.18, lift: 0.92 },
  { canopy: [0.44, 0.55, 0.29], spread: 1.02, lift: 1.05 },
  { canopy: [0.24, 0.39, 0.25], spread: 0.72, lift: 1.28 },
  { canopy: [0.46, 0.57, 0.31], spread: 1.24, lift: 0.88 },
];

/**
 * How many species the world can draw on.
 *
 * When models were shipped this is exactly how many, so every species maps to
 * a distinct model. Taking the larger of the two instead would fold six
 * species onto two files and the field would come out as stripes.
 */
function speciesCount() {
  return propVariantCount('tree') || SPECIES_LOOK.length;
}

/** One tree, with its species already decided. */
function makeTree(x, z, scale, count) {
  const species = speciesAt(x, z, count);
  const look = SPECIES_LOOK[species % SPECIES_LOOK.length];
  // Same species, slightly different tree: age and light do that on a real
  // street, and without it a block of one species looks stamped.
  const j = (hash01(Math.round(x * 17 + z * 23)) - 0.5) * 0.07;
  return {
    x, z, scale, species,
    colour: [
      Math.max(0, Math.min(1, look.canopy[0] + j)),
      Math.max(0, Math.min(1, look.canopy[1] + j)),
      Math.max(0, Math.min(1, look.canopy[2] + j)),
    ],
  };
}

// Shrubs sit lower and in more shade than a canopy, so they read darker and
// slightly bluer than the tree palette.
const SHRUB_COLORS = [
  [0.24, 0.38, 0.20], [0.21, 0.34, 0.19], [0.29, 0.42, 0.22],
  [0.26, 0.40, 0.26], [0.33, 0.45, 0.24],
];

/** Winding number, so a bush lands inside a park and not in the pond next to it. */
function pointInPolygon(pts, x, z) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const zi = pts[i].z, zj = pts[j].z;
    if ((zi > z) !== (zj > z)) {
      const t = (z - zi) / (zj - zi);
      if (x < pts[i].x + t * (pts[j].x - pts[i].x)) inside = !inside;
    }
  }
  return inside;
}

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

  const species = speciesCount();
  const lamps = [];        // {x, z, yaw}
  const trees = [];        // {x, z, scale, species, colour}
  const signalsRed = [];
  const signalsGreen = [];
  const stops = [];
  const cars = [];         // {x, z, yaw, colour}
  const shrubs = [];       // {x, z, scale, colour}
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
        trees.push(makeTree(n.x, n.z,
          0.75 + hash01(Math.round(n.x * 13 + n.z * 7)) * 0.6, species));
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
        trees.push(makeTree(x, z,
          0.7 + hash01(seedBase + Math.round(d * 11)) * 0.7, species));
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

  // --- hedges ---------------------------------------------------------------
  // A hedge is mapped as a line, so it becomes a row of shrubs spaced closely
  // enough to close up. The jitter matters: a hedge planted on a perfect grid
  // reads as a fence, and OSM hedges are almost always along a lot line where
  // the eye is looking for something organic.
  if (opts.hedges !== false) {
    for (const barrier of args.barriers || []) {
      if (barrier.kind !== 'hedge') continue;
      const len = polylineLength(barrier.points);
      if (len < 2) continue;
      const seed = Math.round(barrier.points[0].x * 5 + barrier.points[0].z * 9);
      const height = 0.72 + hash01(seed) * 0.5;      // one hedge, one height
      for (let d = 0.4; d < len; d += 1.05) {
        sampleAt(barrier.points, d, s);
        const j = hash01(seed + Math.round(d * 31));
        const off = (j - 0.5) * 0.5;
        const x = s.x - s.tz * off;
        const z = s.z + s.tx * off;
        if (!insideBounds(bounds, x, z)) continue;
        shrubs.push({
          x, z,
          scale: height * (0.86 + j * 0.28),
          yaw: Math.atan2(s.tz, s.tx) + (j - 0.5) * 0.5,
          colour: SHRUB_COLORS[Math.floor(hash01(seed + Math.round(d * 7)) * SHRUB_COLORS.length) % SHRUB_COLORS.length],
        });
      }
    }

    // Loose bushes scattered through parks. Sampled on a jittered grid over
    // the polygon's bounding box and rejected outside it, which is far cheaper
    // than triangulating the park and does not care about concave shapes.
    for (const area of args.areas || []) {
      if (area.kind !== 'park' && area.kind !== 'garden'
          && area.kind !== 'scrub' && area.kind !== 'village_green') continue;
      const pts = area.points;
      if (pts.length < 3) continue;
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const p of pts) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.z < minZ) minZ = p.z;
        if (p.z > maxZ) maxZ = p.z;
      }
      if ((maxX - minX) * (maxZ - minZ) > 400000) continue;   // a whole forest
      const step = area.kind === 'scrub' ? 9 : 15;
      const seed = Math.round(minX * 3 + minZ * 7);
      for (let gx = minX + step / 2; gx < maxX; gx += step) {
        for (let gz = minZ + step / 2; gz < maxZ; gz += step) {
          const r = hash01(seed + Math.round(gx) * 131 + Math.round(gz));
          if (r > 0.55) continue;
          const x = gx + (hash01(r * 811) - 0.5) * step * 0.8;
          const z = gz + (hash01(r * 419 + 5) - 0.5) * step * 0.8;
          if (!insideBounds(bounds, x, z)) continue;
          if (!pointInPolygon(pts, x, z)) continue;
          shrubs.push({
            x, z,
            scale: 0.8 + r * 0.75,
            yaw: r * 6.28,
            colour: SHRUB_COLORS[Math.floor(r * 991) % SHRUB_COLORS.length],
          });
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

  const variants = propVariantCount('tree');
  if (variants > 0) {
    // Authored trees: one InstancedMesh per material per species. Grouping by
    // species is what lets a street be all maples — every tree in a group
    // shares a model, so the draw-call count is variants × materials, not one
    // per tree. Their own foliage colour is better than our tint, so instance
    // colours are left alone.
    const groups = new Map();
    for (const t of trees) {
      const v = t.species % variants;
      let g = groups.get(v);
      if (!g) { g = []; groups.set(v, g); }
      g.push(t);
    }
    for (const [v, items] of groups) {
      for (const part of propParts('tree', v)) {
        const mesh = addInstanced(part.geometry, part.material, items, placeTree);
        if (mesh) mesh.castShadow = !!args.shadows;
      }
    }
  } else {
    // Procedural: the species shows up as canopy colour and proportion —
    // a spruce narrow and tall, a hackberry wide and low.
    const shape = (it) => SPECIES_LOOK[it.species % SPECIES_LOOK.length];

    const trunkMesh = addInstanced(P.trunk, mats.vertex, trees, (d, it) => {
      d.position.set(it.x, lift(it.x, it.z), it.z);
      d.rotation.set(0, hash01(Math.round(it.x * 3 + it.z * 5)) * 6.28, 0);
      const s = shape(it);
      d.scale.set(it.scale, it.scale * s.lift, it.scale);
    });
    if (trunkMesh) trunkMesh.castShadow = !!args.shadows;

    const canopyMesh = addInstanced(P.canopy, mats.foliage, trees, (d, it) => {
      placeTree(d, it);
      const s = shape(it);
      d.scale.set(it.scale * s.spread, it.scale * s.lift, it.scale * s.spread);
    });
    if (canopyMesh) {
      canopyMesh.castShadow = !!args.shadows;
      for (let i = 0; i < trees.length; i++) {
        colour.setRGB(trees[i].colour[0], trees[i].colour[1], trees[i].colour[2]);
        canopyMesh.setColorAt(i, colour);
      }
      if (canopyMesh.instanceColor) canopyMesh.instanceColor.needsUpdate = true;
    }
  }

  const shrubMesh = addInstanced(P.shrub, mats.foliage, shrubs, (d, it) => {
    d.position.set(it.x, lift(it.x, it.z), it.z);
    d.rotation.set(0, it.yaw || 0, 0);
    d.scale.setScalar(it.scale);
  });
  if (shrubMesh) {
    shrubMesh.castShadow = !!args.shadows;
    for (let i = 0; i < shrubs.length; i++) {
      colour.setRGB(shrubs[i].colour[0], shrubs[i].colour[1], shrubs[i].colour[2]);
      shrubMesh.setColorAt(i, colour);
    }
    if (shrubMesh.instanceColor) shrubMesh.instanceColor.needsUpdate = true;
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

  // Species tally, so a tile can be checked for monoculture without having to
  // reach into the instanced meshes.
  const treeSpecies = {};
  for (const t of trees) treeSpecies[t.species] = (treeSpecies[t.species] || 0) + 1;

  return {
    group,
    colliders: new Float32Array(colliders),
    lampCount: lamps.length,
    shrubCount: shrubs.length,
    treeCount: trees.length,
    treeSpecies,
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
