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
import { buildKerbs, KerbBuilder } from './kerbs.js';
import { buildRoadway, RoadwayBuilder } from './roadway.js';
import { paintTile, paintRoughnessTile, areaKindFromTags, GROUND_COLORS } from './ground.js';
import { buildBuildings } from './buildings.js';
import { buildProps, makePropMaterials } from './props.js';
import {
  makeWallMaterial, makeCapMaterial, makeGroundMaterial,
  makeMarkingMaterial, makeKerbMaterial, makeLightPoolMaterial,
  makeRoadMaterial, asphaltTextures,
} from './materials.js';
import { CollisionGrid } from '../vehicle/collision.js';
import { Terrain } from './terrain.js';

export const ZOOM = 15;

const TEXTURE_SIZE = { low: 1024, medium: 1536, high: 2048 };

// How far tiles are built at all, and how far they are built in full.
//
// Beyond the detail ring a tile still gets its ground and its buildings —
// which is what you actually see at that distance, the silhouette of the
// street — but no street furniture, no staircases and a quarter of the
// texture. That is the whole trade: spend the budget on what fills the
// screen, not on lamp posts a kilometre away that cover four pixels.
const RING = { low: 1, medium: 2, high: 2 };
const DETAIL_RING = { low: 1, medium: 1, high: 1 };
const KEEP_RADIUS = 3;         // tiles kept alive beyond the build ring

// The horizon.
//
// Built tiles reach about three kilometres. Everything past that was a single
// flat plane — which is why the mountain you are standing beside can be built
// correctly and still not look like a mountain: from a car you are mostly
// looking at the distance, and the distance was a sheet of card.
//
// So the horizon follows the height field too. One elevation tile covers about
// nine kilometres, so the data for this is almost always already in memory —
// it costs one displaced grid, rebuilt only when you have travelled far enough
// to matter.
//
// It sits below the real ground because it is coarser: 14 km across at 96
// segments is a hundred and fifty metres a step, and on a slope like Mount Royal's that
// can miss the fine mesh by a good ten metres. Fourteen metres of clearance
// hides that, and at a kilometre it is under a degree low.
const BACKDROP_SPAN = 14000;
const BACKDROP_SEGMENTS = 96;
const BACKDROP_DROP = 14;
const BACKDROP_REFRESH = 700;   // metres of travel before it is redisplaced

// Hysteresis: upgrade a tile when it comes within the detail ring, but do not
// downgrade it until it is well outside. Without the gap, driving along a
// boundary would rebuild the same tile every few seconds.
const DOWNGRADE_RING = 2;

// Ground mesh subdivisions per tile. A z15 tile is ~860 m, so 48 segments give
// an 18 m quad — just finer than the 30 m elevation data underneath, which is
// the right place to stop: more vertices cannot invent detail the source
// does not have.
const GROUND_SEGMENTS = { low: 24, medium: 40, high: 48 };

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
      kerb: makeKerbMaterial(THREE),
      road: makeRoadMaterial(THREE),
      lightPool: makeLightPoolMaterial(THREE),
      props: makePropMaterials(THREE),
    };
    this.materials.props.lightPool = this.materials.lightPool;

    this.backdrop = new THREE.Mesh(
      new THREE.PlaneGeometry(BACKDROP_SPAN, BACKDROP_SPAN,
                              BACKDROP_SEGMENTS, BACKDROP_SEGMENTS),
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(GROUND_COLORS.base), roughness: 1, metalness: 0,
      }),
    );
    this.backdrop.rotation.x = -Math.PI / 2;
    this.backdrop.position.y = -BACKDROP_DROP;
    this.backdrop.receiveShadow = false;
    this.backdrop.frustumCulled = false;
    this.group.add(this.backdrop);
    this._backdropAt = null;      // where it was last displaced, world metres

    this.readyTiles = 0;
    this.requestedTiles = 0;
    this.groundRoughness = 1;
    this._groundMaterials = new Set();
    this.terrain = new Terrain({ enabled: opts.settings.terrain !== false });
    this._abort = new AbortController();
  }

  /** Anchor the world. Everything after this is in metres from here. */
  setOrigin(lat, lon) {
    this.projection = new Projection(lat, lon);
    this.terrain.setOrigin(lat, lon);
    this.clear();
    // The horizon mesh holds baked heights measured against the *old* anchor.
    // Hopping from the Plateau to the summit moves that anchor a hundred and
    // sixty metres, so a horizon nobody invalidated ends up hanging in the air
    // over the city. It has to be thrown away with everything else.
    this._backdropAt = null;
    this._backdropTiles = -1;
    // Nothing may build until the elevation anchor is real — see
    // Terrain.ensureOrigin. Failures resolve too; flat is a fine fallback.
    this._originTerrain = this.terrain.ensureOrigin(lat, lon)
      .catch(() => {})
      .then(() => { this._backdropAt = null; });
  }

  /** Height of the ground at a world position. */
  groundHeight(x, z) {
    return this.terrain.heightAt(this.projection, x, z);
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
  get detailRing() { return DETAIL_RING[this.settings.quality] ?? 1; }

  /** Ensure the tiles around (x,z) exist; retire the ones far behind. */
  update(x, z) {
    if (!this.projection) return;
    const ll = this.projection.toLatLon(x, z);
    const centre = tileAt(ll.lat, ll.lon, ZOOM);
    const ring = this.ring;

    this._updateBackdrop(x, z);

    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        const ring0 = Math.max(Math.abs(dx), Math.abs(dy));
        this._ensureTile(centre.x + dx, centre.y + dy, ring0 <= this.detailRing);
      }
    }

    for (const [key, tile] of this.tiles) {
      const away = Math.max(Math.abs(tile.x - centre.x), Math.abs(tile.y - centre.y));
      if (away > KEEP_RADIUS) {
        this._disposeTile(tile);
        this.tiles.delete(key);
        continue;
      }
      // A tile built cheaply that you are now driving into has to be redone.
      // Rebuilding is the same work as a fresh tile and the build queue
      // spreads it over frames, so this never shows up as a stall.
      if (tile.state === 'ready') {
        if (!tile.detailed && away <= this.detailRing) this._rebuild(tile, true);
        else if (tile.detailed && away >= DOWNGRADE_RING + 1) this._rebuild(tile, false);
      }
    }

    // Nearest-first, so the tile you are about to drive into is built first.
    this.buildQueue.sort((a, b) => this._distanceTo(a, x, z) - this._distanceTo(b, x, z));
  }

  /**
   * Recentre the horizon on the player and lay it back over the relief.
   *
   * Only when it is worth it: a few hundred metres of travel changes nothing
   * about a fourteen-kilometre grid, and displacing twenty thousand vertices
   * every frame would show up in the frame time.
   */
  _updateBackdrop(x, z, force = false) {
    if (!this.terrain.enabled) {
      this.backdrop.position.set(x, -BACKDROP_DROP, z);
      return;
    }
    // Elevation arrives over the network, so the first displacement is against
    // whatever had landed by then. Redo it whenever more has.
    const loaded = this.terrain.stats().loaded;
    const grew = loaded !== this._backdropTiles;
    this._backdropTiles = loaded;

    const moved = !this._backdropAt
      || Math.hypot(x - this._backdropAt.x, z - this._backdropAt.z) > BACKDROP_REFRESH;
    if (!moved && !grew && !force) {
      // Between refreshes it stays put; sliding it would drag the relief with
      // it, which reads as the whole landscape swimming.
      return;
    }
    this._backdropAt = { x, z };
    this.backdrop.position.set(x, -BACKDROP_DROP, z);

    // The plane is built in XY and rotated flat, so its local +Z is world −Y
    // after the rotation: displacing along it is what lifts the ground.
    const pos = this.backdrop.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      pos.setZ(i, this.groundHeight(x + pos.getX(i), z - pos.getY(i)));
    }
    pos.needsUpdate = true;
    this.backdrop.geometry.computeVertexNormals();
  }

  _distanceTo(tile, x, z) {
    const cx = (tile.bounds.x0 + tile.bounds.x1) / 2;
    const cz = (tile.bounds.z0 + tile.bounds.z1) / 2;
    return (cx - x) ** 2 + (cz - z) ** 2;
  }

  /** Tear a tile down and queue it again at a different detail level. */
  _rebuild(tile, detailed) {
    this._disposeTile(tile);
    this.tiles.delete(tile.key);
    this.readyTiles = Math.max(0, this.readyTiles - 1);
    this._ensureTile(tile.x, tile.y, detailed);
  }

  _ensureTile(tx, ty, detailed = true) {
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
      detailed,
      objects: [],
      grid: null,
      roads: [],
      elements: null,
    };
    this.tiles.set(key, tile);
    this.requestedTiles++;

    const signal = this._abort.signal;
    Promise.all([
      this.source.getTile(ZOOM, tx, ty, signal),
      this.terrain.ensure(geo),
      this._originTerrain,
    ]).then(([res]) => {
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
    const barriers = [];

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
      // A hedge is a line of shrubs, not an area — it never reaches the
      // painter, so it has to be picked up here or it is lost entirely.
      if (tags.barrier) {
        const pts = toWorld(el.geometry);
        if (pts.length >= 2) barriers.push({ points: pts, kind: tags.barrier });
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

    tile.parsed = { roads, clipped, areas, buildings, nodes, rails, barriers, junctions };
    tile.roads = clipped;
    tile.elements = null;   // release the raw payload
  }

  // -- step 2: the painted ground --------------------------------------------
  _paint(tile) {
    const { roads, areas, buildings, rails } = tile.parsed;
    const full = TEXTURE_SIZE[this.settings.quality] ?? 1536;
    const size = tile.detailed ? full : Math.max(512, full >> 1);
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

    // Roughness at half resolution: it carries no edges the eye can track.
    const rSize = size >> 1;
    const rCanvas = document.createElement('canvas');
    rCanvas.width = rCanvas.height = rSize;
    const rCtx = rCanvas.getContext('2d', { alpha: false });
    paintRoughnessTile(rCtx, rSize, tile.bounds, roads, areas, buildings, rails);
    const roughTex = new THREE.CanvasTexture(rCanvas);
    roughTex.wrapS = THREE.ClampToEdgeWrapping;
    roughTex.wrapT = THREE.ClampToEdgeWrapping;
    roughTex.anisotropy = 4;
    tile.roughTexture = roughTex;

    const { width, height } = tileSizeMetres(ZOOM, tile.x, tile.y);
    void width; void height;
    const spanX = Math.abs(tile.bounds.x1 - tile.bounds.x0);
    const spanZ = Math.abs(tile.bounds.z1 - tile.bounds.z0);
    const seg = this.terrain.enabled
      ? (GROUND_SEGMENTS[this.settings.quality] ?? 40) >> (tile.detailed ? 0 : 1)
      : 1;
    const geo = new THREE.PlaneGeometry(spanX, spanZ, seg, seg);

    if (this.terrain.enabled) {
      // The plane is built flat in XY and rotated later, so displacing along
      // its local +Z is what lifts it once it is lying down.
      const cx = (tile.bounds.x0 + tile.bounds.x1) / 2;
      const cz = (tile.bounds.z0 + tile.bounds.z1) / 2;
      const pos = geo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        pos.setZ(i, this.groundHeight(cx + pos.getX(i), cz - pos.getY(i)));
      }
      pos.needsUpdate = true;
      geo.computeVertexNormals();
    }
    const groundMat = makeGroundMaterial(THREE, texture, roughTex);
    // `roughness` multiplies the roughness map, so one scalar turns every
    // painted surface glossy at once — which is exactly what rain does.
    groundMat.roughness = this.groundRoughness;
    this._groundMaterials.add(groundMat);
    const mesh = new THREE.Mesh(geo, groundMat);
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

  // -- step 3: buildings + painted markings + kerbs ---------------------------
  _structures(tile) {
    const { clipped, junctions, buildings } = tile.parsed;
    const groundSample = this.terrain.enabled ? (x, z) => this.groundHeight(x, z) : null;

    // Kerbs give the carriageway an edge, so the road reads as a slab you are
    // driving on rather than a texture painted on a field. Near tiles only:
    // fifteen centimetres of relief is worth nothing two kilometres away, and
    // it is by some distance the cheapest triangle to skip.
    // The carriageway itself, before anything that stands on it. Near tiles
    // only: fourteen centimetres of edge is worth nothing two kilometres out,
    // and the painted ground underneath still carries the road at that range.
    if (tile.detailed) {
      const road = new RoadwayBuilder(groundSample, asphaltTextures(THREE).metres);
      buildRoadway(clipped, junctions, road);
      if (road.count) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(road.positions, 3));
        geo.setAttribute('uv', new THREE.Float32BufferAttribute(road.uvs, 2));
        geo.setAttribute('color', new THREE.Float32BufferAttribute(road.colors, 3));
        geo.setIndex(road.indices);
        geo.computeVertexNormals();
        geo.computeBoundingSphere();
        const mesh = new THREE.Mesh(geo, this.materials.road);
        mesh.receiveShadow = !!this.settings.shadows;
        this.group.add(mesh);
        tile.objects.push(mesh);
        tile.roadCount = road.count;
      }
    }

    // Kerbs are off while the carriageway is the thing being worked on. They
    // stand *on* the slab, which puts them exactly on its outer edge — so the
    // fourteen centimetres of asphalt thickness end up hidden behind a band of
    // concrete, and the road reads as flat as it did when it was paint. The
    // road has to show its own edge first; the sidewalk comes after.
    if (false && tile.detailed) {
      const kerbs = new KerbBuilder(groundSample);
      buildKerbs(clipped, junctions, kerbs);
      if (kerbs.count) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(kerbs.positions, 3));
        geo.setAttribute('color', new THREE.Float32BufferAttribute(kerbs.colors, 3));
        geo.setIndex(kerbs.indices);
        geo.computeVertexNormals();
        geo.computeBoundingSphere();
        const mesh = new THREE.Mesh(geo, this.materials.kerb);
        mesh.receiveShadow = !!this.settings.shadows;
        this.group.add(mesh);
        tile.objects.push(mesh);
        tile.kerbCount = kerbs.count;
      }
    }

    const strips = new StripBuilder(groundSample);
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
      groundAt: groundSample,
      // Off until there is a model worth showing. The generated staircase is
      // the right *idea* — it is what makes a Plateau street read as a Plateau
      // street — but a lofted approximation of one reads as a bug on the front
      // of every triplex, and thousands of them read as thousands of bugs.
      // buildings.js still builds them on request; nothing here asks.
      staircases: false,
      rooftops: tile.detailed && this.settings.quality !== 'low',
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
    const { clipped, junctions, nodes, barriers, areas } = tile.parsed;
    if (!tile.detailed) {
      // Distant tiles get their buildings and their ground, and nothing else.
      // The colliders still matter — you can drive into a far tile before it
      // is ever upgraded.
      tile.grid = new CollisionGrid(tile.buildingColliders || new Float32Array(0), tile.bounds);
      tile.parsed.areas = null;
      tile.parsed.buildings = null;
      tile.parsed.nodes = null;
      return;
    }
    const props = buildProps(THREE, {
      nodes, roads: clipped, junctions, barriers, areas, bounds: tile.bounds,
      // Footprints, so nothing is planted through a wall. Still available at
      // this step — _props releases them at the end, not the beginning.
      buildings: tile.parsed.buildings,
      groundAt: this.terrain.enabled ? (x, z) => this.groundHeight(x, z) : null,
      materials: this.materials.props,
      shadows: !!this.settings.shadows && this.settings.quality === 'high',
      opts: {
        // Parked cars are off until there is a reason for other vehicles to
        // exist: right now they only narrow the street and get hit.
        parkedCars: false,
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
    tile.parsed.barriers = null;
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
          if (child.material.roughnessMap) child.material.roughnessMap.dispose();
          this._groundMaterials.delete(child.material);
          child.material.dispose();
        }
      });
    }
    tile.objects.length = 0;
    tile.grid = null;
    tile.parsed = null;
    tile.canvas = null;
    tile.texture = null;
    tile.roughTexture = null;
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

  /** Wet the streets. 1 is dry asphalt, 0.16 is a mirror after rain. */
  setGroundRoughness(r) {
    this.groundRoughness = r;
    for (const m of this._groundMaterials) m.roughness = r;
    this.backdrop.material.roughness = r;
  }

  /**
   * Drive the night: lit windows, glowing lamp heads, pools of light on the
   * pavement. `night` is 0 in full day, 1 in full dark.
   */
  setNight(night) {
    const n = Math.max(0, Math.min(1, night));
    this.materials.wall.emissiveIntensity = n * 0.95;
    // The halo under a streetlamp is additive, so on a dusk-lit lawn a linear
    // ramp shows up as a pale disc long before the lamp would actually be
    // doing anything. Squaring it holds the halo back until the ground is
    // genuinely dark, which is when a real one becomes visible.
    this.materials.lightPool.opacity = n * n * 0.62;
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
