// The settings a person changes: which part of Montréal, and at what scale.
// Defaults live in mtl/carte.json; the menu (and the URL) override them.
//
// A zone is a multipolygon in Montréal's street-grid frame, real metres,
// origin at Peel and Sainte-Catherine (x towards "east", n "north"). The named
// zones below are rectangles, [x0, n0, x1, n1], kept as a special case (the
// map is then cut with the cheap rectangle code); a drawn zone — see
// mtl/zones.html — is a list of polygons, `poly: [ring, …]`, rings being
// [[x, n], …] rounded to the metre. Several polygons are their union.

import * as G from './geom.js';

export const ZONES = {
  // The playable map: a closed shape you can read at a glance, like an
  // open-world game's. The river on the south, the mountain on the north,
  // Turcot on the west; the Lachine canal under Saint-Henri, the islands and
  // the foot of the Jacques-Cartier bridge in Longueuil, so no bridge stops
  // in mid-river. About 30 km², a quarter of `anneau`.
  coeur: {
    nom: 'Cœur',
    description: 'Centre-ville, Vieux-Montréal, Vieux-Port, mont Royal, Saint-Henri, Turcot, les îles et la tête du pont à Longueuil',
    poly: [[
      // West: Turcot, from the foot of the Décarie trench to the canal.
      [-4700, 700], [-4700, -560],
      // South-west: the south bank of the Lachine canal.
      [-4000, -850], [-3000, -1120], [-2500, -1230], [-1500, -1400], [-700, -1750], [-350, -1800],
      // Bonaventure down to the Cité du Havre, then the river (the Victoria
      // bridge stays outside: it leads nowhere in this zone).
      [-400, -2000], [-350, -2600], [-250, -3000], [150, -2950], [1100, -3250], [1650, -3800], [3000, -3800],
      // Longueuil, at the foot of the bridge.
      [3200, -3250], [3700, -3150], [4300, -3150], [4700, -2700], [4700, -2100], [4100, -1600],
      // Back across the river, then up De Lorimier.
      [3800, -900], [3550, -450], [3550, 1050],
      // North: Sherbrooke, the Avenue du Parc, around the mountain.
      [1150, 650], [1000, 1300], [950, 2300], [300, 2950], [-1000, 3150], [-2000, 3100],
      [-2900, 2700], [-3100, 1800], [-3000, 750],
    ]],
  },
  centre: {
    nom: 'Centre',
    description: 'Centre-ville, Vieux-Montréal, Vieux-Port, Plateau, mont Royal, la Ville-Marie et les îles',
    box: [-2900, -3800, 3800, 3400],
  },
  anneau: {
    nom: 'Anneau',
    description: 'Le centre, plus Décarie, la 40, Turcot et le Stade olympique',
    box: [-4700, -3800, 6900, 7150],
  },
};

export const ECHELLES = [100, 85, 70];

export const DEFAUTS = { zone: 'coeur', echelle: 100 };

/** The id a drawn zone goes by in `settings.zone`. */
export const PERSO = 'perso';

/**
 * Settings from carte.json, then the URL on top:
 *   ?zone=<name>          a named zone (wins over ?forme=, so the menu can override it)
 *   ?forme=<base64url>    a drawn zone (see encodeShape)
 *   ?echelle=100
 * In carte.json, `zone` is a name or a shape { nom, poly } (what the drawing
 * tool exports), or a `forme` string. A drawn zone comes out as
 * settings.zone === 'perso' with the shape in settings.forme.
 */
export function resolveSettings(file = {}, params = null) {
  const s = { ...DEFAUTS, ...pick(file) };
  if (params) {
    const forme = params.get('forme') ? decodeShape(params.get('forme')) : null;
    if (forme) { s.zone = PERSO; s.forme = forme; }
    if (params.get('zone') && ZONES[params.get('zone')]) { s.zone = params.get('zone'); delete s.forme; }
    if (params.get('echelle')) s.echelle = Number(params.get('echelle'));
  }
  if (s.zone === PERSO && !(s.forme && makeZone(s.forme))) { s.zone = DEFAUTS.zone; delete s.forme; }
  if (s.zone !== PERSO && !ZONES[s.zone]) s.zone = DEFAUTS.zone;
  if (!(s.echelle >= 50 && s.echelle <= 100)) s.echelle = DEFAUTS.echelle;
  return s;
}

function pick(o) {
  const out = {};
  if (!o) return out;
  if (Number.isFinite(Number(o.echelle))) out.echelle = Number(o.echelle);
  const shape = (v) => (typeof v === 'string' ? decodeShape(v) : normalizeShape(v));
  if (typeof o.zone === 'string') out.zone = o.zone;
  else if (o.zone && typeof o.zone === 'object') {
    const f = shape(o.zone);
    if (f) { out.zone = PERSO; out.forme = f; }
  }
  if (o.forme) {
    const f = shape(o.forme);
    if (f) { out.zone = PERSO; out.forme = f; }
  }
  return out;
}

/** The zone definition ({ nom, box } or { nom, poly }) a settings object names. */
export function zoneDef(settings) {
  if (settings.zone === PERSO && settings.forme) return settings.forme;
  return ZONES[settings.zone] || ZONES[DEFAUTS.zone];
}

// ------------------------------------------------------------------ shapes --

/**
 * A drawn zone as it is stored: { nom, poly: [ring, …] } with integer metres,
 * rings open. Accepts a polygon list in either flavour (rings, or
 * polygon-clipping polygons) and { box } too. Null when there is nothing.
 */
export function normalizeShape(o) {
  if (!o || typeof o !== 'object') return null;
  const nom = typeof o.nom === 'string' ? o.nom.slice(0, 60) : '';
  if (Array.isArray(o.box) && o.box.length === 4 && o.box.every(Number.isFinite)) return { nom, box: o.box.map(Math.round) };
  if (!Array.isArray(o.poly)) return null;
  const rings = [];
  for (const item of o.poly) {
    if (!Array.isArray(item) || !item.length) continue;
    const ring = Array.isArray(item[0][0]) ? item[0] : item;       // a polygon: its outer ring
    const r = ring.filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))
      .map((p) => [Math.round(p[0]), Math.round(p[1])]);
    const open = G.openRing(r);
    if (open.length >= 3) rings.push(open);
  }
  return rings.length ? { nom, poly: rings } : null;
}

// Binary layout, then base64url: version, name (length + UTF-8), ring count,
// and per ring its length then zigzag varints of x, n, and each step after.
function pushVar(out, v) {
  let u = v >= 0 ? v * 2 : -v * 2 - 1;
  while (u >= 128) { out.push((u % 128) | 128); u = Math.floor(u / 128); }
  out.push(u);
}
function pushUnsigned(out, u) {
  while (u >= 128) { out.push((u % 128) | 128); u = Math.floor(u / 128); }
  out.push(u);
}

/** A shape as a short URL-safe string: `?forme=…`. */
export function encodeShape(shape) {
  const f = normalizeShape(shape);
  if (!f) return '';
  const rings = f.poly || [[[f.box[0], f.box[1]], [f.box[2], f.box[1]], [f.box[2], f.box[3]], [f.box[0], f.box[3]]]];
  const bytes = [1];
  const name = new TextEncoder().encode(f.nom || '');
  pushUnsigned(bytes, name.length);
  for (const b of name) bytes.push(b);
  pushUnsigned(bytes, rings.length);
  for (const ring of rings) {
    pushUnsigned(bytes, ring.length);
    let px = 0, pn = 0;
    for (const [x, n] of ring) { pushVar(bytes, x - px); pushVar(bytes, n - pn); px = x; pn = n; }
  }
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The reverse; null for anything that is not a shape. */
export function decodeShape(text) {
  try {
    const bin = atob(String(text).replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    let o = 0;
    const un = () => {
      let u = 0, k = 1;
      for (;;) {
        if (o >= bytes.length) throw new Error('court');
        const b = bytes[o++];
        u += (b & 127) * k;
        if (b < 128) return u;
        k *= 128;
      }
    };
    const zz = () => { const u = un(); return u % 2 ? -(u + 1) / 2 : u / 2; };
    if (bytes[o++] !== 1) return null;
    const len = un();
    const nom = new TextDecoder().decode(bytes.slice(o, o + len));
    o += len;
    const count = un();
    if (count < 1 || count > 200) return null;
    const poly = [];
    for (let r = 0; r < count; r++) {
      const m = un();
      if (m < 3 || m > 20000) return null;
      let x = 0, n = 0;
      const ring = [];
      for (let i = 0; i < m; i++) { x += zz(); n += zz(); ring.push([x, n]); }
      poly.push(ring);
    }
    return normalizeShape({ nom, poly });
  } catch (e) {
    return null;
  }
}

// -------------------------------------------------------------------- zones --

const rectRing = ([x0, n0, x1, n1]) => [[x0, n0], [x1, n0], [x1, n1], [x0, n1], [x0, n0]];

/**
 * A zone ready to be asked things.
 * @param def { nom, box } | { nom, poly: rings } | { nom, multi: MultiPolygon }
 * @returns  { nom, box (null for a drawn zone), multi, edges, bbox, area (m²),
 *             contains(x, n, pad), boxState(x0, n0, x1, n1), grow(pad), centre }
 *           or null when the definition holds no area.
 */
export function makeZone(def) {
  if (!def) return null;
  let multi, box = null;
  if (def.box) {
    box = def.box.slice();
    multi = [[rectRing(box)]];
  } else if (def.multi) {
    multi = def.multi;
  } else {
    const shape = normalizeShape(def);
    if (!shape) return null;
    if (shape.box) { box = shape.box; multi = [[rectRing(box)]]; } else multi = union(shape.poly);
  }
  if (!multi.length) return null;
  const edges = [];
  let x0 = Infinity, n0 = Infinity, x1 = -Infinity, n1 = -Infinity;
  for (const poly of multi) {
    for (const ring of poly) {
      for (let i = 0; i + 1 < ring.length; i++) edges.push([ring[i][0], ring[i][1], ring[i + 1][0], ring[i + 1][1]]);
    }
    const b = G.ringBBox(poly[0]);
    x0 = Math.min(x0, b.x0); n0 = Math.min(n0, b.n0); x1 = Math.max(x1, b.x1); n1 = Math.max(n1, b.n1);
  }
  const bbox = box ? box.slice() : [x0, n0, x1, n1];
  const area = multi.reduce((a, p) => a + G.polygonArea(p), 0);
  if (!(area > 1)) return null;
  const zone = {
    nom: def.nom || '', box, multi, edges, bbox, area,
    contains: null, boxState: null, grow: null, centre: null, def,
  };
  let raster = null;
  const rast = () => raster || (raster = buildRaster(zone));
  zone.contains = box
    ? (x, n, pad = 0) => x >= box[0] - pad && x <= box[2] + pad && n >= box[1] - pad && n <= box[3] + pad
    : (x, n, pad = 0) => {
      if (x < bbox[0] - pad || x > bbox[2] + pad || n < bbox[1] - pad || n > bbox[3] + pad) return false;
      const r = rast();
      const i = Math.floor((x - bbox[0]) / r.cell), j = Math.floor((n - bbox[1]) / r.cell);
      let inside = false;
      if (i >= 0 && j >= 0 && i < r.cols && j < r.rows) {
        const st = r.state[j * r.cols + i];
        inside = st === 1 || (st === 2 && G.pointInMulti(x, n, multi));
      }
      if (inside || pad <= 0) return inside;
      return edgeDistance(edges, x, n, pad) <= pad;
    };
  // 1 when the whole box lies inside the zone, 0 when none of it does, 2 otherwise.
  zone.boxState = (qx0, qn0, qx1, qn1) => {
    if (qx1 < bbox[0] || qx0 > bbox[2] || qn1 < bbox[1] || qn0 > bbox[3]) return 0;
    if (box) return qx0 >= box[0] && qx1 <= box[2] && qn0 >= box[1] && qn1 <= box[3] ? 1 : 2;
    const r = rast();
    if (qx0 < bbox[0] || qx1 > bbox[2] || qn0 < bbox[1] || qn1 > bbox[3]) {
      // Sticks out of the raster: never "all inside"; maybe "none".
      let any = false;
      forCells(r, Math.max(qx0, bbox[0]), Math.max(qn0, bbox[1]), Math.min(qx1, bbox[2]), Math.min(qn1, bbox[3]), (st) => { if (st) any = true; });
      return any ? 2 : 0;
    }
    let all = true, any = false;
    forCells(r, qx0, qn0, qx1, qn1, (st) => { if (st !== 1) all = false; if (st) any = true; });
    return all ? 1 : any ? 2 : 0;
  };
  const grown = new Map();
  zone.grow = (pad) => {
    if (!(pad > 0)) return multi;
    if (box) return [[rectRing([box[0] - pad, box[1] - pad, box[2] + pad, box[3] + pad])]];
    if (!grown.has(pad)) grown.set(pad, growMulti(multi, pad, bbox));
    return grown.get(pad);
  };
  // A point inside the zone, for a start when nothing else is there.
  let big = multi[0];
  for (const p of multi) if (G.polygonArea(p) > G.polygonArea(big)) big = p;
  zone.centre = box ? [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2] : G.interiorPoint(big);
  return zone;
}

/** Shrink or grow every coordinate: the zone at another scale. */
export function scaleZone(zone, s) {
  if (s === 1) return zone;
  if (zone.box) return makeZone({ nom: zone.nom, box: zone.box.map((v) => v * s) });
  const multi = zone.multi.map((poly) => poly.map((ring) => ring.map(([x, n]) => [x * s, n * s])));
  return makeZone({ nom: zone.nom, multi });
}

function union(rings) {
  const polys = rings.map((r) => [G.closeRing(r)]);
  try {
    return polys.length === 1 ? G.pc.union(polys[0]) : G.pc.union(...polys);
  } catch (e) {
    return polys;
  }
}

/** The zone widened by `pad`: each edge buffered, all of it merged. */
function growMulti(multi, pad, bbox) {
  try {
    const parts = [multi];
    for (const poly of multi) {
      for (const ring of poly) {
        const pts = G.simplify(ring, Math.max(1, pad / 25));
        parts.push(G.bufferPolyline(pts, pad, 0));
        parts.push([[G.circleRing(ring[0][0], ring[0][1], pad, 16)]]);
      }
    }
    return G.unionAll(parts);
  } catch (e) {
    return [[rectRing([bbox[0] - pad, bbox[1] - pad, bbox[2] + pad, bbox[3] + pad])]];
  }
}

function edgeDistance(edges, x, n, limit) {
  let best = Infinity;
  for (const e of edges) {
    if (x < Math.min(e[0], e[2]) - limit || x > Math.max(e[0], e[2]) + limit) continue;
    if (n < Math.min(e[1], e[3]) - limit || n > Math.max(e[1], e[3]) + limit) continue;
    const d = G.segDist2(x, n, e[0], e[1], e[2], e[3]).d2;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

// A coarse raster over the bounding box: 0 outside, 1 inside, 2 where the
// boundary passes (ask the polygon). Most questions end there.
function buildRaster(zone) {
  const [x0, n0, x1, n1] = zone.bbox;
  const cell = Math.max(20, Math.sqrt(((x1 - x0) * (n1 - n0)) / 60000));
  const cols = Math.ceil((x1 - x0) / cell) + 1, rows = Math.ceil((n1 - n0) / cell) + 1;
  const state = new Uint8Array(cols * rows);
  const r = { cell, cols, rows, state, x0, n0 };
  for (const [ax, an, bx, bn] of zone.edges) {
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - x0) / cell)), i1 = Math.min(cols - 1, Math.floor((Math.max(ax, bx) - x0) / cell));
    const j0 = Math.max(0, Math.floor((Math.min(an, bn) - n0) / cell)), j1 = Math.min(rows - 1, Math.floor((Math.max(an, bn) - n0) / cell));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        if (segmentTouchesBox(ax, an, bx, bn, x0 + i * cell, n0 + j * cell, x0 + (i + 1) * cell, n0 + (j + 1) * cell)) state[j * cols + i] = 2;
      }
    }
  }
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      if (state[j * cols + i]) continue;
      state[j * cols + i] = G.pointInMulti(x0 + (i + 0.5) * cell, n0 + (j + 0.5) * cell, zone.multi) ? 1 : 0;
    }
  }
  return r;
}

function forCells(r, qx0, qn0, qx1, qn1, fn) {
  const i0 = Math.max(0, Math.floor((qx0 - r.x0) / r.cell)), i1 = Math.min(r.cols - 1, Math.floor((qx1 - r.x0) / r.cell));
  const j0 = Math.max(0, Math.floor((qn0 - r.n0) / r.cell)), j1 = Math.min(r.rows - 1, Math.floor((qn1 - r.n0) / r.cell));
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) fn(r.state[j * r.cols + i]);
}

function segmentTouchesBox(ax, an, bx, bn, x0, n0, x1, n1) {
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dn = bn - an;
  const clip = (p, q) => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
    return true;
  };
  return clip(-dx, ax - x0) && clip(dx, x1 - ax) && clip(-dn, an - n0) && clip(dn, n1 - an);
}

/** Area of a shape in km², for the drawing tool and the README's promises. */
export function shapeAreaKm2(shape) {
  const z = makeZone(shape);
  return z ? z.area / 1e6 : 0;
}
