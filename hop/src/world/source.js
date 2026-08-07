// Where map data comes from.
//
// Four sources, tried in order, so the world is never empty:
//   1. a bundled dataset shipped with the build (instant, offline, no quotas)
//   2. the IndexedDB cache of previously fetched tiles
//   3. the live Overpass API (any city on Earth)
//   4. the synthetic Montréal fixture (last resort)
//
// Overpass is deliberately throttled to two concurrent requests: the public
// instances hand out roughly two slots per client and ask heavy users to keep
// under ~10k requests a day. Caching aggressively is not an optimisation here,
// it is the difference between being a good citizen and being rate-limited.

import { tileBounds, tileKey } from '../core/geo.js';
import { buildMontrealFixture } from './fixture.js';

const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const MAX_CONCURRENT = 2;
const REQUEST_TIMEOUT = 40000;
const CACHE_TTL = 14 * 24 * 3600 * 1000;   // two weeks
const DB_NAME = 'ruelle-tiles';
const DB_STORE = 'tiles';

// Ways we never want: they are not drivable and they triple the payload.
const HIGHWAY_EXCLUDE = 'footway|path|steps|cycleway|bridleway|corridor|proposed|construction|platform|elevator|raceway|bus_guideway';

export function buildQuery(bounds) {
  const bbox = `${bounds.south},${bounds.west},${bounds.north},${bounds.east}`;
  return `[out:json][timeout:35];
(
  way["highway"]["highway"!~"^(${HIGHWAY_EXCLUDE})$"]["area"!="yes"](${bbox});
  way["building"](${bbox});
  way["building:part"](${bbox});
  way["leisure"~"^(park|garden|pitch|playground|golf_course|common)$"](${bbox});
  way["landuse"~"^(grass|forest|meadow|cemetery|recreation_ground|village_green|farmland|industrial|railway)$"](${bbox});
  way["natural"~"^(water|wood|scrub|grassland|sand|bare_rock)$"](${bbox});
  way["waterway"~"^(river|canal)$"](${bbox});
  way["railway"~"^(rail|light_rail|subway|tram)$"](${bbox});
  way["barrier"~"^(wall|fence|hedge)$"](${bbox});
  relation["leisure"~"^(park|garden)$"](${bbox});
  relation["natural"="water"](${bbox});
  relation["building"](${bbox});
  node["highway"~"^(street_lamp|traffic_signals|stop|give_way|crossing|turning_circle)$"](${bbox});
  node["natural"="tree"](${bbox});
  node["amenity"~"^(bench|fountain|waste_basket|bicycle_parking)$"](${bbox});
);
out geom qt;`;
}

/**
 * Flatten Overpass output: relations become their outer rings, so every
 * consumer downstream only ever sees ways and nodes.
 */
export function normaliseElements(elements) {
  const out = [];
  for (const el of elements) {
    if (!el) continue;
    if (el.type === 'node') {
      if (Number.isFinite(el.lat) && Number.isFinite(el.lon)) out.push(el);
    } else if (el.type === 'way') {
      if (Array.isArray(el.geometry) && el.geometry.length >= 2) out.push(el);
    } else if (el.type === 'relation' && Array.isArray(el.members)) {
      for (const m of el.members) {
        if (m.role && m.role !== 'outer') continue;
        if (!Array.isArray(m.geometry) || m.geometry.length < 3) continue;
        out.push({
          type: 'way',
          id: `${el.id}:${m.ref}`,
          tags: el.tags || {},
          geometry: m.geometry.filter((g) => g && Number.isFinite(g.lat)),
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dataset: a bag of elements with precomputed bounding boxes
// ---------------------------------------------------------------------------

export class Dataset {
  constructor(elements, meta = {}) {
    this.elements = normaliseElements(elements);
    this.meta = meta;
    const n = this.elements.length;
    this.minLat = new Float64Array(n);
    this.maxLat = new Float64Array(n);
    this.minLon = new Float64Array(n);
    this.maxLon = new Float64Array(n);

    let bMinLat = Infinity, bMaxLat = -Infinity, bMinLon = Infinity, bMaxLon = -Infinity;
    for (let i = 0; i < n; i++) {
      const el = this.elements[i];
      let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
      if (el.type === 'node') {
        a = b = el.lat; c = d = el.lon;
      } else {
        for (const g of el.geometry) {
          if (g.lat < a) a = g.lat;
          if (g.lat > b) b = g.lat;
          if (g.lon < c) c = g.lon;
          if (g.lon > d) d = g.lon;
        }
      }
      this.minLat[i] = a; this.maxLat[i] = b; this.minLon[i] = c; this.maxLon[i] = d;
      if (a < bMinLat) bMinLat = a;
      if (b > bMaxLat) bMaxLat = b;
      if (c < bMinLon) bMinLon = c;
      if (d > bMaxLon) bMaxLon = d;
    }
    this.bounds = n
      ? { south: bMinLat, north: bMaxLat, west: bMinLon, east: bMaxLon }
      : { south: 0, north: 0, west: 0, east: 0 };
  }

  /** Does this dataset fully contain the given box? */
  covers(b) {
    return b.south >= this.bounds.south && b.north <= this.bounds.north
        && b.west >= this.bounds.west && b.east <= this.bounds.east;
  }

  /** Elements whose bbox intersects the query box. */
  query(b) {
    const out = [];
    for (let i = 0; i < this.elements.length; i++) {
      if (this.maxLat[i] < b.south || this.minLat[i] > b.north) continue;
      if (this.maxLon[i] < b.west || this.minLon[i] > b.east) continue;
      out.push(this.elements[i]);
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// IndexedDB tile cache
// ---------------------------------------------------------------------------

function openDb() {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    let req;
    try {
      req = indexedDB.open(DB_NAME, 1);
    } catch {
      return resolve(null);
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    // Blocked by another tab holding an old version: don't hang forever.
    setTimeout(() => resolve(null), 3000);
  });
}

class TileCache {
  constructor() { this.dbPromise = null; }

  _db() {
    if (!this.dbPromise) this.dbPromise = openDb();
    return this.dbPromise;
  }

  async get(key) {
    const db = await this._db();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(DB_STORE, 'readonly');
        const req = tx.objectStore(DB_STORE).get(key);
        req.onsuccess = () => {
          const rec = req.result;
          if (!rec || Date.now() - rec.ts > CACHE_TTL) return resolve(null);
          resolve(rec.elements);
        };
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  async put(key, elements) {
    const db = await this._db();
    if (!db) return;
    try {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).put({ key, ts: Date.now(), elements });
    } catch {
      /* quota or closed db: caching is best-effort */
    }
  }

  async clear() {
    const db = await this._db();
    if (!db) return;
    try {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).clear();
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// TileSource
// ---------------------------------------------------------------------------

export class TileSource {
  /**
   * @param {object} opts
   * @param {boolean} opts.offline  never touch the network
   * @param {(s:object)=>void} opts.onStatus
   */
  constructor(opts = {}) {
    this.offline = !!opts.offline;
    this.onStatus = opts.onStatus || (() => {});
    this.cache = new TileCache();
    this.dataset = null;         // bundled dataset, if any
    this.fixture = null;         // lazily generated
    this.fixtureAnchor = null;
    this.inFlight = 0;
    this.queue = [];
    this.mirrorIndex = 0;
    this.networkFailures = 0;
    this.networkDisabled = false;
    this.stats = { dataset: 0, cache: 0, network: 0, fixture: 0, failed: 0 };
  }

  /** Attach a dataset bundled with the build (data/*.json). */
  async loadDataset(url) {
    try {
      const res = await fetch(url, { cache: 'force-cache' });
      if (!res.ok) return false;
      const json = await res.json();
      const elements = Array.isArray(json) ? json : json.elements;
      if (!Array.isArray(elements) || !elements.length) return false;
      this.dataset = new Dataset(elements, json.meta || {});
      return true;
    } catch {
      return false;
    }
  }

  /** Elements for one tile, from whichever source can supply them. */
  async getTile(z, x, y, signal) {
    const b = tileBounds(z, x, y);
    const key = tileKey(z, x, y);

    if (this.dataset && this.dataset.covers(b)) {
      this.stats.dataset++;
      return { elements: this.dataset.query(b), source: 'dataset' };
    }

    if (!this.offline) {
      const cached = await this.cache.get(key);
      if (cached) {
        this.stats.cache++;
        return { elements: cached, source: 'cache' };
      }
    }

    if (!this.offline && !this.networkDisabled) {
      try {
        const elements = await this._fetchThrottled(b, signal);
        this.stats.network++;
        this.cache.put(key, elements);
        return { elements, source: 'network' };
      } catch (err) {
        if (err && err.name === 'AbortError') throw err;
        this.networkFailures++;
        if (this.networkFailures >= 3) {
          this.networkDisabled = true;
          this.onStatus({
            level: 'warn',
            message: 'Overpass injoignable — bascule sur les données hors-ligne.',
          });
        }
      }
    }

    // Nothing else worked: synthesise, anchored on the tile we were asked for
    // so the fallback world appears exactly where the player is standing.
    this.stats.fixture++;
    return { elements: this._fixtureFor(b), source: 'fixture' };
  }

  _fixtureFor(b) {
    const anchor = { lat: (b.north + b.south) / 2, lon: (b.east + b.west) / 2 };
    if (!this.fixture || !this.fixture.covers(b)) {
      // One generous fixture covers the whole playable area; regenerate only
      // if the player has driven clean out of it.
      const seedAnchor = this.fixtureAnchor || anchor;
      this.fixtureAnchor = seedAnchor;
      const built = buildMontrealFixture({ anchor: seedAnchor, extent: 1600 });
      this.fixture = new Dataset(built.elements, built.meta);
      if (!this.fixture.covers(b)) {
        this.fixtureAnchor = anchor;
        const rebuilt = buildMontrealFixture({ anchor, extent: 1600 });
        this.fixture = new Dataset(rebuilt.elements, rebuilt.meta);
      }
    }
    return this.fixture.query(b);
  }

  _fetchThrottled(bounds, signal) {
    return new Promise((resolve, reject) => {
      this.queue.push({ bounds, signal, resolve, reject });
      this._pump();
    });
  }

  _pump() {
    while (this.inFlight < MAX_CONCURRENT && this.queue.length) {
      const job = this.queue.shift();
      if (job.signal && job.signal.aborted) {
        const e = new Error('aborted'); e.name = 'AbortError';
        job.reject(e);
        continue;
      }
      this.inFlight++;
      this._fetchOnce(job.bounds, job.signal)
        .then(job.resolve, job.reject)
        .finally(() => { this.inFlight--; this._pump(); });
    }
  }

  async _fetchOnce(bounds, signal) {
    const body = buildQuery(bounds);
    let lastError = null;

    for (let attempt = 0; attempt < OVERPASS_MIRRORS.length; attempt++) {
      const url = OVERPASS_MIRRORS[(this.mirrorIndex + attempt) % OVERPASS_MIRRORS.length];
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

      try {
        const res = await fetch(url, {
          method: 'POST',
          body: 'data=' + encodeURIComponent(body),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          signal: controller.signal,
        });
        if (res.status === 429 || res.status === 504) {
          // Rate limited or overloaded: move on to the next mirror, and start
          // future requests there too.
          this.mirrorIndex = (this.mirrorIndex + attempt + 1) % OVERPASS_MIRRORS.length;
          lastError = new Error(`overpass ${res.status}`);
          continue;
        }
        if (!res.ok) { lastError = new Error(`overpass ${res.status}`); continue; }
        const json = await res.json();
        this.networkFailures = 0;
        return normaliseElements(json.elements || []);
      } catch (err) {
        if (signal && signal.aborted) { err.name = 'AbortError'; throw err; }
        lastError = err;
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
      }
    }
    throw lastError || new Error('overpass unavailable');
  }
}

export { OVERPASS_MIRRORS };
