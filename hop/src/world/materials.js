// Shared, procedurally generated textures and materials.
//
// Nothing here loads from the network: every texture is drawn into a canvas at
// startup. That keeps the whole game a single self-contained download, and it
// means a building facade costs one texture no matter how many buildings there
// are.

import { TEX_BAYS, TEX_FLOORS } from './buildings.js';

const BAY_PX = 64;
const FLOOR_PX = 64;

let cached = null;

/**
 * Glass, top-down: dark where it looks into the room, lighter at the bottom
 * where the pane catches the sky. Multiplied by the building's vertex colour,
 * so it tints with the brick rather than fighting it.
 */
function glassGradient(ctx, x, y, h) {
  const g = ctx.createLinearGradient(x, y, x, y + h);
  g.addColorStop(0, 'rgba(40,54,70,0.96)');
  g.addColorStop(0.45, 'rgba(14,19,26,0.97)');
  g.addColorStop(1, 'rgba(30,42,56,0.96)');
  return g;
}

/**
 * Sobel-differentiate a height canvas into a tangent-space normal map.
 * Cheap, runs once at startup, and needs no authored art.
 */
function heightToNormal(heightCanvas, strength) {
  const w = heightCanvas.width, h = heightCanvas.height;
  const src = heightCanvas.getContext('2d').getImageData(0, 0, w, h).data;
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const ctx = out.getContext('2d');
  const img = ctx.createImageData(w, h);

  const at = (x, y) => {
    const xi = (x + w) % w;
    const yi = (y + h) % h;
    return src[(yi * w + xi) * 4] / 255;
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      // Normal of the height field, packed into 0..255.
      const len = Math.hypot(dx, dy, 1);
      const i = (y * w + x) * 4;
      img.data[i] = Math.round(((-dx / len) * 0.5 + 0.5) * 255);
      img.data[i + 1] = Math.round(((dy / len) * 0.5 + 0.5) * 255);
      img.data[i + 2] = Math.round(((1 / len) * 0.5 + 0.5) * 255);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

/**
 * Facade textures.
 *  - `map` is mostly white (so the per-building vertex colour shows through)
 *    with darker glass and a hint of brick coursing.
 *  - `emissiveMap` is black except for the windows that happen to be lit,
 *    which is what turns the city on at dusk.
 */
export function facadeTextures(THREE) {
  if (cached) return cached;

  const w = TEX_BAYS * BAY_PX;
  const h = TEX_FLOORS * FLOOR_PX;

  const day = document.createElement('canvas');
  day.width = w; day.height = h;
  const dg = day.getContext('2d');

  const night = document.createElement('canvas');
  night.width = w; night.height = h;
  const ng = night.getContext('2d');

  // Roughness: bright = matte masonry, dark = polished glass. This is what
  // lets one wall material show sharp sky reflections in every window while
  // the brick around them stays dead flat.
  const rough = document.createElement('canvas');
  rough.width = w; rough.height = h;
  const rg = rough.getContext('2d');
  rg.fillStyle = '#dcdcdc';
  rg.fillRect(0, 0, w, h);

  // Height field: mid grey is the wall plane, darker is recessed, lighter is
  // proud of it. This is the whole trick — a flat extruded prism reads as a
  // building the moment light rakes across recessed openings and protruding
  // sills, and a normal map buys that without a single extra triangle.
  const height = document.createElement('canvas');
  height.width = w; height.height = h;
  const hg = height.getContext('2d');
  hg.fillStyle = '#808080';
  hg.fillRect(0, 0, w, h);
  // Brick coursing: a shallow ripple so bare wall is never perfectly flat.
  for (let y = 0; y < h; y += 8) {
    hg.fillStyle = 'rgba(0,0,0,0.10)';
    hg.fillRect(0, y, w, 1);
    hg.fillStyle = 'rgba(255,255,255,0.07)';
    hg.fillRect(0, y + 1, w, 1);
  }

  dg.fillStyle = '#ffffff';
  dg.fillRect(0, 0, w, h);
  ng.fillStyle = '#000000';
  ng.fillRect(0, 0, w, h);

  // Faint horizontal coursing, so a blank wall still has some scale to it.
  dg.strokeStyle = 'rgba(0,0,0,0.05)';
  dg.lineWidth = 1;
  for (let y = 0; y < h; y += 8) {
    dg.beginPath();
    dg.moveTo(0, y + 0.5);
    dg.lineTo(w, y + 0.5);
    dg.stroke();
  }

  let seed = 0x2f6b1c;
  const rand = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  // Four façade families, four bays each, side by side in one sheet. A
  // building picks a band; one texture and one draw call still cover the
  // whole city, but a row of triplexes stops looking rubber-stamped.
  //
  //   0 red brick, sash windows      — the Plateau triplex
  //   1 grey limestone, tall openings — the older stone terrace
  //   2 commercial, wide glazing      — Mont-Royal, Saint-Denis
  //   3 post-war block, ribbon strip  — everything built after 1960
  const bandOf = (bay) => Math.floor(bay / (TEX_BAYS / 4));

  for (let f = 0; f < TEX_FLOORS; f++) {
    // Canvas y grows downward; three.js flips textures, so the bottom row of
    // the canvas is v≈0 — which is where we want the ground floor.
    const y = h - (f + 1) * FLOOR_PX;
    const groundFloor = f === 0;

    for (let bx = 0; bx < TEX_BAYS; bx++) {
      const x = bx * BAY_PX;
      const band = bandOf(bx);

      // Per-family window geometry, in pixels within a 64-wide bay.
      const style = [
        { count: 2, w: 17, h: 30, top: 16, sill: true },    // sash pair
        { count: 1, w: 26, h: 40, top: 10, sill: true },    // tall stone
        { count: 2, w: 19, h: 26, top: 18, sill: false },   // commercial upper
        { count: 1, w: 46, h: 20, top: 22, sill: false },   // ribbon strip
      ][band];

      if (groundFloor) {
        // Shopfront: wide glazing, a stall riser, a doorway on some bays.
        const gx = x + 6, gy = y + 14, gw = BAY_PX - 12, gh = FLOOR_PX - 26;
        dg.fillStyle = glassGradient(dg, gx, gy, gh);
        dg.fillRect(gx, gy, gw, gh);
        dg.fillStyle = 'rgba(255,255,255,0.10)';
        dg.fillRect(gx, gy, gw, 5);
        dg.fillStyle = 'rgba(0,0,0,0.22)';
        dg.fillRect(x, y + FLOOR_PX - 10, BAY_PX, 10);

        rg.fillStyle = '#585858';
        // Shopfront: deep reveal, heavy lintel above, stall riser below.
        hg.fillStyle = '#3a3a3a';
        hg.fillRect(gx, gy, gw, gh);
        hg.fillStyle = '#c8c8c8';
        hg.fillRect(gx - 4, gy - 6, gw + 8, 6);
        hg.fillStyle = '#b4b4b4';
        hg.fillRect(gx - 3, gy + gh, gw + 6, 5);
        rg.fillRect(gx, gy, gw, gh);

        const lit = rand() < 0.72;
        if (lit) {
          const warm = 200 + Math.floor(rand() * 55);
          ng.fillStyle = `rgb(${warm},${Math.floor(warm * 0.86)},${Math.floor(warm * 0.62)})`;
          ng.fillRect(gx, gy, gw, gh);
        }
        continue;
      }

      for (let k = 0; k < style.count; k++) {
        const ww = style.w, wh = style.h;
        const spread = style.count > 1 ? 29 : 0;
        const wx = x + (BAY_PX - ww * style.count - spread * (style.count - 1)) / 2 + k * (ww + spread);
        const wy = y + style.top;
        dg.fillStyle = glassGradient(dg, wx, wy, wh);
        dg.fillRect(wx, wy, ww, wh);
        // A slanted highlight reads as a reflection and stops the pane from
        // looking like a hole punched in the wall.
        dg.save();
        dg.beginPath();
        dg.rect(wx, wy, ww, wh);
        dg.clip();
        dg.fillStyle = 'rgba(190,214,240,0.10)';
        dg.beginPath();
        dg.moveTo(wx - 2, wy + wh * 0.72);
        dg.lineTo(wx + ww * 0.66, wy - 2);
        dg.lineTo(wx + ww + 2, wy - 2);
        dg.lineTo(wx + ww + 2, wy + wh * 0.30);
        dg.closePath();
        dg.fill();
        dg.restore();
        rg.fillStyle = '#525252';
        // Sash window: pane sunk into the wall, stone sill sticking out under
        // it and a lintel over — the two edges that catch a low sun.
        hg.fillStyle = '#2a2a2a';
        hg.fillRect(wx, wy, ww, wh);
        if (style.sill) {
          hg.fillStyle = '#e6e6e6';
          hg.fillRect(wx - 3, wy + wh, ww + 6, 4);
        }
        hg.fillStyle = '#b0b0b0';
        hg.fillRect(wx - 2, wy - 4, ww + 4, 4);
        rg.fillRect(wx, wy, ww, wh);
        // Frame highlight and a glazing bar.
        dg.fillStyle = 'rgba(255,255,255,0.30)';
        dg.fillRect(wx - 2, wy - 2, ww + 4, 2);
        dg.fillStyle = 'rgba(255,255,255,0.18)';
        dg.fillRect(wx, wy + wh / 2 - 1, ww, 1.5);

        const r = rand();
        if (r < 0.34) {
          const warm = 190 + Math.floor(rand() * 60);
          const dim = 0.55 + rand() * 0.45;
          ng.fillStyle = `rgb(${Math.floor(warm * dim)},${Math.floor(warm * 0.82 * dim)},${Math.floor(warm * 0.58 * dim)})`;
          ng.fillRect(wx, wy, ww, wh);
        } else if (r < 0.40) {
          // The occasional television-blue window.
          ng.fillStyle = 'rgb(70,110,150)';
          ng.fillRect(wx, wy, ww, wh);
        }
      }
    }
  }

  const normal = heightToNormal(height, 4.2);

  const map = new THREE.CanvasTexture(day);
  const emissiveMap = new THREE.CanvasTexture(night);
  const roughnessMap = new THREE.CanvasTexture(rough);
  const normalMap = new THREE.CanvasTexture(normal);
  for (const t of [map, emissiveMap, roughnessMap, normalMap]) {
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 4;
  }
  // Colour data is sRGB; the roughness map is raw numbers and must stay linear.
  map.colorSpace = THREE.SRGBColorSpace;
  emissiveMap.colorSpace = THREE.SRGBColorSpace;

  cached = { map, emissiveMap, roughnessMap, normalMap };
  return cached;
}

/** Material for building walls. Windows light up through `emissiveIntensity`. */
export function makeWallMaterial(THREE) {
  const { map, emissiveMap, roughnessMap, normalMap } = facadeTextures(THREE);
  return new THREE.MeshStandardMaterial({
    map,
    roughnessMap,
    normalMap,
    normalScale: new THREE.Vector2(1.7, 1.7),
    roughness: 1,
    metalness: 0,
    emissiveMap,
    emissive: new THREE.Color(0xffffff),
    emissiveIntensity: 0,
    vertexColors: true,
  });
}

/** Material for roofs, parapets, staircases: flat vertex colour, no texture. */
export function makeCapMaterial(THREE) {
  return new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });
}

/** Ground tiles: painted colour + painted roughness (water smooth, grass matte). */
export function makeGroundMaterial(THREE, texture, roughnessMap) {
  return new THREE.MeshStandardMaterial({
    map: texture,
    roughnessMap: roughnessMap || null,
    normalMap: groundDetailNormal(THREE),
    normalScale: new THREE.Vector2(0.22, 0.22),
    roughness: 1,
    metalness: 0,
  });
}

/**
 * Kerbs: poured concrete, which is matte, slightly lighter than asphalt, and
 * carries its face and cap colours per vertex — see kerbs.js.
 */
export function makeKerbMaterial(THREE) {
  return new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.94,
    metalness: 0,
  });
}

/** Road markings: worn paint with a hint of sheen. */
export function makeMarkingMaterial(THREE) {
  return new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.55,
    metalness: 0,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
    transparent: false,
  });
}

/** Soft pool of light under a street lamp, additive and night-only. */
export function makeLightPoolMaterial(THREE) {
  const size = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255,214,150,0.85)');
  grad.addColorStop(0.45, 'rgba(255,198,124,0.30)');
  grad.addColorStop(1, 'rgba(255,190,110,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    opacity: 0,
  });
}

// ---------------------------------------------------------------------------
// The road surface
// ---------------------------------------------------------------------------

/**
 * Asphalt, generated: colour, roughness and normal, all tiling seamlessly.
 *
 * Photographed asphalt was the obvious answer and turns out to be the wrong one
 * here. A photo is lit — it carries the shadows of the day it was taken, baked
 * in, and they fight the game's own sun and never move. It also arrives with a
 * licence, a download, and a resolution decided by somebody else. Generating it
 * gives an unlit albedo, exact control of the feature sizes in *metres*, and a
 * seam-free tile for nothing.
 *
 * What makes a road read as a road, in the order it matters (and none of it is
 * the base colour, which is the part people reach for first):
 *
 *   1. aggregate — chips of 8 to 14 mm, light against dark binder, the thing
 *      the eye actually resolves from a windscreen;
 *   2. tar seams — the black snakes poured over cracks, which is the single
 *      most recognisable feature of a Montréal street and costs four lines;
 *   3. patches — rectangles of newer, darker asphalt where a trench was
 *      reopened, at a slightly different roughness so they catch the light
 *      differently;
 *   4. mottling — broad slow variation, so a long straight never looks flat.
 *
 * @param {number} metres how much ground one tile of this texture covers
 */
const ASPHALT_TILE_M = 6;
let asphaltMaps = null;

export function asphaltTextures(THREE) {
  if (asphaltMaps) return asphaltMaps;
  const n = 512;                       // ~12 mm a pixel over six metres

  // Deterministic, and wrapping: every lookup is taken modulo the lattice, so
  // the left edge and the right edge are computed from the same numbers.
  const hash = (x, y, seed = 0) => {
    let h = Math.imul(((x & 1023) + Math.imul(y & 1023, 311) + seed) | 0, 0x27d4eb2d);
    h ^= h >>> 15;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    return (h >>> 0) / 4294967296;
  };

  const value = (x, y, period, seed) => {
    const fx = (x / n) * period, fy = (y / n) * period;
    const ix = Math.floor(fx), iy = Math.floor(fy);
    const tx = fx - ix, ty = fy - iy;
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    const w = (a, b) => hash(((a % period) + period) % period, ((b % period) + period) % period, seed);
    const a = w(ix, iy), b = w(ix + 1, iy), c = w(ix, iy + 1), d = w(ix + 1, iy + 1);
    const top = a + (b - a) * sx;
    return top + ((c + (d - c) * sx) - top) * sy;
  };

  // --- aggregate ------------------------------------------------------------
  // Worley-ish: distance to the nearest of one scattered point per cell. That
  // gives closed cells with visible boundaries, which is what crushed stone in
  // binder looks like — unlike value noise, which gives clouds.
  const CHIPS = 48;                    // cells across → ~12 cm cells… see below
  const chip = (x, y) => {
    const fx = (x / n) * CHIPS, fy = (y / n) * CHIPS;
    const ix = Math.floor(fx), iy = Math.floor(fy);
    let best = 9, second = 9;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cx = ((ix + dx) % CHIPS + CHIPS) % CHIPS;
        const cy = ((iy + dy) % CHIPS + CHIPS) % CHIPS;
        const px = ix + dx + hash(cx, cy, 11);
        const py = iy + dy + hash(cx, cy, 29);
        const d = Math.hypot(px - fx, py - fy);
        if (d < best) { second = best; best = d; } else if (d < second) second = d;
      }
    }
    return { edge: Math.min(1, second - best), grain: best };
  };

  const height = new Float32Array(n * n);
  const albedo = new Float32Array(n * n);
  const rough = new Float32Array(n * n);

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const c = chip(x, y);
      // A stone is light in the middle and dark at its boundary, where the
      // binder shows through.
      const stone = Math.min(1, c.edge * 2.4);
      const fine = value(x, y, 128, 3) * 0.5 + value(x, y, 256, 5) * 0.5;
      const mottle = value(x, y, 4, 7) * 0.6 + value(x, y, 9, 13) * 0.4;

      let a = 0.30 + stone * 0.15 + (fine - 0.5) * 0.10 + (mottle - 0.5) * 0.09;
      let r = 0.74 + (1 - stone) * 0.14 + (fine - 0.5) * 0.10;
      let h = stone * 0.7 + fine * 0.3;

      // --- tar seams --------------------------------------------------------
      // A wandering line, black and slightly proud of the surface, and glossy
      // because sealant stays shiny for years.
      const seam = (phase, amp, freq, seed) => {
        const wob = (value(x, y, freq, seed) - 0.5) * amp;
        return Math.abs(((y / n) + wob) - phase);
      };
      for (const [phase, seed] of [[0.23, 21], [0.71, 41]]) {
        const d = seam(phase, 0.16, 6, seed);
        if (d < 0.012) {
          const t = 1 - d / 0.012;
          a -= 0.16 * t;
          r -= 0.30 * t;
          h += 0.25 * t;
        }
      }
      // One running the other way, so the seams do not read as stripes.
      {
        const wob = (value(x, y, 5, 61) - 0.5) * 0.14;
        const d = Math.abs((x / n) + wob - 0.44);
        if (d < 0.010) {
          const t = 1 - d / 0.010;
          a -= 0.15 * t;
          r -= 0.28 * t;
          h += 0.22 * t;
        }
      }

      // --- patches ----------------------------------------------------------
      // Reopened trenches: newer asphalt, darker and smoother, with a hard edge.
      const px = Math.floor((x / n) * 3), py = Math.floor((y / n) * 3);
      if (hash(px, py, 97) > 0.72) {
        const inX = Math.abs(((x / n) * 3 - px) - 0.5) < 0.34;
        const inY = Math.abs(((y / n) * 3 - py) - 0.5) < 0.30;
        if (inX && inY) {
          a -= 0.045;
          r -= 0.10;
        }
      }

      albedo[i] = Math.max(0.10, Math.min(0.62, a));
      rough[i] = Math.max(0.35, Math.min(1, r));
      height[i] = h;
    }
  }

  const make = (fill, srgb) => {
    const cv = document.createElement('canvas');
    cv.width = cv.height = n;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(n, n);
    fill(img.data);
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(cv);
    if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 16;               // the road is always seen at a grazing angle
    return tex;
  };

  const map = make((d) => {
    for (let i = 0; i < n * n; i++) {
      // A touch of blue in the shadow of the binder: fresh asphalt is neutral,
      // weathered asphalt goes grey-blue, never brown.
      const v = albedo[i];
      d[i * 4] = Math.round(v * 255);
      d[i * 4 + 1] = Math.round(v * 254);
      d[i * 4 + 2] = Math.round(Math.min(1, v * 1.04) * 255);
      d[i * 4 + 3] = 255;
    }
  }, true);

  const roughnessMap = make((d) => {
    for (let i = 0; i < n * n; i++) {
      const v = Math.round(rough[i] * 255);
      d[i * 4] = v; d[i * 4 + 1] = v; d[i * 4 + 2] = v; d[i * 4 + 3] = 255;
    }
  }, false);

  const at = (x, y) => height[(((y % n) + n) % n) * n + (((x % n) + n) % n)];
  const normalMap = make((d) => {
    const strength = 2.6;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
        const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
        const len = Math.hypot(dx, dy, 1);
        const i = (y * n + x) * 4;
        d[i] = Math.round(((-dx / len) * 0.5 + 0.5) * 255);
        d[i + 1] = Math.round(((dy / len) * 0.5 + 0.5) * 255);
        d[i + 2] = Math.round(((1 / len) * 0.5 + 0.5) * 255);
        d[i + 3] = 255;
      }
    }
  }, false);

  asphaltMaps = { map, roughnessMap, normalMap, metres: ASPHALT_TILE_M };
  return asphaltMaps;
}

/**
 * The carriageway slab.
 *
 * UVs are world coordinates in metres divided by the tile size, which is what
 * lets two overlapping ribbons at a junction sample the very same texel — so
 * even where they fight over the depth buffer, the pixels they produce are
 * identical and the fight is invisible. That is the whole trick that makes a
 * road mesh possible over a painted ground at all.
 */
export function makeRoadMaterial(THREE) {
  const t = asphaltTextures(THREE);
  return new THREE.MeshStandardMaterial({
    map: t.map,
    roughnessMap: t.roughnessMap,
    normalMap: t.normalMap,
    normalScale: new THREE.Vector2(1.0, 1.0),
    vertexColors: true,
    roughness: 1,
    metalness: 0,
  });
}

// ---------------------------------------------------------------------------
// Ground detail
// ---------------------------------------------------------------------------

let detailNormal = null;

/**
 * A tileable asphalt grain, as a normal map.
 *
 * The tile colour texture covers ~850 m in 2048 px — about 40 cm a pixel, far
 * too coarse to show road surface. So the grain arrives separately, at its own
 * repeat: three.js gives every texture its own offset/repeat, so this can tile
 * a hundred times across the same mesh the colour map covers once.
 *
 * The noise lattice wraps on the texture size, which is what makes it seamless.
 */
export function groundDetailNormal(THREE) {
  if (detailNormal) return detailNormal;
  const n = 256;

  const hash = (x, y) => {
    let h = Math.imul(((x & 255) + Math.imul(y & 255, 57)) | 0, 0x27d4eb2d);
    h ^= h >>> 15;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    return (h >>> 0) / 4294967296;
  };

  // Value noise on a lattice that repeats every `period` cells.
  const octave = (x, y, period) => {
    const fx = (x / n) * period, fy = (y / n) * period;
    const ix = Math.floor(fx), iy = Math.floor(fy);
    const tx = fx - ix, ty = fy - iy;
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    const w = (a, b) => hash(((a % period) + period) % period, ((b % period) + period) % period);
    const a = w(ix, iy), b = w(ix + 1, iy), c = w(ix, iy + 1), d = w(ix + 1, iy + 1);
    return (a + (b - a) * sx) + ((c + (d - c) * sx) - (a + (b - a) * sx)) * sy;
  };

  const heights = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      // Coarse chip pattern under a fine sand grain.
      const v = octave(x, y, 32) * 0.55 + octave(x, y, 64) * 0.28 + octave(x, y, 128) * 0.17;
      heights[y * n + x] = v;
    }
  }

  const cv = document.createElement('canvas');
  cv.width = cv.height = n;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(n, n);
  const at = (x, y) => heights[(((y % n) + n) % n) * n + (((x % n) + n) % n)];
  const strength = 1.1;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * n + x) * 4;
      img.data[i] = Math.round(((-dx / len) * 0.5 + 0.5) * 255);
      img.data[i + 1] = Math.round(((dy / len) * 0.5 + 0.5) * 255);
      img.data[i + 2] = Math.round(((1 / len) * 0.5 + 0.5) * 255);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  // One repeat every ~4 m of ground: fine enough to read as grain from a
  // windscreen, coarse enough not to shimmer at the end of the street.
  tex.repeat.set(150, 150);
  tex.anisotropy = 8;
  detailNormal = tex;
  return tex;
}

/**
 * Foliage: a mass of small leaf strokes with a transparent background, used on
 * crossed billboards. Alpha-tested rather than blended, so there is no sorting
 * to get wrong and trees still cast shadows.
 */
let foliageTexture = null;
export function makeFoliageTexture(THREE) {
  if (foliageTexture) return foliageTexture;
  const n = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = n;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, n, n);

  let seed = 0x51f3a7;
  const rand = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  // Leaves cluster towards the middle and thin out at the silhouette, which is
  // what stops a billboard reading as a disc.
  for (let i = 0; i < 1400; i++) {
    const a = rand() * Math.PI * 2;
    const r = Math.pow(rand(), 0.62) * (n * 0.46);
    const x = n / 2 + Math.cos(a) * r;
    const y = n / 2 + Math.sin(a) * r * 0.92;
    const size = 5 + rand() * 11;
    const shade = 0.55 + rand() * 0.45;
    const warm = rand() < 0.18;
    g.fillStyle = warm
      ? `rgba(${Math.round(150 * shade)},${Math.round(160 * shade)},${Math.round(70 * shade)},0.95)`
      : `rgba(${Math.round(74 * shade)},${Math.round(128 * shade)},${Math.round(58 * shade)},0.95)`;
    g.beginPath();
    g.ellipse(x, y, size, size * (0.55 + rand() * 0.5), rand() * Math.PI, 0, Math.PI * 2);
    g.fill();
  }

  foliageTexture = new THREE.CanvasTexture(cv);
  foliageTexture.colorSpace = THREE.SRGBColorSpace;
  foliageTexture.anisotropy = 4;
  return foliageTexture;
}

export function disposeTextureCache() {
  if (!cached) return;
  cached.map.dispose();
  cached.emissiveMap.dispose();
  cached.roughnessMap.dispose();
  cached.normalMap.dispose();
  cached = null;
}
