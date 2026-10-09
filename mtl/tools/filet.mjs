// The safety net for changes to the map: everything a driver would see wrong
// (holes, slits between carriageways, solid things on the asphalt, road ends
// open on the void, relief over a road, points of a road at the wrong height)
// and every wall, barrier and median deck, summed per 40 m cell over the
// whole map, then compared with the reference committed next to this file.
//
//   node mtl/tools/filet.mjs                       → anneau and coeur against the reference
//   node mtl/tools/filet.mjs --vise decarie        → changes allowed in Décarie only
//   node mtl/tools/filet.mjs --vise -4000,3000,-3600,4500   (x0,n0,x1,n1, metres)
//   node mtl/tools/filet.mjs --vise decarie --permet fente   → and the slits may shrink anywhere
//   node mtl/tools/filet.mjs --zone coeur
//   node mtl/tools/filet.mjs --accepter            → the new numbers become the reference
//
// It fails when anything changes outside the boxes named by --vise (in either
// direction: 4.5 km of fascia gone far from a fix is a bug, not a gain), when
// a defect grows anywhere, inside the boxes too, or when the map drifts by a
// little everywhere. Inside the boxes, walls may change and defects may
// shrink: that is the fix. check.mjs runs it on anneau with the world it has
// already built; `--accepter` is only for after the change has been looked at.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { artefacts, openEnds, slits, groundOver, offLevel, walls } from './lib/mesures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REF = (zone) => path.join(HERE, 'filet', `${zone}.json`);
const CELL = 40;

// Places a change usually aims at, in real metres: x0, n0, x1, n1.
export const PLACES = {
  decarie: [-4300, -600, -3200, 7100],
  turcot: [-5000, -1300, -3400, 400],
  savane: [-3800, 4800, -2900, 5800],
  'ville-marie': [-4700, -900, 2900, 300],
  'jacques-cartier': [2900, -2800, 4400, 300],
  concorde: [1300, -2700, 2500, -1700],
};

// Defects: a growth anywhere fails. tol: the smallest change that counts in
// one cell (one probe of the measure).
const DEFECTS = {
  trou: { unit: 'm²', tol: 3, what: 'trous sous les roues' },
  fente: { unit: 'm', tol: 2, what: 'fentes entre chaussées' },
  obstacle: { unit: 'm', tol: 1, what: 'obstacles sur la chaussée' },
  bout: { unit: '', tol: 1, what: 'bouts de route ouverts' },
  sol: { unit: 'm', tol: 4, what: 'relief au-dessus de la route' },
  niveau: { unit: '', tol: 1, what: 'points de route mal posés' },
};
const WALL_TOL = 2;       // metres of wall in a cell
const DRIFT = 25;         // metres of wall, summed over every cell outside the boxes

/** Everything measured on a built world, per metric and per cell. */
export function measure(world) {
  const s = world.layout.map.scale || 1;
  const cells = {};
  const add = (metric, x, n, v) => {
    const k = `${Math.floor(x / s / CELL)},${Math.floor(n / s / CELL)}`;
    const m = cells[metric] || (cells[metric] = {});
    m[k] = (m[k] || 0) + v;
  };
  const art = artefacts(world);
  for (const p of art.hole) add('trou', p.x, p.n, p.len);
  for (const p of art.obstacle) add('obstacle', p.x, p.n, p.len);
  for (const e of openEnds(world)) if (e.miss > 0) add('bout', e.x, e.n, 1);
  for (const p of slits(world)) add('fente', p.x, p.n, p.len);
  for (const p of groundOver(world)) add('sol', p.x, p.n, p.len);
  for (const p of offLevel(world)) add('niveau', p.x, p.n, p.len);
  for (const w of walls(world)) add(w.kind, w.x, w.n, w.len);
  const totals = {};
  for (const [m, c] of Object.entries(cells)) {
    for (const k of Object.keys(c)) c[k] = Math.round(c[k] * 10) / 10;
    totals[m] = Math.round(Object.values(c).reduce((a, v) => a + v, 0));
  }
  return { totals, cells };
}

/** --vise: names from PLACES or x0,n0,x1,n1 boxes, comma or space separated. */
export function parseTargets(spec) {
  if (!spec) return [];
  const out = [];
  for (const part of String(spec).split(/[ ;]+/).filter(Boolean)) {
    if (/^-?\d/.test(part)) {
      const v = part.split(',').map(Number);
      for (let i = 0; i + 3 < v.length; i += 4) out.push({ name: v.slice(i, i + 4).join(','), box: v.slice(i, i + 4) });
    } else {
      for (const name of part.split(',')) {
        if (!PLACES[name]) throw new Error(`--vise : lieu inconnu « ${name} » (connus : ${Object.keys(PLACES).join(', ')})`);
        out.push({ name, box: PLACES[name] });
      }
    }
  }
  return out;
}

function inside(targets, k) {
  const [i, j] = k.split(',').map(Number);
  const x0 = i * CELL, n0 = j * CELL, x1 = x0 + CELL, n1 = n0 + CELL;
  return targets.some(({ box: [a, b, c, d] }) => x1 > Math.min(a, c) && x0 < Math.max(a, c) && n1 > Math.min(b, d) && n0 < Math.max(b, d));
}

/**
 * Compares a measure with the reference. `allowed`: metrics that may change
 * anywhere (a rule meant for the whole map: every slit between twins); a
 * defect among them still may not grow.
 * @returns { ok, lines: [string], changes } — lines: the report, in French
 */
export function compare(ref, now, targets = [], world = null, allowed = []) {
  const lines = [], fails = [];
  const metrics = new Set([...Object.keys(ref.cells), ...Object.keys(now.cells)]);
  const changed = [];   // { k, metric, a, b, in }
  let drift = 0;
  for (const m of metrics) {
    const A = ref.cells[m] || {}, B = now.cells[m] || {};
    const tol = DEFECTS[m] ? DEFECTS[m].tol : WALL_TOL;
    for (const k of new Set([...Object.keys(A), ...Object.keys(B)])) {
      const a = A[k] || 0, b = B[k] || 0, d = b - a;
      if (!d) continue;
      const tin = allowed.includes(m) || inside(targets, k);
      if (!DEFECTS[m] && !tin) drift += Math.abs(d);
      if (Math.abs(d) < tol) continue;
      changed.push({ k, metric: m, a, b, in: tin });
    }
  }
  // Totals, the defects first.
  const order = [...Object.keys(DEFECTS), ...[...metrics].filter((m) => !DEFECTS[m]).sort()];
  lines.push('             référence  maintenant');
  for (const m of order) {
    const a = ref.totals[m] || 0, b = now.totals[m] || 0;
    if (!a && !b) continue;
    const unit = DEFECTS[m] ? DEFECTS[m].unit : 'm';
    const d = b - a;
    lines.push(`  ${m.padEnd(20)} ${String(a).padStart(7)} ${String(b).padStart(7)} ${unit.padEnd(3)}${d ? ` ${d > 0 ? '+' : ''}${d}` : ''}`);
  }
  const outside = changed.filter((c) => !c.in);
  const worse = changed.filter((c) => DEFECTS[c.metric] && c.b > c.a);
  if (outside.length) fails.push(`${new Set(outside.map((c) => c.k)).size} cellules de 40 m changent hors de la zone visée`);
  if (worse.length) {
    const by = {};
    for (const c of worse) by[c.metric] = (by[c.metric] || 0) + c.b - c.a;
    fails.push('défauts en plus : ' + Object.entries(by).map(([m, v]) => `${DEFECTS[m].what} +${Math.round(v)} ${DEFECTS[m].unit}`).join(', '));
  }
  if (drift > DRIFT) fails.push(`${Math.round(drift)} m de murs bougent un peu partout hors de la zone visée`);

  // Where: changed cells grouped into places (cells within 3 of each other).
  const groups = [];
  for (const c of changed) {
    const [i, j] = c.k.split(',').map(Number);
    let g = groups.find((g) => g.cells.some(([p, q]) => Math.abs(p - i) <= 3 && Math.abs(q - j) <= 3));
    if (!g) groups.push(g = { cells: [], by: {}, in: true, worse: false });
    g.cells.push([i, j]);
    g.by[c.metric] = (g.by[c.metric] || 0) + c.b - c.a;
    g.in = g.in && c.in;
    if (DEFECTS[c.metric] && c.b > c.a) g.worse = true;
  }
  for (const g of groups) {
    const xs = g.cells.map((c) => c[0]), ns = g.cells.map((c) => c[1]);
    g.box = [Math.min(...xs) * CELL, Math.min(...ns) * CELL, (Math.max(...xs) + 1) * CELL, (Math.max(...ns) + 1) * CELL];
    g.size = Object.values(g.by).reduce((a, v) => a + Math.abs(v), 0);
    g.near = world ? nearestRoad(world, (g.box[0] + g.box[2]) / 2, (g.box[1] + g.box[3]) / 2) : '';
  }
  groups.sort((a, b) => (a.in - b.in) || (b.worse - a.worse) || (b.size - a.size));
  if (groups.length) {
    lines.push(`\n  ${groups.length} endroits changent (${changed.length} changements de cellule) :`);
    for (const g of groups.slice(0, 20)) {
      const what = Object.entries(g.by).filter(([, v]) => Math.abs(v) >= 0.5)
        .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 5)
        .map(([m, v]) => `${m} ${v > 0 ? '+' : ''}${Math.round(v)}`).join(', ');
      lines.push(`  ${g.in ? 'visé ' : 'HORS '}${g.worse ? 'PIRE ' : '     '}x ${g.box[0]}..${g.box[2]}, n ${g.box[1]}..${g.box[3]}${g.near ? ` (${g.near})` : ''} : ${what}`);
    }
    if (groups.length > 20) lines.push(`  … et ${groups.length - 20} autres`);
  } else lines.push('\n  rien ne change');
  return { ok: !fails.length, fails, lines, changed };
}

function nearestRoad(world, x, n) {
  const s = world.layout.map.scale || 1;
  let best = null, bd = 120 * s;
  for (const r of world.layout.roads) {
    for (const p of r.samples) {
      const d = Math.hypot(p.x - x * s, p.n - n * s);
      if (d < bd) { bd = d; best = r.name || r.id; }
    }
  }
  if (best) return best;
  for (const st of world.layout.streetsAt(x * s, n * s, 60 * s, [])) if (st.name) return st.name;
  return '';
}

export function readRef(zone) {
  try { return JSON.parse(fs.readFileSync(REF(zone), 'utf8')); } catch { return null; }
}

export function writeRef(zone, settings, now) {
  fs.mkdirSync(path.dirname(REF(zone)), { recursive: true });
  // One metric per line, cells sorted: a reference change reads as a diff.
  const body = [`{"zone":${JSON.stringify(zone)},"echelle":${settings.echelle},"cellule":${CELL},`,
    `"totals":${JSON.stringify(now.totals)},`, '"cells":{'];
  const ms = Object.keys(now.cells).sort();
  ms.forEach((m, i) => {
    const c = now.cells[m];
    const sorted = Object.fromEntries(Object.keys(c).sort().map((k) => [k, c[k]]));
    body.push(`${JSON.stringify(m)}:${JSON.stringify(sorted)}${i + 1 < ms.length ? ',' : ''}`);
  });
  body.push('}}\n');
  fs.writeFileSync(REF(zone), body.join('\n'));
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const zones = arg('--zone', 'anneau,coeur').split(',');
  const targets = parseTargets(arg('--vise', null));
  const allowed = (arg('--permet', '') || '').split(',').filter(Boolean);
  const ACCEPT = args.includes('--accepter');
  const THREE = await import('../vendor/three.module.min.js');
  const { buildWorld } = await import('../src/world/build.js');
  const { loadSourceNode } = await import('./lib/source-node.mjs');
  const source = await loadSourceNode();
  let ok = true;
  for (const zone of zones) {
    const settings = { zone, echelle: 100 };
    const t0 = performance.now();
    const world = await buildWorld(THREE, source, { settings, outside: false });
    const now = measure(world);
    const ref = readRef(zone);
    console.log(`\n${zone} — mesuré en ${((performance.now() - t0) / 1000).toFixed(0)} s${targets.length ? `, zone visée : ${targets.map((t) => t.name).join(', ')}` : ''}${allowed.length ? `, partout : ${allowed.join(', ')}` : ''}`);
    if (ACCEPT) {
      if (ref) for (const l of compare(ref, now, targets, world, allowed).lines) console.log(l);
      writeRef(zone, settings, now);
      console.log(`  référence écrite : ${path.relative(process.cwd(), REF(zone))}`);
      continue;
    }
    if (!ref) { console.log(`  pas de référence : node mtl/tools/filet.mjs --accepter --zone ${zone}`); ok = false; continue; }
    const res = compare(ref, now, targets, world, allowed);
    for (const l of res.lines) console.log(l);
    console.log(res.ok ? '\n  ok' : `\n  ÉCHEC — ${res.fails.join(' ; ')}`);
    ok = ok && res.ok;
  }
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
