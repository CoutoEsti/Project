// Cut a prepared dataset into a pack of z15 tiles the browser can stream.
//
//   node hop/tools/pack-data.mjs hop/data/montreal.json hop/data/mtl
//
// Why this exists: the single-file dataset works beautifully up to a few
// hundred elements per square kilometre and then falls off a cliff. The
// Plateau extract is 107 km² for 10,6 Mo — about 0,10 Mo/km². The whole island
// is roughly five times that area, so a single file would be ~50 Mo, half a
// million elements parsed before the menu can even be drawn, and a linear scan
// of all of them for every one of the thirty-five tiles resident around the
// car. A pack turns that into one small fetch per tile actually visited.
//
// Four kinds of output land in the target directory:
//   index.json      the manifest: zoom, bounds, and which tiles exist
//   {x}/{y}.json    one array of elements per tile
//   overview.json   roads only, simplified — what the menu map rasterises
//   far.json        the skyline: what is worth drawing beyond the tile ring
//
// The tile arithmetic is imported from the game's own geo.js rather than
// reimplemented, because a packer that disagreed with the runtime by even one
// tile would drop geometry along every tile seam and the cause would be
// invisible in the output.

import fs from 'node:fs';
import path from 'node:path';

const ZOOM = 15;

// Elements are filed under every tile they touch. For a line that means the
// tiles its segments actually cross; for an area it means the tiles its
// interior covers, because a park you are standing in the middle of still has
// to be drawn. Areas bigger than this many tiles get clipped rather than
// copied whole — the St. Lawrence is one ring of several thousand vertices
// spanning hundreds of tiles, and copying it into each of them would dwarf the
// rest of the city put together.
const CLIP_ABOVE_TILES = 16;
// Clip rectangles are grown by ~1 m so neighbouring pieces overlap instead of
// meeting on an exact float boundary, where a hairline seam can show through.
const CLIP_MARGIN_DEG = 1e-5;

// The menu map is 2048 px for a city ~40 km across, so ~20 m per pixel.
// Simplifying to a quarter of that is far below anything visible.
const OVERVIEW_EPSILON_M = 5;
const MAJOR = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary',
  'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link',
  'residential', 'unclassified', 'living_street', 'pedestrian']);

// --- the far layer ---------------------------------------------------------
// Past the detailed tile ring a building is a silhouette against the sky, so it
// is drawn as a single oriented box. The filter below is what makes the whole
// idea affordable: on the Plateau extract only 470 of 19 732 buildings pass it
// — 2,4 %. A three-storey triplex is two pixels tall at four kilometres and
// contributes nothing but draw calls, whereas a grain elevator or a downtown
// tower is the entire reason you can tell which way you are facing.
const FAR_MIN_HEIGHT = 15;      // metres
const FAR_MIN_FOOTPRINT = 1200; // square metres
// Coarse ground cover, painted into the backdrop texture so the land beyond
// the tiles is not one flat colour: from the mountain you should see the river
// and the parks. Anything smaller than a city block is invisible at that range.
const COVER_MIN_AREA = 8000;
const COVER_EPSILON_M = 30;
const COVER_KINDS = [
  ['water', (t) => t.natural === 'water' || t.waterway === 'riverbank'],
  ['green', (t) => /^(park|garden|golf_course|common)$/.test(t.leisure || '')
    || /^(forest|grass|meadow|cemetery|recreation_ground|village_green|farmland)$/.test(t.landuse || '')
    || /^(wood|scrub|grassland)$/.test(t.natural || '')],
  ['sand', (t) => t.natural === 'sand' || t.natural === 'bare_rock'],
  ['built', (t) => t.landuse === 'industrial' || t.landuse === 'railway'],
];

const FLOOR_HEIGHT = 3.2;

/**
 * Height in metres. Must agree with heightFor() in world/buildings.js, or a
 * tower would change size the moment you drove close enough for the detailed
 * tile to replace its silhouette.
 */
function heightFor(tags) {
  const h = num(tags.height ?? tags['building:height']);
  if (Number.isFinite(h) && h > 1) return Math.min(h, 320);
  const levels = num(tags['building:levels']);
  if (Number.isFinite(levels) && levels >= 1) return Math.min(levels * FLOOR_HEIGHT + 1.1, 320);
  switch (tags.building) {
    case 'house': case 'detached': case 'bungalow': return 7.0;
    case 'garage': case 'garages': case 'shed': case 'hut': return 3.0;
    case 'terrace': case 'semidetached_house': return 9.5;
    case 'apartments': case 'residential': return 11.5;
    case 'commercial': case 'office': return 14.0;
    case 'retail': case 'supermarket': return 8.0;
    case 'industrial': case 'warehouse': return 9.0;
    case 'church': case 'cathedral': case 'chapel': return 17.0;
    case 'school': case 'university': case 'hospital': return 12.5;
    default: return 9.5;
  }
}

function num(v) {
  if (v == null) return NaN;
  const m = String(v).match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : NaN;
}

// geo.js is an ES module with a .js extension and the project ships no
// package.json — adding one under hop/ would change how Vercel identifies the
// folder. Loading the source through a data: URL gets Node to treat it as the
// module it already is, with no build step and no second copy of the maths.
async function loadGeo() {
  const src = fs.readFileSync(new URL('../src/core/geo.js', import.meta.url), 'utf8');
  const url = 'data:text/javascript;base64,' + Buffer.from(src).toString('base64');
  return import(url);
}

// ---------------------------------------------------------------------------
// which tiles does an element belong to
// ---------------------------------------------------------------------------

/** Tiles crossed by a polyline, walking the grid cell by cell. */
function tilesForLine(geom, geo, z) {
  const out = new Set();
  for (let i = 0; i < geom.length; i++) {
    const fx = geo.lonToTileX(geom[i].lon, z);
    const fy = geo.latToTileY(geom[i].lat, z);
    out.add(`${Math.floor(fx)}/${Math.floor(fy)}`);
    if (i === 0) continue;
    const px = geo.lonToTileX(geom[i - 1].lon, z);
    const py = geo.latToTileY(geom[i - 1].lat, z);
    // Sample the segment densely enough that no cell can be stepped over: one
    // sample per half-cell of the longer axis.
    const steps = Math.ceil(Math.max(Math.abs(fx - px), Math.abs(fy - py)) * 2);
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      out.add(`${Math.floor(px + (fx - px) * t)}/${Math.floor(py + (fy - py) * t)}`);
    }
  }
  return out;
}

/** Every tile in an element's bounding box. */
function tilesForBox(box, geo, z) {
  const x0 = Math.floor(geo.lonToTileX(box.west, z));
  const x1 = Math.floor(geo.lonToTileX(box.east, z));
  const y0 = Math.floor(geo.latToTileY(box.north, z));
  const y1 = Math.floor(geo.latToTileY(box.south, z));
  const out = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push(`${x}/${y}`);
  return out;
}

function boundsOf(geom) {
  let south = 90, north = -90, west = 180, east = -180;
  for (const p of geom) {
    if (p.lat < south) south = p.lat;
    if (p.lat > north) north = p.lat;
    if (p.lon < west) west = p.lon;
    if (p.lon > east) east = p.lon;
  }
  return { south, north, west, east };
}

const AREA_KEYS = ['building', 'building:part', 'leisure', 'landuse', 'natural'];

function isArea(el) {
  const t = el.tags || {};
  if (t.area === 'yes') return true;
  if (t.highway || t.barrier || t.railway) return false;
  if (t.waterway) return false;                       // river centrelines are lines
  return AREA_KEYS.some((k) => t[k]);
}

// ---------------------------------------------------------------------------
// Sutherland–Hodgman, against one axis-aligned tile
// ---------------------------------------------------------------------------

function clipToBox(geom, box) {
  const edges = [
    { keep: (p) => p.lon >= box.west, cut: (a, b) => lerpLon(a, b, box.west) },
    { keep: (p) => p.lon <= box.east, cut: (a, b) => lerpLon(a, b, box.east) },
    { keep: (p) => p.lat >= box.south, cut: (a, b) => lerpLat(a, b, box.south) },
    { keep: (p) => p.lat <= box.north, cut: (a, b) => lerpLat(a, b, box.north) },
  ];
  let ring = geom;
  for (const e of edges) {
    if (!ring.length) return [];
    const next = [];
    for (let i = 0; i < ring.length; i++) {
      const cur = ring[i];
      const prev = ring[(i + ring.length - 1) % ring.length];
      const curIn = e.keep(cur);
      const prevIn = e.keep(prev);
      if (curIn) {
        if (!prevIn) next.push(e.cut(prev, cur));
        next.push(cur);
      } else if (prevIn) {
        next.push(e.cut(prev, cur));
      }
    }
    ring = next;
  }
  return ring;
}

function lerpLon(a, b, lon) {
  const t = (lon - a.lon) / (b.lon - a.lon);
  return { lat: a.lat + (b.lat - a.lat) * t, lon };
}

function lerpLat(a, b, lat) {
  const t = (lat - a.lat) / (b.lat - a.lat);
  return { lat, lon: a.lon + (b.lon - a.lon) * t };
}

// ---------------------------------------------------------------------------
// overview: roads only, Ramer–Douglas–Peucker
// ---------------------------------------------------------------------------

function simplify(points, epsilon) {
  if (points.length < 3) return points;
  let maxDist = 0;
  let index = 0;
  const first = points[0];
  const last = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpendicular(points[i], first, last);
    if (d > maxDist) { maxDist = d; index = i; }
  }
  if (maxDist <= epsilon) return [first, last];
  const left = simplify(points.slice(0, index + 1), epsilon);
  const right = simplify(points.slice(index), epsilon);
  return left.slice(0, -1).concat(right);
}

function perpendicular(p, a, b) {
  const dx = b.lon - a.lon;
  const dy = b.lat - a.lat;
  const len = Math.hypot(dx, dy);
  if (len === 0) return Math.hypot(p.lon - a.lon, p.lat - a.lat);
  return Math.abs(dy * p.lon - dx * p.lat + b.lon * a.lat - b.lat * a.lon) / len;
}

function buildOverview(elements, meta) {
  // A degree of longitude is shorter than a degree of latitude here, so the
  // tolerance is taken on the tighter axis: erring towards keeping vertices.
  const midLat = ((meta.bounds.north + meta.bounds.south) / 2) * Math.PI / 180;
  const epsilon = OVERVIEW_EPSILON_M / (111320 * Math.cos(midLat));
  const out = [];
  let before = 0, after = 0;
  for (const el of elements) {
    if (el.type !== 'way' || !el.tags || !el.tags.highway) continue;
    if (!MAJOR.has(el.tags.highway) && el.tags.highway !== 'service') continue;
    before += el.geometry.length;
    const geom = simplify(el.geometry, epsilon);
    after += geom.length;
    out.push({ type: 'way', tags: { highway: el.tags.highway, service: el.tags.service }, geometry: geom });
  }
  return { elements: out, before, after };
}

// ---------------------------------------------------------------------------
// far layer: oriented boxes and coarse ground cover
// ---------------------------------------------------------------------------

const M_LAT = 111132.92;
const mLon = (lat) => 111412.84 * Math.cos(lat * Math.PI / 180);

/** Ring in metres east/north of an anchor. */
function toMetres(geom, lat0, lon0) {
  const k = mLon(lat0);
  return geom.map((p) => ({ x: (p.lon - lon0) * k, y: (p.lat - lat0) * M_LAT }));
}

/** Andrew's monotone chain. */
function convexHull(pts) {
  const p = [...pts].sort((a, b) => (a.x - b.x) || (a.y - b.y));
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const half = (src) => {
    const h = [];
    for (const q of src) {
      while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], q) <= 0) h.pop();
      h.push(q);
    }
    h.pop();
    return h;
  };
  return half(p).concat(half([...p].reverse()));
}

/**
 * Smallest enclosing rectangle. The minimum-area rectangle around a convex
 * polygon always has one side collinear with a hull edge, so trying every edge
 * finds the exact optimum — and footprints have a handful of vertices, so
 * "every edge" costs nothing.
 */
function minAreaRect(pts) {
  const hull = convexHull(pts);
  if (hull.length < 3) return null;
  let best = null;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const cos = Math.cos(-angle), sin = Math.sin(-angle);
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const p of hull) {
      const u = p.x * cos - p.y * sin;
      const v = p.x * sin + p.y * cos;
      if (u < minU) minU = u; if (u > maxU) maxU = u;
      if (v < minV) minV = v; if (v > maxV) maxV = v;
    }
    const w = maxU - minU, d = maxV - minV;
    if (!best || w * d < best.area) {
      // Centre back in world axes: undo the rotation applied above.
      const cu = (minU + maxU) / 2, cv = (minV + maxV) / 2;
      best = {
        area: w * d, w, d, angle,
        cx: cu * cos + cv * sin,
        cy: -cu * sin + cv * cos,
      };
    }
  }
  return best;
}

function ringAreaM2(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a / 2);
}

const r6 = (v) => Math.round(v * 1e6) / 1e6;
const r1 = (v) => Math.round(v * 10) / 10;

function buildFar(elements, meta) {
  const lat0 = (meta.bounds.north + meta.bounds.south) / 2;
  const lon0 = (meta.bounds.east + meta.bounds.west) / 2;
  const k = mLon(lat0);

  const buildings = [];
  let examined = 0;
  for (const el of elements) {
    const t = el.tags || {};
    if (!t.building && !t['building:part']) continue;
    if (!Array.isArray(el.geometry) || el.geometry.length < 3) continue;
    examined++;
    const height = heightFor(t);
    const ring = toMetres(el.geometry, lat0, lon0);
    const foot = ringAreaM2(ring);
    if (height < FAR_MIN_HEIGHT && foot < FAR_MIN_FOOTPRINT) continue;
    const rect = minAreaRect(ring);
    if (!rect || !(rect.w > 1) || !(rect.d > 1)) continue;
    // Stored as lat/lon so the browser can place it against whatever origin
    // the player hopped into. The angle is a bearing in the east/north plane;
    // three.js gets rotation.y = -angle because its +Z points south.
    buildings.push([
      r6(lat0 + rect.cy / M_LAT), r6(lon0 + rect.cx / k),
      r1(rect.w), r1(rect.d), Math.round(rect.angle * 1e3) / 1e3, r1(height),
    ]);
  }

  const cover = [];
  const epsilon = COVER_EPSILON_M / k;
  for (const el of elements) {
    const t = el.tags || {};
    if (!Array.isArray(el.geometry) || el.geometry.length < 4) continue;
    const kind = COVER_KINDS.find(([, test]) => test(t));
    if (!kind) continue;
    if (ringAreaM2(toMetres(el.geometry, lat0, lon0)) < COVER_MIN_AREA) continue;
    const geom = simplify(el.geometry, epsilon);
    if (geom.length < 4) continue;
    cover.push([kind[0], geom.map((p) => [r6(p.lat), r6(p.lon)])]);
  }

  return { buildings, cover, examined };
}

// ---------------------------------------------------------------------------

async function main() {
  const [input, outDir] = process.argv.slice(2);
  if (!input || !outDir) {
    console.error('usage: node pack-data.mjs <dataset.json> <outdir>');
    process.exit(2);
  }

  const geo = await loadGeo();
  const doc = JSON.parse(fs.readFileSync(input, 'utf8'));
  const elements = Array.isArray(doc) ? doc : doc.elements;
  if (!Array.isArray(elements) || !elements.length) {
    console.error('aucun élément dans', input);
    process.exit(1);
  }
  const meta = doc.meta || {};
  if (!meta.bounds) meta.bounds = boundsOf(elements.flatMap((e) => (e.type === 'node' ? [e] : e.geometry)));

  const tiles = new Map();       // "x/y" -> element[]
  const stats = { lines: 0, areas: 0, nodes: 0, clipped: 0, copies: 0, dropped: 0 };

  const push = (key, el) => {
    let list = tiles.get(key);
    if (!list) { list = []; tiles.set(key, list); }
    list.push(el);
    stats.copies++;
  };

  for (const el of elements) {
    if (el.type === 'node') {
      stats.nodes++;
      push(`${Math.floor(geo.lonToTileX(el.lon, ZOOM))}/${Math.floor(geo.latToTileY(el.lat, ZOOM))}`, el);
      continue;
    }
    if (!Array.isArray(el.geometry) || el.geometry.length < 2) { stats.dropped++; continue; }

    if (!isArea(el)) {
      stats.lines++;
      for (const key of tilesForLine(el.geometry, geo, ZOOM)) push(key, el);
      continue;
    }

    stats.areas++;
    const box = boundsOf(el.geometry);
    const keys = tilesForBox(box, geo, ZOOM);
    if (keys.length <= CLIP_ABOVE_TILES) {
      for (const key of keys) push(key, el);
      continue;
    }
    // Too big to copy whole: hand each tile only the piece that falls inside
    // it. Buildings never reach here; rivers, big parks and the lake do.
    stats.clipped++;
    for (const key of keys) {
      const [x, y] = key.split('/').map(Number);
      const b = geo.tileBounds(ZOOM, x, y);
      const piece = clipToBox(el.geometry, {
        west: b.west - CLIP_MARGIN_DEG, east: b.east + CLIP_MARGIN_DEG,
        south: b.south - CLIP_MARGIN_DEG, north: b.north + CLIP_MARGIN_DEG,
      });
      if (piece.length >= 3) push(key, { ...el, geometry: piece });
    }
  }

  // --- write ---------------------------------------------------------------
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const keys = [...tiles.keys()].sort();
  let bytes = 0;
  let biggest = { key: null, size: 0 };
  for (const key of keys) {
    const [x, y] = key.split('/');
    const dir = path.join(outDir, x);
    fs.mkdirSync(dir, { recursive: true });
    const json = JSON.stringify(tiles.get(key));
    fs.writeFileSync(path.join(dir, `${y}.json`), json);
    bytes += json.length;
    if (json.length > biggest.size) biggest = { key, size: json.length };
  }

  const overview = buildOverview(elements, meta);
  const overviewDoc = { meta: { ...meta, counts: undefined }, elements: overview.elements };
  fs.writeFileSync(path.join(outDir, 'overview.json'), JSON.stringify(overviewDoc));
  const overviewSize = fs.statSync(path.join(outDir, 'overview.json')).size;

  const far = buildFar(elements, meta);
  fs.writeFileSync(path.join(outDir, 'far.json'), JSON.stringify({
    anchor: {
      lat: (meta.bounds.north + meta.bounds.south) / 2,
      lon: (meta.bounds.east + meta.bounds.west) / 2,
    },
    bounds: meta.bounds,
    buildings: far.buildings,
    cover: far.cover,
  }));
  const farSize = fs.statSync(path.join(outDir, 'far.json')).size;

  const index = {
    meta: {
      name: meta.name || 'Montréal',
      source: meta.source || 'OpenStreetMap',
      licence: meta.licence || 'ODbL — © les contributeurs d’OpenStreetMap',
      generated: new Date().toISOString().slice(0, 10),
      bounds: meta.bounds,
    },
    zoom: ZOOM,
    tiles: keys,
    far: true,
    overview: true,
  };
  fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(index));

  const km2 = (meta.bounds.north - meta.bounds.south) * 111.32
    * (meta.bounds.east - meta.bounds.west) * 111.32
    * Math.cos((meta.bounds.north + meta.bounds.south) / 2 * Math.PI / 180);

  console.log(`${elements.length} éléments → ${keys.length} tuiles z${ZOOM} (${km2.toFixed(0)} km²)`);
  console.log(`  ${stats.lines} lignes, ${stats.areas} surfaces (${stats.clipped} découpées), ${stats.nodes} nœuds`);
  console.log(`  ${stats.copies} copies, soit ${(stats.copies / elements.length).toFixed(2)} tuile(s) par élément`);
  console.log(`  ${(bytes / 1e6).toFixed(1)} Mo au total, ${(bytes / keys.length / 1e3).toFixed(0)} Ko par tuile en moyenne`);
  console.log(`  plus grosse tuile ${biggest.key} : ${(biggest.size / 1e3).toFixed(0)} Ko`);
  console.log(`  aperçu : ${overview.elements.length} routes, ${overview.before} → ${overview.after} sommets, ${(overviewSize / 1e6).toFixed(2)} Mo`);
  console.log(`  horizon : ${far.buildings.length} silhouettes sur ${far.examined} bâtiments `
    + `(${(100 * far.buildings.length / Math.max(1, far.examined)).toFixed(1)} %), `
    + `${far.cover.length} surfaces de couverture, ${(farSize / 1e6).toFixed(2)} Mo`);
}

main();
