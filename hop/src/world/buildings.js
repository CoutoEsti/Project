// Buildings: footprints extruded into one merged mesh per tile.
//
// Two geometries come out of this — walls (textured with a tiling window
// pattern, lit from inside after dark) and caps (roofs, parapets and the
// outdoor staircases that make a Montréal street read as a Montréal street).
// Both use vertex colours, so a whole tile of buildings is two draw calls.

import { hash01, ringArea, ringCentroid } from '../core/geo.js';

const FLOOR_HEIGHT = 3.2;
const BAY_WIDTH = 3.6;        // one window bay, metres — must match the texture
const TEX_BAYS = 16;
const TEX_FLOORS = 16;
const STYLE_BANDS = 4;
const BAND_WIDTH = (BAY_WIDTH * TEX_BAYS) / STYLE_BANDS;   // metres per family

/** Which façade family a building belongs to. */
function facadeBand(tags, seed, height) {
  const t = tags.building;
  if (t === 'retail' || t === 'supermarket' || tags.shop) return 2;
  if (t === 'commercial' || t === 'office' || t === 'industrial'
      || t === 'warehouse' || height > 22) return 3;
  const material = tags['building:material'];
  if (material === 'stone' || material === 'limestone') return 1;
  const r = hash01(seed * 41 + 7);
  if (r < 0.52) return 0;
  if (r < 0.74) return 1;
  if (r < 0.88) return 2;
  return 3;
}

function num(v) {
  if (v == null) return NaN;
  const m = String(v).match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : NaN;
}

/** Height in metres, from tags where possible and from the building type otherwise. */
export function heightFor(tags) {
  const h = num(tags.height ?? tags['building:height']);
  if (Number.isFinite(h) && h > 1) return Math.min(h, 320);

  const levels = num(tags['building:levels']);
  if (Number.isFinite(levels) && levels >= 1) return Math.min(levels * FLOOR_HEIGHT + 1.1, 320);

  const type = tags.building;
  switch (type) {
    case 'house': case 'detached': case 'bungalow': return 7.0;
    case 'garage': case 'garages': case 'shed': case 'hut': return 3.0;
    case 'terrace': case 'semidetached_house': return 9.5;
    case 'apartments': case 'residential': return 11.5;
    case 'commercial': case 'office': return 14.0;
    case 'retail': case 'supermarket': return 8.0;
    case 'industrial': case 'warehouse': return 9.0;
    case 'church': case 'cathedral': case 'chapel': return 17.0;
    case 'school': case 'university': case 'hospital': return 12.5;
    default: return 9.5;
  }
}

// Montréal's building stock in five families: red brick, grey limestone,
// beige/ochre brick, painted render, and darker brown brick.
const WALL_COLORS = [
  [0.60, 0.35, 0.27], [0.55, 0.31, 0.24], [0.66, 0.42, 0.30],
  [0.60, 0.59, 0.55], [0.55, 0.54, 0.50],
  [0.73, 0.65, 0.50], [0.78, 0.71, 0.56],
  [0.68, 0.65, 0.60], [0.49, 0.47, 0.44],
  [0.46, 0.33, 0.26],
];

function wallColor(tags, seed) {
  const material = tags['building:material'] || tags['building:facade:material'];
  let pool = WALL_COLORS;
  if (material === 'brick') pool = [WALL_COLORS[0], WALL_COLORS[1], WALL_COLORS[2], WALL_COLORS[9]];
  else if (material === 'stone' || material === 'limestone') pool = [WALL_COLORS[3], WALL_COLORS[4], WALL_COLORS[7]];
  else if (material === 'concrete') pool = [WALL_COLORS[7], WALL_COLORS[8]];

  const base = pool[Math.floor(hash01(seed) * pool.length) % pool.length];
  // Small per-building tint so identical rows do not look copy-pasted.
  const j = (hash01(seed * 7 + 11) - 0.5) * 0.06;
  return [
    Math.max(0, Math.min(1, base[0] + j)),
    Math.max(0, Math.min(1, base[1] + j)),
    Math.max(0, Math.min(1, base[2] + j)),
  ];
}

/** Accumulator for one merged mesh. */
class MeshBuilder {
  constructor(withUv) {
    this.pos = [];
    this.norm = [];
    this.col = [];
    this.uv = withUv ? [] : null;
    this.idx = [];
  }
  get count() { return this.pos.length / 3; }

  tri(a, b, c) { this.idx.push(a, b, c); }

  vertex(x, y, z, nx, ny, nz, r, g, bl, u, v) {
    this.pos.push(x, y, z);
    this.norm.push(nx, ny, nz);
    this.col.push(r, g, bl);
    if (this.uv) this.uv.push(u || 0, v || 0);
    return this.count - 1;
  }

  /**
   * A wall, UV-mapped into one façade family's band of the atlas.
   *
   * The band is only BAND_WIDTH metres of texture, so a wall longer than that
   * has to be cut into pieces that each restart at the band's left edge.
   * Without the cut, a wide building would walk across the sheet and change
   * architectural style halfway along its own facade.
   *
   * @param {number} bandStart metres offset of this family in the atlas
   * @param {number} occ 0 = open to the sky, 1 = wedged against a neighbour
   */
  wall(ax, az, bx, bz, y0, y1, uStart, bandStart, colour, occ = 0) {
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len < 0.05) return;
    const nx = dz / len, nz = -dx / len;
    const uSpan = BAY_WIDTH * TEX_BAYS;
    const vSpan = FLOOR_HEIGHT * TEX_FLOORS;
    const v0 = y0 / vSpan;
    const v1 = y1 / vSpan;

    // A wall facing a neighbour a few metres away sees almost no sky. This is
    // the single biggest thing separating a street from a set of loose boxes.
    const shade = 1 - occ * 0.38;
    const [r, g, b] = colour;
    const rt = r * shade, gt = g * shade, bt = b * shade;
    // Ground contact stays darker still: the pavement bounces less light up
    // than the sky pours down, and interpolating up the quad gives a gradient.
    const foot = 0.74;
    const rb = rt * foot, gb = gt * foot, bb = bt * foot;

    let done = 0;
    let off = ((uStart % BAND_WIDTH) + BAND_WIDTH) % BAND_WIDTH;
    while (done < len - 1e-4) {
      const chunk = Math.min(len - done, BAND_WIDTH - off);
      const t0 = done / len, t1 = (done + chunk) / len;
      const cx0 = ax + dx * t0, cz0 = az + dz * t0;
      const cx1 = ax + dx * t1, cz1 = az + dz * t1;
      const u0 = (bandStart + off) / uSpan;
      const u1 = (bandStart + off + chunk) / uSpan;

      const i = this.count;
      this.vertex(cx0, y0, cz0, nx, 0, nz, rb, gb, bb, u0, v0);
      this.vertex(cx1, y0, cz1, nx, 0, nz, rb, gb, bb, u1, v0);
      this.vertex(cx1, y1, cz1, nx, 0, nz, rt, gt, bt, u1, v1);
      this.vertex(cx0, y1, cz0, nx, 0, nz, rt, gt, bt, u0, v1);
      this.tri(i, i + 1, i + 2);
      this.tri(i, i + 2, i + 3);

      done += chunk;
      off += chunk;
      if (off >= BAND_WIDTH - 1e-6) off = 0;
    }
  }

  /** An axis-aligned box, used for parapets, steps and railings. */
  box(cx, cy, cz, sx, sy, sz, yaw, colour) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const hx = sx / 2, hy = sy / 2, hz = sz / 2;
    const [r, g, b] = colour;
    const corners = [
      [-hx, -hy, -hz], [hx, -hy, -hz], [hx, hy, -hz], [-hx, hy, -hz],
      [-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz],
    ].map(([x, y, z]) => [cx + x * c - z * s, cy + y, cz + x * s + z * c]);

    const faces = [
      [[0, 3, 2, 1], [0, 0, -1]], [[4, 5, 6, 7], [0, 0, 1]],
      [[0, 1, 5, 4], [0, -1, 0]], [[3, 7, 6, 2], [0, 1, 0]],
      [[0, 4, 7, 3], [-1, 0, 0]], [[1, 2, 6, 5], [1, 0, 0]],
    ];
    for (const [quad, n] of faces) {
      const nx = n[0] * c - n[2] * s, nz = n[0] * s + n[2] * c;
      const i = this.count;
      for (const k of quad) {
        const p = corners[k];
        this.vertex(p[0], p[1], p[2], nx, n[1], nz, r, g, b, 0, 0);
      }
      this.tri(i, i + 1, i + 2);
      this.tri(i, i + 2, i + 3);
    }
  }

  toGeometry(THREE) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(this.norm, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    if (this.uv) geo.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    geo.setIndex(this.idx);
    geo.computeBoundingSphere();
    return geo;
  }
}

/**
 * @param {object} THREE
 * @param {Array} buildings  {points:[{x,z}], tags, id}
 * @param {Array} roads      used only to orient the outdoor staircases
 * @param {object} opts      {staircases:boolean}
 * @returns {{walls, caps, colliders:Float32Array, count:number}}
 */
export function buildBuildings(THREE, buildings, roads, opts = {}) {
  const walls = new MeshBuilder(true);
  const caps = new MeshBuilder(false);
  const colliders = [];
  let built = 0;

  // --- pass 1: measure ------------------------------------------------------
  // Geometry cannot be emitted until every neighbour is known, because how
  // dark a wall should be depends on what is standing in front of it.
  const prepared = [];
  for (const b of buildings) {
    const ring = dedupeRing(b.points);
    if (ring.length < 3) continue;
    const area = Math.abs(ringArea(ring));
    if (area < 6) continue;                 // sheds and mapping noise

    const tags = b.tags || {};
    const seed = hashId(b.id);
    const height = heightFor(tags);
    // A footprint on a slope has to start at its lowest corner and be buried
    // deep enough that no gap opens under the uphill wall.
    let base = 0, foot = 0;
    if (opts.groundAt) {
      let lo = Infinity, hi = -Infinity;
      for (const p of ring) {
        const h = opts.groundAt(p.x, p.z);
        if (h < lo) lo = h;
        if (h > hi) hi = h;
      }
      base = lo;
      foot = Math.min(6, hi - lo + 0.6);
    }
    prepared.push({
      base, foot,
      ring: ringArea(ring) > 0 ? ring : ring.slice().reverse(),
      area, seed, height, tags,
      colour: wallColor(tags, seed),
      bandStart: facadeBand(tags, seed, height) * BAND_WIDTH,
    });
  }

  const neighbours = new EdgeGrid(prepared);

  // --- pass 2: emit ---------------------------------------------------------
  for (let bi = 0; bi < prepared.length; bi++) {
    const { ring: ordered, area, seed, height, colour, bandStart, base, foot } = prepared[bi];
    const b = { tags: prepared[bi].tags, id: seed };

    // Cumulative distance keeps window bays running around corners rather
    // than restarting at each one.
    let u = hash01(seed * 3 + 5) * BAND_WIDTH;

    for (let i = 0; i < ordered.length; i++) {
      const a = ordered[i];
      const c = ordered[(i + 1) % ordered.length];
      const len = Math.hypot(c.x - a.x, c.z - a.z);
      if (len < 0.05) continue;
      const occ = neighbours.occlusion(a, c, len, bi);
      walls.wall(a.x, a.z, c.x, c.z, base - foot, base + height, u, bandStart, colour, occ);
      u += len;
      colliders.push(a.x, a.z, c.x, c.z);
    }

    // Roof
    const roofColour = [colour[0] * 0.5 + 0.10, colour[1] * 0.5 + 0.10, colour[2] * 0.5 + 0.11];
    addCap(THREE, caps, ordered, base + height, roofColour);

    // Parapet: a thin lip around flat roofs. Cheap, and it stops the roofline
    // from looking like a sheet of paper.
    if (height > 5 && area > 150) {
      const parapetColour = [roofColour[0] * 1.15, roofColour[1] * 1.15, roofColour[2] * 1.15];
      for (let i = 0; i < ordered.length; i++) {
        const a = ordered[i];
        const c = ordered[(i + 1) % ordered.length];
        const len = Math.hypot(c.x - a.x, c.z - a.z);
        if (len < 0.4) continue;
        const yaw = Math.atan2(c.z - a.z, c.x - a.x);
        caps.box((a.x + c.x) / 2, base + height + 0.30, (a.z + c.z) / 2,
                 len, 0.60, 0.52, yaw, parapetColour);
        // Cornice: a second, wider band just under the roofline. Two boxes an
        // edge is cheap, and it is what gives a row of triplexes a skyline.
        caps.box((a.x + c.x) / 2, base + height - 0.34, (a.z + c.z) / 2,
                 len, 0.34, 0.78, yaw, parapetColour);
      }
    }

    // Rooftop clutter on the bigger flat roofs.
    if (opts.rooftops !== false && area > 260 && hash01(seed * 13) > 0.45) {
      const c0 = ringCentroid(ordered);
      const w = 2.2 + hash01(seed * 17) * 3;
      caps.box(c0.x, base + height + 0.9, c0.z, w, 1.8, w * 0.7,
               hash01(seed * 19) * Math.PI, [0.42, 0.42, 0.44]);
    }

    // The Montréal staircase.
    if (opts.staircases && area > 55 && area < 420) {
      const levels = num((b.tags || {})['building:levels']);
      const isWalkup = (Number.isFinite(levels) ? levels >= 2 && levels <= 4 : height >= 7 && height <= 14);
      if (isWalkup && hash01(seed * 23) > 0.25) {
        addStaircase(caps, ordered, roads, colour, seed, base);
      }
    }

    built++;
  }

  return {
    walls: walls.count ? walls.toGeometry(THREE) : null,
    caps: caps.count ? caps.toGeometry(THREE) : null,
    colliders: new Float32Array(colliders),
    count: built,
  };
}

/**
 * A uniform grid of every building edge, used to ask "is anything standing
 * just outside this wall?".
 *
 * A true ambient-occlusion bake would trace rays against the neighbours; that
 * is minutes of work per tile, not milliseconds. Counting how much geometry
 * sits within a few metres of a probe point in front of the wall captures most
 * of the same signal — alleys go dark, courtyards go dark, a facade on an open
 * boulevard stays bright — for one grid lookup per wall.
 */
class EdgeGrid {
  constructor(buildings, cell = 12) {
    this.cell = cell;
    this.cells = new Map();
    for (let bi = 0; bi < buildings.length; bi++) {
      const ring = buildings[bi].ring;
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i];
        const c = ring[(i + 1) % ring.length];
        const mx = (a.x + c.x) / 2, mz = (a.z + c.z) / 2;
        this._push(mx, mz, bi);
        // Long edges need more than their midpoint to be findable.
        const len = Math.hypot(c.x - a.x, c.z - a.z);
        for (let d = cell; d < len; d += cell) {
          const t = d / len;
          this._push(a.x + (c.x - a.x) * t, a.z + (c.z - a.z) * t, bi);
        }
      }
    }
  }

  _push(x, z, bi) {
    const k = `${Math.floor(x / this.cell)}|${Math.floor(z / this.cell)}`;
    let list = this.cells.get(k);
    if (!list) { list = []; this.cells.set(k, list); }
    list.push(x, z, bi);
  }

  /** 0 when the wall faces open space, 1 when it is boxed in. */
  occlusion(a, c, len, self) {
    // Probe a few metres out from the middle of the wall, along its normal.
    const nx = (c.z - a.z) / len, nz = -(c.x - a.x) / len;
    const px = (a.x + c.x) / 2 + nx * 4.5;
    const pz = (a.z + c.z) / 2 + nz * 4.5;

    const cx = Math.floor(px / this.cell), cz = Math.floor(pz / this.cell);
    let near = 0;
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        const list = this.cells.get(`${cx + i}|${cz + j}`);
        if (!list) continue;
        for (let k = 0; k < list.length; k += 3) {
          if (list[k + 2] === self) continue;
          const dx = list[k] - px, dz = list[k + 1] - pz;
          if (dx * dx + dz * dz < 49) near++;      // within 7 m
        }
      }
    }
    return Math.min(1, near / 4);
  }
}

function hashId(id) {
  if (typeof id === 'number') return id;
  let h = 2166136261;
  const s = String(id);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function dedupeRing(points) {
  const out = [];
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) continue;
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 1e-4 && Math.abs(last.z - p.z) < 1e-4) continue;
    out.push(p);
  }
  // OSM closes rings by repeating the first node.
  if (out.length > 1) {
    const a = out[0], b = out[out.length - 1];
    if (Math.abs(a.x - b.x) < 1e-4 && Math.abs(a.z - b.z) < 1e-4) out.pop();
  }
  return out;
}

/** Triangulate the footprint and lay it flat at `y`. */
function addCap(THREE, mb, ring, y, colour) {
  const contour = ring.map((p) => new THREE.Vector2(p.x, p.z));
  let tris;
  try {
    tris = THREE.ShapeUtils.triangulateShape(contour, []);
  } catch {
    tris = null;
  }
  if (!tris || !tris.length) {
    // Fan fallback: wrong for concave shapes but never crashes, and a roof
    // seen from a car is a silhouette more than a surface.
    tris = [];
    for (let i = 1; i < ring.length - 1; i++) tris.push([0, i, i + 1]);
  }
  const base = mb.count;
  const [r, g, b] = colour;
  for (const p of ring) mb.vertex(p.x, y, p.z, 0, 1, 0, r, g, b, 0, 0);
  for (const t of tris) {
    // Ring is counter-clockwise in XZ, which is clockwise seen from above,
    // so wind the triangle backwards to face +Y.
    mb.tri(base + t[0], base + t[2], base + t[1]);
  }
}

/**
 * An exterior staircase on the street-facing wall: curved-ish flight up to the
 * first floor, with two railings. Placed on whichever edge faces the nearest
 * road, so it never ends up in a back yard.
 */
function addStaircase(mb, ring, roads, wallColour, seed, base = 0) {
  const centre = ringCentroid(ring);
  const target = nearestRoadTarget(roads, centre.x, centre.z);
  if (!target) return;

  // Edge whose midpoint is closest to the road, and which faces outward.
  let bestEdge = null, bestScore = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len < 3.5) continue;
    const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
    const d = Math.hypot(mx - target.x, mz - target.z);
    if (d < bestScore) { bestScore = d; bestEdge = { a, b, mx, mz, len }; }
  }
  // Only on buildings that actually front a street. Beyond this the stair
  // ends up marooned in the middle of a garden, which is what made them read
  // as random concrete blocks by the roadside.
  if (!bestEdge || bestScore > 22) return;

  const { a, b, mx, mz, len } = bestEdge;
  // Outward normal: away from the building centre.
  let nx = (b.z - a.z) / len, nz = -(b.x - a.x) / len;
  if ((mx + nx - centre.x) ** 2 + (mz + nz - centre.z) ** 2 < (mx - centre.x) ** 2 + (mz - centre.z) ** 2) {
    nx = -nx; nz = -nz;
  }

  const yaw = Math.atan2(nz, nx);
  const rise = 3.05;
  const y0 = base;
  const run = 2.3;
  const steps = 6;
  const stepColour = [0.52, 0.50, 0.48];
  const railColour = [
    Math.min(1, wallColour[0] * 0.45 + 0.10),
    Math.min(1, wallColour[1] * 0.45 + 0.10),
    Math.min(1, wallColour[2] * 0.45 + 0.12),
  ];

  // Offset along the wall so neighbouring triplexes do not line up perfectly.
  const along = (hash01(seed * 29) - 0.5) * Math.max(0, len - 3.2);
  const ax = -(b.z - a.z) / len, az = (b.x - a.x) / len;   // unit along the wall
  const baseX = mx + ax * along;
  const baseZ = mz + az * along;

  // Real Montréal stairs are open: treads carried on two inclined stringers,
  // with daylight between them. Solid blocks from the ground up read as a
  // concrete ramp, which is what made these look like roadside rubble.
  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) / steps;
    const top = rise * ((i + 1) / steps);
    const outward = run * (1 - t);
    mb.box(baseX + nx * outward, y0 + top, baseZ + nz * outward,
           1.05, 0.09, run / steps + 0.16, yaw, stepColour);
  }

  // The two stringers carrying them, as one inclined box each.
  const midOut = run / 2;
  const stringerLen = Math.hypot(rise, run);
  for (const side of [-1, 1]) {
    mb.box(baseX + nx * midOut + ax * side * 0.52, y0 + rise / 2, baseZ + nz * midOut + az * side * 0.52,
           0.09, stringerLen * 0.92, 0.22, yaw, railColour);
  }

  // Small landing at the door.
  mb.box(baseX + nx * 0.26, y0 + rise + 0.09, baseZ + nz * 0.26, 1.25, 0.14, 0.72, yaw, stepColour);

  // Two inclined railings, approximated by three short segments each.
  for (const side of [-1, 1]) {
    for (let k = 0; k < 2; k++) {
      const t0 = k / 2, t1 = (k + 1) / 2;
      // Named ya/yb, not y0/y1: the outer y0 is the building's base height and
      // shadowing it here would drop every railing back to sea level.
      const ya = y0 + 0.55 + rise * t0, yb = y0 + 0.55 + rise * t1;
      const o0 = run * (1 - t0), o1 = run * (1 - t1);
      const cx = baseX + nx * (o0 + o1) / 2 + ax * side * 0.56;
      const cz = baseZ + nz * (o0 + o1) / 2 + az * side * 0.56;
      const dy = yb - ya;
      const dh = Math.hypot(o1 - o0, 0);
      mb.box(cx, (ya + yb) / 2, cz, 0.07, Math.hypot(dy, dh), 0.07, yaw, railColour);
    }
    // Balusters: the wrought iron is most of what you actually see of a
    // Montréal staircase from a car.
    for (let k = 0; k <= 3; k++) {
      const t = k / 3;
      const out = run * (1 - t);
      const y = 0.5 + rise * t;
      mb.box(baseX + nx * out + ax * side * 0.56, y0 + y / 2 + rise * t * 0.5,
             baseZ + nz * out + az * side * 0.56,
             0.05, y, 0.05, yaw, railColour);
    }
  }
}

function nearestRoadTarget(roads, x, z) {
  let best = null, bestD = Infinity;
  for (const road of roads) {
    if (!road.spec || road.spec.kind === 'alley') continue;
    const pts = road.points;
    for (let i = 1; i < pts.length; i++) {
      const ax = pts[i - 1].x, az = pts[i - 1].z;
      const bx = pts[i].x, bz = pts[i].z;
      const dx = bx - ax, dz = bz - az;
      const l2 = dx * dx + dz * dz;
      if (l2 < 1e-6) continue;
      let t = ((x - ax) * dx + (z - az) * dz) / l2;
      t = Math.max(0, Math.min(1, t));
      const px = ax + dx * t, pz = az + dz * t;
      const d = (px - x) ** 2 + (pz - z) ** 2;
      if (d < bestD) { bestD = d; best = { x: px, z: pz }; }
    }
  }
  return best;
}

export { FLOOR_HEIGHT, BAY_WIDTH, TEX_BAYS, TEX_FLOORS };
