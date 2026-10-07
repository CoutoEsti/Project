// Level-design checks: the mistakes that are easy to make in a data file and
// expensive to find by driving. Each returns human-readable findings in French,
// with the position, so they can be fixed in montreal.js directly.
//
//   grade      a stretch steeper than its class allows
//   clearance  two roads crossing with less than 5 m of headroom
//   crossing   a street meeting a road that is neither at grade, nor above,
//              nor safely below it
//   overlap    two roads sharing ground at different heights (a ramp that
//              peels off a carriageway before matching its level)

import { Grid, segDist2 } from './geom.js';

export function validate(layout) {
  const { map, roads } = layout;
  const L = map.levels;
  const headroom = L.clearance + 1.2;      // clearance plus the upper deck
  const findings = [];
  const at = (p) => `(${p.x.toFixed(0)}, ${p.n.toFixed(0)})`;

  // --- grades -------------------------------------------------------------
  for (const r of roads) {
    const limit = (r.maxGrade || r.rules.maxGrade) + 0.004;
    let worst = null;
    for (let i = 1; i < r.samples.length; i++) {
      const a = r.samples[i - 1], b = r.samples[i];
      const g = Math.abs(b.y - a.y) / Math.max(0.1, b.s - a.s);
      if (!worst || g > worst.g) worst = { g, p: b };
    }
    if (worst && worst.g > limit) {
      findings.push({ kind: 'grade', road: r.id, severity: 'warn',
        text: `${r.name} : pente de ${(worst.g * 100).toFixed(1)} % en ${at(worst.p)}, limite ${(limit * 100).toFixed(1)} %` });
    }
  }

  // --- road against road ---------------------------------------------------
  const grid = new Grid(24);
  for (const r of roads) {
    for (let i = 0; i + 1 < r.samples.length; i += 1) {
      const a = r.samples[i], b = r.samples[i + 1];
      const h = r.half;
      grid.insert({ r, a, b }, Math.min(a.x, b.x) - h, Math.min(a.n, b.n) - h, Math.max(a.x, b.x) + h, Math.max(a.n, b.n) + h);
    }
  }
  const reported = new Set();
  const tmp = [];
  for (const r of roads) {
    for (let i = 0; i < r.samples.length; i += 3) {
      const p = r.samples[i];
      for (const c of grid.query(p.x, p.n, r.half, tmp)) {
        if (c.r === r) continue;
        // A mountain road's junction onto another is trimmed by the builder.
        if (isJunction(r, c.r, p) || isJunction(c.r, r, c.a)) continue;
        const { d2, t } = segDist2(p.x, p.n, c.a.x, c.a.n, c.b.x, c.b.n);
        const d = Math.sqrt(d2);
        // Footprints overlap by more than a metre.
        if (d > r.half + c.r.half - 1) continue;
        const y2 = c.a.y + (c.b.y - c.a.y) * t;
        const dy = Math.abs(p.y - y2);
        if (dy < 0.45 || dy >= headroom) continue;
        // Side by side (not crossing) at different levels is fine when the
        // centrelines are far enough apart for walls to stand between them.
        const cross = Math.abs(p.tx * c.a.tn - p.tn * c.a.tx);
        const kind = cross > 0.35 ? 'clearance' : 'overlap';
        if (kind === 'overlap' && d > Math.max(r.half, c.r.half)) continue;
        const key = [r.id, c.r.id].sort().join('|') + kind + Math.round(p.x / 60) + ':' + Math.round(p.n / 60);
        if (reported.has(key)) continue;
        reported.add(key);
        findings.push({ kind, road: r.id, other: c.r.id, severity: 'error',
          text: kind === 'clearance'
            ? `${r.name} croise ${c.r.name} en ${at(p)} avec ${dy.toFixed(1)} m d'écart (il en faut ${headroom.toFixed(1)})`
            : `${r.name} chevauche ${c.r.name} en ${at(p)} à ${dy.toFixed(1)} m d'écart de niveau` });
      }
    }
  }

  // --- road against street -------------------------------------------------
  const seen = new Set();
  for (const r of roads) {
    if (r.follow === 'terrain') continue;
    for (const p of r.samples) {
      for (const st of layout.streetsAt(p.x, p.n, -0.5, tmp)) {
        if (st.cls === 'apron') continue;
        // Streets lie on the relief: heights are measured from it.
        const rel = p.y - (p.gs ?? 0);
        const ok = Math.abs(rel) < 0.45 || rel >= headroom || (p.covered && rel <= -headroom);
        if (ok) continue;
        const key = r.id + '|' + st.index;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push({ kind: 'crossing', road: r.id, street: st.name, severity: 'error',
          text: `${r.name} rencontre ${st.name} en ${at(p)} à ${rel.toFixed(1)} m : ni au niveau, ni dessus, ni dessous` });
      }
    }
  }

  return findings;
}

/** Is sample p of road `minor` inside its declared junction with `major`? */
function isJunction(minor, major, p) {
  for (const j of minor.junctions || []) {
    if (j.major !== major.id) continue;
    if (j.end === 'start' && p.s <= j.sEdge + 2) return true;
    if (j.end === 'end' && p.s >= j.sEdge - 2) return true;
  }
  return false;
}

/** One line per finding, errors first. */
export function formatFindings(findings) {
  const order = { error: 0, warn: 1 };
  return findings
    .slice()
    .sort((a, b) => order[a.severity] - order[b.severity])
    .map((f) => `${f.severity === 'error' ? '✗' : '!'} [${f.kind}] ${f.text}`)
    .join('\n');
}
