// Exit gantries, from the data: wherever a ramp leaves a highway, a green
// panel stands over the carriageway some 250 m before, naming where the ramp
// goes — the street it ends on, or the highway it joins. Nothing is placed by
// hand, so every zone and every scale gets its own.
//
// Pure logic: returns sign specs for world/signs.js ({ road, at, dir, panels }).

import { projectOnRoad, SPACING } from './layout.js';

const AHEAD = 250;        // metres before the split
const APART = 180;        // two gantries on one carriageway at least this far apart
const MAX = 90;           // each panel is a texture: keep the count bounded

export function exitSigns(layout) {
  const s = layout.map.scale;
  const found = [];
  for (const r of layout.roads) {
    if (r.cls !== 'ramp' || !r.samples.length) continue;
    const j = (r.junctions || []).find((k) => k.end === 'start');
    if (!j) continue;
    const major = layout.roadById[j.major];
    if (!major || major.cls !== 'highway' || !major.oneway) continue;
    const p0 = r.samples[0];
    const hit = projectOnRoad(major, p0.x, p0.n);
    if (!hit || hit.s < AHEAD * s + 40) continue;
    const dest = destination(layout, r);
    if (!dest) continue;
    const at = major.samples[Math.round((hit.s - AHEAD * s) / SPACING)];
    if (!at || at.covered || Math.abs(at.y - at.gs) > 30) continue;
    found.push({ major, at, s: hit.s, dest });
  }
  // Nearest exits first, one gantry per stretch.
  found.sort((a, b) => a.s - b.s);
  const out = [];
  for (const f of found) {
    if (out.some((o) => o.road === f.major.id && Math.abs(o.s - f.s) < APART * s)) continue;
    out.push({
      road: f.major.id, s: f.s, at: [f.at.x, f.at.n], dir: [f.at.tx, f.at.tn],
      panels: [f.dest.ref ? { ref: f.dest.ref, dir: f.dest.dir, text: f.dest.name } : { dir: 'SORTIE', text: f.dest.name }],
    });
    if (out.length >= MAX) break;
  }
  return out;
}

/** Where a ramp leads: the highway it joins (with its shield) or the street it ends on. */
function destination(layout, r) {
  const end = (r.junctions || []).find((k) => k.end === 'end');
  const e = r.samples[r.samples.length - 1];
  const heading = cardinal(e.tx, e.tn);
  if (end) {
    const to = layout.roadById[end.major];
    if (to && to.cls === 'highway' && to.name) {
      const ref = to.ref ? to.ref.replace(/^[AR]/, '') : null;
      const name = shorten(to.name);
      return { name: /^\d+$/.test(name) ? `Autoroute ${name}` : name, ref, dir: heading };
    }
    if (to && to.name) return { name: shorten(to.name) };
  }
  const tmp = [];
  const st = layout.streetsAt(e.x, e.n, 4, tmp).find((k) => k.name);
  if (!st) return r.name ? { name: shorten(r.name) } : null;
  // A ramp that lands on a service road (Crémazie along the 40) is signed
  // for the first street it lets you turn onto, as the real panels are.
  if (Math.abs(dirOf(st, e.x, e.n)[0] * e.tx + dirOf(st, e.x, e.n)[1] * e.tn) > 0.8) {
    for (let d = 20; d <= 300; d += 10) {
      const x = e.x + e.tx * d, n = e.n + e.tn * d;
      const cross = layout.streetsAt(x, n, 0, tmp).find((k) => k.name && k.name !== st.name
        && Math.abs(dirOf(k, x, n)[0] * e.tx + dirOf(k, x, n)[1] * e.tn) < 0.45);
      if (cross) return { name: shorten(cross.name) };
    }
  }
  return { name: shorten(st.name) };
}

/** Unit direction of a street's segment nearest (x, n). */
function dirOf(st, x, n) {
  let best = [1, 0], bd = Infinity;
  const P = st.path;
  for (let i = 0; i + 1 < P.length; i++) {
    const mx = (P[i][0] + P[i + 1][0]) / 2, mn = (P[i][1] + P[i + 1][1]) / 2;
    const d = (mx - x) ** 2 + (mn - n) ** 2;
    if (d >= bd) continue;
    const l = Math.hypot(P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1]) || 1;
    bd = d;
    best = [(P[i + 1][0] - P[i][0]) / l, (P[i + 1][1] - P[i][1]) / l];
  }
  return best;
}

/** Québec panels abbreviate: Boul., Av., Ch., and drop "Rue". */
export function shorten(name) {
  return name
    .replace(/^Autoroute /, '')
    .replace(/^Boulevard /, 'Boul. ')
    .replace(/^Avenue /, 'Av. ')
    .replace(/^Chemin /, 'Ch. ')
    .replace(/^Rue /, '')
    .replace(/ (Est|Ouest|Nord|Sud)$/, '');
}

/** Montréal's street-grid compass: "north" is up the island. */
function cardinal(tx, tn) {
  if (Math.abs(tn) >= Math.abs(tx)) return tn > 0 ? 'NORD' : 'SUD';
  return tx > 0 ? 'EST' : 'OUEST';
}
