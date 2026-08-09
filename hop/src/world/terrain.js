// Ground elevation, from the Mapzen terrain tiles hosted on AWS Open Data.
//
// The "terrarium" encoding packs metres into a PNG:
//     height = red · 256 + green + blue / 256 − 32768
// which gives a centimetre of precision over the whole range of the planet,
// in an image any browser can decode. No key, CORS open, free.
//
// The catch is resolution. These tiles come from SRTM and friends at about
// thirty metres a sample, which is fine for the shape of a mountain and far
// too coarse for a road — sampled raw, a street inherits every stair-step of
// the source data and the car judders. So the sampler blurs: it reads a small
// neighbourhood and weights it, which costs nothing and turns the staircase
// into the smooth ramp a road actually is.

const ENDPOINT = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const ZOOM = 12;               // ≈9.5 km a tile at this latitude
const TILE_PX = 256;

const DEG = Math.PI / 180;

function lonToTileX(lon, z) { return ((lon + 180) / 360) * Math.pow(2, z); }
function latToTileY(lat, z) {
  const p = lat * DEG;
  return ((1 - Math.log(Math.tan(p) + 1 / Math.cos(p)) / Math.PI) / 2) * Math.pow(2, z);
}

export class Terrain {
  /**
   * @param {object} opts {enabled:boolean, exaggeration:number}
   */
  constructor(opts = {}) {
    this.enabled = opts.enabled !== false;
    this.exaggeration = opts.exaggeration ?? 1;
    this.tiles = new Map();      // key -> Float32Array(256×256) | 'pending' | 'failed'
    this.baseline = 0;           // height at the hop origin, so the world starts at y≈0
    this.baselineReady = false;  // false until the origin's own tile has landed
    this.originLat = 0;
    this.originLon = 0;
    this.ready = false;
    this.lastError = null;
  }

  _key(x, y) { return `${x}/${y}`; }

  /**
   * Load every elevation tile covering a geographic box. Resolves when they
   * have all settled; failures are silent and read as flat ground.
   */
  async ensure(bounds) {
    if (!this.enabled) return;
    const x0 = Math.floor(lonToTileX(bounds.west, ZOOM));
    const x1 = Math.floor(lonToTileX(bounds.east, ZOOM));
    const y0 = Math.floor(latToTileY(bounds.north, ZOOM));
    const y1 = Math.floor(latToTileY(bounds.south, ZOOM));

    const jobs = [];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const key = this._key(x, y);
        if (this.tiles.has(key)) continue;
        this.tiles.set(key, 'pending');
        jobs.push(this._load(x, y, key));
      }
    }
    await Promise.all(jobs);
    this.ready = true;
  }

  /**
   * Load just the tile the hop lands in, and fix the anchor to it.
   *
   * Worth having separately from `ensure`: no map tile may be built before
   * this resolves, because a ground mesh bakes its displacement at build time
   * and a tile built against a provisional anchor is wrong for good.
   */
  async ensureOrigin(lat, lon) {
    if (!this.enabled) return;

    // The tile you land in, and its eight neighbours.
    //
    // Not overkill: at this zoom one tile is nine kilometres, so the ring
    // covers about twenty-eight — which is what the horizon mesh spans. Load
    // only the centre one and everything past nine kilometres reads as flat,
    // and a flat horizon at the height you are standing buries the city below
    // you. Nine PNGs, under a megabyte, once per hop.
    const cx = Math.floor(lonToTileX(lon, ZOOM));
    const cy = Math.floor(latToTileY(lat, ZOOM));
    let centre = null;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const key = this._key(cx + dx, cy + dy);
        if (this.tiles.has(key)) continue;
        this.tiles.set(key, 'pending');
        const job = this._load(cx + dx, cy + dy, key);
        if (dx === 0 && dy === 0) centre = job;
      }
    }
    // Only the centre tile carries the anchor, so the hop waits on that one.
    // The other eight matter only for the far horizon and can land late.
    if (centre) await centre;
    this._resolveBaseline();
    this.ready = true;
  }

  async _load(x, y, key) {
    try {
      const res = await fetch(`${ENDPOINT}/${ZOOM}/${x}/${y}.png`);
      if (!res.ok) throw new Error(String(res.status));
      const bitmap = await createImageBitmap(await res.blob());

      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = TILE_PX;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bitmap, 0, 0, TILE_PX, TILE_PX);
      const data = ctx.getImageData(0, 0, TILE_PX, TILE_PX).data;
      bitmap.close();

      const heights = new Float32Array(TILE_PX * TILE_PX);
      for (let i = 0; i < heights.length; i++) {
        const o = i * 4;
        heights[i] = data[o] * 256 + data[o + 1] + data[o + 2] / 256 - 32768;
      }
      this.tiles.set(key, heights);
      // The origin's own tile may only have arrived now; until it does, every
      // height in the world is measured against a placeholder.
      this._resolveBaseline();
    } catch (err) {
      this.tiles.set(key, 'failed');
      // A silent elevation failure is indistinguishable from flat ground, and
      // "the mountain is missing" is not a bug report anyone can act on. Keep
      // the first reason so the game can say what actually went wrong.
      if (!this.lastError) this.lastError = String((err && err.message) || err);
    }
  }

  /** {loaded, failed, pending} — what the elevation layer actually has. */
  stats() {
    let loaded = 0, failed = 0, pending = 0;
    for (const v of this.tiles.values()) {
      if (v === 'failed') failed++;
      else if (v === 'pending') pending++;
      else loaded++;
    }
    return { loaded, failed, pending, error: this.lastError || null };
  }

  /**
   * Metres above sea level, or null where the data has not arrived.
   *
   * The null matters. Reading missing ground as sea level puts a forty-metre
   * cliff at the edge of whatever has loaded, and Montréal sits about forty
   * metres up — so the entire not-yet-loaded city drops through the floor and
   * the player is left standing on a mesa. Callers substitute the baseline,
   * which reads as "flat, at the height you started".
   */
  _raw(lat, lon) {
    const fx = lonToTileX(lon, ZOOM);
    const fy = latToTileY(lat, ZOOM);
    const tx = Math.floor(fx), ty = Math.floor(fy);
    const heights = this.tiles.get(this._key(tx, ty));
    if (!heights || heights === 'pending' || heights === 'failed') return null;

    // Bilinear inside the tile.
    const px = (fx - tx) * TILE_PX;
    const py = (fy - ty) * TILE_PX;
    const ix = Math.max(0, Math.min(TILE_PX - 2, Math.floor(px)));
    const iy = Math.max(0, Math.min(TILE_PX - 2, Math.floor(py)));
    const sx = px - ix, sy = py - iy;
    const a = heights[iy * TILE_PX + ix];
    const b = heights[iy * TILE_PX + ix + 1];
    const c = heights[(iy + 1) * TILE_PX + ix];
    const d = heights[(iy + 1) * TILE_PX + ix + 1];
    return (a + (b - a) * sx) + ((c + (d - c) * sx) - (a + (b - a) * sx)) * sy;
  }

  /** Metres above sea level, with missing ground held at the origin's height. */
  sample(lat, lon) {
    if (!this.enabled) return 0;
    const h = this._raw(lat, lon);
    return h === null ? this.baseline : h;
  }

  /**
   * Height relative to the hop origin, smoothed.
   *
   * The smoothing is the whole reason a car can drive on this. Thirty-metre
   * samples produce visible terraces; averaging a small cross around the point
   * flattens them into a gradient without losing the hill itself.
   */
  height(lat, lon) {
    if (!this.enabled) return 0;
    if (!this.baselineReady) this._resolveBaseline();

    // ~40 m offsets, in degrees at this latitude.
    const dLat = 0.00036;
    const dLon = dLat / Math.max(0.2, Math.cos(lat * DEG));
    const h = this.sample(lat, lon) * 0.44
      + (this.sample(lat + dLat, lon) + this.sample(lat - dLat, lon)
       + this.sample(lat, lon + dLon) + this.sample(lat, lon - dLon)) * 0.14;

    return (h - this.baseline) * this.exaggeration;
  }

  /**
   * Anchor the world so the place you hopped into sits at y = 0.
   *
   * The anchor cannot be computed here: a hop is synchronous and the elevation
   * tile covering it is a network round trip away. So it is provisional until
   * that tile lands, and every unloaded sample reads as the anchor in the
   * meantime — which keeps the world flat and continuous rather than terraced.
   */
  setOrigin(lat, lon) {
    this.originLat = lat;
    this.originLon = lon;
    this.baseline = 0;
    this.baselineReady = false;
    this._resolveBaseline();
  }

  _resolveBaseline() {
    if (this.baselineReady || !this.enabled) return;
    const h = this._raw(this.originLat, this.originLon);
    if (h === null) return;
    this.baseline = h;
    this.baselineReady = true;
  }

  /** Convenience: height at a world-space position, given the projection. */
  heightAt(projection, x, z) {
    if (!this.enabled || !projection) return 0;
    const ll = projection.toLatLon(x, z);
    return this.height(ll.lat, ll.lon);
  }
}
