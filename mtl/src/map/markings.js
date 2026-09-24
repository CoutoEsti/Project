// Paint as data: lines along streets and roads, as polylines with a width, a
// colour and an optional dash. Every line stops short of an intersection —
// the rule that keeps two sets of markings from ever painting over each
// other — and none is drawn where a road already lies over the street.
//
// Québec conventions: yellow separates opposite directions, white separates
// lanes going the same way, dashed means you may cross.

const W = 0.13;                   // line width, metres
const DASH = [3, 6];              // lane lines: 3 m painted, 6 m gap
const DASH_CENTRE = [3, 3];
const STOP = 3.5;                 // clear distance before a crossing street

export function streetMarkings(layout, structures) {
  const { index, ground } = structures;
  const T = layout.terrain, s = layout.map.scale;
  const out = [];
  const tmp = [];
  const STEP = 2;
  const lift = 0.09;
  for (const st of layout.streets) {
    const lines = streetLines(st, s);
    if (!lines.length) continue;
    for (let i = 0; i + 1 < st.path.length; i++) {
      const a = st.path[i], b = st.path[i + 1];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 0.5) continue;
      const tx = (b[0] - a[0]) / len, tn = (b[1] - a[1]) / len;
      const lx = -tn, ln = tx;
      // Walk the centreline, splitting it into runs that are clear of other
      // streets, roads, holes and water.
      const clear = [];
      for (let d = 0; d <= len; d += STEP) {
        const x = a[0] + tx * d, n = a[1] + tn * d;
        let ok = true;
        for (const o of layout.streetsAt(x, n, STOP * s, tmp)) {
          if (o === st || o.cls === 'alley') continue;
          if (o.name !== st.name || (o.path !== st.path && crosses(o, st))) { ok = false; break; }
        }
        if (ok) ok = index.surfacesAt(x, n, 1).every((q) => q.covered || q.y < T.height(x, n) - 1.5);
        if (ok) ok = ground.kindAt(x, n) === 'terrain';
        clear.push(ok ? d : null);
      }
      let run = [];
      const flush = () => {
        if (run.length >= 2) {
          const d0 = run[0], d1 = run[run.length - 1];
          for (const L of lines) {
            const pts = [];
            for (let d = d0; d <= d1 + 1e-6; d += 4) {
              const dd = Math.min(d, d1);
              const x = a[0] + tx * dd + lx * L.off, n = a[1] + tn * dd + ln * L.off;
              pts.push([x, n, T.height(x, n) + lift]);
              if (dd === d1) break;
            }
            const last = pts[pts.length - 1];
            const ex = a[0] + tx * d1 + lx * L.off, en = a[1] + tn * d1 + ln * L.off;
            if (Math.hypot(last[0] - ex, last[1] - en) > 0.01) pts.push([ex, en, T.height(ex, en) + lift]);
            out.push({ pts, w: (L.w || W) * Math.max(0.8, s), color: L.color, dash: L.dash ? L.dash.map((v) => v * s) : null, street: st.index });
          }
        }
        run = [];
      };
      for (const d of clear) { if (d === null) flush(); else run.push(d); }
      flush();
    }
  }
  return out;
}

function crosses(o, st) {
  // Two same-named pieces (Notre-Dame Ouest / Est) continue each other; only
  // a genuinely crossing piece should stop the paint.
  const a = o.path[0], b = o.path[o.path.length - 1], c = st.path[0], d = st.path[st.path.length - 1];
  const u = [b[0] - a[0], b[1] - a[1]], v = [d[0] - c[0], d[1] - c[1]];
  const cross = Math.abs(u[0] * v[1] - u[1] * v[0]) / ((Math.hypot(...u) * Math.hypot(...v)) || 1);
  return cross > 0.5;
}

/** Lateral offsets of a street's lines, by class and width. */
function streetLines(st, s = 1) {
  const w = st.width / s, h = st.half / s;
  return linesFor(st, w, h).map((L) => ({ ...L, off: L.off * s }));
}

function linesFor(st, w, h) {
  const L = [];
  if (st.oneway || st.cls === 'service') {
    const lanes = Math.max(1, Math.floor(w / 3.5));
    for (let k = 1; k < lanes; k++) L.push({ off: -h + (w * k) / lanes, color: 'white', dash: DASH });
    return L;
  }
  if (st.cls === 'boulevard') {
    const med = w >= 24 ? 1.1 : 0.12;
    L.push({ off: med, color: 'yellow' }, { off: -med, color: 'yellow' });
    const per = Math.max(1, Math.floor((h - med) / 3.5));
    for (let k = 1; k < per; k++) {
      const o = med + ((h - med) * k) / per;
      L.push({ off: o, color: 'white', dash: DASH }, { off: -o, color: 'white', dash: DASH });
    }
    return L;
  }
  if (st.cls === 'avenue') {
    L.push({ off: 0.12, color: 'yellow' }, { off: -0.12, color: 'yellow' });
    if (w >= 16) L.push({ off: h / 2, color: 'white', dash: DASH }, { off: -h / 2, color: 'white', dash: DASH });
    return L;
  }
  if (st.cls === 'street' && w >= 12) {
    L.push({ off: 0, color: 'yellow', dash: DASH_CENTRE });
  }
  return L;
}

/** Lines along the roads that carry their own surface. */
export function roadMarkings(layout) {
  const out = [];
  for (const r of layout.roads) {
    const lines = roadLines(r);
    const S = r.samples;
    // Skip the junction overlaps of mountain roads.
    let i0 = 0, i1 = S.length - 1;
    for (const j of r.junctions || []) {
      if (j.end === 'start') while (i0 < i1 && S[i0].s < j.sEdge + 2) i0++;
      else while (i1 > i0 && S[i1].s > j.sEdge - 2) i1--;
    }
    for (const L of lines) {
      const pts = [];
      for (let i = i0; i <= i1; i += 1) {
        const p = S[i];
        pts.push([p.x + p.lx * L.off, p.n + p.ln * L.off, p.y + 0.02]);
      }
      if (pts.length >= 2) out.push({ pts, w: L.w || W, color: L.color, dash: L.dash || null, road: r.id });
    }
  }
  return out;
}

function roadLines(r) {
  const h = r.half, L = [];
  if (r.oneway) {
    // A carriageway: yellow on the left edge (Québec), white on the right,
    // dashed white between lanes.
    const lanes = Math.max(1, r.lanes || 1);
    const edge = Math.min(0.6, h * 0.12);
    const lane = (r.width - 2 * edge) / lanes;
    L.push({ off: h - edge, color: 'yellow' });
    for (let k = 1; k < lanes; k++) L.push({ off: h - edge - lane * k, color: 'white', dash: DASH });
    L.push({ off: -(h - edge), color: 'white' });
    return L;
  }
  if (r.median) {
    const lane = 3.7, inner = 0.75;
    for (const s of [1, -1]) {
      L.push({ off: s * inner, color: 'yellow' });
      for (let k = 1; k < r.lanes; k++) L.push({ off: s * (inner + lane * k), color: 'white', dash: DASH });
      L.push({ off: s * (inner + lane * r.lanes), color: 'white' });
    }
    return L;
  }
  if (r.cls === 'ramp') return [{ off: h - 0.8, color: 'white' }, { off: -(h - 0.8), color: 'white' }];
  if (r.cls === 'circuit') return [{ off: h - 0.35, color: 'white', w: 0.25 }, { off: -(h - 0.35), color: 'white', w: 0.25 }];
  if (r.cls === 'bridge' && r.lanes >= 2) {
    return [
      { off: 0.12, color: 'yellow' }, { off: -0.12, color: 'yellow' },
      { off: h / 2, color: 'white', dash: DASH }, { off: -h / 2, color: 'white', dash: DASH },
      { off: h - 1.0, color: 'white' }, { off: -(h - 1.0), color: 'white' },
    ];
  }
  // Two-way roads: the mountain, the islands.
  return [
    { off: 0.12, color: 'yellow' }, { off: -0.12, color: 'yellow' },
    { off: h - 0.6, color: 'white' }, { off: -(h - 0.6), color: 'white' },
  ];
}
