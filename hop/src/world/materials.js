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
  g.addColorStop(0, 'rgba(74,96,120,0.78)');
  g.addColorStop(0.45, 'rgba(34,42,54,0.88)');
  g.addColorStop(1, 'rgba(52,64,80,0.82)');
  return g;
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

  for (let f = 0; f < TEX_FLOORS; f++) {
    // Canvas y grows downward; three.js flips textures, so the bottom row of
    // the canvas is v≈0 — which is where we want the ground floor.
    const y = h - (f + 1) * FLOOR_PX;
    const groundFloor = f === 0;

    for (let bx = 0; bx < TEX_BAYS; bx++) {
      const x = bx * BAY_PX;

      if (groundFloor) {
        // Shopfront: wide glazing, a stall riser, a doorway on some bays.
        const gx = x + 6, gy = y + 14, gw = BAY_PX - 12, gh = FLOOR_PX - 26;
        dg.fillStyle = glassGradient(dg, gx, gy, gh);
        dg.fillRect(gx, gy, gw, gh);
        dg.fillStyle = 'rgba(255,255,255,0.10)';
        dg.fillRect(gx, gy, gw, 5);
        dg.fillStyle = 'rgba(0,0,0,0.22)';
        dg.fillRect(x, y + FLOOR_PX - 10, BAY_PX, 10);

        const lit = rand() < 0.72;
        if (lit) {
          const warm = 200 + Math.floor(rand() * 55);
          ng.fillStyle = `rgb(${warm},${Math.floor(warm * 0.86)},${Math.floor(warm * 0.62)})`;
          ng.fillRect(gx, gy, gw, gh);
        }
        continue;
      }

      // Two sash windows per bay, which is roughly the Plateau rhythm.
      for (const half of [0, 1]) {
        const ww = 17, wh = 30;
        const wx = x + 9 + half * 29;
        const wy = y + 16;
        dg.fillStyle = glassGradient(dg, wx, wy, wh);
        dg.fillRect(wx, wy, ww, wh);
        // A slanted highlight reads as a reflection and stops the pane from
        // looking like a hole punched in the wall.
        dg.save();
        dg.beginPath();
        dg.rect(wx, wy, ww, wh);
        dg.clip();
        dg.fillStyle = 'rgba(200,222,245,0.16)';
        dg.beginPath();
        dg.moveTo(wx - 2, wy + wh * 0.72);
        dg.lineTo(wx + ww * 0.66, wy - 2);
        dg.lineTo(wx + ww + 2, wy - 2);
        dg.lineTo(wx + ww + 2, wy + wh * 0.30);
        dg.closePath();
        dg.fill();
        dg.restore();
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

  const map = new THREE.CanvasTexture(day);
  const emissiveMap = new THREE.CanvasTexture(night);
  for (const t of [map, emissiveMap]) {
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 4;
    t.colorSpace = THREE.SRGBColorSpace;
  }

  cached = { map, emissiveMap };
  return cached;
}

/** Material for building walls. Windows light up through `emissiveIntensity`. */
export function makeWallMaterial(THREE) {
  const { map, emissiveMap } = facadeTextures(THREE);
  return new THREE.MeshLambertMaterial({
    map,
    emissiveMap,
    emissive: new THREE.Color(0xffffff),
    emissiveIntensity: 0,
    vertexColors: true,
  });
}

/** Material for roofs, parapets, staircases: flat vertex colour, no texture. */
export function makeCapMaterial(THREE) {
  return new THREE.MeshLambertMaterial({ vertexColors: true });
}

/** Ground tiles: the painted canvas, kept matte. */
export function makeGroundMaterial(THREE, texture) {
  return new THREE.MeshLambertMaterial({ map: texture });
}

/** Road markings: unlit-ish flat colour, pushed above the ground. */
export function makeMarkingMaterial(THREE) {
  return new THREE.MeshLambertMaterial({
    vertexColors: true,
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

export function disposeTextureCache() {
  if (!cached) return;
  cached.map.dispose();
  cached.emissiveMap.dispose();
  cached = null;
}
