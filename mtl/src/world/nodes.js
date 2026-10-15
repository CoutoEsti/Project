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

// materials.js: facadeMaterial. The GLSL branches become selects: every
// path is computed and the right one kept, which costs a few more texture
// reads but stays one shader.
function facades(TSL, m) {
  const u = m.userData.uniforms;
  const atlas = u && u.facadeAtlas.value;
  if (!atlas) return;
  const {
    attribute, varying, uv, uniform, uniformArray, texture, vec2, vec3, vec4, float, int,
    floor, fract, dFdx, dFdy, fwidth, length, normalize, cross, dot, sign, clamp, mix, min, max, step,
    smoothstep, pow, abs, exp, select, positionView, normalViewGeometry, cameraViewMatrix,
    materialColor, materialRoughness,
  } = TSL;
  // setNight writes u.night.value: the uniform nodes take the holders' place.
  u.night = uniform(u.night.value);
  u.litRatio = uniform(u.litRatio.value);
  const night = u.night, litRatio = u.litRatio;
  const rows = float(u.facadeRows.value);
  const winRect = uniformArray(u.winRect.value, 'vec4');
  const bayWidth = uniformArray(u.bayWidth ? u.bayWidth.value : u.winRect.value.map(() => 3), 'float');

  const one = float(1.0);
  const not = (x) => one.sub(x);
  const and = (...xs) => xs.reduce((a, b) => a.mul(b));
  // GLSL's mod (WGSL's % truncates towards zero).
  const gmod = (x, y) => x.sub(floor(x.div(y)).mul(y));
  const vUv = uv();
  const vFacade = varying(attribute('facade', 'float')).setInterpolation('flat');
  const vSeed = varying(attribute('seed', 'float')).setInterpolation('flat');
  const fi = int(vFacade.add(0.5));
  const hash = (p) => {
    const q = fract(p.mul(0.3183099).add(vec3(0.11, 0.17, 0.13))).mul(17.0);
    return fract(q.x.mul(q.y).mul(q.z).mul(q.x.add(q.y).add(q.z)));
  };
  const k = vec2(1.0, one.div(rows));
  const gx = dFdx(vUv).mul(k), gy = dFdy(vUv).mul(k);
  const atlasAt = (f) => texture(atlas, vec2(f.x, rows.sub(vFacade).sub(1.0).add(f.y).div(rows))).grad(gx, gy);
  const inside = (p, lo, hi) => and(step(lo.x, p.x), step(p.x, hi.x), step(lo.y, p.y), step(p.y, hi.y));

  const cell = floor(vUv);
  const ff0 = fract(vUv);
  const office = step(9.5, vFacade);
  // Doors: on brick and stone, some ground-floor bays.
  const fWin = winRect.element(fi);
  const door = and(step(vFacade, 6.5), not(step(1.0, cell.y)), step(hash(vec3(cell.x, vSeed, 41.0)), 0.3));
  const isDoor = door.greaterThan(0.5);
  const wr0 = select(isDoor, vec4(0.31, 0.03, 0.38, 0.73), fWin);
  // Around a door, the window that would be there is bricked in.
  const bricked = and(door, inside(ff0, fWin.xy.sub(vec2(6.0, 8.0).div(128.0)), fWin.xy.add(fWin.zw).add(4.0 / 128.0)));
  const wallUv = vec2(select(bricked.greaterThan(0.5), fract(ff0.x.add(select(ff0.x.lessThan(0.5), -0.25, 0.25))), ff0.x), ff0.y);
  // Recessed windows, by parallax.
  const lo = wr0.xy, hi = wr0.xy.add(wr0.zw);
  const inWin = inside(ff0, lo, hi);
  const near = not(clamp(length(fwidth(vUv)).mul(4.0).sub(0.3), 0.0, 1.0));
  const active = inWin.mul(step(1e-6, near));
  const V = normalize(positionView.negate());
  const N = normalViewGeometry;
  const B = normalize(cameraViewMatrix.mul(vec4(0.0, 1.0, 0.0, 0.0)).xyz);
  const Tg = normalize(cross(B, N));
  const vn = max(dot(V, N), 0.2);
  const depth = mix(0.24, 0.07, office).mul(near);
  const shift = vec2(dot(V, Tg).div(bayWidth.element(fi)), dot(V, B).div(3.3)).mul(depth).div(vn);
  const g = ff0.sub(shift);
  const reveal = active.mul(not(inside(g, lo, hi)));
  const revealShade = select(g.y.greaterThan(hi.y), 0.35, select(g.y.lessThan(lo.y), 0.95, 0.6));
  const ff = select(active.greaterThan(0.5), clamp(g, lo.add(0.002), hi.sub(0.002)), ff0);

  let fs = atlasAt(ff);
  let glass = not(fs.a);
  const inDoor = door.mul(inWin);
  const doorWall = door.mul(not(inWin));
  fs = select(doorWall.greaterThan(0.5), atlasAt(wallUv), fs);
  glass = mix(glass, float(0.0), doorWall);
  // A painted door: frame, two sunk panels, a glazed top, a brass knob.
  const du = ff.sub(wr0.xy).div(wr0.zw);
  const ph = hash(vec3(cell.x, vSeed, 43.0));
  const paint = select(ph.lessThan(0.25), vec3(0.1, 0.24, 0.14), select(ph.lessThan(0.45), vec3(0.32, 0.06, 0.07),
    select(ph.lessThan(0.65), vec3(0.05, 0.05, 0.06), select(ph.lessThan(0.85), vec3(0.34, 0.2, 0.1), vec3(0.08, 0.16, 0.3)))));
  const frame = not(step(0.07, min(min(du.x, not(du.x)), not(du.y).mul(0.5))));
  const innerD = step(0.17, du.x).mul(step(du.x, 0.83));
  const pane = and(innerD, step(0.64, du.y), step(du.y, 0.9));
  const panel = innerD.mul(and(step(0.08, du.y), step(du.y, 0.28)).add(and(step(0.34, du.y), step(du.y, 0.56))));
  let dcol = paint.mul(mix(1.0, 0.72, panel));
  dcol = mix(dcol, vec3(0.74, 0.72, 0.66), frame);
  const knob = not(step(0.035, length(du.sub(vec2(0.86, 0.46)).mul(vec2(1.0, 2.6)))));
  dcol = mix(dcol, vec3(0.75, 0.6, 0.3), knob);
  const painted = inDoor.mul(not(reveal));
  fs = select(painted.greaterThan(0.5), vec4(dcol, not(pane)), fs);
  glass = mix(glass, pane, painted);
  const doorGlass = pane.mul(painted);
  const doorHeight = not(panel).mul(not(pane)).mul(0.006).add(frame.mul(0.01));
  // The reveal is the wall's own material, read just beside the window.
  const revealFs = atlasAt(vec2(max(min(wr0.x, fWin.x).sub(0.04), 0.01), ff.y));
  fs = select(reveal.greaterThan(0.5), vec4(revealFs.rgb.mul(revealShade), revealFs.a), fs);
  glass = mix(glass, float(0.0), reveal);
  // Relief: brick and stone joints, frames and sills, in metres.
  const p = vec2(wallUv.x, not(wallUv.y)).mul(128.0);
  const pw = max(fwidth(p), vec2(0.001));
  const fJoint = (d, halfW, w) => not(smoothstep(float(halfW), w.add(halfW), d));
  const brickRow = floor(p.y.div(6.0));
  const brick = max(fJoint(abs(gmod(p.y.sub(0.5).add(3.0), 6.0).sub(3.0)), 0.6, pw.y),
    fJoint(abs(gmod(p.x.sub(gmod(brickRow, 2.0).mul(8.0)).sub(0.5).add(8.0), 16.0).sub(8.0)), 0.6, pw.x));
  const stoneRow = floor(p.y.div(32.0));
  const stone = max(fJoint(abs(gmod(p.y.sub(0.75).add(16.0), 32.0).sub(16.0)), 0.9, pw.y),
    fJoint(abs(gmod(p.x.sub(gmod(stoneRow, 2.0).mul(24.0)).sub(0.75).add(24.0), 48.0).sub(24.0)), 0.9, pw.x));
  const mortar = select(vFacade.lessThan(4.5), brick, select(vFacade.lessThan(6.5), stone, float(0.0)));
  let h = not(mortar).mul(0.012);
  const onFrame = inside(wallUv, fWin.xy.sub(3.0 / 128.0), fWin.xy.add(fWin.zw).add(3.0 / 128.0));
  const onSill = inside(wallUv, vec2(fWin.x.sub(5.0 / 128.0), fWin.y.sub(7.0 / 128.0)),
    vec2(fWin.x.add(fWin.z).add(5.0 / 128.0), fWin.y.sub(3.0 / 128.0)));
  h = select(not(door).mul(not(office)).greaterThan(0.5), max(h, max(onFrame.mul(0.02), onSill.mul(0.04))), h);
  const wallHeight = h.mul(not(glass));
  const height = select(painted.greaterThan(0.5), doorHeight,
    select(not(reveal).mul(not(inDoor)).greaterThan(0.5), wallHeight, float(0.0))).mul(near);

  const glassTint = mix(vec3(0.05, 0.07, 0.1), vec3(0.1, 0.16, 0.24), office);
  const wall = mix(fs.rgb.mul(hash(vec3(vSeed, 3.0, 1.0)).mul(0.24).add(0.88)), glassTint, glass);
  const diffuse = materialColor.rgb.mul(wall);
  m.colorNode = vec4(diffuse, materialColor.a);

  // Bump from the relief height: joints, frames and door panels catch the light.
  const dpx = dFdx(positionView), dpy = dFdy(positionView);
  const r1 = cross(dpy, N), r2 = cross(N, dpx);
  const det = dot(dpx, r1);
  const grad = sign(det).mul(dFdx(height).mul(r1).add(dFdy(height).mul(r2)));
  m.normalNode = select(near.greaterThan(0.0), normalize(abs(det).mul(N).sub(grad)), N);

  // Far off, a window is less than a pixel: glass turns matte with distance.
  const far = clamp(length(fwidth(vUv)).mul(1.6).sub(0.2), 0.0, 1.0);
  m.roughnessNode = mix(materialRoughness, mix(0.22, 0.7, far), glass);

  // Lit windows, shops, the street's bounce and the LED strips: see the GLSL.
  const fr = hash(vec3(cell, vSeed.mul(97.0).add(1.0)));
  const floorLit = hash(vec3(0.0, cell.y, vSeed.mul(13.0).add(2.0)));
  const byFloor = step(floorLit, litRatio.mul(0.6)).mul(step(fr, 0.8));
  const shop = not(step(1.0, cell.y));
  const ratio = mix(litRatio, 0.62, shop);
  const lit = mix(step(fr, ratio), byFloor, office.mul(not(shop))).mul(glass).mul(night);
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
  wcol = mix(wcol, vec3(1.0, 0.7, 0.42), doorGlass);
  let shade = hash(vec3(cell, vSeed.add(5.0))).mul(0.55).add(0.45);
  const wr = winRect.element(fi);
  const wuv = clamp(ff.sub(wr.xy).div(wr.zw), 0.0, 1.0);
  let room = mix(0.5, 1.1, smoothstep(0.0, 1.0, wuv.y));
  room = room.mul(not(pow(abs(wuv.x.mul(2.0).sub(1.0)), 3.0).mul(0.45)));
  room = room.mul(mix(0.55, 1.0, smoothstep(0.12, 0.3, wuv.y)));
  const cur = hash(vec3(cell, vSeed.add(23.0)));
  const home = not(office).mul(not(shop));
  const curtain = step(0.55, cur).mul(home);
  const cw = fract(cur.mul(7.0)).mul(0.16).add(0.14);
  const side = not(smoothstep(cw, cw.add(0.05), min(wuv.x, not(wuv.x))));
  room = mix(room, 0.42, side.mul(curtain));
  const blinds = step(0.78, hash(vec3(cell, vSeed.add(19.0))));
  room = room.mul(mix(1.0, step(0.3, fract(wuv.y.mul(9.0))).mul(0.5).add(0.5), blinds));
  room = mix(room, wuv.y.mul(0.2).add(0.9), shop);
  const tv = step(0.93, hash(vec3(cell, vSeed.add(31.0)))).mul(home);
  wcol = mix(wcol, vec3(0.35, 0.5, 1.0), tv);
  shade = shade.mul(mix(1.0, 0.45, tv));
  const windows = wcol.mul(lit).mul(shade).mul(room).mul(mix(0.82, 1.05, shop));
  const bounce = exp(vUv.y.mul(-1.3)).mul(night).mul(not(glass.mul(0.5)));
  const bcol = mix(vec3(0.55, 0.32, 0.2), vec3(0.45, 0.15, 0.55), step(0.6, hash(vec3(vSeed, 1.0, 9.0))));
  const strip = office.mul(step(hash(vec3(vSeed, 11.0, 4.0)), 0.3)).mul(night);
  const edge = not(step(0.06, ff.x)).mul(not(step(0.5, cell.x)));
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

/** rain.js's streaks, in TSL: same box, fall, wrap and fade. */
export function applyRainNodes(THREE, TSL, lines) {
  const {
    attribute, positionGeometry, varying, vec4, floor, abs, max, length, smoothstep, float,
  } = TSL;
  const old = lines.material;
  const U = old.uniforms;
  const time = follow(TSL, U.time), centre = follow(TSL, U.centre), box = follow(TSL, U.box);
  const fall = follow(TSL, U.fall), streak = follow(TSL, U.streak);
  const colour = follow(TSL, U.colour), alpha = follow(TSL, U.alpha);
  const gmod = (x, y) => x.sub(floor(x.div(y)).mul(y));
  // The drops are placed in world space; the lines object never moves.
  let p = positionGeometry.mul(box).add(fall.mul(time));
  p = centre.add(gmod(p.sub(centre), box)).sub(box.mul(0.5));
  p = p.add(fall.mul(streak).mul(attribute('end', 'float')));
  const d = p.sub(centre);
  const q = abs(d).div(box.mul(0.5));
  const fade = float(1.0).sub(smoothstep(0.7, 1.0, max(q.x, max(q.y, q.z)))).mul(smoothstep(1.0, 4.0, length(d)));
  const m = new THREE.LineBasicNodeMaterial({ transparent: true, depthWrite: false, fog: false });
  m.positionNode = p;
  m.colorNode = vec4(colour, 1.0);
  m.opacityNode = alpha.mul(varying(fade));
  m.uniforms = U;   // rain.update() writes these
  lines.material = m;
  old.dispose();
}

/**
 * main.js's post chain, on WebGPU: scene (MSAA), bloom, speed blur, tone
 * mapping, then the grade in display space — grade.js and speedblur.js in
 * TSL. Returns stand-ins with the fields main.js sets on the WebGL passes.
 */
export function createGpuPost(THREE, TSL, bloomNode, renderer, scene, camera, { grade: gradeOn = true } = {}) {
  const {
    Fn, If, pass, uniform, uv, vec2, vec3, vec4, float, fract, sin, dot, length, smoothstep, mix, clamp,
    screenCoordinate, renderOutput,
  } = TSL;
  const color = pass(scene, camera).getTextureNode('output');
  const glow = bloomNode(color, 0.7, 0.4, 0.88);
  const glowTex = glow.getTextureNode();
  const amount = uniform(0);
  const centre = uniform(new THREE.Vector2(0.5, 0.45));
  const contrast = uniform(1.06), saturation = uniform(1.12), vignette = uniform(0.32);
  const jitter = fract(sin(dot(screenCoordinate.xy, vec2(12.9898, 78.233))).mul(43758.5453));

  const build = (withBloom) => {
    // UnrealBloomPass adds its glow with SrcAlpha blending, and the glow's
    // alpha is strength × 3: the WebGL picture has that much more bloom.
    const glowAt = (p) => { const g = glowTex.sample(p); return vec4(g.rgb.mul(g.a), 0.0); };
    const at = (p) => (withBloom ? color.sample(p).add(glowAt(p)) : color.sample(p));
    // speedblur.js: eight taps outwards, skipped when the car is slow.
    const hdr = Fn(() => {
      const out = vec4(0.0).toVar();
      If(amount.greaterThan(0.001), () => {
        const d = uv().sub(centre);
        const edge = smoothstep(0.12, 0.5, length(d.mul(vec2(1.0, 0.8))));
        const s = d.mul(amount).mul(edge).mul(0.014);
        for (let i = 0; i < 8; i++) out.addAssign(at(uv().sub(s.mul(jitter.add(i)))));
        out.divAssign(8.0);
      }).Else(() => {
        out.assign(at(uv()));
      });
      return out;
    })();
    const display = renderOutput(hdr);
    if (!gradeOn) return display;
    // grade.js: contrast, saturation, vignette, a one-level dither.
    let c = display.rgb;
    c = mix(vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))), c, saturation);
    c = c.sub(0.5).mul(contrast).add(0.5);
    const v = uv().sub(0.5).mul(vec2(1.0, 0.75));
    c = c.mul(float(1.0).sub(vignette.mul(smoothstep(0.18, 0.62, dot(v, v).mul(2.2)))));
    c = c.add(jitter.sub(0.5).div(255.0));
    return vec4(clamp(c, 0.0, 1.0), display.a);
  };

  const pipeline = new THREE.RenderPipeline(renderer, build(true));
  pipeline.outputColorTransform = false;   // renderOutput above, before the grade
  let bloomOn = true;
  return {
    bloom: {
      get enabled() { return bloomOn; },
      set enabled(v) {
        if (v === bloomOn) return;
        bloomOn = v;
        pipeline.outputNode = build(v);
        pipeline.needsUpdate = true;
      },
      get strength() { return glow.strength.value; },
      set strength(v) { glow.strength.value = v; },
    },
    // Always in the chain: amount 0 is the switch.
    speedBlur: { enabled: false, uniforms: { amount, centre } },
    grade: { enabled: gradeOn },
    composer: {
      render() { pipeline.render(); },
      setSize() { /* the passes follow the renderer */ },
    },
  };
}
