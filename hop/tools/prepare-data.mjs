// Compact a raw Overpass export into the dataset the game ships.
//
//   node hop/tools/prepare-data.mjs hop/data/montreal.raw.json hop/data/montreal.json
//
// Three things shrink the file, in order of how much they matter:
//   1. minifying (Overpass pretty-prints, which roughly triples the size)
//   2. dropping every tag the renderer never reads
//   3. rounding coordinates to six decimals — about 11 cm, far below the
//      precision of the survey the data came from
//
// Relations are flattened to their outer rings here rather than at runtime, so
// the browser never has to think about them.

import fs from 'node:fs';

const KEEP_WAY_TAGS = new Set([
  'highway', 'name', 'lanes', 'oneway', 'width', 'surface', 'maxspeed',
  'service', 'tunnel', 'bridge', 'layer', 'area', 'access',
  'building', 'building:part', 'building:levels', 'building:material',
  'building:facade:material', 'height', 'building:height', 'min_height',
  'natural', 'leisure', 'landuse', 'waterway', 'railway', 'barrier',
]);

const KEEP_NODE_KINDS = [
  ['highway', new Set(['street_lamp', 'traffic_signals', 'stop', 'give_way', 'turning_circle'])],
  ['natural', new Set(['tree'])],
  ['amenity', new Set(['bench', 'fountain'])],
];

const round = (v) => Math.round(v * 1e6) / 1e6;

function trimTags(tags, keep) {
  if (!tags) return undefined;
  const out = {};
  let n = 0;
  for (const k of Object.keys(tags)) {
    if (keep.has(k)) { out[k] = tags[k]; n++; }
  }
  return n ? out : undefined;
}

function nodeTags(tags) {
  if (!tags) return null;
  for (const [key, values] of KEEP_NODE_KINDS) {
    const v = tags[key];
    if (v && values.has(v)) return { [key]: v };
  }
  return null;
}

function geometry(list) {
  const out = [];
  let lastLat = null, lastLon = null;
  for (const g of list) {
    if (!g || !Number.isFinite(g.lat) || !Number.isFinite(g.lon)) continue;
    const lat = round(g.lat), lon = round(g.lon);
    // Rounding can collapse neighbouring vertices; drop the duplicates.
    if (lat === lastLat && lon === lastLon) continue;
    out.push({ lat, lon });
    lastLat = lat; lastLon = lon;
  }
  return out;
}

function main() {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    console.error('usage: node prepare-data.mjs <raw.json> <out.json>');
    process.exit(2);
  }

  const raw = JSON.parse(fs.readFileSync(input, 'utf8'));
  const source = raw.elements || [];
  const elements = [];
  const stats = { ways: 0, nodes: 0, relations: 0, droppedNodes: 0, droppedWays: 0 };

  for (const el of source) {
    if (el.type === 'node') {
      const tags = nodeTags(el.tags);
      if (!tags) { stats.droppedNodes++; continue; }
      elements.push({ type: 'node', lat: round(el.lat), lon: round(el.lon), tags });
      stats.nodes++;
      continue;
    }

    if (el.type === 'way') {
      const tags = trimTags(el.tags, KEEP_WAY_TAGS);
      if (!tags) { stats.droppedWays++; continue; }
      const geom = geometry(el.geometry || []);
      if (geom.length < 2) { stats.droppedWays++; continue; }
      elements.push({ type: 'way', id: el.id, tags, geometry: geom });
      stats.ways++;
      continue;
    }

    if (el.type === 'relation' && Array.isArray(el.members)) {
      const tags = trimTags(el.tags, KEEP_WAY_TAGS);
      if (!tags) continue;
      for (const m of el.members) {
        if (m.role && m.role !== 'outer') continue;
        const geom = geometry(m.geometry || []);
        if (geom.length < 3) continue;
        elements.push({ type: 'way', id: `${el.id}:${m.ref}`, tags, geometry: geom });
        stats.relations++;
      }
    }
  }

  let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
  for (const el of elements) {
    const pts = el.type === 'node' ? [el] : el.geometry;
    for (const p of pts) {
      if (p.lat < minLat) minLat = p.lat;
      if (p.lat > maxLat) maxLat = p.lat;
      if (p.lon < minLon) minLon = p.lon;
      if (p.lon > maxLon) maxLon = p.lon;
    }
  }

  const doc = {
    meta: {
      name: 'Montréal',
      source: 'OpenStreetMap',
      licence: 'ODbL — © les contributeurs d’OpenStreetMap',
      generated: new Date().toISOString().slice(0, 10),
      bounds: { south: minLat, west: minLon, north: maxLat, east: maxLon },
      counts: stats,
    },
    elements,
  };

  fs.writeFileSync(output, JSON.stringify(doc));
  const before = fs.statSync(input).size;
  const after = fs.statSync(output).size;
  console.log(`${elements.length} éléments  (${stats.ways} ways, ${stats.nodes} nodes, ${stats.relations} anneaux de relations)`);
  console.log(`abandonnés : ${stats.droppedWays} ways, ${stats.droppedNodes} nodes sans intérêt pour le rendu`);
  console.log(`bbox ${minLat.toFixed(4)},${minLon.toFixed(4)} → ${maxLat.toFixed(4)},${maxLon.toFixed(4)}`);
  console.log(`${(before / 1e6).toFixed(1)} Mo → ${(after / 1e6).toFixed(1)} Mo (${(100 - (after / before) * 100).toFixed(0)} % en moins)`);
}

main();
