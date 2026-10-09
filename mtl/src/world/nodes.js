// The custom shaders, for the WebGPU renderer. WebGPURenderer ignores
// onBeforeCompile and ShaderMaterial (they are GLSL patches), so each one is
// written again here in TSL, three.js's node language, which compiles to WGSL.
// The WebGL path never loads this file: materials.js and sky.js stay the
// reference, and a change to one of their shaders goes here too.
//
// The nodes are hung on the existing materials (colorNode, positionNode…):
// the renderer turns a plain material into a node material by copying its
// properties, these included, so the rest of the game keeps the same objects
// and setNight, the export and the names all work unchanged.

/** Hang the TSL versions of materials.js's shaders on the world's materials. */
export function applyMaterialNodes(THREE, TSL, M) {
  if (M.Street_Asphalt && M.Street_Asphalt.map) antiTile(TSL, M.Street_Asphalt);
  for (const k of ['Light_Pool', 'Neon_Pool']) if (M[k]) wetStreaks(THREE, TSL, M[k]);
  if (M.Facades) facades(TSL, M.Facades);
}

/** A uniform node that reads a plain { value } holder on every render. */
function follow(TSL, holder) {
  return TSL.uniform(holder.value).onRenderUpdate(() => holder.value);
}

// materials.js: antiTile.
function antiTile(TSL, m) {
  const { uv, vec2, vec3, vec4, texture, dot, clamp, materialColor } = TSL;
  const map = m.map;
  const mapUv = uv().mul(vec2(map.repeat.x, map.repeat.y)).add(vec2(map.offset.x, map.offset.y));
  // mat2(0.8, -0.6, 0.6, 0.8) * uv, written out.
  const turned = vec2(mapUv.x.mul(0.8).add(mapUv.y.mul(0.6)), mapUv.x.mul(-0.6).add(mapUv.y.mul(0.8)));
  const big = texture(map, turned.mul(0.23).add(vec2(0.37, 0.11))).rgb;
  const k = dot(big, vec3(0.3333)).div(0.026);
  m.colorNode = vec4(materialColor.rgb.mul(clamp(k.mul(0.45).add(0.55), 0.75, 1.3)), materialColor.a);
}

// materials.js: wetStreaks. The GLSL bends the disc before instancing; a node
// position comes after it, so this one reads the instance matrix itself and
// applies it again to the bent disc.
const matrixBuffers = new WeakMap();
function wetStreaks(THREE, TSL, m) {
  const {
    Fn, vec2, vec3, vec4, mat4, varying, positionGeometry, cameraPosition, modelWorldMatrix,
    instancedBufferAttribute, length, max, min, clamp, mix, dot, materialColor,
  } = TSL;
  const bend = (object) => {
    let buf = matrixBuffers.get(object.instanceMatrix);
    if (!buf) {
      buf = new THREE.InstancedInterleavedBuffer(object.instanceMatrix.array, 16, 1);
      matrixBuffers.set(object.instanceMatrix, buf);
    }
    const cols = [0, 4, 8, 12].map((o) => instancedBufferAttribute(buf, 'vec4', 16, o));
    const inst = mat4(...cols);
    const c = modelWorldMatrix.mul(inst).mul(vec4(0, 0, 0, 1)).xyz;
    const toEye = cameraPosition.xz.sub(c.xz);
    const dist = length(toEye);
    const d = toEye.div(max(dist, 1e-3));
    const lift = cameraPosition.y.sub(c.y);
    const graze = clamp(dist.div(max(lift, 0.5)), 1.0, 12.0);
    const stretch = min(graze.mul(0.3), 2.6).add(1.0);
    const p = positionGeometry.xz;
    const along = dot(p, d);
    const perp = p.sub(d.mul(along));
    const along2 = along.mul(stretch).add(stretch.sub(1.0));
    const thin = mix(1.0, 0.32, clamp(stretch.sub(1.0).div(2.0), 0.0, 1.0));
    const above = clamp(lift.sub(30.0).div(250.0), 0.0, 1.0);
    const high = clamp(lift.sub(300.0).div(1500.0), 0.0, 1.0);
    const xz = perp.mul(thin).add(d.mul(along2)).mul(above.mul(0.6).add(high.mul(0.6)).add(1.0));
    return { position: inst.mul(vec4(xz.x, positionGeometry.y, xz.y, 1.0)).xyz, boost: above.mul(1.4).add(1.0) };
  };
  m.positionNode = Fn(({ object }) => (object.isInstancedMesh ? bend(object).position : positionGeometry))();
  // The GLSL brightened the instance colour; here the instance colour
  // multiplies this, which comes to the same.
  m.colorNode = Fn(({ object }) => {
    if (!object.isInstancedMesh || !object.instanceColor) return materialColor;
    return vec4(materialColor.rgb.mul(varying(bend(object).boost)), materialColor.a);
  })();
}

// materials.js: facadeMaterial.
function facades(TSL, m) {
  const u = m.userData.uniforms;
  const atlas = u && u.facadeAtlas.value;
  if (!atlas) return;
  const {
    attribute, varying, uv, uniform, uniformArray, texture, vec2, vec3, vec4, float, int,
    floor, fract, dFdx, dFdy, fwidth, length, clamp, mix, min, step, smoothstep, pow, abs, exp, select,
    materialColor, materialRoughness,
  } = TSL;
  // setNight writes u.night.value: the uniform nodes take the holders' place.
  u.night = uniform(1);
  u.litRatio = uniform(u.litRatio.value);
  const night = u.night, litRatio = u.litRatio;
  const rows = float(u.facadeRows.value);
  const winRect = uniformArray(u.winRect.value, 'vec4');

  const vUv = uv();
  const vFacade = varying(attribute('facade', 'float')).setInterpolation('flat');
  const vSeed = varying(attribute('seed', 'float')).setInterpolation('flat');
  const hash = (p) => {
    const q = fract(p.mul(0.3183099).add(vec3(0.11, 0.17, 0.13))).mul(17.0);
    return fract(q.x.mul(q.y).mul(q.z).mul(q.x.add(q.y).add(q.z)));
  };

  const cell = floor(vUv);
  const ff = fract(vUv);
  const auv = vec2(ff.x, rows.sub(vFacade).sub(1.0).add(ff.y).div(rows));
  const k = vec2(1.0, float(1.0).div(rows));
  const fs = texture(atlas, auv).grad(dFdx(vUv).mul(k), dFdy(vUv).mul(k));
  const glass = float(1.0).sub(fs.a);
  const office = step(9.5, vFacade);
  const glassTint = mix(vec3(0.05, 0.07, 0.1), vec3(0.1, 0.16, 0.24), office);
  const wall = mix(fs.rgb.mul(hash(vec3(vSeed, 3.0, 1.0)).mul(0.24).add(0.88)), glassTint, glass);
  const diffuse = materialColor.rgb.mul(wall);
  m.colorNode = vec4(diffuse, materialColor.a);

  // Far off, a window is less than a pixel: glass turns matte with distance.
  const far = clamp(length(fwidth(vUv)).mul(1.6).sub(0.2), 0.0, 1.0);
  m.roughnessNode = mix(materialRoughness, mix(0.22, 0.7, far), glass);

  // Lit windows, shops, the street's bounce and the LED strips: see the GLSL.
  const fr = hash(vec3(cell, vSeed.mul(97.0).add(1.0)));
  const floorLit = hash(vec3(0.0, cell.y, vSeed.mul(13.0).add(2.0)));
  const byFloor = step(floorLit, litRatio.mul(0.6)).mul(step(fr, 0.8));
  const shop = float(1.0).sub(step(1.0, cell.y));
  const ratio = mix(litRatio, 0.62, shop);
  const lit = mix(step(fr, ratio), byFloor, office.mul(float(1.0).sub(shop))).mul(glass).mul(night);
  const tone = hash(vec3(cell.yx, vSeed.add(7.0)));
  let wcol = select(tone.lessThan(0.62), vec3(1.0, 0.64, 0.36),
    select(tone.lessThan(0.86), vec3(0.78, 0.86, 1.0),
      select(tone.lessThan(0.92), vec3(0.25, 0.85, 1.0),
        select(tone.lessThan(0.96), vec3(0.8, 0.35, 1.0), vec3(1.0, 0.3, 0.55)))));
  wcol = mix(wcol, select(tone.lessThan(0.7), vec3(0.82, 0.9, 1.0), vec3(1.0, 0.86, 0.66)), office);
  const st = hash(vec3(cell.x, vSeed, 3.0));
  const scol = select(st.lessThan(0.45), vec3(1.0, 0.82, 0.62),
    select(st.lessThan(0.62), vec3(0.2, 0.9, 1.0),
      select(st.lessThan(0.8), vec3(1.0, 0.25, 0.65),
        select(st.lessThan(0.9), vec3(0.6, 0.35, 1.0), vec3(1.0, 0.6, 0.25)))));
  wcol = mix(wcol, scol, shop);
  let shade = hash(vec3(cell, vSeed.add(5.0))).mul(0.55).add(0.45);
  const wr = winRect.element(int(vFacade.add(0.5)));
  const wuv = clamp(ff.sub(wr.xy).div(wr.zw), 0.0, 1.0);
  let room = mix(0.5, 1.1, smoothstep(0.0, 1.0, wuv.y));
  room = room.mul(float(1.0).sub(pow(abs(wuv.x.mul(2.0).sub(1.0)), 3.0).mul(0.45)));
  room = room.mul(mix(0.55, 1.0, smoothstep(0.12, 0.3, wuv.y)));
  const cur = hash(vec3(cell, vSeed.add(23.0)));
  const home = float(1.0).sub(office).mul(float(1.0).sub(shop));
  const curtain = step(0.55, cur).mul(home);
  const cw = fract(cur.mul(7.0)).mul(0.16).add(0.14);
  const side = float(1.0).sub(smoothstep(cw, cw.add(0.05), min(wuv.x, float(1.0).sub(wuv.x))));
  room = mix(room, 0.42, side.mul(curtain));
  const blinds = step(0.78, hash(vec3(cell, vSeed.add(19.0))));
  room = room.mul(mix(1.0, step(0.3, fract(wuv.y.mul(9.0))).mul(0.5).add(0.5), blinds));
  room = mix(room, wuv.y.mul(0.2).add(0.9), shop);
  const tv = step(0.93, hash(vec3(cell, vSeed.add(31.0)))).mul(home);
  wcol = mix(wcol, vec3(0.35, 0.5, 1.0), tv);
  shade = shade.mul(mix(1.0, 0.45, tv));
  const windows = wcol.mul(lit).mul(shade).mul(room).mul(mix(0.82, 1.05, shop));
  const bounce = exp(vUv.y.mul(-1.3)).mul(night).mul(float(1.0).sub(glass.mul(0.5)));
  const bcol = mix(vec3(0.55, 0.32, 0.2), vec3(0.45, 0.15, 0.55), step(0.6, hash(vec3(vSeed, 1.0, 9.0))));
  const strip = office.mul(step(hash(vec3(vSeed, 11.0, 4.0)), 0.3)).mul(night);
  const edge = float(1.0).sub(step(0.06, ff.x)).mul(float(1.0).sub(step(0.5, cell.x)));
  const lcol = select(hash(vec3(vSeed, 2.0, 8.0)).lessThan(0.5), vec3(0.1, 0.9, 1.0), vec3(0.95, 0.2, 1.0));
  m.emissiveNode = windows.add(diffuse.mul(bcol).mul(bounce).mul(0.7)).add(lcol.mul(edge).mul(strip).mul(2.5));
}

/** sky.js's dome, in TSL: same gradient, glow, cloud deck and stars. */
export function applySkyNodes(THREE, TSL, sky) {
  const {
    Fn, varying, positionGeometry, vec3, vec4, float, floor, fract, dot, clamp, mix, pow, max, exp, sin,
    atan, smoothstep, step,
  } = TSL;
  const old = sky.dome.material;
  const U = old.uniforms;
  const top = follow(TSL, U.top), horizon = follow(TSL, U.horizon), glow = follow(TSL, U.glow);
  const glow2 = follow(TSL, U.glow2), stars = follow(TSL, U.stars), haze = follow(TSL, U.haze);
  const dir = varying(positionGeometry.normalize());
  const h = (p0) => {
    let p = fract(p0.mul(0.1031));
    p = p.add(dot(p, p.yzx.add(33.33)));
    return fract(p.x.add(p.y).mul(p.z));
  };
  const color = Fn(() => {
    const y = clamp(dir.y, -0.2, 1.0);
    const y0 = max(y, 0.0);
    let c = mix(horizon, top, pow(y0, 0.55));
    const side = sin(atan(dir.z, dir.x).add(0.6)).mul(0.5).add(0.5);
    c = c.add(mix(glow, glow2, side).mul(exp(y0.mul(-7.0))));
    c = c.add(glow.mul(0.35).mul(smoothstep(0.08, 0.2, y)).mul(float(1.0).sub(smoothstep(0.2, 0.45, y))));
    c = mix(haze, c, smoothstep(-0.01, 0.07, dir.y));
    const s = step(0.9985, h(floor(dir.mul(420.0)))).mul(smoothstep(0.05, 0.4, y)).mul(step(0.05, y));
    return vec4(c.add(vec3(s).mul(stars).mul(0.8)), 1.0);
  })();
  const m = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false });
  m.colorNode = color;
  m.uniforms = U;   // sky.set() writes these
  m.name = old.name;
  sky.dome.material = m;
  old.dispose();
}
