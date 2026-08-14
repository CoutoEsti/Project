// The edge of the road, as geometry.
//
// Everything flat in this game is painted into one canvas per tile (ground.js),
// which is what makes four streets merge into one seamless piece of asphalt with
// no z-fighting anywhere. The price of that trick is that the road, the kerb and
// the sidewalk all sit at exactly the same height, and a road with no edge reads
// as a decal on a field rather than as a slab you are driving on.
//
// This is the fix, and the important part is which way round it goes. Raising
// the asphalt is the obvious idea and the wrong one: an inch and a half at five
// metres is about 0.4°, seven pixels. The kerb is 15 cm — four times more — and
// in the real world the asphalt is the *low* point. So the road is not lifted;
// the rim around it is, and the carriageway ends up sitting in a shallow tray.
//
// The cross-section, four points wide, per side of the street:
//
//        cap
//     ┌────────┐
//     │        └──┐  return to grade
//     │           └────── painted sidewalk
//   ──┘ face (15 cm)
//   carriageway
//
// Three quads per segment per side, six triangles. The one thing that had to be
// solved is junctions: two crossing streets would each extrude a rim straight
// through the other's asphalt. Rather than clipping the geometry — fiddly, and
// it leaves raw ends hanging — the height fades to nothing as a junction is
// approached, so the rim sinks into the road exactly where a real corner has its
// kerb ramp anyway. Nothing overlaps because by then there is nothing there.

import { junctionArcs, isJunction, offsetNormals, JUNCTION_CLEARANCE } from './roads.js';

export const KERB_HEIGHT = 0.15;    // metres — a Montréal kerb, measured
const CAP_WIDTH = 0.30;             // flat top
const RETURN_WIDTH = 0.34;          // slope back down to the painted sidewalk
const GRADE_LIFT = 0.012;           // keeps the outer edge off the ground plane

// Where the rim starts sinking. Slightly tighter than the marking clearance so
// the kerb is already flat before the painted asphalt starts to round off.
const FADE = JUNCTION_CLEARANCE * 0.8;

// Never emit a cross-section closer than this to the previous one. City streets
// are mostly straight and OSM nodes cluster; without it a tile costs three times
// the triangles for detail nobody can see.
const MIN_STEP = 2.5;

const FACE_COLOUR = [0.44, 0.43, 0.40];
const CAP_COLOUR = [0.62, 0.61, 0.57];

/** Roads that have no kerb in the first place. */
function hasKerb(spec) {
  if (!spec || spec.sidewalk <= 0) return false;          // motorway, alley, track
  if (spec.kind === 'alley') return false;
  if (spec.highway === 'pedestrian' || spec.highway === 'track') return false;
  if (spec.bridge || spec.tunnel) return false;           // no verge to sit on
  if (spec.surface === 'unpaved' || spec.surface === 'gravel' || spec.surface === 'dirt') return false;
  return true;
}

/**
 * Accumulates the kerb ribbons of one tile into flat arrays.
 * Same shape as StripBuilder so the tile builder treats them alike.
 */
export class KerbBuilder {
  /** @param {?(x:number,z:number)=>number} groundAt terrain height, or null */
  constructor(groundAt = null) {
    this.positions = [];
    this.colors = [];
    this.indices = [];
    this.groundAt = groundAt;
  }

  get count() { return this.positions.length / 3; }

  /**
   * One cross-section: four points across the rim, at the given height.
   * Returns the index of the first vertex so the caller can stitch rings.
   *
   * The terrain is sampled under *each* point rather than once on the
   * centreline. A street can be four metres from its own axis to the far edge
   * of its kerb, and on a cross-slope like Mount Royal's that is a third of a
   * metre of elevation — enough for the ribbon to hang in the air on one side
   * of the road and be swallowed by the ground on the other.
   */
  ring(x, z, nx, nz, halfWidth, height) {
    const inner = halfWidth;
    const capOut = halfWidth + CAP_WIDTH;
    const outer = halfWidth + CAP_WIDTH + RETURN_WIDTH;

    const ix = x + nx * inner, iz = z + nz * inner;
    const cx = x + nx * capOut, cz = z + nz * capOut;
    const ox = x + nx * outer, oz = z + nz * outer;

    const at = this.groundAt;
    const baseInner = at ? at(ix, iz) : 0;
    const baseCap = at ? at(cx, cz) : 0;
    const baseOuter = at ? at(ox, oz) : 0;

    const i = this.count;
    this.positions.push(
      ix, baseInner + GRADE_LIFT, iz,      // foot of the face, at the road edge
      ix, baseInner + height, iz,          // top of the face
      cx, baseCap + height, cz,            // outer edge of the cap
      ox, baseOuter + GRADE_LIFT, oz,      // back down to grade
    );
    // The vertical face is the one the light catches; the cap is concrete seen
    // from above and reads a stop lighter.
    this.colors.push(
      FACE_COLOUR[0], FACE_COLOUR[1], FACE_COLOUR[2],
      FACE_COLOUR[0], FACE_COLOUR[1], FACE_COLOUR[2],
      CAP_COLOUR[0], CAP_COLOUR[1], CAP_COLOUR[2],
      CAP_COLOUR[0], CAP_COLOUR[1], CAP_COLOUR[2],
    );
    return i;
  }

  /** Bridge two consecutive rings with three quads. */
  stitch(a, b) {
    for (let k = 0; k < 3; k++) {
      this.indices.push(a + k, b + k, b + k + 1, a + k, b + k + 1, a + k + 1);
    }
  }
}

/**
 * Build both kerb ribbons for every road in a tile.
 *
 * @param {Array} roads      clipped road pieces: {points, spec}
 * @param {Map} junctions    from findJunctions(), over the *unclipped* set
 * @param {KerbBuilder} out
 */
export function buildKerbs(roads, junctions, out) {
  for (const road of roads) {
    const { spec, points } = road;
    if (points.length < 2 || !hasKerb(spec)) continue;

    // Thin first, then measure: arc lengths have to be read off the same
    // polyline the sections are placed on, or the fade lands a few metres from
    // the junction it is supposed to be hiding. Junction vertices survive the
    // thinning for the same reason — dropping one loses the junction entirely.
    const line = thin(points, MIN_STEP, junctions);
    if (line.length < 2) continue;

    const arcs = junctionArcs(line, junctions);
    const normals = offsetNormals(line);
    const halfWidth = spec.width / 2;

    // Arc length of each kept vertex, so the junction fade can be read off it.
    const s = new Array(line.length);
    s[0] = 0;
    for (let i = 1; i < line.length; i++) {
      s[i] = s[i - 1] + Math.hypot(line[i].x - line[i - 1].x, line[i].z - line[i - 1].z);
    }
    const total = s[s.length - 1];

    for (const side of [1, -1]) {
      let previous = -1;
      for (let i = 0; i < line.length; i++) {
        const height = KERB_HEIGHT * fadeAt(s[i], arcs, total);
        if (height <= 0.001) { previous = -1; continue; }   // inside a junction
        const p = line[i];
        const n = normals[i];
        const index = out.ring(p.x, p.z, n.x * side, n.z * side, halfWidth, height);
        if (previous >= 0) {
          // Winding flips with the side, or one ribbon renders inside out.
          if (side > 0) out.stitch(previous, index);
          else out.stitch(index, previous);
        }
        previous = index;
      }
    }
  }
}

/**
 * How tall the kerb is here: full height away from junctions, nothing at one.
 *
 * Also tapered at the very ends of a clipped piece — a tile boundary cuts a
 * street mid-block, and a rim that stopped dead there would show a 15 cm wall
 * across the road at the seam between two tiles.
 */
function fadeAt(s, arcs, total) {
  let nearest = Math.min(s, total - s);          // distance to either open end
  for (let i = 0; i < arcs.length; i++) {
    const d = Math.abs(s - arcs[i]);
    if (d < nearest) nearest = d;
  }
  if (nearest >= FADE) return 1;
  if (nearest <= 0) return 0;
  const t = nearest / FADE;
  return t * t * (3 - 2 * t);                    // smoothstep, so no visible crease
}

/**
 * Drop vertices closer together than `step`, keeping the first, the last, and
 * every junction — a junction that gets thinned away takes its fade with it,
 * and the kerb then runs straight through a crossroads.
 */
function thin(points, step, junctions) {
  const out = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const last = out[out.length - 1];
    const here = points[i];
    const keep = junctions && isJunction(junctions, here.x, here.z);
    if (keep || Math.hypot(here.x - last.x, here.z - last.z) >= step) out.push(here);
  }
  out.push(points[points.length - 1]);
  return out;
}
