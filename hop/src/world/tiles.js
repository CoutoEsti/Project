// The streaming world: which tiles exist, what state they are in, and the
// frame-by-frame budget that turns raw OSM elements into meshes.
//
// Building a tile is split into four steps (parse, paint, structures, props)
// and at most one step runs per frame. That is the whole anti-stutter story:
// no single frame ever does more than a few milliseconds of world building,
// so streaming never shows up as a hitch while you are driving.

import * as THREE from 'three';
import {
  Projection, tileAt, tileBounds, tileKey, tileSizeMetres,
} from '../core/geo.js';
import { classifyRoad, findJunctions, buildMarkings, StripBuilder } from './roads.js';
import { paintTile, areaKindFromTags, GROUND_COLORS } from './ground.js';
import { buildBuildings } from './buildings.js';
import { buildProps, makePropMaterials } from './props.js';
import {
  makeWallMaterial, makeCapMaterial, makeGroundMaterial,
  makeMarkingMaterial, makeLightPoolMaterial,
} from './materials.js';
import { CollisionGrid } from '../vehicle/collision.js';

export const ZOOM = 15;

const TEXTURE_SIZE = { low: 1024, medium: 1536, high: 2048 };
const RING = { low: 1, medium: 1, high: 1 };
const KEEP_RADIUS = 2;         // tiles kept alive beyond the build ring

export class World {
  /**
   * @param {THREE.Scene} scene
   * @param {object} opts {source, settings, onProgress}
   */
  constructor(scene, opts) {
    this.scene = scene;
    this.source = opts.source;
    this.settings = opts.settings;
    this.onProgress = opts.onProgress || (() => {});

    this.projection = null;
    this.tiles = new Map();
    this.buildQueue = [];
    this.group = new THREE.Group();
    this.group.name = 'world';
    scene.add(this.group);

    this.materials = {
      wall: makeWallMaterial(THREE),
      cap: makeCapMaterial(THREE),
      marking: makeMarkingMaterial(THREE),
      lightPool: makeLightPoolMaterial(THREE),
      props: makePropMaterials(THREE),
    };
    this.materials.props.lightPool = this.materials.lightPool;

    this.backdrop = new THREE.Mesh(
      new THREE.PlaneGeometry(16000, 16000),
      new THREE.MeshLambertMaterial({ color: new THREE.Color(GROUND_COLORS.base) }),
    );
    this.backdrop.rotation.x = -Math.PI / 2;
    this.backdrop.position.y = -0.08;
    this.backdrop.receiveShadow = false;
    this.group.add(this.backdrop);

    this.readyTiles = 0;
    this.requestedTiles = 0;
    this._abort = new AbortController();
  }

  /** Anchor the world. Everything after this is in metres from here. */
  setOrigin(lat, lon) {
    this.projection = new Projection(lat, lon);
    this.clear();
  }

  clear() {
    for (const tile of this.tiles.values()) this._disposeTile(tile);
    this.tiles.clear();
    this.buildQueue.length = 0;
    this.readyTiles = 0;
    this.requestedTiles = 0;
    this._abort.abort();
    this._abort = new AbortController();
  }

  get ring() { return RING[this.settings.quality] ?? 1; }

  /** Ensure the tiles around (x,z) exist; retire the ones far behind. */
  update(x, z) {
    if (!this.projection) return;
    const ll = this.projection.toLatLon(x, z);
    const centre = tileAt(ll.lat, ll.lon, ZOOM);
    const ring = this.ring;

    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        this._ensureTile(centre.x + dx, centre.y + dy);
      }
    }

    for (const [key, tile] of this.tiles) {
      if (Math.abs(tile.x - centre.x) > KEEP_RADIUS || Math.abs(tile.y - centre.y) > KEEP_RADIUS) {
        this._disposeTile(tile);
        this.tiles.delete(key);
      }
    }

    // Nearest-first, so the tile you are about to drive into is built first.
    this.buildQueue.sort((a, b) => this._distanceTo(a, x, z) - this._distanceTo(b, x, z));
  }

  _distanceTo(tile, x, z) {
    const cx = (tile.bounds.x0 + tile.bounds.x1) / 2;
    const cz = (tile.bounds.z0 + tile.bounds.z1) / 2;
    return (cx - x) ** 2 + (cz - z) ** 2;
  }

  _ensureTile(tx, ty) {
    const key = tileKey(ZOOM, tx, ty);
    if (this.tiles.has(key)) return;

    const geo = tileBounds(ZOOM, tx, ty);
    const nw = this.projection.toWorld(geo.north, geo.west);
    const se = this.projection.toWorld(geo.south, geo.east);
    const tile = {
      key, x: tx, y: ty,
      geo,
      bounds: { x0: nw.x, z0: nw.z, x1: se.x, z1: se.z },
      state: 'requested',
      objects: [],
      grid: null,
      roads: [],
      elements: null,
    };
    this.tiles.set(key, tile);
    this.requestedTiles++;

    const signal = this._abort.signal;
    this.source.getTile(ZOOM, tx, ty, signal).then((res) => {
      if (signal.aborted || !this.tiles.has(key)) return;
      tile.elements = res.elements;
      tile.source = res.source;
      tile.state = 'parse';
      this.buildQueue.push(tile);
    }).catch((err) => {
      if (err && err.name === 'AbortError') return;
      tile.state = 'error';
    });
  }

  /**
   * Do at most one build step, if the frame has room for it.
   * @param {number} budgetMs
   */
  step(budgetMs = 8) {
    if (!this.buildQueue.length) return;
    const started = performance.now();
    while (this.buildQueue.length && performance.now() - started < budgetMs) {
      const tile = this.buildQueue[0];
      if (!this.tiles.has(tile.key)) { this.buildQueue.shift(); continue; }
      try {
        this._advance(tile);
      } catch (err) {
        console.error('[world] tile build failed', tile.key, err);
        tile.state = 'ready';
      }
      if (tile.state === 'ready') {
        this.buildQueue.shift();
        this.readyTiles++;
        this.onProgress({ ready: this.readyTiles, requested: this.requestedTiles });
      }
      // One heavy step per frame is the point; do not loop into a second one.
      if (tile.state !== 'ready') break;
    }
  }

  _advance(tile) {
    switch (tile.state) {
      case 'parse': this._parse(tile); tile.state = 'paint'; break;
      case 'paint': this._paint(tile); tile.state = 'structures'; break;
      case 'structures': this._structures(tile); tile.state = 'props'; break;
      case 'props': this._props(tile); tile.state = 'ready'; break;
      default: tile.state = 'ready'; break;
    }
  }

  // -- step 1: OSM elements -> world-space features --------------------------
  _parse(tile) {
    const proj = this.projection;
    const roads = [];
    const areas = [];
    const buildings = [];
    const nodes = [];
    const rails = [];

    const toWorld = (geometry) => {
      const pts = new Array(geometry.length);
      for (let i = 0; i < geometry.length; i++) {
        pts[i] = proj.toWorld(geometry[i].lat, geometry[i].lon, { x: 0, z: 0 });
      }
      return pts;
    };

    for (const el of tile.elements) {
      const tags = el.tags || {};
      if (el.type === 'node') {
        const kind = nodeKind(tags);
        if (!kind) continue;
        const p = proj.toWorld(el.lat, el.lon);
        nodes.push({ x: p.x, z: p.z, kind });
        continue;
      }
      if (!el.geometry || el.geometry.length < 2) continue;

      if (tags.highway) {
        const spec = classifyRoad(tags);
        if (spec) roads.push({ points: toWorld(el.geometry), spec, id: el.id });
        continue;
      }
      if (tags.building || tags['building:part']) {
        const pts = toWorld(el.geometry);
        if (pts.length >= 4 && centroidInside(pts, tile.bounds)) {
          buildings.push({ points: pts, tags, id: el.id });
        }
        continue;
      }
      if (tags.railway) {
        rails.push({ points: toWorld(el.geometry) });
        continue;
      }
      const kind = areaKindFromTags(tags);
      if (kind) {
        const pts = toWorld(el.geometry);
        if (pts.length >= 3) areas.push({ points: pts, kind });
      }
    }

    // Junctions come from the unclipped road set so corners on a tile border
    // are still recognised as junctions.
    const junctions = findJunctions(roads);

    const clipped = [];
    for (const road of roads) {
      for (const piece of clipPolyline(road.points, tile.bounds)) {
        clipped.push({ points: piece, spec: road.spec, id: road.id });
      }
    }

    tile.parsed = { roads, clipped, areas, buildings, nodes, rails, junctions };
    tile.roads = clipped;
    tile.elements = null;   // release the raw payload
  }

  // -- step 2: the painted ground --------------------------------------------
  _paint(tile) {
    const { roads, areas, buildings, rails } = tile.parsed;
    const size = TEXTURE_SIZE[this.settings.quality] ?? 1536;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d', { alpha: false });

    paintTile(ctx, size, tile.bounds, roads, areas, buildings, rails);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.anisotropy = 8;
    texture.needsUpdate = true;

    const { width, height } = tileSizeMetres(ZOOM, tile.x, tile.y);
    const geo = new THREE.PlaneGeometry(Math.abs(tile.bounds.x1 - tile.bounds.x0),
                                        Math.abs(tile.bounds.z1 - tile.bounds.z0));
    void width; void height;
    const mesh = new THREE.Mesh(geo, makeGroundMaterial(THREE, texture));
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set((tile.bounds.x0 + tile.bounds.x1) / 2, 0,
                      (tile.bounds.z0 + tile.bounds.z1) / 2);
    mesh.receiveShadow = !!this.settings.shadows;
    mesh.renderOrder = 0;
    this.group.add(mesh);
    tile.objects.push(mesh);
    tile.texture = texture;
    tile.canvas = canvas;
  }

  // -- step 3: buildings + painted markings ----------------------------------
  _structures(tile) {
    const { clipped, junctions, buildings } = tile.parsed;

    const strips = new StripBuilder();
    buildMarkings(clipped, junctions, strips);
    if (strips.count) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(strips.positions, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(strips.colors, 3));
      geo.setIndex(strips.indices);
      geo.computeVertexNormals();
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, this.materials.marking);
      mesh.renderOrder = 1;
      this.group.add(mesh);
      tile.objects.push(mesh);
    }

    const built = buildBuildings(THREE, buildings, clipped, {
      staircases: this.settings.quality === 'high',
      rooftops: this.settings.quality !== 'low',
    });
    if (built.walls) {
      const mesh = new THREE.Mesh(built.walls, this.materials.wall);
      mesh.castShadow = !!this.settings.shadows;
      mesh.receiveShadow = !!this.settings.shadows;
      this.group.add(mesh);
      tile.objects.push(mesh);
    }
    if (built.caps) {
      const mesh = new THREE.Mesh(built.caps, this.materials.cap);
      mesh.castShadow = !!this.settings.shadows;
      this.group.add(mesh);
      tile.objects.push(mesh);
    }
    tile.buildingColliders = built.colliders;
  }

  // -- step 4: street furniture ----------------------------------------------
  _props(tile) {
    const { clipped, junctions, nodes } = tile.parsed;
    const props = buildProps(THREE, {
      nodes, roads: clipped, junctions, bounds: tile.bounds,
      materials: this.materials.props,
      shadows: !!this.settings.shadows && this.settings.quality === 'high',
      opts: {
        parkedCars: this.settings.quality !== 'low',
        trees: true,
        lamps: true,
      },
    });
    this.group.add(props.group);
    tile.objects.push(props.group);
    tile.propMeshes = props;

    // Everything solid in this tile, in one grid.
    const total = new Float32Array(
      (tile.buildingColliders ? tile.buildingColliders.length : 0) + props.colliders.length,
    );
    let o = 0;
    if (tile.buildingColliders) { total.set(tile.buildingColliders, 0); o = tile.buildingColliders.length; }
    total.set(props.colliders, o);
    tile.grid = new CollisionGrid(total, tile.bounds);
    tile.colliders = total;

    tile.parsed.areas = null;
    tile.parsed.buildings = null;
    tile.parsed.nodes = null;
  }

  _disposeTile(tile) {
    for (const obj of tile.objects) {
      this.group.remove(obj);
      obj.traverse((child) => {
        if (child.geometry) child.geometry.dispose();
        // Materials are shared across tiles except the ground, which owns its
        // own texture and must be released or memory climbs forever.
        if (child.material && child.material.map && child.material.map === tile.texture) {
          child.material.map.dispose();
          child.material.dispose();
        }
      });
    }
    tile.objects.length = 0;
    tile.grid = null;
    tile.parsed = null;
    tile.canvas = null;
    tile.texture = null;
  }

  /** All road pieces currently loaded, for spawning and the minimap. */
  allRoads() {
    const out = [];
    for (const tile of this.tiles.values()) {
      if (tile.roads && tile.roads.length) out.push(...tile.roads);
    }
    return out;
  }

  /** Is the tile under this position finished building? */
  isReadyAt(x, z) {
    for (const tile of this.tiles.values()) {
      if (x >= tile.bounds.x0 && x <= tile.bounds.x1 && z >= tile.bounds.z0 && z <= tile.bounds.z1) {
        return tile.state === 'ready';
      }
    }
    return false;
  }

  /** Collision grids covering a position. */
  gridsNear(x, z) {
    const out = [];
    for (const tile of this.tiles.values()) {
      if (!tile.grid) continue;
      const b = tile.bounds;
      if (x < b.x0 - 40 || x > b.x1 + 40 || z < b.z0 - 40 || z > b.z1 + 40) continue;
      out.push(tile.grid);
    }
    return out;
  }

  /**
   * Drive the night: lit windows, glowing lamp heads, pools of light on the
   * pavement. `night` is 0 in full day, 1 in full dark.
   */
  setNight(night) {
    const n = Math.max(0, Math.min(1, night));
    this.materials.wall.emissiveIntensity = n * 0.95;
    this.materials.lightPool.opacity = n * 0.72;
    this.materials.props.lampHead.color.setRGB(
      0.35 + n * 0.65, 0.30 + n * 0.56, 0.22 + n * 0.40,
    );
  }

  dispose() {
    this.clear();
    this.scene.remove(this.group);
    for (const m of Object.values(this.materials)) {
      if (m && m.dispose) m.dispose();
    }
  }
}

// ---------------------------------------------------------------------------

function nodeKind(tags) {
  if (tags.highway === 'street_lamp') return 'street_lamp';
  if (tags.highway === 'traffic_signals') return 'traffic_signals';
  if (tags.highway === 'stop') return 'stop';
  if (tags.natural === 'tree') return 'tree';
  if (tags.amenity === 'bench') return 'bench';
  return null;
}

function centroidInside(points, b) {
  let sx = 0, sz = 0;
  for (const p of points) { sx += p.x; sz += p.z; }
  const x = sx / points.length, z = sz / points.length;
  return x >= b.x0 && x < b.x1 && z >= b.z0 && z < b.z1;
}

/** Liang-Barsky clip of one segment against the tile rect. */
function clipSegment(a, b, r) {
  let t0 = 0, t1 = 1;
  const dx = b.x - a.x, dz = b.z - a.z;
  const p = [-dx, dx, -dz, dz];
  const q = [a.x - r.x0, r.x1 - a.x, a.z - r.z0, r.z1 - a.z];

  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return null;
    } else {
      const t = q[i] / p[i];
      if (p[i] < 0) { if (t > t1) return null; if (t > t0) t0 = t; }
      else { if (t < t0) return null; if (t < t1) t1 = t; }
    }
  }
  return {
    a: { x: a.x + dx * t0, z: a.z + dz * t0 },
    b: { x: a.x + dx * t1, z: a.z + dz * t1 },
    entered: t0 > 0,
  };
}

/** Clip a polyline to the tile, yielding the pieces that survive. */
export function clipPolyline(points, rect) {
  const r = {
    x0: Math.min(rect.x0, rect.x1), x1: Math.max(rect.x0, rect.x1),
    z0: Math.min(rect.z0, rect.z1), z1: Math.max(rect.z0, rect.z1),
  };
  const out = [];
  let current = null;
  for (let i = 1; i < points.length; i++) {
    const seg = clipSegment(points[i - 1], points[i], r);
    if (!seg) { current = null; continue; }
    if (!current || seg.entered) {
      current = [seg.a, seg.b];
      out.push(current);
    } else {
      current.push(seg.b);
    }
  }
  return out.filter((p) => p.length >= 2);
}
