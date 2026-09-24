// Lamp posts, their pools of light, and trees — all instanced: a few thousand
// of each cost a handful of draw calls.

import { ceilingY } from '../map/structures.js';
import { hash01 } from '../map/geom.js';

// Per kind: pole height, arm reach (towards the road), light colour, pool
// radius, and whether the pole is drawn at all.
const KINDS = {
  cobra: { h: 8.6, arm: 2.3, light: 'sodium', pool: 10, pole: 'arm' },
  led: { h: 8.6, arm: 2.3, light: 'led', pool: 11, pole: 'arm' },
  pole: { h: 9.2, arm: 2.4, light: 'led', pool: 11, pole: 'arm' },
  lantern: { h: 4.4, arm: 0, light: 'warm', pool: 6, pole: 'post' },
  mast: { h: 13.5, arm: 5, light: 'led', pool: 12, pole: 'mast' },
  flood: { h: 16, arm: 0.8, light: 'white', pool: 16, pole: 'post' },
  tunnel: { h: 0, arm: 0, light: 'tunnel', pool: 4.5, pole: 'none' },
};

const LIGHT = {
  sodium: { material: 'Lamp_Sodium', pool: 0xc98a4c },
  led: { material: 'Lamp_LED', pool: 0x5a7fa8 },
  warm: { material: 'Lamp_White', pool: 0xc9ae88 },
  white: { material: 'Lamp_White', pool: 0xb6c0d0 },
  tunnel: { material: 'Lamp_Tunnel', pool: 0x2c3f4c },
};

/**
 * Tilt of a light pool lying on the ground at (x, n): the quaternion that
 * turns +Y onto the relief's normal there, so the disc hugs a slope instead
 * of half sinking into it.
 */
export function groundTilt(THREE, height, x, n, q) {
  const e = 2;
  const gx = (height(x + e, n) - height(x - e, n)) / (2 * e);
  const gn = (height(x, n + e) - height(x, n - e)) / (2 * e);
  const v = new THREE.Vector3(-gx, 1, gn).normalize();
  return q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), v);
}

export function buildLamps(THREE, lamps, M, tile = null, height = null) {
  const out = [];
  const poles = { arm: [], post: [], mast: [] };
  const heads = { sodium: [], led: [], warm: [], white: [], tunnel: [] };
  const pools = [];

  for (const l of lamps) {
    const K = KINDS[l.kind] || KINDS.cobra;
    // Arms point towards the road: `lx, ln` is outward from the road.
    const ax = -l.lx, an = -l.ln;
    // three.js yaw turning local +X onto (ax, an): X = x, Z = -n.
    const yaw = Math.atan2(an, ax);
    const heads2 = l.kind === 'mast' ? [1, -1] : [1];
    if (K.pole !== 'none') poles[K.pole].push({ x: l.x, n: l.n, y: l.y, yaw, s: 1 });
    for (const side of heads2) {
      let hx = l.x + ax * K.arm * side, hn = l.n + an * K.arm * side, hy = l.y + K.h;
      if (l.kind === 'tunnel') { hx = l.x; hn = l.n; hy = ceilingY({ y: l.y, gs: l.gs }) - 0.12; }
      heads[K.light].push({ x: hx, n: hn, y: hy, yaw });
      const reach = l.kind === 'mast' ? 8 : l.kind === 'tunnel' ? 0 : K.arm * 1.4;
      pools.push({ x: l.x + ax * reach * side, n: l.n + an * reach * side, y: l.y + 0.05, r: K.pool, c: LIGHT[K.light].pool });
    }
  }

  const metal = M.Metal_Dark;
  const poleGeo = {
    arm: armPole(THREE, KINDS.cobra.h, KINDS.cobra.arm),
    post: postPole(THREE, 4.4),
    mast: mastPole(THREE, KINDS.mast.h, KINDS.mast.arm),
  };
  for (const [k, list] of Object.entries(poles)) {
    if (!list.length) continue;
    out.push(instanced(THREE, poleGeo[k], metal, list, `Lampadaires_${k}`));
  }
  const headGeo = {
    sodium: new THREE.BoxGeometry(1.1, 0.22, 0.45),
    led: new THREE.BoxGeometry(0.9, 0.12, 0.38),
    warm: new THREE.BoxGeometry(0.5, 0.75, 0.5),
    white: new THREE.BoxGeometry(1.6, 0.9, 0.5),
    tunnel: new THREE.BoxGeometry(1.1, 0.08, 0.22),
  };
  for (const [k, list] of Object.entries(heads)) {
    if (!list.length) continue;
    out.push(instanced(THREE, headGeo[k], M[LIGHT[k].material], list, `Lumieres_${k}`));
  }
  if (pools.length) {
    const g = new THREE.PlaneGeometry(2, 2);
    g.rotateX(-Math.PI / 2);
    const mesh = new THREE.InstancedMesh(g, M.Light_Pool, pools.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    const c = new THREE.Color();
    pools.forEach((pl, i) => {
      // On the street (not a deck, not a tunnel): hug the relief, above the
      // kerb-high sidewalk or the sidewalk cuts it in half.
      const onGround = height && Math.abs(pl.y - height(pl.x, pl.n)) < 0.6;
      p.set(pl.x, onGround ? height(pl.x, pl.n) + 0.2 : pl.y, -pl.n);
      if (onGround) groundTilt(THREE, height, pl.x, pl.n, q); else q.identity();
      s.set(pl.r, 1, pl.r);
      m.compose(p, q, s);
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, c.set(pl.c));
    });
    mesh.name = 'Flaques_de_lumiere';
    mesh.userData.zone = 'mobilier';
    mesh.userData.exportSkip = true;     // a lighting trick, not geometry
    mesh.renderOrder = 2;
    mesh.computeBoundingSphere();
    out.push(mesh);
  }
  for (const m of out) { m.userData.tile = tile; m.userData.layer = 'mobilier'; m.userData.detail = true; }
  return out;
}

function instanced(THREE, geo, mat, list, name) {
  const mesh = new THREE.InstancedMesh(geo, mat, list.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3();
  list.forEach((it, i) => {
    p.set(it.x, it.y, -it.n);
    q.setFromEuler(e.set(0, it.yaw || 0, 0));
    s.setScalar(it.s || 1);
    m.compose(p, q, s);
    mesh.setMatrixAt(i, m);
  });
  mesh.name = name;
  mesh.userData.zone = 'mobilier';
  mesh.computeBoundingSphere();
  return mesh;
}

function armPole(THREE, h, arm) {
  const parts = [];
  const pole = new THREE.CylinderGeometry(0.09, 0.14, h, 5, 1, true);
  pole.translate(0, h / 2, 0);
  parts.push(pole);
  const a = new THREE.BoxGeometry(arm + 0.2, 0.1, 0.1);
  a.translate(arm / 2, h - 0.15, 0);
  parts.push(a);
  return merge(THREE, parts);
}

function postPole(THREE, h) {
  const pole = new THREE.CylinderGeometry(0.07, 0.12, h, 5, 1, true);
  pole.translate(0, h / 2, 0);
  return pole;
}

function mastPole(THREE, h, arm) {
  const parts = [];
  const pole = new THREE.CylinderGeometry(0.14, 0.26, h, 6, 1, true);
  pole.translate(0, h / 2, 0);
  parts.push(pole);
  const a = new THREE.BoxGeometry(arm * 2 + 0.4, 0.14, 0.14);
  a.translate(0, h - 0.2, 0);
  parts.push(a);
  return merge(THREE, parts);
}

function merge(THREE, parts) {
  // Minimal non-indexed merge, to avoid pulling BufferGeometryUtils here.
  const geos = parts.map((g) => (g.index ? g.toNonIndexed() : g));
  let count = 0;
  for (const g of geos) count += g.attributes.position.count;
  const pos = new Float32Array(count * 3), nor = new Float32Array(count * 3), uv = new Float32Array(count * 2);
  let o = 0;
  for (const g of geos) {
    pos.set(g.attributes.position.array, o * 3);
    nor.set(g.attributes.normal.array, o * 3);
    if (g.attributes.uv) uv.set(g.attributes.uv.array, o * 2);
    o += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return out;
}

/** Trees: a trunk and a crown, round or conical, each tinted a little. */
export function buildTrees(THREE, trees, M, tile = null) {
  const out = [];
  const leafy = trees.filter((t) => t.kind !== 'conifer');
  const conifer = trees.filter((t) => t.kind === 'conifer');
  const trunk = new THREE.CylinderGeometry(0.14, 0.22, 3.2, 4, 1, true);
  trunk.translate(0, 1.6, 0);
  const crown = new THREE.IcosahedronGeometry(2.7, 0);
  crown.scale(1, 0.9, 1);
  crown.translate(0, 4.8, 0);
  const cone = new THREE.ConeGeometry(2.3, 7.5, 6, 1, true);
  cone.translate(0, 5.2, 0);

  const place = (list, geo, mat, name, tint) => {
    if (!list.length) return;
    const mesh = new THREE.InstancedMesh(geo, mat, list.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(), p = new THREE.Vector3();
    const c = new THREE.Color();
    list.forEach((t, i) => {
      const h = hash01(Math.round(t.x * 10), Math.round(t.n * 10), 9);
      p.set(t.x, t.y - 0.1, -t.n);
      q.setFromEuler(e.set(0, h * Math.PI * 2, 0));
      s.set(t.s, t.s * (0.9 + h * 0.3), t.s);
      m.compose(p, q, s);
      mesh.setMatrixAt(i, m);
      if (tint) mesh.setColorAt(i, tint(c, h));
    });
    mesh.name = name;
    mesh.userData.zone = 'arbres';
    mesh.computeBoundingSphere();
    out.push(mesh);
  };
  place(trees, trunk, M.Bark, 'Arbres_troncs');
  place(leafy, crown, M.Leaves, 'Arbres_feuillus', (c, h) => c.setHSL(0.24 + h * 0.08, 0.35 + h * 0.2, 0.78 + h * 0.3));
  place(conifer, cone, M.Leaves_Dark, 'Arbres_coniferes', (c, h) => c.setHSL(0.3, 0.3, 0.8 + h * 0.25));
  for (const m of out) { m.userData.tile = tile; m.userData.layer = 'arbres'; m.userData.detail = true; }
  return out;
}
