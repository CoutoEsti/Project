// Synthetic Montréal, emitted in exactly the shape Overpass returns.
//
// Why this exists: the game normally streams real OpenStreetMap data, but a
// build machine without network access (or a first-time visitor on a plane,
// or Overpass having a bad day) must still get a world worth driving. So we
// generate a Plateau-Mont-Royal-shaped city — rotated grid, back alleys,
// contiguous rows of triplexes, La Fontaine-sized park — using the same
// element format as the live API. Every downstream builder therefore runs the
// identical code path whether the data is real or synthesised.
//
// Format: { elements: [ {type:'way', id, tags, geometry:[{lat,lon}…]},
//                       {type:'node', id, lat, lon, tags} ] }

import { hash01 } from '../core/geo.js';

// Plateau-Mont-Royal, just west of Parc La Fontaine.
export const MONTREAL_ANCHOR = { lat: 45.5265, lon: -73.5795 };

// The Montréal grid is famously not aligned to true north: what locals call
// "north" is roughly north-west. Cross-streets bear about 22° north of east.
const GRID_ROTATION = 22 * (Math.PI / 180);

const AVENUE_SPACING = 68;    // metres between the long streets
const CROSS_SPACING = 106;    // metres between cross streets
const ROAD_HALF = 4.0;
const SIDEWALK = 2.6;
const FRONT_YARD = 3.2;
const HOUSE_DEPTH = 11.5;
const HOUSE_WIDTH = 7.4;

// Real street names, laid out in the real order, so the minimap and the
// signage read like the neighbourhood rather than like "Street 12".
const AVENUE_NAMES = [
  'Rue Saint-Dominique', 'Boulevard Saint-Laurent', "Avenue de l'Hôtel-de-Ville",
  'Rue Drolet', 'Rue Henri-Julien', 'Rue Laval', 'Rue Berri', 'Rue Saint-Denis',
  'Rue Sanguinet', 'Rue Saint-Hubert', 'Rue Christophe-Colomb', 'Rue Boyer',
  'Rue Mentana', 'Rue Rivard', 'Rue Garnier', 'Rue Fabre', 'Rue Chambord',
  'Rue Marquette', 'Rue Cartier', 'Avenue Papineau', 'Avenue De Lorimier',
  'Rue Parthenais', 'Rue Dorion', 'Rue Alexandre-DeSève', 'Rue Bordeaux',
  'Rue Frontenac', 'Rue Poupart', 'Rue Nicolet',
];

const CROSS_NAMES = [
  'Rue Sherbrooke Est', 'Rue Roy Est', 'Rue Napoléon', 'Rue Duluth Est',
  'Rue Rachel Est', 'Rue Marie-Anne Est', 'Avenue du Mont-Royal Est',
  'Rue Gilford', 'Rue Saint-Grégoire', 'Avenue Laurier Est', 'Rue Saint-Joseph Est',
  'Rue Villeneuve Est', 'Rue Bienville', 'Rue Beaubien Est', 'Rue Saint-Zotique Est',
];

// Streets that are genuinely arterial get wider carriageways, more lanes and
// traffic signals — that contrast is most of what makes a grid feel real.
const ARTERIALS = {
  'Boulevard Saint-Laurent': { highway: 'secondary', lanes: 4 },
  'Rue Saint-Denis': { highway: 'secondary', lanes: 4 },
  'Avenue Papineau': { highway: 'primary', lanes: 4 },
  'Avenue De Lorimier': { highway: 'secondary', lanes: 4 },
  'Rue Saint-Hubert': { highway: 'tertiary', lanes: 2 },
  'Rue Frontenac': { highway: 'tertiary', lanes: 2 },
  'Rue Sherbrooke Est': { highway: 'primary', lanes: 4 },
  'Avenue du Mont-Royal Est': { highway: 'secondary', lanes: 3 },
  'Rue Rachel Est': { highway: 'tertiary', lanes: 2 },
  'Avenue Laurier Est': { highway: 'tertiary', lanes: 2 },
  'Rue Beaubien Est': { highway: 'tertiary', lanes: 2 },
  'Rue Saint-Joseph Est': { highway: 'tertiary', lanes: 2 },
};

// Commercial strips: ground-floor retail changes the building mix entirely.
const COMMERCIAL_STREETS = new Set([
  'Boulevard Saint-Laurent', 'Rue Saint-Denis', 'Avenue du Mont-Royal Est',
  'Avenue Laurier Est', 'Rue Beaubien Est',
]);

/** Deterministic PRNG so screenshots and physics traces are reproducible. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function buildMontrealFixture(options = {}) {
  const anchor = options.anchor || MONTREAL_ANCHOR;
  const extent = options.extent || 1200;      // half-size of the generated square, metres
  const rand = rng(0x5eed1a);

  const mLat = 111132.92 - 559.82 * Math.cos(2 * anchor.lat * Math.PI / 180);
  const mLon = 111412.84 * Math.cos(anchor.lat * Math.PI / 180)
             - 93.5 * Math.cos(3 * anchor.lat * Math.PI / 180);

  const cos = Math.cos(GRID_ROTATION);
  const sin = Math.sin(GRID_ROTATION);

  // Grid space (u along cross-streets, v along avenues) -> world metres -> lat/lon.
  const toLatLon = (u, v) => {
    const x = u * cos - v * sin;
    const z = u * sin + v * cos;
    return { lat: anchor.lat - z / mLat, lon: anchor.lon + x / mLon };
  };

  const elements = [];
  let id = 1;
  const nextId = () => id++;

  const nAve = Math.floor((extent * 2) / AVENUE_SPACING);
  const nCross = Math.floor((extent * 2) / CROSS_SPACING);
  const aveV = [];   // v coordinate of each avenue centreline
  const crossU = []; // u coordinate of each cross-street centreline

  for (let i = 0; i <= nAve; i++) aveV.push(-extent + i * AVENUE_SPACING);
  for (let j = 0; j <= nCross; j++) crossU.push(-extent + j * CROSS_SPACING);

  const uMin = crossU[0], uMax = crossU[crossU.length - 1];
  const vMin = aveV[0], vMax = aveV[aveV.length - 1];

  // Parc La Fontaine, placed off-centre like the real one.
  const park = { u0: -40, u1: 380, v0: 150, v1: 430 };
  const inPark = (u, v) => u > park.u0 && u < park.u1 && v > park.v0 && v < park.v1;

  const nameFor = (list, index) => list[((index % list.length) + list.length) % list.length];

  // ---- Avenues (the long streets) ------------------------------------------
  aveV.forEach((v, i) => {
    const name = nameFor(AVENUE_NAMES, i);
    const spec = ARTERIALS[name] || { highway: 'residential', lanes: 2 };
    const tags = {
      highway: spec.highway,
      name,
      lanes: String(spec.lanes),
      surface: 'asphalt',
    };
    if (spec.highway === 'residential') tags.maxspeed = '40';
    else tags.maxspeed = '50';
    if (COMMERCIAL_STREETS.has(name)) tags.lit = 'yes';

    // Break the avenue where it would cross the park, like the real street net.
    const spans = [];
    if (v > park.v0 && v < park.v1) {
      spans.push([uMin, park.u0], [park.u1, uMax]);
    } else {
      spans.push([uMin, uMax]);
    }
    for (const [a, b] of spans) {
      if (b - a < 20) continue;
      const geometry = [];
      // A few intermediate vertices keep the road from being a single huge
      // segment, which matters for marking generation and culling.
      const steps = Math.max(2, Math.round((b - a) / 60));
      for (let s = 0; s <= steps; s++) {
        const u = a + ((b - a) * s) / steps;
        geometry.push(toLatLon(u, v));
      }
      elements.push({ type: 'way', id: nextId(), tags, geometry });
    }
  });

  // ---- Cross streets -------------------------------------------------------
  crossU.forEach((u, j) => {
    const name = nameFor(CROSS_NAMES, j);
    const spec = ARTERIALS[name] || { highway: 'residential', lanes: 2 };
    const tags = {
      highway: spec.highway,
      name,
      lanes: String(spec.lanes),
      surface: 'asphalt',
      maxspeed: spec.highway === 'residential' ? '40' : '50',
    };
    const spans = [];
    if (u > park.u0 && u < park.u1) {
      spans.push([vMin, park.v0], [park.v1, vMax]);
    } else {
      spans.push([vMin, vMax]);
    }
    for (const [a, b] of spans) {
      if (b - a < 20) continue;
      const geometry = [];
      const steps = Math.max(2, Math.round((b - a) / 60));
      for (let s = 0; s <= steps; s++) {
        const v = a + ((b - a) * s) / steps;
        geometry.push(toLatLon(u, v));
      }
      elements.push({ type: 'way', id: nextId(), tags, geometry });
    }
  });

  // ---- Ruelles: the back alleys that make Montréal look like Montréal ------
  for (let i = 0; i < aveV.length - 1; i++) {
    const v = aveV[i] + AVENUE_SPACING / 2;
    if (v > park.v0 && v < park.v1) continue;
    const geometry = [];
    const steps = Math.max(2, Math.round((uMax - uMin) / 60));
    for (let s = 0; s <= steps; s++) geometry.push(toLatLon(uMin + ((uMax - uMin) * s) / steps, v));
    elements.push({
      type: 'way', id: nextId(),
      tags: { highway: 'service', service: 'alley', surface: 'asphalt', name: 'Ruelle' },
      geometry,
    });
  }

  // ---- Buildings -----------------------------------------------------------
  // Two contiguous rows per block, one facing each avenue, set back behind a
  // sidewalk and a small front yard — the classic Plateau section.
  const frontOffset = ROAD_HALF + SIDEWALK + FRONT_YARD;

  for (let i = 0; i < aveV.length - 1; i++) {
    const avenueName = nameFor(AVENUE_NAMES, i);
    const nextAvenueName = nameFor(AVENUE_NAMES, i + 1);

    for (const side of [0, 1]) {
      const v0 = side === 0 ? aveV[i] + frontOffset : aveV[i + 1] - frontOffset - HOUSE_DEPTH;
      const v1 = v0 + HOUSE_DEPTH;
      const street = side === 0 ? avenueName : nextAvenueName;
      const commercial = COMMERCIAL_STREETS.has(street);

      for (let j = 0; j < crossU.length - 1; j++) {
        const uStart = crossU[j] + 9;
        const uEnd = crossU[j + 1] - 9;
        let u = uStart;
        let houseNo = 4000 + i * 40 + j * 4;

        while (u + HOUSE_WIDTH < uEnd) {
          const w = HOUSE_WIDTH * (0.85 + rand() * 0.4);
          if (u + w > uEnd) break;
          const cu = u + w / 2;
          const cv = (v0 + v1) / 2;
          if (inPark(cu, cv)) { u += w + 0.7; continue; }

          const depth = commercial ? HOUSE_DEPTH + 4 : HOUSE_DEPTH * (0.9 + rand() * 0.25);
          const bv1 = v0 + depth;
          const levels = commercial
            ? 2 + Math.floor(rand() * 3)
            : (rand() < 0.62 ? 3 : (rand() < 0.7 ? 2 : 4));

          const tags = {
            building: commercial ? 'retail' : (levels >= 3 ? 'apartments' : 'house'),
            'building:levels': String(levels),
            'addr:street': street,
            'addr:housenumber': String(houseNo),
          };
          if (commercial) tags.shop = 'yes';
          // Roughly a third of real Montréal buildings carry a material tag;
          // matching that ratio keeps the colour mix honest.
          const m = rand();
          if (m < 0.42) tags['building:material'] = 'brick';
          else if (m < 0.55) tags['building:material'] = 'stone';

          elements.push({
            type: 'way', id: nextId(), tags,
            geometry: [
              toLatLon(u, v0), toLatLon(u + w, v0),
              toLatLon(u + w, bv1), toLatLon(u, bv1), toLatLon(u, v0),
            ],
          });
          u += w + 0.7;
          houseNo += 2;
        }
      }
    }
  }

  // ---- Parc La Fontaine ----------------------------------------------------
  elements.push({
    type: 'way', id: nextId(),
    tags: { leisure: 'park', name: 'Parc La Fontaine' },
    geometry: [
      toLatLon(park.u0, park.v0), toLatLon(park.u1, park.v0),
      toLatLon(park.u1, park.v1), toLatLon(park.u0, park.v1),
      toLatLon(park.u0, park.v0),
    ],
  });

  // The pond, as an irregular blob rather than a rectangle.
  const pondU = (park.u0 + park.u1) / 2 + 40;
  const pondV = (park.v0 + park.v1) / 2;
  const pond = [];
  for (let a = 0; a < 24; a++) {
    const t = (a / 24) * Math.PI * 2;
    const r = 62 + Math.sin(t * 3) * 16 + Math.cos(t * 2) * 10;
    pond.push(toLatLon(pondU + Math.cos(t) * r * 1.4, pondV + Math.sin(t) * r * 0.75));
  }
  pond.push(pond[0]);
  elements.push({ type: 'way', id: nextId(), tags: { natural: 'water', name: 'Étang' }, geometry: pond });

  // A couple of smaller green squares elsewhere, so the park isn't a one-off.
  for (const sq of [{ u: -420, v: -330, w: 150, h: 96 }, { u: 520, v: -180, w: 120, h: 110 }]) {
    elements.push({
      type: 'way', id: nextId(),
      tags: { leisure: 'park', name: 'Parc de quartier' },
      geometry: [
        toLatLon(sq.u, sq.v), toLatLon(sq.u + sq.w, sq.v),
        toLatLon(sq.u + sq.w, sq.v + sq.h), toLatLon(sq.u, sq.v + sq.h),
        toLatLon(sq.u, sq.v),
      ],
    });
  }

  // ---- Point furniture -----------------------------------------------------
  // Street lamps and trees along the avenues; signals where arterials meet.
  aveV.forEach((v, i) => {
    const name = nameFor(AVENUE_NAMES, i);
    const arterial = !!ARTERIALS[name];
    for (let u = uMin; u < uMax; u += 30) {
      const sideSign = (Math.floor(u / 30) % 2 === 0) ? 1 : -1;
      const lv = v + sideSign * (ROAD_HALF + 1.2);
      if (inPark(u, lv)) continue;
      const p = toLatLon(u, lv);
      elements.push({ type: 'node', id: nextId(), lat: p.lat, lon: p.lon, tags: { highway: 'street_lamp' } });
    }
    if (!arterial) {
      for (let u = uMin + 6; u < uMax; u += 11) {
        const sideSign = hash01(Math.round(u * 7) + i * 131) > 0.5 ? 1 : -1;
        const tv = v + sideSign * (ROAD_HALF + 1.6);
        if (inPark(u, tv)) continue;
        if (hash01(Math.round(u * 13) + i * 977) < 0.25) continue;
        const p = toLatLon(u, tv);
        elements.push({ type: 'node', id: nextId(), lat: p.lat, lon: p.lon, tags: { natural: 'tree' } });
      }
    }
  });

  // Park trees, scattered but never in the pond.
  for (let k = 0; k < 260; k++) {
    const u = park.u0 + 12 + rand() * (park.u1 - park.u0 - 24);
    const v = park.v0 + 12 + rand() * (park.v1 - park.v0 - 24);
    const du = (u - pondU) / 1.5, dv = v - pondV;
    if (Math.sqrt(du * du + dv * dv) < 78) continue;
    const p = toLatLon(u, v);
    elements.push({ type: 'node', id: nextId(), lat: p.lat, lon: p.lon, tags: { natural: 'tree' } });
  }

  // Traffic signals at arterial × arterial crossings, stop signs elsewhere on
  // the bigger cross streets.
  aveV.forEach((v, i) => {
    const aName = nameFor(AVENUE_NAMES, i);
    crossU.forEach((u, j) => {
      const cName = nameFor(CROSS_NAMES, j);
      const both = ARTERIALS[aName] && ARTERIALS[cName];
      const one = ARTERIALS[aName] || ARTERIALS[cName];
      if (inPark(u, v)) return;
      const p = toLatLon(u, v);
      if (both) {
        elements.push({ type: 'node', id: nextId(), lat: p.lat, lon: p.lon, tags: { highway: 'traffic_signals' } });
      } else if (one && hash01(i * 31 + j * 17) < 0.5) {
        elements.push({ type: 'node', id: nextId(), lat: p.lat, lon: p.lon, tags: { highway: 'stop' } });
      }
    });
  });

  return {
    elements,
    meta: {
      synthetic: true,
      anchor,
      name: 'Plateau-Mont-Royal (généré)',
      bounds: boundsOf(elements),
    },
  };
}

function boundsOf(elements) {
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const el of elements) {
    if (el.type === 'node') {
      if (el.lat < minLat) minLat = el.lat;
      if (el.lat > maxLat) maxLat = el.lat;
      if (el.lon < minLon) minLon = el.lon;
      if (el.lon > maxLon) maxLon = el.lon;
    } else if (el.geometry) {
      for (const g of el.geometry) {
        if (g.lat < minLat) minLat = g.lat;
        if (g.lat > maxLat) maxLat = g.lat;
        if (g.lon < minLon) minLon = g.lon;
        if (g.lon > maxLon) maxLon = g.lon;
      }
    }
  }
  return { minLat, maxLat, minLon, maxLon };
}
