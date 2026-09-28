// Where a ramp leaves a carriageway (or joins it), one piece of road, as
// EasyRoads3D's side connection builds it: the carriageway widens along the
// ramp's outer edge — the taper of the exit lane — until the ramp has pulled
// clear of it, the nose; only there does the ramp's own ribbon begin.
//
// Drawn as two ribbons instead, the ramp crossed the carriageway at an angle
// for the length of the merge: two surfaces on top of each other, a cut edge
// across the lanes where one was trimmed, a wedge of bare ground in the V.
//
// Pure data, like the rest of map/: rows of [edge of the carriageway, outer
// edge of the ramp], meshed by world/roads.js and exported with the roads.

import { projectOnRoad } from './layout.js';

const NOSE_GAP = 0.4;     // metres between the two edges where the ramp is clear
const REACH = 260;        // metres along the ramp, at most, to find the nose

/**
 * @returns [{ road, major, end, nose, side, rows: [[ex, en, ey, ox, on, oy]],
 *            majorFrom, majorTo }] — nose: the ramp sample where its ribbon
 *            starts (or stops); side: which side of the carriageway (+1 left);
 *            majorFrom..majorTo: arc lengths of the carriageway along the join.
 */
export function junctionPatches(layout) {
  const out = [];
  for (const r of layout.roads) {
    for (const j of r.junctions || []) {
      const M = layout.roadById[j.major];
      if (!M || M === r || r.loop || j.through) continue;
      const patch = sideJoin(r, M, j.end);
      if (patch) out.push(patch);
    }
  }
  return out;
}

function sideJoin(r, M, end) {
  const S = r.samples;
  const dir = end === 'start' ? 1 : -1;
  const k0 = dir > 0 ? 0 : S.length - 1;
  const rows = [];
  let side = 0, nose = -1, sFrom = Infinity, sTo = -Infinity;
  for (let k = k0; k >= 0 && k < S.length && Math.abs(S[k].s - S[k0].s) <= REACH; k += dir) {
    const p = S[k];
    const hit = projectOnRoad(M, p.x, p.n);
    if (!hit) return null;
    const a = M.samples[hit.i], b = M.samples[Math.min(M.samples.length - 1, hit.i + 1)];
    const qx = a.x + (b.x - a.x) * hit.t, qn = a.n + (b.n - a.n) * hit.t;
    const lat = (p.x - qx) * a.lx + (p.n - qn) * a.ln;
    // The carriageway's half-width there: it tapers where it forks (layout.js).
    const hM = (a.h ?? M.half) + ((b.h ?? M.half) - (a.h ?? M.half)) * hit.t, hr = p.h ?? r.half;
    if (!side && Math.abs(lat) > 1) side = Math.sign(lat);
    // Both ramp edges, measured across the carriageway.
    const e1 = [p.x + p.lx * hr, p.n + p.ln * hr], e2 = [p.x - p.lx * hr, p.n - p.ln * hr];
    const across = (e) => ((e[0] - qx) * a.lx + (e[1] - qn) * a.ln) * (side || Math.sign(lat) || 1);
    const [inner, outer] = across(e1) < across(e2) ? [e1, e2] : [e2, e1];
    const sgn = side || Math.sign(lat) || 1;
    const E = [qx + a.lx * hM * sgn, qn + a.ln * hM * sgn, hit.y];
    const reachOut = across(outer);
    // Outer edge still inside the carriageway: nothing to widen yet.
    const O = reachOut > hM ? [outer[0], outer[1], p.y] : [E[0], E[1], hit.y];
    rows.push([E[0], E[1], E[2], O[0], O[1], O[2]]);
    sFrom = Math.min(sFrom, hit.s); sTo = Math.max(sTo, hit.s);
    // The ramp has pulled away: stop at the nose.
    if (side && across(inner) >= hM + NOSE_GAP) {
      // The last row is the ramp's own first cross-section, so the taper
      // closes on it exactly: square to the carriageway it left a sliver.
      rows[rows.length - 1] = [inner[0], inner[1], p.y, outer[0], outer[1], p.y];
      nose = k;
      break;
    }
    // Parted in height before it parted in plan (a ramp climbing away over
    // the shoulder): not a side join.
    if (Math.abs(p.y - hit.y) > 0.6) return null;
  }
  if (nose < 0 || rows.length < 2 || !side) return null;
  return { road: r.id, major: M.id, end, nose, side, rows, majorFrom: sFrom, majorTo: sTo };
}
