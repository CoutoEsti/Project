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

/**
 * Where a ramp comes down to a street — the service roads of Décarie, a
 * boulevard at the foot of an exit — it met the street at an angle and ended
 * square in the middle of its lanes: two asphalts on top of each other. The
 * street keeps its surface; the ramp's edge vertices that fall inside it
 * slide onto its edge, and cross-sections wholly inside are not drawn — the
 * same one-surface rule as a side join, against a street this time.
 *
 * @returns [{ road, end, edges: Map(sample index → { L, R, inside }), clear }]
 *          L, R: [x, n, y] replacing that edge vertex, or null; clear: the
 *          first sample, from the end, whose centreline is off the street.
 */
export function streetLandings(layout) {
  const T = layout.terrain;
  const out = [];
  for (const r of layout.roads) {
    if (r.loop) continue;
    const S = r.samples;
    for (const end of ['start', 'end']) {
      if ((r.junctions || []).some((j) => j.end === end)) continue;
      const k0 = end === 'start' ? 0 : S.length - 1, dir = end === 'start' ? 1 : -1;
      const p0 = S[k0];
      if (Math.abs(p0.y - T.height(p0.x, p0.n)) > 1) continue;     // not at grade
      let st = null, best = Infinity;
      for (const o of layout.streetsAt(p0.x, p0.n, 0.5)) {
        const f = frameOnPath(o.path, p0.x, p0.n);
        if (f && f.d < best) { best = f.d; st = o; }
      }
      if (!st) continue;
      // The side the ramp leaves by: where its centreline is off the street.
      let side = 0, clear = -1;
      for (let k = k0; k >= 0 && k < S.length && Math.abs(S[k].s - p0.s) < 120; k += dir) {
        const f = frameOnPath(st.path, S[k].x, S[k].n);
        if (!f || f.past) break;
        if (Math.abs(f.off) > st.half + 0.5) { side = Math.sign(f.off); clear = k; break; }
      }
      if (!side) continue;
      const edges = new Map();
      for (let k = k0; k >= 0 && k < S.length; k += dir) {
        const p = S[k], h = p.h ?? r.half;
        const slide = (x, n) => {
          const f = frameOnPath(st.path, x, n);
          if (!f || f.past || f.off * side >= st.half) return null;
          const ex = f.cx + f.lx * st.half * side, en = f.cn + f.ln * st.half * side;
          return [ex, en, Math.max(p.y, T.height(ex, en) + 0.07)];
        };
        const L = slide(p.x + p.lx * h, p.n + p.ln * h), R = slide(p.x - p.lx * h, p.n - p.ln * h);
        if (!L && !R) break;
        edges.set(k, { L, R, inside: !!(L && R) });
      }
      if (edges.size) out.push({ road: r.id, end, edges, clear });
    }
  }
  return out;
}

/** Nearest point of a polyline: foot, left normal, signed offset, and whether it fell past an end. */
function frameOnPath(path, x, n) {
  let best = null;
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i], b = path[i + 1];
    const dx = b[0] - a[0], dn = b[1] - a[1], L2 = dx * dx + dn * dn;
    if (L2 < 1e-6) continue;
    const t = ((x - a[0]) * dx + (n - a[1]) * dn) / L2;
    const u = Math.max(0, Math.min(1, t));
    const cx = a[0] + dx * u, cn = a[1] + dn * u;
    const d = Math.hypot(x - cx, n - cn);
    if (!best || d < best.d) {
      const len = Math.sqrt(L2), lx = -dn / len, ln = dx / len;
      best = { d, cx, cn, lx, ln, off: (x - cx) * lx + (n - cn) * ln,
        past: (i === 0 && t < 0) || (i === path.length - 2 && t > 1) };
    }
  }
  return best;
}
