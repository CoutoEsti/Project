// Neon signs as meshes, instanced per tile: a dark backing panel, a tube
// frame and a few tube "letters" in front of it, and the colour it throws on
// the wet sidewalk. One unit box stretched per piece: a thousand signs cost
// four draw calls per tile. A few signs buzz on and off.

import { hash01 } from '../map/geom.js';
import { groundTilt } from './props.js';

const TUBE = 0.07;        // tube thickness, metres

/**
 * @param signs  placeNeon() output for one tile
 * @param ground (x, n) → ground height, for the light spill
 */
export function buildNeon(THREE, signs, M, tile, ground) {
  const backs = [], tubes = [], buzz = [], pools = [];
  const push = (list, s, a, u, o, w, h, d, colour) => list.push({ s, a, u, o, w, h, d, colour });

  const awnings = [];
  for (const sg of signs) {
    if (sg.kind === 'awning') {
      // A slanted canvas: one flat box tipped down and out.
      awnings.push({ s: sg, a: 0, u: sg.h / 2, o: sg.d / 2, w: sg.w, h: 0.08, d: sg.d * 1.08, colour: sg.colour, tilt: 0.42 });
      continue;
    }
    const k = sg.h / 3.2;        // scale of details with the sign
    const t = TUBE * Math.max(1, sg.h / 1.5);
    const list = hash01(sg.seed * 7777, 17) < 0.06 ? buzz : tubes;
    if (sg.kind === 'blade') {
      // Sticks out of the wall: its width runs outward, its faces along.
      const cx = sg.w / 2;
      push(backs, sg, 0, sg.h / 2, cx, sg.d, sg.h, sg.w, null);
      // Bracket to the wall.
      push(backs, sg, 0, sg.h + 0.08, cx, 0.06, 0.08, sg.w + 0.2, null);
      for (const side of [1, -1]) {
        const a = side * (sg.d / 2 + t / 2);
        // Frame.
        push(list, sg, a, t / 2, cx, t, t, sg.w, sg.accent);
        push(list, sg, a, sg.h - t / 2, cx, t, t, sg.w, sg.accent);
        push(list, sg, a, sg.h / 2, t / 2 + 0.05, t, sg.h, t, sg.accent);
        push(list, sg, a, sg.h / 2, sg.w - t / 2 - 0.05, t, sg.h, t, sg.accent);
        // Letters stacked down the blade.
        const n = 2 + Math.floor(hash01(sg.seed * 311, 1) * 2);
        const step = (sg.h - 0.3) / n;
        for (let i = 0; i < n; i++) {
          const lw = sg.w * (0.35 + 0.35 * hash01(sg.seed * 17, i, 3));
          push(list, sg, a, sg.h - 0.15 - step * (i + 0.5), cx, t, step * 0.55, lw, sg.colour);
        }
      }
    } else {
      // Flat on the facade: band over a shop, or a name on a tower.
      const f = sg.d / 2 + t / 2;
      push(backs, sg, 0, sg.h / 2, 0, sg.w, sg.h, sg.d, null);
      push(list, sg, 0, t / 2, f, sg.w, t, t, sg.accent);
      push(list, sg, 0, sg.h - t / 2, f, sg.w, t, t, sg.accent);
      push(list, sg, -sg.w / 2 + t / 2, sg.h / 2, f, t, sg.h, t, sg.accent);
      push(list, sg, sg.w / 2 - t / 2, sg.h / 2, f, t, sg.h, t, sg.accent);
      // Letters: a word of blocks, some tall, some short, a gap or two.
      const n = Math.max(3, Math.min(7, Math.round(sg.w / (sg.h * 0.9))));
      const cell = (sg.w - 0.4 * k) / n;
      for (let i = 0; i < n; i++) {
        const r = hash01(sg.seed * 53, i, 5);
        if (r < 0.12) continue;
        const lh = sg.h * (r < 0.4 ? 0.34 : 0.56);
        const lw = cell * (r > 0.85 ? 0.35 : 0.62);
        push(list, sg, -sg.w / 2 + 0.2 * k + cell * (i + 0.5), sg.h / 2, f, lw, lh, t, sg.colour);
      }
      if (sg.kind === 'band') pools.push({ x: sg.x + sg.ox * 3.2, n: sg.n + sg.on * 3.2, r: Math.min(7, 2.5 + sg.w * 0.35), colour: sg.colour });
    }
    if (sg.kind === 'blade') pools.push({ x: sg.x + sg.ox * 2, n: sg.n + sg.on * 2, r: 4.5, colour: sg.colour });
  }

  const box = new THREE.BoxGeometry(1, 1, 1);
  const out = [];
  const mk = (list, mat, name, colours) => {
    if (!list.length) return;
    const mesh = new THREE.InstancedMesh(box, mat, list.length);
    const m = new THREE.Matrix4(), p = new THREE.Vector3(), sc = new THREE.Vector3();
    const O = new THREE.Vector3(), U = new THREE.Vector3(0, 1, 0), A = new THREE.Vector3();
    const c = new THREE.Color();
    const tilt = new THREE.Matrix4();
    list.forEach((it, i) => {
      const s = it.s;
      O.set(s.ox, 0, -s.on);
      A.set(O.z, 0, -O.x);                 // U × O: a right-handed frame
      m.makeBasis(A, U, O);
      if (it.tilt) m.multiply(tilt.makeRotationX(it.tilt));
      p.set(s.x, s.y, -s.n).addScaledVector(A, it.a).addScaledVector(U, it.u).addScaledVector(O, it.o);
      m.scale(sc.set(it.w, it.h, it.d));
      m.setPosition(p);
      mesh.setMatrixAt(i, m);
      if (colours) mesh.setColorAt(i, c.set(it.colour));
    });
    mesh.name = `${name}_${tile}`;
    mesh.computeBoundingSphere();
    out.push(mesh);
  };
  mk(backs, M.Neon_Back, 'Enseignes');
  mk(awnings, M.Awning, 'Auvents', true);
  mk(tubes, M.Neon, 'Neons', true);
  mk(buzz, M.Neon_Buzz, 'Neons_clignotants', true);

  if (pools.length) {
    const g = new THREE.PlaneGeometry(2, 2);
    g.rotateX(-Math.PI / 2);
    const mesh = new THREE.InstancedMesh(g, M.Neon_Pool, pools.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3();
    const c = new THREE.Color();
    pools.forEach((pl, i) => {
      p.set(pl.x, ground(pl.x, pl.n) + 0.2, -pl.n);
      groundTilt(THREE, ground, pl.x, pl.n, q);
      m.compose(p, q, sc.set(pl.r, 1, pl.r));
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, c.set(pl.colour));
    });
    mesh.name = `Flaques_neon_${tile}`;
    mesh.userData.exportSkip = true;      // a lighting trick, not geometry
    mesh.renderOrder = 2;
    mesh.computeBoundingSphere();
    out.push(mesh);
  }
  for (const o of out) { o.userData.tile = tile; o.userData.layer = 'neons'; o.userData.detail = true; }
  return out;
}
