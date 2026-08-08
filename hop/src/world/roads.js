// Road classification, junction detection, and painted-marking geometry.
//
// The one idea that makes junctions look right: surfaces are *painted into the
// ground texture* (round joins merge every approach into one seamless piece of
// asphalt, with no overlapping meshes to z-fight), while *markings are real
// geometry* so they stay crisp at any distance. Markings are then trimmed back
// from every junction — which is what real road paint does anyway — so no two
// marking strips ever overlap.

const DEG = Math.PI / 180;

/** Carriageway width in metres, by highway class, when nothing better is tagged. */
const DEFAULT_WIDTH = {
  motorway: 15, motorway_link: 8,
  trunk: 13, trunk_link: 7.5,
  primary: 12, primary_link: 7,
  secondary: 10.5, secondary_link: 6.5,
  tertiary: 9, tertiary_link: 6,
  unclassified: 7.5, residential: 8,
  living_street: 6.5, pedestrian: 6,
  service: 5, track: 4, road: 7.5, busway: 7,
};

/** Rank used for draw order: bigger roads are painted last, so they win. */
const RANK = {
  service: 0, track: 0, pedestrian: 1, living_street: 1, residential: 2,
  unclassified: 2, road: 2, tertiary: 3, tertiary_link: 3, secondary: 4,
  secondary_link: 4, primary: 5, primary_link: 5, trunk: 6, trunk_link: 6,
  motorway: 7, motorway_link: 7, busway: 3,
};

const MAJOR = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary',
  'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link']);

export const JUNCTION_CLEARANCE = 9.5;   // metres of paint trimmed either side of a junction

function num(v) {
  if (v == null) return NaN;
  const m = String(v).match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : NaN;
}

/**
 * Turn an OSM way's tags into everything the renderer needs to know about it.
 * Returns null for ways we do not draw as roads.
 */
export function classifyRoad(tags) {
  if (!tags || !tags.highway) return null;
  const hw = tags.highway;
  if (hw === 'proposed' || hw === 'construction') return null;

  const isAlley = hw === 'service' && (tags.service === 'alley' || tags.service === 'driveway');
  const lanes = num(tags.lanes);
  let width = num(tags.width);
  if (!Number.isFinite(width) || width <= 0) {
    if (Number.isFinite(lanes) && lanes > 0) {
      width = Math.min(lanes, 8) * 3.35 + (MAJOR.has(hw) ? 1.0 : 0.4);
    } else {
      width = DEFAULT_WIDTH[hw] ?? 7;
    }
  }
  if (isAlley) width = Math.min(width, 4.8);
  width = Math.max(3, Math.min(30, width));

  const oneway = tags.oneway === 'yes' || tags.oneway === '1' || tags.oneway === '-1'
    || hw === 'motorway' || hw === 'motorway_link';
  const laneCount = Number.isFinite(lanes) && lanes > 0
    ? Math.round(lanes)
    : (MAJOR.has(hw) ? (width > 11 ? 4 : 2) : 2);

  // Sidewalks and grass verges: how much of the streetscape sits either side.
  let sidewalk = 0, verge = 0;
  if (isAlley) { sidewalk = 0; verge = 0.4; }
  else if (hw === 'service' || hw === 'track') { sidewalk = 1.2; verge = 0.8; }
  else if (hw === 'residential' || hw === 'living_street' || hw === 'unclassified') { sidewalk = 2.6; verge = 2.4; }
  else if (hw === 'motorway' || hw === 'trunk') { sidewalk = 0; verge = 6; }
  else { sidewalk = 3.0; verge = 1.8; }

  return {
    highway: hw,
    kind: isAlley ? 'alley' : (MAJOR.has(hw) ? 'major' : 'minor'),
    name: tags.name || '',
    width,
    lanes: laneCount,
    oneway,
    sidewalk,
    verge,
    rank: (RANK[hw] ?? 2) + (isAlley ? -1 : 0),
    tunnel: tags.tunnel === 'yes' || tags.tunnel === 'building_passage',
    bridge: tags.bridge === 'yes',
    surface: tags.surface || 'asphalt',
    maxspeed: num(tags.maxspeed) || (MAJOR.has(hw) ? 50 : 40),
  };
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/** Quantise a world position to a 0.4 m grid, as a string key. */
function vertexKey(x, z) {
  return `${Math.round(x * 2.5)}|${Math.round(z * 2.5)}`;
}

/**
 * Find junctions by vertex coincidence. OpenStreetMap splits ways at
 * intersections and they share the node, so a position touched by two or more
 * distinct ways is a junction. Works identically for real and generated data.
 *
 * @param {Array<{points:Array<{x:number,z:number}>, id:any}>} roads
 * @returns {Map<string,{x:number,z:number,ways:number}>}
 */
export function findJunctions(roads) {
  const seen = new Map();
  for (const road of roads) {
    const local = new Set();
    for (const p of road.points) {
      const k = vertexKey(p.x, p.z);
      if (local.has(k)) continue;      // a way touching itself is not a junction
      local.add(k);
      let rec = seen.get(k);
      if (!rec) { rec = { x: p.x, z: p.z, ways: 0 }; seen.set(k, rec); }
      rec.ways++;
    }
  }
  const junctions = new Map();
  for (const [k, rec] of seen) if (rec.ways >= 2) junctions.set(k, rec);
  return junctions;
}

/** Squared distance from a point to the nearest junction, capped by `limit`. */
function nearJunction(junctions, x, z, limit) {
  // Junction keys are on a 0.4 m grid; scan the cells within `limit`.
  const cells = Math.ceil(limit * 2.5);
  const cx = Math.round(x * 2.5), cz = Math.round(z * 2.5);
  let best = Infinity;
  for (let i = -cells; i <= cells; i++) {
    for (let j = -cells; j <= cells; j++) {
      const rec = junctions.get(`${cx + i}|${cz + j}`);
      if (!rec) continue;
      const dx = rec.x - x, dz = rec.z - z;
      const d = dx * dx + dz * dz;
      if (d < best) best = d;
    }
  }
  return best;
}

/**
 * A cheaper junction test for long polylines: precompute the arc-length
 * positions of junction vertices along the line, then ask whether a given
 * arc-length is inside any clearance window.
 */
function junctionWindows(points, junctions) {
  const windows = [];
  let s = 0;
  for (let i = 0; i < points.length; i++) {
    if (i > 0) {
      const dx = points[i].x - points[i - 1].x;
      const dz = points[i].z - points[i - 1].z;
      s += Math.hypot(dx, dz);
    }
    if (junctions.has(vertexKey(points[i].x, points[i].z))) {
      windows.push([s - JUNCTION_CLEARANCE, s + JUNCTION_CLEARANCE]);
    }
  }
  return windows;
}

function inWindows(windows, s) {
  for (let i = 0; i < windows.length; i++) {
    if (s >= windows[i][0] && s <= windows[i][1]) return true;
  }
  return false;
}

/** Total length of a polyline. */
export function polylineLength(points) {
  let s = 0;
  for (let i = 1; i < points.length; i++) s += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
  return s;
}

/** Point and unit tangent at arc-length `s` along a polyline. */
export function sampleAt(points, s, out = { x: 0, z: 0, tx: 0, tz: 0 }) {
  let acc = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dz = points[i].z - points[i - 1].z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) continue;
    if (acc + len >= s) {
      const t = (s - acc) / len;
      out.x = points[i - 1].x + dx * t;
      out.z = points[i - 1].z + dz * t;
      out.tx = dx / len;
      out.tz = dz / len;
      return out;
    }
    acc += len;
  }
  const n = points.length - 1;
  out.x = points[n].x; out.z = points[n].z;
  const dx = points[n].x - points[n - 1].x, dz = points[n].z - points[n - 1].z;
  const len = Math.hypot(dx, dz) || 1;
  out.tx = dx / len; out.tz = dz / len;
  return out;
}

// ---------------------------------------------------------------------------
// Marking geometry
// ---------------------------------------------------------------------------

/** Accumulates flat, y-up quads with vertex colours into plain arrays. */
export class StripBuilder {
  constructor() {
    this.positions = [];
    this.colors = [];
    this.indices = [];
  }

  get count() { return this.positions.length / 3; }

  /**
   * A quad centred on the segment a->b, `width` metres wide, at height y.
   * @param {number} r,g,b  linear-ish colour, 0..1
   */
  quad(ax, az, bx, bz, width, y, r, g, bl) {
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len < 1e-5) return;
    const nx = (-dz / len) * (width / 2);
    const nz = (dx / len) * (width / 2);
    const i = this.count;
    this.positions.push(
      ax - nx, y, az - nz,
      ax + nx, y, az + nz,
      bx + nx, y, bz + nz,
      bx - nx, y, bz - nz,
    );
    for (let k = 0; k < 4; k++) this.colors.push(r, g, bl);
    this.indices.push(i, i + 1, i + 2, i, i + 2, i + 3);
  }

  /** An axis-aligned-to-direction rectangle centred at (cx,cz). */
  rect(cx, cz, dirX, dirZ, length, width, y, r, g, b) {
    const len = Math.hypot(dirX, dirZ) || 1;
    const ux = dirX / len, uz = dirZ / len;
    this.quad(cx - ux * length / 2, cz - uz * length / 2,
              cx + ux * length / 2, cz + uz * length / 2,
              width, y, r, g, b);
  }
}

const PAINT_Y = 0.018;
const YELLOW = [0.86, 0.68, 0.16];
const WHITE = [0.90, 0.90, 0.87];

/**
 * Build every painted marking for one tile's roads.
 *
 * @param {Array} roads     clipped road pieces: {points, spec}
 * @param {Map} junctions   from findJunctions(), built over the *unclipped* set
 * @param {StripBuilder} out
 */
export function buildMarkings(roads, junctions, out) {
  for (const road of roads) {
    const { spec, points } = road;
    if (points.length < 2) continue;
    if (spec.kind === 'alley' || spec.highway === 'pedestrian' || spec.highway === 'track') continue;
    if (spec.surface === 'unpaved' || spec.surface === 'gravel' || spec.surface === 'dirt') continue;

    const total = polylineLength(points);
    if (total < 6) continue;
    const windows = junctionWindows(points, junctions);
    const s = { x: 0, z: 0, tx: 0, tz: 0 };

    // --- centre line -------------------------------------------------------
    // Québec paints the two-way divider yellow; lane dividers stay white.
    if (!spec.oneway) {
      const solid = spec.kind === 'major' && spec.lanes >= 4;
      if (solid) {
        // Double solid yellow, drawn as two offset ribbons.
        for (const off of [-0.22, 0.22]) drawOffsetLine(points, windows, off, 0.14, YELLOW, out, 1.0);
      } else {
        drawDashedLine(points, windows, 0, 0.14, YELLOW, out, 3.0, 6.0);
      }
    }

    // --- lane dividers -----------------------------------------------------
    if (spec.lanes >= 4) {
      const laneW = spec.width / spec.lanes;
      const half = spec.lanes / 2;
      for (let l = 1; l < half; l++) {
        for (const sign of [-1, 1]) {
          drawDashedLine(points, windows, sign * l * laneW, 0.12, WHITE, out, 3.0, 6.0);
        }
      }
    } else if (spec.oneway && spec.lanes >= 2) {
      const laneW = spec.width / spec.lanes;
      for (let l = 1; l < spec.lanes; l++) {
        drawDashedLine(points, windows, (l - spec.lanes / 2) * laneW, 0.12, WHITE, out, 3.0, 6.0);
      }
    }

    // --- edge lines on the bigger roads -----------------------------------
    if (spec.kind === 'major') {
      for (const sign of [-1, 1]) {
        drawOffsetLine(points, windows, sign * (spec.width / 2 - 0.45), 0.12, WHITE, out, 1.0);
      }
    }

    // --- stop bars and crosswalks at junctions -----------------------------
    for (const w of windows) {
      const centre = (w[0] + w[1]) / 2;
      if (centre < 1 || centre > total - 1) continue;
      for (const sign of [-1, 1]) {
        const at = centre + sign * (JUNCTION_CLEARANCE - 1.2);
        if (at < 0.5 || at > total - 0.5) continue;
        sampleAt(points, at, s);
        const nx = -s.tz, nz = s.tx;

        // Stop bar across the approaching half of the carriageway.
        const halfW = spec.oneway ? spec.width * 0.9 : spec.width / 2 - 0.2;
        const barCx = s.x + nx * (spec.oneway ? 0 : -sign * spec.width / 4);
        const barCz = s.z + nz * (spec.oneway ? 0 : -sign * spec.width / 4);
        out.rect(barCx, barCz, nx, nz, halfW, 0.45, PAINT_Y, WHITE[0], WHITE[1], WHITE[2]);

        // Zebra crossing just outside the stop bar.
        if (spec.kind === 'major' || spec.width > 8.5) {
          const zAt = centre + sign * (JUNCTION_CLEARANCE - 3.4);
          if (zAt > 0.5 && zAt < total - 0.5) {
            sampleAt(points, zAt, s);
            drawZebra(s, spec.width, out);
          }
        }
      }
    }
  }
}

function drawZebra(s, width, out) {
  const nx = -s.tz, nz = s.tx;
  const bars = Math.max(3, Math.floor(width / 1.2));
  for (let i = 0; i < bars; i++) {
    const t = (i + 0.5) / bars - 0.5;
    const cx = s.x + nx * t * (width - 0.6);
    const cz = s.z + nz * t * (width - 0.6);
    out.rect(cx, cz, s.tx, s.tz, 2.4, 0.42, PAINT_Y, WHITE[0], WHITE[1], WHITE[2]);
  }
}

/** A continuous line offset laterally from the centreline. */
function drawOffsetLine(points, windows, offset, width, colour, out, minLen) {
  let s = 0;
  for (let i = 1; i < points.length; i++) {
    const ax = points[i - 1].x, az = points[i - 1].z;
    const bx = points[i].x, bz = points[i].z;
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len < 1e-4) continue;
    const nx = (-dz / len) * offset, nz = (dx / len) * offset;

    // Walk the segment, skipping the stretches inside a junction window.
    let t = 0;
    while (t < len) {
      const stepEnd = Math.min(len, t + 2);
      const mid = s + (t + stepEnd) / 2;
      if (!inWindows(windows, mid)) {
        out.quad(ax + (dx * t) / len + nx, az + (dz * t) / len + nz,
                 ax + (dx * stepEnd) / len + nx, az + (dz * stepEnd) / len + nz,
                 width, PAINT_Y, colour[0], colour[1], colour[2]);
      }
      t = stepEnd;
    }
    s += len;
  }
  void minLen;
}

/** A dashed line offset laterally from the centreline. */
function drawDashedLine(points, windows, offset, width, colour, out, dash, gap) {
  const total = polylineLength(points);
  const period = dash + gap;
  const s = { x: 0, z: 0, tx: 0, tz: 0 };
  const e = { x: 0, z: 0, tx: 0, tz: 0 };
  for (let start = 1.5; start + dash < total - 1.5; start += period) {
    const mid = start + dash / 2;
    if (inWindows(windows, mid)) continue;
    sampleAt(points, start, s);
    sampleAt(points, start + dash, e);
    const nx = -s.tz * 0 + -s.tz, nz = s.tx;
    out.quad(s.x + nx * offset, s.z + nz * offset,
             e.x + (-e.tz) * offset, e.z + e.tx * offset,
             width, PAINT_Y, colour[0], colour[1], colour[2]);
  }
}

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------

/**
 * A place to put the car: on a real street, pointing along it.
 *
 * Nearest is not good enough. In the Plateau the nearest carriageway to an
 * arbitrary point is usually a back lane between two triplexes, where the
 * chase camera opens against a brick wall a metre away. So distance is
 * weighted by how narrow the road is: a boulevard a hundred metres off beats
 * a service road right under your feet.
 *
 * @param {object} opts {preferWide:boolean, maxDistance:number}
 */
export function nearestRoadPoint(roads, x, z, opts = {}) {
  const preferWide = opts.preferWide !== false;
  const maxDistance = opts.maxDistance ?? 600;
  let best = null;
  let bestScore = Infinity;
  for (const road of roads) {
    const spec = road.spec;
    if (!spec || spec.kind === 'alley') continue;
    if (spec.highway === 'motorway' || spec.highway === 'pedestrian') continue;
    // Narrower than a two-lane street: penalise hard. Wider: small bonus.
    const widthPenalty = preferWide
      ? 1 + Math.max(0, 10.5 - spec.width) * 0.9 - Math.min(spec.width, 16) * 0.02
      : 1;
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
      const d = Math.hypot(px - x, pz - z);
      if (d > maxDistance) continue;
      const score = d * widthPenalty;
      if (score < bestScore) {
        bestScore = score;
        const len = Math.sqrt(l2);
        best = {
          x: px, z: pz,
          // World forward is (sin yaw, cos yaw), so the heading that points
          // along (dx, dz) is atan2(dx, dz) — not atan2(dx, -dz).
          heading: Math.atan2(dx / len, dz / len),
          spec,
          dirX: dx / len, dirZ: dz / len,
        };
      }
    }
  }
  return best;
}

export { DEFAULT_WIDTH, MAJOR, DEG };
