// Local tangent-plane projection + slippy-tile maths.
//
// The world is expressed in metres on a plane anchored at a single origin
// (the place you hopped into). Over the few kilometres a car can cover in a
// session the error of an equirectangular local plane is centimetric, and it
// keeps every tile an exact axis-aligned rectangle — which is what lets the
// ground textures line up seamlessly.
//
// Axis convention (matches three.js defaults): +X east, -Z north, +Y up.

const DEG = Math.PI / 180;

/** Metres per degree of latitude at a given latitude. */
function metresPerDegLat(latDeg) {
  const p = latDeg * DEG;
  return 111132.92 - 559.82 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p) - 0.0023 * Math.cos(6 * p);
}

/** Metres per degree of longitude at a given latitude. */
function metresPerDegLon(latDeg) {
  const p = latDeg * DEG;
  return 111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p) + 0.118 * Math.cos(5 * p);
}

export class Projection {
  constructor(lat0, lon0) {
    this.lat0 = lat0;
    this.lon0 = lon0;
    this.mLat = metresPerDegLat(lat0);
    this.mLon = metresPerDegLon(lat0);
  }

  /** lat/lon -> world metres. */
  x(lon) { return (lon - this.lon0) * this.mLon; }
  z(lat) { return -(lat - this.lat0) * this.mLat; }

  toWorld(lat, lon, out = { x: 0, z: 0 }) {
    out.x = (lon - this.lon0) * this.mLon;
    out.z = -(lat - this.lat0) * this.mLat;
    return out;
  }

  /** world metres -> lat/lon. */
  toLatLon(x, z, out = { lat: 0, lon: 0 }) {
    out.lat = this.lat0 - z / this.mLat;
    out.lon = this.lon0 + x / this.mLon;
    return out;
  }
}

// ---------------------------------------------------------------------------
// Slippy tiles (Web Mercator, the usual z/x/y scheme)
// ---------------------------------------------------------------------------

export function lonToTileX(lon, z) {
  return ((lon + 180) / 360) * Math.pow(2, z);
}

export function latToTileY(lat, z) {
  const p = lat * DEG;
  return ((1 - Math.log(Math.tan(p) + 1 / Math.cos(p)) / Math.PI) / 2) * Math.pow(2, z);
}

export function tileXToLon(x, z) {
  return (x / Math.pow(2, z)) * 360 - 180;
}

export function tileYToLat(y, z) {
  const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, z);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

export function tileKey(z, x, y) {
  return `${z}/${x}/${y}`;
}

/**
 * Geographic bounds of a tile, in the order Overpass wants them
 * (south, west, north, east).
 */
export function tileBounds(z, x, y) {
  return {
    west: tileXToLon(x, z),
    east: tileXToLon(x + 1, z),
    north: tileYToLat(y, z),
    south: tileYToLat(y + 1, z),
  };
}

/** Tile containing a coordinate, at a given zoom. */
export function tileAt(lat, lon, z) {
  return { z, x: Math.floor(lonToTileX(lon, z)), y: Math.floor(latToTileY(lat, z)) };
}

/** Approximate tile side length in metres, north-south and east-west. */
export function tileSizeMetres(z, x, y) {
  const b = tileBounds(z, x, y);
  const mid = (b.north + b.south) / 2;
  return {
    width: (b.east - b.west) * metresPerDegLon(mid),
    height: (b.north - b.south) * metresPerDegLat(mid),
  };
}

// ---------------------------------------------------------------------------
// Small geometry helpers shared by the world builders
// ---------------------------------------------------------------------------

/** Signed area of a closed ring of {x,z} points. Positive = counter-clockwise. */
export function ringArea(points) {
  let a = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    a += (points[j].x + points[i].x) * (points[j].z - points[i].z);
  }
  return a / 2;
}

/** Centroid of a closed ring, falling back to the vertex average if degenerate. */
export function ringCentroid(points) {
  let a = 0, cx = 0, cz = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const f = points[j].x * points[i].z - points[i].x * points[j].z;
    a += f;
    cx += (points[j].x + points[i].x) * f;
    cz += (points[j].z + points[i].z) * f;
  }
  if (Math.abs(a) < 1e-6) {
    let sx = 0, sz = 0;
    for (const p of points) { sx += p.x; sz += p.z; }
    return { x: sx / points.length, z: sz / points.length };
  }
  a *= 0.5;
  return { x: cx / (6 * a), z: cz / (6 * a) };
}

/** Cheap deterministic hash -> [0,1). Used to vary colours without randomness drift. */
export function hash01(n) {
  let h = (n | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
