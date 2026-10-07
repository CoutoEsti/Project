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
  // Streets lie on the terrain a few centimetres up; the offset settles the
  // depth test far away, where a few centimetres are below its precision.
  M.Street_Asphalt = M.Asphalt.clone();
  M.Street_Asphalt.name = 'Asphalt';
  Object.assign(M.Street_Asphalt, { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -3 });
  if (canvasOk) antiTile(M.Street_Asphalt);
  M.Street_Sidewalk = M.Sidewalk.clone();
  M.Street_Sidewalk.name = 'Sidewalk';
  // Vertex colours: the kerb is the same concrete, a band lighter.
  Object.assign(M.Street_Sidewalk, { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2, vertexColors: true });
  // Beyond the zone: a far-off city, lit at night.
  std('Outskirts', { color: 0xffffff, roughness: 1, emissive: 0x000000 });
  if (canvasOk) {
    const o = T.outskirts(THREE);
    for (const t of [o.albedo, o.lights]) t.repeat.set(1 / T.OUTSKIRTS_METRES, 1 / T.OUTSKIRTS_METRES);
    M.Outskirts.map = o.albedo;
    M.Outskirts.emissiveMap = o.lights;
  } else {
    M.Outskirts.color.set(0x5d5c57);
  }
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
  // Deck undersides and tunnel ceilings: at night the lamps below light them a
  // little, or they read as holes in the picture.
  if (M.Concrete_Dark.map) M.Concrete_Dark.emissiveMap = M.Concrete_Dark.map;
  if (!canvasOk) M.Concrete_Dark.color.set(0x56544f);
  std('Tunnel', { color: 0xffffff, roughness: 0.4 }, T.tiles);
  // At night the tiles glow faintly: the tunnel's own strip lights on them.
  if (M.Tunnel.map) M.Tunnel.emissiveMap = M.Tunnel.map;
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
  // A trace of emission so the canopy reads against the night as a shape,
  // not a hole.
  // Vertex colours shade the crowns darker underneath.
  std('Leaves', { color: 0x355e2c, roughness: 0.95, emissive: 0x0b1f1c, vertexColors: true });
  std('Leaves_Dark', { color: 0x284a24, roughness: 0.95, emissive: 0x08171a, vertexColors: true });

  // --- light: these glow, and bloom picks them up ---
  glow('Lamp_Sodium', 0xffb36b, 3.2);
  glow('Lamp_White', 0xe4ecff, 3.0);
  glow('Lamp_LED', 0xcfe8ff, 2.2);
  glow('Neon_Cyan', 0x22e6ff, 1.8);
  glow('Neon_Magenta', 0xe03cff, 1.8);
  glow('Beacon_Red', 0xff1a1a, 4.0);
  glow('Lamp_Tunnel', 0xdff2ff, 1.5);
  glow('Neon_Red', 0xff2a1f, 4.0);
  glow('Neon_White', 0xffffff, 3.5);
  glow('Beacon', 0xfff4dc, 0.9, { transparent: true, opacity: 0.1, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  if (canvasOk) M.Beacon.alphaMap = T.beamFade(THREE);
  // Neon: tubes brighter than white so the bloom haloes them, per-instance
  // colour; a few buzz (animated in the frame loop).
  glow('Neon', 0xffffff, 1.45);
  glow('Neon_Buzz', 0xffffff, 1.45);
  std('Neon_Back', { color: 0x101018, roughness: 0.45, metalness: 0.5 });
  std('Awning', { color: 0xffffff, roughness: 0.95, side: THREE.DoubleSide });
  const pool = new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, opacity: 0.2, depthWrite: false,
    blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6,
  });
  pool.name = 'Light_Pool';
  if (canvasOk) pool.map = T.lightPool(THREE);
  wetStreaks(pool);
  M.Light_Pool = pool;
  // The colour a sign throws on the wet sidewalk and the street.
  const npool = pool.clone();
  npool.name = 'Neon_Pool';
  npool.opacity = 0.55;
  wetStreaks(npool);
  M.Neon_Pool = npool;

  M.setNight = (night) => setNight(M, night);
  return M;
}

/**
 * Break an 8 m texture's repeat: a second sample of the same map, four times
 * larger and turned, modulates the first by its brightness. One extra
 * texture read, and a street no longer shows the same crack every car length.
 */
function antiTile(m) {
  m.customProgramCacheKey = () => 'anti-tile-v1';
  m.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
#ifdef USE_MAP
{
  vec2 bigUv = mat2(0.8, -0.6, 0.6, 0.8) * vMapUv * 0.23 + vec2(0.37, 0.11);
  vec3 big = texture2D(map, bigUv).rgb;
  float k = dot(big, vec3(0.3333)) / 0.026;
  diffuseColor.rgb *= clamp(0.55 + 0.45 * k, 0.75, 1.3);
}
#endif`);
  };
}

/**
 * Wet asphalt, faked: a light's pool on the ground stretches towards the eye,
 * the way its reflection streaks down a wet street. Done in the vertex shader
 * per instance (pools are unrotated discs), so it follows the camera for free.
 */
function wetStreaks(m) {
  m.customProgramCacheKey = () => 'wet-streaks-v2';
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
#ifdef USE_INSTANCING
{
  vec3 c = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vec2 toEye = cameraPosition.xz - c.xz;
  float dist = length(toEye);
  vec2 d = toEye / max(dist, 1e-3);
  float r = length(instanceMatrix[0].xyz);
  // Longer the lower the eye: a streak is a grazing reflection.
  float graze = clamp(dist / max(cameraPosition.y - c.y, 0.5), 1.0, 12.0);
  float stretch = 1.0 + min(graze * 0.3, 2.6);
  vec2 p = transformed.xz;
  float along = dot(p, d);
  vec2 perp = p - along * d;
  along = along * stretch + (stretch - 1.0);
  transformed.xz = perp * mix(1.0, 0.32, clamp((stretch - 1.0) / 2.0, 0.0, 1.0)) + d * along;
  // Seen from above, the pools are what draws the streets at night: a
  // little wider and brighter, the higher the eye.
  float above = clamp((cameraPosition.y - c.y - 30.0) / 250.0, 0.0, 1.0);
  float high = clamp((cameraPosition.y - c.y - 300.0) / 1500.0, 0.0, 1.0);
  transformed.xz *= 1.0 + above * 0.6 + high * 0.6;
#ifdef USE_INSTANCING_COLOR
  vColor.rgb *= 1.0 + above * 1.4;
#endif
}
#endif`);
  };
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
    litRatio: { value: 0.3 },
    winRect: { value: T.facadeWindows().map(([x, y, w, h]) => new THREE.Vector4(x, y, w, h)) },
  };
  m.userData.uniforms = uniforms;
  if (!atlas) return m;
  m.customProgramCacheKey = () => 'facades-v4';
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute float facade;
attribute float seed;
varying vec2 vFacadeUv;
flat varying float vFacade;
flat varying float vSeed;`)
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
uniform vec4 winRect[${T.FACADES.length}];
varying vec2 vFacadeUv;
flat varying float vFacade;
flat varying float vSeed;
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
fGlass = 1.0 - fs.a;
vec3 glassTint = mix(vec3(0.05, 0.07, 0.1), vec3(0.1, 0.16, 0.24), step(9.5, vFacade));
diffuseColor.rgb *= mix(fs.rgb * (0.88 + 0.24 * fHash(vec3(vSeed, 3.0, 1.0))), glassTint, fGlass);`)
      .replace('#include <roughnessmap_fragment>', `
// Far off, a window is less than a pixel: its reflection is noise. Glass
// turns matte with distance, so the walls stop sparkling.
float fFar = clamp(length(fwidth(vFacadeUv)) * 1.6 - 0.2, 0.0, 1.0);
float roughnessFactor = mix(roughness, mix(0.22, 0.7, fFar), fGlass);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
float fr = fHash(vec3(fCell, vSeed * 97.0 + 1.0));
// Curtain-wall offices light up by floor, homes window by window, and the
// ground floor is shops: lit more often, and in colour.
float office = step(9.5, vFacade);
float floorLit = fHash(vec3(0.0, fCell.y, vSeed * 13.0 + 2.0));
float byFloor = step(floorLit, litRatio * 0.6) * step(fr, 0.8);
float shop = 1.0 - step(1.0, fCell.y);
float ratio = mix(litRatio, 0.62, shop);
float lit = mix(step(fr, ratio), byFloor, office * (1.0 - shop)) * fGlass * night;
float tone = fHash(vec3(fCell.yx, vSeed + 7.0));
// Homes: mostly warm, some cool LED, a few rooms lit in colour. Offices:
// fluorescent white, nothing else.
vec3 wcol = tone < 0.62 ? vec3(1.0, 0.64, 0.36)
  : tone < 0.86 ? vec3(0.78, 0.86, 1.0)
  : tone < 0.92 ? vec3(0.25, 0.85, 1.0)
  : tone < 0.96 ? vec3(0.8, 0.35, 1.0)
  : vec3(1.0, 0.3, 0.55);
wcol = mix(wcol, tone < 0.7 ? vec3(0.82, 0.9, 1.0) : vec3(1.0, 0.86, 0.66), office);
// Shops: warm white, or the colour of their sign.
float st = fHash(vec3(fCell.x, vSeed, 3.0));
vec3 scol = st < 0.45 ? vec3(1.0, 0.82, 0.62) : st < 0.62 ? vec3(0.2, 0.9, 1.0) : st < 0.8 ? vec3(1.0, 0.25, 0.65) : st < 0.9 ? vec3(0.6, 0.35, 1.0) : vec3(1.0, 0.6, 0.25);
wcol = mix(wcol, scol, shop);
float shade = 0.45 + 0.55 * fHash(vec3(fCell, 5.0 + vSeed));
// Inside the window: a room lit from its ceiling, brighter up top, the
// corners in shadow, furniture dark along the sill. Curtains drawn to the
// sides in some, blinds across others.
vec4 wr = winRect[int(vFacade + 0.5)];
vec2 wuv = clamp((ff - wr.xy) / wr.zw, 0.0, 1.0);
float room = mix(0.5, 1.1, smoothstep(0.0, 1.0, wuv.y));
room *= 1.0 - 0.45 * pow(abs(wuv.x * 2.0 - 1.0), 3.0);
room *= mix(0.55, 1.0, smoothstep(0.12, 0.3, wuv.y));
float cur = fHash(vec3(fCell, vSeed + 23.0));
float curtain = step(0.55, cur) * (1.0 - office) * (1.0 - shop);
float cw = 0.14 + 0.16 * fract(cur * 7.0);
float side = 1.0 - smoothstep(cw, cw + 0.05, min(wuv.x, 1.0 - wuv.x));
room = mix(room, 0.42, side * curtain);
float blinds = step(0.78, fHash(vec3(fCell, vSeed + 19.0)));
room *= mix(1.0, 0.5 + 0.5 * step(0.3, fract(wuv.y * 9.0)), blinds);
// Shops: an even, brighter shopfront.
room = mix(room, 0.9 + 0.2 * wuv.y, shop);
// A few rooms lit only by a television: dim and blue.
float tv = step(0.93, fHash(vec3(fCell, vSeed + 31.0))) * (1.0 - office) * (1.0 - shop);
wcol = mix(wcol, vec3(0.35, 0.5, 1.0), tv);
shade *= mix(1.0, 0.45, tv);
totalEmissiveRadiance += wcol * lit * shade * room * mix(0.82, 1.05, shop);
// The street lights the bottom of every wall, fading up two floors: warm,
// or tinted by the signs.
float bounce = exp(-vFacadeUv.y * 1.3) * night * (1.0 - fGlass * 0.5);
vec3 bcol = mix(vec3(0.55, 0.32, 0.2), vec3(0.45, 0.15, 0.55), step(0.6, fHash(vec3(vSeed, 1.0, 9.0))));
totalEmissiveRadiance += diffuseColor.rgb * bcol * bounce * 0.7;
// Some towers wear LED strips up their corners.
float strip = office * step(fHash(vec3(vSeed, 11.0, 4.0)), 0.3) * night;
float edge = (1.0 - step(0.06, ff.x)) * (1.0 - step(0.5, fCell.x));
vec3 lcol = fHash(vec3(vSeed, 2.0, 8.0)) < 0.5 ? vec3(0.1, 0.9, 1.0) : vec3(0.95, 0.2, 1.0);
totalEmissiveRadiance += lcol * edge * strip * 2.5;`);
  };
  return m;
}

function setNight(M, night) {
  const u = M.Facades.userData.uniforms;
  if (u) u.night.value = night ? 1 : 0;
  for (const k of ['Lamp_Sodium', 'Lamp_White', 'Lamp_LED', 'Lamp_Tunnel', 'Neon_Red', 'Neon_White', 'Neon', 'Neon_Buzz', 'Neon_Cyan', 'Neon_Magenta', 'Beacon_Red']) {
    if (!M[k]) continue;
    M[k].userData.base = M[k].userData.base || M[k].color.clone();
    M[k].userData.level = night ? 1 : 0.25;
    M[k].color.copy(M[k].userData.base).multiplyScalar(M[k].userData.level);
  }
  if (M.Light_Pool) M.Light_Pool.visible = !!night;
  if (M.Neon_Pool) M.Neon_Pool.visible = !!night;
  if (M.Beacon) M.Beacon.visible = !!night;
  // Streets look wet at night — the NFSU look — and dry by day.
  if (M.Asphalt) M.Asphalt.roughness = night ? 0.42 : 0.82;
  if (M.Concrete_Dark && M.Concrete_Dark.emissiveMap) M.Concrete_Dark.emissive.set(night ? 0x766e7c : 0x000000);
  if (M.Tunnel && M.Tunnel.emissiveMap) M.Tunnel.emissive.set(night ? 0x766d5f : 0x000000);
  // Sparse one-texel lamps: bright, or the mipmaps average them away.
  if (M.Outskirts) M.Outskirts.emissive.setScalar(night ? 2.6 : 0);
  if (M.Street_Asphalt) M.Street_Asphalt.roughness = night ? 0.42 : 0.82;
}
