// Named start points, resolved on the compiled map: "on this road, near this
// point, going roughly this way". Written that way (map/montreal.js SPAWNS),
// they survive any zone and any scale.

/**
 * @param layout compiled map
 * @param spec   { road, x, n, heading } — x, n already scaled; heading in degrees
 * @returns { x, n, y, heading } heading in radians, or null
 */
export function resolveSpawn(layout, spec) {
  const wx = Math.sin((spec.heading * Math.PI) / 180), wn = Math.cos((spec.heading * Math.PI) / 180);
  let best = null;
  const consider = (x, n, y, tx, tn, width, oneway, score, isRoad) => {
    let dir = 1;
    if (tx * wx + tn * wn < 0) {
      if (oneway) return;            // the other carriageway will offer itself
      dir = -1;
    }
    if (best && score >= best.score) return;
    const ux = tx * dir, un = tn * dir;
    // The right-hand lane.
    const off = width >= 10 ? width / 4 : 0;
    best = { x: x + un * off, n: n - ux * off, y, heading: Math.atan2(ux, un), score, road: isRoad };
  };
  for (const r of layout.roads) {
    if (r.name !== spec.road) continue;
    const S = r.samples;
    for (let i = 0; i < S.length; i += 2) {
      const p = S[i];
      const d = Math.hypot(p.x - spec.x, p.n - spec.n);
      consider(p.x, p.n, p.y, p.tx, p.tn, r.width, r.oneway, d, true);
    }
  }
  const T = layout.terrain;
  for (const st of layout.streets) {
    if (st.name !== spec.road) continue;
    const P = st.path;
    for (let i = 0; i + 1 < P.length; i++) {
      const a = P[i], b = P[i + 1];
      const dx = b[0] - a[0], dn = b[1] - a[1], l2 = dx * dx + dn * dn;
      if (l2 < 1e-6) continue;
      const t = Math.max(0.05, Math.min(0.95, ((spec.x - a[0]) * dx + (spec.n - a[1]) * dn) / l2));
      const x = a[0] + dx * t, n = a[1] + dn * t, l = Math.sqrt(l2);
      const d = Math.hypot(x - spec.x, n - spec.n);
      consider(x, n, T.height(x, n), dx / l, dn / l, st.width, st.oneway, d, false);
    }
  }
  if (!best) return null;
  // On a road the height is the sample's; recompute for the lane offset.
  if (!best.road) best.y = T.height(best.x, best.n);
  return best;
}
