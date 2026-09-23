// Every material in the world, by name. The names are the contract with the
// Unity import: a mesh exported with material "Concrete" gets whatever Unity
// material is mapped to "Concrete" — see unity/README.md.
//
// UVs are metres everywhere except facades (bays and floors), so a texture's
// repeat is simply 1 / its size in metres, and two surfaces that overlap
// sample the same texel: an at-grade ramp laid over the street is invisible.

import * as T from './textures.js';

export function createMaterials(THREE, opts = {}) {
  const canvasOk = opts.textures !== false && T.hasCanvas();
  const M = {};
  const std = (name, params, texture) => {
    const m = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0, ...params });
    m.name = name;
    if (texture && canvasOk) {
      const t = texture(THREE);
      const k = 1 / (t.userData.metres || 1);
      t.repeat.set(k, k);
      m.map = t;
    }
    M[name] = m;
    return m;
  };
  const glow = (name, hex, strength = 1, params = {}) => {
    const m = new THREE.MeshBasicMaterial({ color: new THREE.Color(hex).multiplyScalar(strength), toneMapped: true, ...params });
    m.name = name;
    M[name] = m;
    return m;
  };

  // --- ground ---
  std('Asphalt', { color: 0xffffff, roughness: 0.62 }, T.asphalt);
  if (!canvasOk) M.Asphalt.color.set(0x2e2e32);
  std('Sidewalk', { color: 0xffffff, roughness: 0.92 }, T.sidewalk);
  if (!canvasOk) M.Sidewalk.color.set(0x85827b);
  std('Curb', { color: 0x9c9990, roughness: 0.9 });
  std('Grass', { color: 0xffffff, roughness: 1 }, T.grass);
  if (!canvasOk) M.Grass.color.set(0x3f5a33);
  std('Yard', { color: 0xb8c4a8, roughness: 1, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }, T.grass);
  if (!canvasOk) M.Yard.color.set(0x3b4a30);
  std('Gravel', { color: 0xffffff, roughness: 1 }, T.gravel);
  if (!canvasOk) M.Gravel.color.set(0x5d5850);
  std('Parking', { color: 0xd8d8d8, roughness: 0.7 }, T.asphalt);
  if (!canvasOk) M.Parking.color.set(0x38383c);
  std('Plaza', { color: 0xffffff, roughness: 0.85 }, T.pavers);
  if (!canvasOk) M.Plaza.color.set(0x8a8378);
  std('Terrain', { color: 0xffffff, roughness: 1, vertexColors: true });
  const water = std('Water', { color: 0x0b1e2c, roughness: 0.08, metalness: 0.1 });
  if (canvasOk) {
    const n = T.water(THREE);
    n.repeat.set(1 / 30, 1 / 30);
    water.bumpMap = n;
    water.bumpScale = 0.4;
  }

  // --- structures ---
  std('Concrete', { color: 0xffffff, roughness: 0.88 }, (t) => T.concrete(t));
  if (!canvasOk) M.Concrete.color.set(0x8b8883);
  std('Concrete_Dark', { color: 0xffffff, roughness: 0.95 }, (t) => T.concrete(t, '#56544f', 4));
  if (!canvasOk) M.Concrete_Dark.color.set(0x56544f);
  std('Tunnel', { color: 0xffffff, roughness: 0.4 }, T.tiles);
  if (!canvasOk) M.Tunnel.color.set(0xc9c3b0);
  std('Metal', { color: 0x6b6f73, roughness: 0.45, metalness: 0.7 });
  std('Metal_Dark', { color: 0x2a2c2e, roughness: 0.5, metalness: 0.6 });
  std('Metal_Green', { color: 0x3d6b52, roughness: 0.55, metalness: 0.45 });
  std('Metal_Black', { color: 0x1c1c1c, roughness: 0.6, metalness: 0.4 });
  const fence = std('Fence', { color: 0xaeb2b4, roughness: 0.5, metalness: 0.6, side: THREE.DoubleSide, alphaTest: 0.4 });
  if (canvasOk) fence.alphaMap = T.chainlink(THREE);
  fence.transparent = false;
  std('Glass', { color: 0x2a3d4d, roughness: 0.08, metalness: 0.3 });
  std('Copper', { color: 0x5c8f7a, roughness: 0.55, metalness: 0.35 });
  std('Stone', { color: 0xa39c8e, roughness: 0.9 });
  std('Stone_Dark', { color: 0x6c675f, roughness: 0.9 });
  std('Brick', { color: 0x8e4634, roughness: 0.92 });
  std('White', { color: 0xe9e6de, roughness: 0.7 });
  std('Wood', { color: 0x6b4a2f, roughness: 0.85 });

  // --- markings: a hair above the asphalt and always winning the depth test
  std('Marking_White', { color: 0xdad8cf, roughness: 0.55, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
  std('Marking_Yellow', { color: 0xd3a023, roughness: 0.55, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
  std('Marking_Red', { color: 0xb3261e, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });

  // --- buildings ---
  M.Facades = facadeMaterial(THREE, canvasOk ? T.facadeAtlas(THREE) : null);
  std('Roof', { color: 0xffffff, roughness: 0.95 }, T.roof);
  if (!canvasOk) M.Roof.color.set(0x3a3836);

  // --- vegetation ---
  std('Bark', { color: 0x3b2e24, roughness: 1 });
  std('Leaves', { color: 0x355e2c, roughness: 0.95 });
  std('Leaves_Dark', { color: 0x284a24, roughness: 0.95 });

  // --- light: these glow, and bloom picks them up ---
  glow('Lamp_Sodium', 0xffb36b, 3.2);
  glow('Lamp_White', 0xe4ecff, 3.0);
  glow('Lamp_Tunnel', 0xffe2b8, 1.7);
  glow('Neon_Red', 0xff2a1f, 4.0);
  glow('Neon_White', 0xffffff, 3.5);
  glow('Beacon', 0xfff4dc, 0.9, { transparent: true, opacity: 0.1, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  if (canvasOk) M.Beacon.alphaMap = T.beamFade(THREE);
  const pool = new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, opacity: 0.26, depthWrite: false,
    blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6,
  });
  pool.name = 'Light_Pool';
  if (canvasOk) pool.map = T.lightPool(THREE);
  M.Light_Pool = pool;

  M.setNight = (night) => setNight(M, night);
  return M;
}

/**
 * One material for every facade in the city: an atlas row per facade type,
 * tiled per bay and per floor in the shader, with lit windows chosen per
 * window from a hash — so ten thousand buildings cost one draw call per chunk
 * and no two streets light up alike.
 */
function facadeMaterial(THREE, atlas) {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.88, metalness: 0 });
  m.name = 'Facades';
  const uniforms = {
    facadeAtlas: { value: atlas },
    facadeRows: { value: T.FACADES.length },
    night: { value: 1 },
    litRatio: { value: 0.36 },
  };
  m.userData.uniforms = uniforms;
  if (!atlas) return m;
  m.customProgramCacheKey = () => 'facades-v1';
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute float facade;
attribute float seed;
varying vec2 vFacadeUv;
varying float vFacade;
varying float vSeed;`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>
vFacadeUv = uv;
vFacade = facade;
vSeed = seed;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform sampler2D facadeAtlas;
uniform float facadeRows;
uniform float night;
uniform float litRatio;
varying vec2 vFacadeUv;
varying float vFacade;
varying float vSeed;
float fHash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.11, 0.17, 0.13));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float fGlass = 0.0;
vec2 fCell = vec2(0.0);`)
      .replace('#include <map_fragment>', `
fCell = floor(vFacadeUv);
vec2 ff = fract(vFacadeUv);
vec2 auv = vec2(ff.x, (facadeRows - vFacade - 1.0 + ff.y) / facadeRows);
vec2 gx = dFdx(vFacadeUv) * vec2(1.0, 1.0 / facadeRows);
vec2 gy = dFdy(vFacadeUv) * vec2(1.0, 1.0 / facadeRows);
vec4 fs = textureGrad(facadeAtlas, auv, gx, gy);
fGlass = fs.a;
diffuseColor.rgb *= fs.rgb * (0.88 + 0.24 * fHash(vec3(vSeed, 3.0, 1.0)));`)
      .replace('#include <roughnessmap_fragment>', `
float roughnessFactor = mix(roughness, 0.14, fGlass);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
float fr = fHash(vec3(fCell, vSeed * 97.0 + 1.0));
// Curtain-wall offices light up by floor, homes window by window.
float office = step(9.5, vFacade);
float floorLit = fHash(vec3(0.0, fCell.y, vSeed * 13.0 + 2.0));
float byFloor = step(floorLit, litRatio * 0.8) * step(fr, 0.85);
float lit = mix(step(fr, litRatio), byFloor, office) * fGlass * night;
float tone = fHash(vec3(fCell.yx, vSeed + 7.0));
vec3 wcol = tone < 0.72 ? vec3(1.0, 0.66, 0.36) : (tone < 0.9 ? vec3(0.7, 0.8, 0.95) : vec3(1.0, 0.86, 0.66));
float shade = 0.45 + 0.55 * fHash(vec3(fCell, 5.0 + vSeed));
totalEmissiveRadiance += wcol * lit * shade * 1.05;`);
  };
  return m;
}

function setNight(M, night) {
  const u = M.Facades.userData.uniforms;
  if (u) u.night.value = night ? 1 : 0;
  for (const k of ['Lamp_Sodium', 'Lamp_White', 'Lamp_Tunnel', 'Neon_Red', 'Neon_White']) {
    if (!M[k]) continue;
    M[k].userData.base = M[k].userData.base || M[k].color.clone();
    M[k].color.copy(M[k].userData.base).multiplyScalar(night ? 1 : 0.25);
  }
  if (M.Light_Pool) M.Light_Pool.visible = !!night;
  if (M.Beacon) M.Beacon.visible = !!night;
  // Streets look wet at night — the NFSU look — and dry by day.
  if (M.Asphalt) M.Asphalt.roughness = night ? 0.42 : 0.82;
}
