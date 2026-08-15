// The carriageway, as a real slab with a real edge.
//
// The ground of a tile is one painted canvas, and the rule that came with it
// was: never put a mesh over the road, because two streets crossing put two
// coplanar surfaces in the same place and the depth buffer picks a winner per
// pixel, per frame. That is z-fighting, and it is the ugliest thing a city
// renderer can do.
//
// This puts a mesh over the road anyway, because painted asphalt reads as a
// decal no matter how well it is painted — there is no edge, no thickness, and
// nothing for the light to catch. The rule is respected rather than broken, by
// removing the thing that made it necessary:
//
//   * **The texture is keyed to the world, not to the ribbon.** UVs are metres
//     east and north. Two overlapping slabs at a junction therefore sample the
//     same texel, so whichever wins the depth test paints exactly the same
//     pixel. The fight still happens; nothing can see it.
//   * **The rim fades out near junctions**, exactly as the kerbs do. A vertical
//     edge is the one part that *would* show through another road, and there is
//     never one within a junction's reach.
//   * **Everything is one mesh per tile**, so the whole carriageway is a single
//     draw call and the triangles are rasterised in a deterministic order.
//
// The lateral samples are not decoration either: they carry the wheel tracks as
// vertex colour, which is the polish two lanes of traffic leave down the middle
// of their own half of the road. That is the detail that stops a long straight
// from reading as a corridor of wallpaper.

import {
  junctionArcs, isJunction, offsetNormals, JUNCTION_CLEARANCE, ROAD_LIFT,
} from './roads.js';

export { ROAD_LIFT };

/** Cross-section samples across the carriageway. Odd, so one lands on the axis. */
const LATERAL = 5;

/** Metres between cross-sections. Junction vertices are kept regardless. */
const STEP = 6;

/** Where the rim has finished sinking, measured from a junction. */
const RIM_FADE = JUNCTION_CLEARANCE * 0.9;

/**
 * Wheel polish, as a darkening curve across one direction of travel.
 *
 * `t` is the position across the road, −1 at one kerb to +1 at the other. Each
 * direction runs down the middle of its own half, so the two dark bands sit at
 * ±0.5 — and the very edges stay pale, because that is where the grit collects
 * and no tyre ever goes.
 */
function polish(t) {
  const track = Math.exp(-((Math.abs(t) - 0.5) ** 2) / 0.045);
  const edge = Math.max(0, Math.abs(t) - 0.82) / 0.18;
  return 1 - track * 0.16 + edge * 0.06;
}

/** Roads that get a built surface at all. */
function paved(spec) {
  if (!spec) return false;
  if (spec.surface === 'unpaved' || spec.surface === 'gravel' || spec.surface === 'dirt') return false;
  if (spec.highway === 'pedestrian' || spec.highway === 'track') return false;
  return true;
}

/** Accumulates the carriageway of one tile: position, uv, colour, index. */
export class RoadwayBuilder {
  /**
   * @param {?(x:number,z:number)=>number} groundAt terrain height, or null
   * @param {number} uvMetres how much ground one texture tile covers
   */
  constructor(groundAt = null, uvMetres = 6) {
    this.positions = [];
    this.uvs = [];
    this.colors = [];
    this.indices = [];
    this.groundAt = groundAt;
    this.uvMetres = uvMetres;
  }

  get count() { return this.positions.length / 3; }

  /**
   * One vertex. UVs come from the world position, which is what makes
   * overlapping ribbons agree — see the header.
   */
  vertex(x, z, y, shade) {
    this.positions.push(x, y, z);
    this.uvs.push(x / this.uvMetres, z / this.uvMetres);
    this.colors.push(shade, shade, shade);
    return this.count - 1;
  }

  /** A strip of quads between two rows of equal length. */
  bridge(a, b, n) {
    for (let k = 0; k < n - 1; k++) {
      this.indices.push(a + k, b + k, b + k + 1, a + k, b + k + 1, a + k + 1);
    }
  }
}

/**
 * Build the carriageway for one tile.
 *
 * @param {Array} roads     clipped road pieces: {points, spec}
 * @param {Map} junctions   from findJunctions(), over the *unclipped* set
 * @param {RoadwayBuilder} out
 */
export function buildRoadway(roads, junctions, out) {
  for (const road of roads) {
    const { spec, points } = road;
    if (points.length < 2 || !paved(spec)) continue;

    const line = thin(points, STEP, junctions);
    if (line.length < 2) continue;

    const normals = offsetNormals(line);
    const arcs = junctionArcs(line, junctions);
    const half = spec.width / 2;

    const s = new Array(line.length);
    s[0] = 0;
    for (let i = 1; i < line.length; i++) {
      s[i] = s[i - 1] + Math.hypot(line[i].x - line[i - 1].x, line[i].z - line[i - 1].z);
    }
    const total = s[s.length - 1];
    if (total < 1) continue;

    // --- the surface ---------------------------------------------------------
    let previous = -1;
    const rows = [];
    for (let i = 0; i < line.length; i++) {
      const p = line[i];
      const nx = normals[i].x, nz = normals[i].z;
      const first = out.count;
      for (let k = 0; k < LATERAL; k++) {
        const t = (k / (LATERAL - 1)) * 2 - 1;              // −1 … +1 across
        const x = p.x + nx * t * half;
        const z = p.z + nz * t * half;
        const base = out.groundAt ? out.groundAt(x, z) : 0;
        // Flat across, for now. A real road is crowned two per cent so water
        // runs to the gutter, and that is eleven centimetres of rise in the
        // middle of an eleven-metre street — which is exactly where the centre
        // line is painted. Camber has to arrive together with camber-aware
        // markings or the yellow line sinks under the asphalt.
        out.vertex(x, z, base + ROAD_LIFT, polish(t));
      }
      if (previous >= 0) out.bridge(previous, first, LATERAL);
      rows.push({ first, i });
      previous = first;
    }

    // --- the edge ------------------------------------------------------------
    // The visible thickness. Only on the outside, and only away from junctions,
    // where a vertical face would cut across the road it meets.
    for (const side of [1, -1]) {
      let prevTop = -1;
      let prevBottom = -1;
      for (let i = 0; i < line.length; i++) {
        const drop = ROAD_LIFT * rimFade(s[i], arcs, total);
        if (drop <= 0.002) { prevTop = -1; continue; }
        const p = line[i];
        const nx = normals[i].x * side, nz = normals[i].z * side;
        const x = p.x + nx * half;
        const z = p.z + nz * half;
        const base = out.groundAt ? out.groundAt(x, z) : 0;
        const top = out.vertex(x, z, base + ROAD_LIFT, polish(1));
        const bottom = out.vertex(x, z, base + ROAD_LIFT - drop, polish(1) * 0.82);
        if (prevTop >= 0) {
          // Winding flips with the side so both faces point outward.
          if (side > 0) out.indices.push(prevTop, prevBottom, bottom, prevTop, bottom, top);
          else out.indices.push(prevTop, bottom, prevBottom, prevTop, top, bottom);
        }
        prevTop = top;
        prevBottom = bottom;
      }
    }
  }
}

/**
 * How much of the edge is showing here: all of it in open road, none at a
 * junction, and none at the open ends of a piece cut by a tile boundary — a
 * fourteen-centimetre wall across the road at a tile seam would be a wall you
 * could hit.
 */
function rimFade(s, arcs, total) {
  let nearest = Math.min(s, total - s);
  for (let i = 0; i < arcs.length; i++) {
    const d = Math.abs(s - arcs[i]);
    if (d < nearest) nearest = d;
  }
  if (nearest >= RIM_FADE) return 1;
  if (nearest <= 0) return 0;
  const t = nearest / RIM_FADE;
  return t * t * (3 - 2 * t);
}

/** Drop vertices closer than `step`, keeping the ends and every junction. */
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
