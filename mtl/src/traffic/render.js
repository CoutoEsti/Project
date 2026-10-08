// Traffic drawn: every car in one instanced mesh (body, cabin and wheels in
// vertex colours, the paint per instance), their lamps in a second, and the
// traffic lights in three more — five draw calls for the whole city. Receives
// THREE, like the world modules.

import { span, pointOn, lightAt } from './network.js';

const PAINT = [0xd9dde2, 0x1d1f24, 0x8a9099, 0xa3202a, 0x1f4f9c, 0xe8e4d6, 0x2e5e3e, 0x5a4a3a];
const LAMP = { r: [1, 0.08, 0.04], y: [1, 0.62, 0], g: [0.1, 1, 0.5] };

export function createTrafficView(THREE, net, { max = 120 } = {}) {
  const root = new THREE.Group();
  root.name = 'Trafic';

  // --- cars ------------------------------------------------------------------------
  // Forward is +z, as the player's car (main.js turns it by π - heading).
  const body = boxes(THREE, [
    // [x, y, z, w, h, l, shade]
    [0, 0.62, 0, 1.84, 0.62, 4.5, 1],          // body
    [0, 1.17, -0.25, 1.62, 0.5, 2.3, 0.16],    // cabin, glass
    [0, 1.43, -0.25, 1.5, 0.04, 1.9, 1],       // roof
    [0, 0.33, 1.35, 1.9, 0.5, 0.72, 0.06],     // front wheels
    [0, 0.33, -1.35, 1.9, 0.5, 0.72, 0.06],    // rear wheels
  ]);
  const carMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.35 });
  const cars = new THREE.InstancedMesh(body, carMat, max);
  cars.name = 'Autos';
  cars.frustumCulled = false;
  cars.count = 0;
  const paint = new THREE.Color();
  for (let i = 0; i < max; i++) cars.setColorAt(i, paint.set(PAINT[0]));
  root.add(cars);

  const lamps = boxes(THREE, [
    [0.66, 0.72, 2.26, 0.34, 0.14, 0.04, 2],    // headlights
    [-0.66, 0.72, 2.26, 0.34, 0.14, 0.04, 2],
    [0.7, 0.78, -2.26, 0.3, 0.12, 0.04, -1],    // tail lights
    [-0.7, 0.78, -2.26, 0.3, 0.12, 0.04, -1],
  ]);
  const lampMat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
  const lights = new THREE.InstancedMesh(lamps, lampMat, max);
  lights.name = 'Phares';
  lights.frustumCulled = false;
  lights.count = 0;
  root.add(lights);

  // --- traffic lights ---------------------------------------------------------------
  // One pole and one head on the right of each approach, at its stop line;
  // one lit lamp per head, moved to red, yellow or green.
  const heads = [];
  const q = {}, sp = {};
  for (const node of net.nodes) {
    if (node.control !== 'signal') continue;
    for (const ed of node.in) {
      span(net, ed, sp);
      if (sp.s1 - sp.s0 < 6) continue;
      pointOn(net, ed, sp.s1, -(sp.e.width / 2 + 0.9), q);
      heads.push({ node, ed, x: q.x, n: q.n, y: q.y, h: q.h, state: null });
    }
  }
  const poleGeo = new THREE.CylinderGeometry(0.09, 0.11, 4.6, 6);
  poleGeo.translate(0, 2.3, 0);
  const headGeo = new THREE.BoxGeometry(0.42, 1.15, 0.32);
  const lampGeo = new THREE.SphereGeometry(0.14, 8, 6);
  const dark = new THREE.MeshStandardMaterial({ color: 0x24262a, roughness: 0.7, metalness: 0.4 });
  const poles = new THREE.InstancedMesh(poleGeo, dark, Math.max(1, heads.length));
  const boxesMesh = new THREE.InstancedMesh(headGeo, dark, Math.max(1, heads.length));
  const lit = new THREE.InstancedMesh(lampGeo, new THREE.MeshBasicMaterial({ toneMapped: false }), Math.max(1, heads.length));
  poles.name = 'Feux';
  for (const m of [poles, boxesMesh, lit]) { m.count = heads.length; m.frustumCulled = false; root.add(m); }
  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), E = new THREE.Euler(), P = new THREE.Vector3(), S = new THREE.Vector3(1, 1, 1);
  const col = new THREE.Color();
  heads.forEach((hd, i) => {
    // The head faces the cars coming: its front (+z) points back down the approach.
    E.set(0, -hd.h, 0, 'YXZ');
    Q.setFromEuler(E);
    poles.setMatrixAt(i, M.compose(P.set(hd.x, hd.y, -hd.n), Q, S));
    boxesMesh.setMatrixAt(i, M.compose(P.set(hd.x, hd.y + 4.0, -hd.n), Q, S));
  });

  let night = true;
  const carColour = new THREE.Color();

  function update(poses, source) {
    const n = Math.min(poses.length, max);
    cars.count = n;
    lights.count = n;
    for (let i = 0; i < n; i++) {
      const p = poses[i];
      E.set(-p.p, Math.PI - p.h, 0, 'YXZ');
      Q.setFromEuler(E);
      M.compose(P.set(p.x, p.y, -p.n), Q, S);
      cars.setMatrixAt(i, M);
      lights.setMatrixAt(i, M);
      cars.setColorAt(i, carColour.set(PAINT[p.colour % PAINT.length]));
      // Lamps: the instance colour scales the vertex colours (white front,
      // red back); brakes and night brighten them, bloom does the rest.
      const k = night ? (p.brake ? 2.6 : 1.4) : (p.brake ? 1.6 : 0.5);
      lights.setColorAt(i, col.setRGB(k, k, k));
    }
    cars.instanceMatrix.needsUpdate = true;
    lights.instanceMatrix.needsUpdate = true;
    if (cars.instanceColor) cars.instanceColor.needsUpdate = true;
    if (lights.instanceColor) lights.instanceColor.needsUpdate = true;

    // Lights change a few times a minute: only those are rewritten.
    let changed = false;
    for (let i = 0; i < heads.length; i++) {
      const hd = heads[i];
      const st = lightAt(hd.node, hd.ed, source.time);
      if (st === hd.state) continue;
      hd.state = st;
      changed = true;
      const dy = st === 'r' ? 0.36 : st === 'y' ? 0 : -0.36;
      const fx = -Math.sin(hd.h) * 0.17, fn = -Math.cos(hd.h) * 0.17;
      M.makeTranslation(hd.x + fx, hd.y + 4.0 + dy, -(hd.n + fn));
      lit.setMatrixAt(i, M);
      const c = LAMP[st];
      lit.setColorAt(i, col.setRGB(c[0], c[1], c[2]));
    }
    if (changed) {
      lit.instanceMatrix.needsUpdate = true;
      if (lit.instanceColor) lit.instanceColor.needsUpdate = true;
    }
  }

  return {
    root,
    heads: heads.length,
    update,
    setNight(v) { night = v; },
    dispose() {
      for (const m of [cars, lights, poles, boxesMesh, lit]) { m.geometry.dispose(); m.material.dispose(); m.dispose(); }
    },
  };
}

/**
 * Boxes merged into one geometry, with a grey level per box in the vertex
 * colours (1 takes the paint, low values stay dark whatever the paint).
 * A negative shade marks a tail light (red), 2 a headlight (warm white).
 */
function boxes(THREE, list) {
  const pos = [], nor = [], colr = [], idx = [];
  for (const [x, y, z, w, h, l, shade] of list) {
    const g = new THREE.BoxGeometry(w, h, l);
    g.translate(x, y, z);
    const base = pos.length / 3;
    const P = g.attributes.position.array, N = g.attributes.normal.array;
    for (let i = 0; i < P.length; i++) { pos.push(P[i]); nor.push(N[i]); }
    const c = shade < 0 ? [1, 0.03, 0.02] : shade === 2 ? [1, 0.95, 0.82] : [shade, shade, shade];
    for (let i = 0; i < P.length / 3; i++) colr.push(...c);
    for (const i of g.index.array) idx.push(base + i);
    g.dispose();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(colr, 3));
  g.setIndex(idx);
  return g;
}
