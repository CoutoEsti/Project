// Lane counts from OpenStreetMap, matched onto the roads of mtl/data/rues.json.
//
// Overture (where rues.json comes from) keeps no `lanes` tag, so the game
// guessed lanes from a road's class. This reads a raw Overpass export of the
// big roads — motorways, trunks, primaries and their links, with geometry —
// and writes mtl/data/voies.json: { index in rues.json → lanes }.
//
//   node mtl/tools/voies.mjs export.json
//
// The query that makes export.json (overpass-turbo.eu, "Export → raw data"):
//
//   [out:json][timeout:180];
//   way["highway"~"^(motorway|motorway_link|trunk|trunk_link|primary|primary_link)$"]
//     (45.44,-73.70,45.60,-73.50);
//   out tags geom;
//
// The two sources do not share ids, so roads are matched by shape: points
// every 10 m along each road look for an OSM way within 8 m running the same
// way; the lanes most of them agree on win, if enough of the road matched.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const input = process.argv[2];
if (!input) {
  console.error('usage : node mtl/tools/voies.mjs export.json');
  process.exit(1);
}

// The street-grid frame (tools/extract.py, data/meta.json).
const meta = JSON.parse(await fs.readFile(path.join(ROOT, 'data/meta.json'), 'utf8'));
const { lat: LAT0, lon: LON0, kx: KX, ky: KY } = meta.repere;
const EAST = (meta.repere.est * Math.PI) / 180;
const toGrid = (lon, lat) => {
  const e = (lon - LON0) * KX, nn = (lat - LAT0) * KY;
  return [e * Math.sin(EAST) + nn * Math.cos(EAST), -e * Math.cos(EAST) + nn * Math.sin(EAST)];
};

const BIG = new Set(['motorway', 'trunk', 'primary']);
const REACH = 8;          // metres between the two centrelines, at most
const STEP = 10;          // metres between probes along a road
const CELL = 50;

// --- OpenStreetMap ways, as segments in a grid ------------------------------
const doc = JSON.parse(await fs.readFile(input, 'utf8'));
const cells = new Map();
let ways = 0;
for (const el of doc.elements || []) {
  if (el.type !== 'way' || !el.geometry || !el.tags) continue;
  const lanes = parseInt(el.tags.lanes, 10);
  if (!(lanes >= 1 && lanes <= 8)) continue;
  const oneway = el.tags.oneway === 'yes' || el.tags.oneway === '1' || /^motorway/.test(el.tags.highway);
  const reverse = el.tags.oneway === '-1';
  const pts = el.geometry.map((g) => toGrid(g.lon, g.lat));
  if (reverse) pts.reverse();
  ways++;
  for (let i = 0; i + 1 < pts.length; i++) {
    const seg = { a: pts[i], b: pts[i + 1], lanes, oneway, id: el.id };
    const x0 = Math.floor((Math.min(seg.a[0], seg.b[0]) - REACH) / CELL), x1 = Math.floor((Math.max(seg.a[0], seg.b[0]) + REACH) / CELL);
    const n0 = Math.floor((Math.min(seg.a[1], seg.b[1]) - REACH) / CELL), n1 = Math.floor((Math.max(seg.a[1], seg.b[1]) + REACH) / CELL);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cn = n0; cn <= n1; cn++) {
        const k = `${cx},${cn}`;
        if (!cells.has(k)) cells.set(k, []);
        cells.get(k).push(seg);
      }
    }
  }
}

/** The OSM segment nearest (x, n) running along (tx, tn), or null. */
function nearest(x, n, tx, tn, oneway) {
  let best = null, bd = REACH;
  for (const seg of cells.get(`${Math.floor(x / CELL)},${Math.floor(n / CELL)}`) || []) {
    const dx = seg.b[0] - seg.a[0], dn = seg.b[1] - seg.a[1], L = Math.hypot(dx, dn);
    if (L < 0.1) continue;
    const cos = (dx * tx + dn * tn) / L;
    // Same direction for a carriageway; either for a two-way road.
    if (oneway ? cos < 0.85 : Math.abs(cos) < 0.85) continue;
    const t = Math.max(0, Math.min(1, ((x - seg.a[0]) * dx + (n - seg.a[1]) * dn) / (L * L)));
    const d = Math.hypot(x - seg.a[0] - dx * t, n - seg.a[1] - dn * t);
    if (d < bd) { bd = d; best = seg; }
  }
  return best;
}

// --- the roads of rues.json -------------------------------------------------
const rues = JSON.parse(await fs.readFile(path.join(ROOT, 'data/rues.json'), 'utf8'));
const out = {};
let tried = 0, matched = 0;
rues.roads.forEach((r, index) => {
  if (!BIG.has(r.c)) return;
  tried++;
  const pts = [];
  for (let i = 0; i < r.p.length; i += 2) pts.push([r.p[i] / 10, r.p[i + 1] / 10]);
  const oneway = !!r.o || r.c === 'motorway';
  const votes = new Map();
  let probes = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 0.1) continue;
    const tx = (b[0] - a[0]) / L, tn = (b[1] - a[1]) / L;
    for (let d = (i === 0 ? 5 : 0); d < L; d += STEP) {
      probes++;
      const seg = nearest(a[0] + tx * d, a[1] + tn * d, tx, tn, oneway);
      if (seg) votes.set(seg.lanes, (votes.get(seg.lanes) || 0) + 1);
    }
  }
  if (!probes) return;
  let lanes = 0, most = 0, total = 0;
  for (const [k, v] of votes) { total += v; if (v > most) { most = v; lanes = k; } }
  if (total >= probes * 0.5 && most >= total * 0.6) { out[index] = lanes; matched++; }
});

await fs.writeFile(path.join(ROOT, 'data/voies.json'), JSON.stringify({
  source: 'OpenStreetMap (Overpass), balise lanes',
  licence: 'ODbL — © les contributeurs d’OpenStreetMap',
  genere: new Date().toISOString().slice(0, 10),
  voies: out,
}));
console.log(`${ways} voies OSM lues ; ${matched} routes sur ${tried} (autoroutes, artères, bretelles) ont leur nombre de voies → data/voies.json`);
