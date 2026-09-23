// The landmarks, as parametric models. OpenStreetMap gives a footprint and a
// height; these give the silhouette you recognise from the highway at night:
// Place Ville Marie's searchlights, the cross on the mountain, the Stadium's
// leaning tower, the Five Roses sign.
//
// Local frame: metres, +Y up, the front faces -Z; the model is then turned to
// its `heading` (clockwise from Montréal north) and set on the ground.

import { textPanel, hasCanvas } from './textures.js';
import { mergeStatic } from './builder.js';
import { hash01, rng, convexHull } from '../map/geom.js';

export function buildLandmarks(THREE, map, layout, M) {
  const out = [];
  const animated = [];
  const ctx = { THREE, M, animated, canvas: hasCanvas() };
  for (const lm of map.landmarks) {
    const make = MODELS[lm.type];
    if (!make) continue;
    const g = make(ctx, lm);
    if (!g) continue;
    mergeStatic(THREE, g);
    const y = lm.ground ?? groundAt(layout, lm.x, lm.n);
    g.position.set(lm.x, y, -lm.n);
    g.rotation.y = (-(lm.heading || 0) * Math.PI) / 180;
    g.name = lm.name;
    g.userData.zone = 'reperes';
    g.userData.landmark = lm.id;
    g.traverse((o) => { if (o.isMesh) { o.matrixAutoUpdate = !o.userData.animated; o.updateMatrix(); } });
    out.push(g);
  }
  return { objects: out, animated };
}

/**
 * What a car hits at each landmark, derived from the model itself so the
 * collision follows it when the model changes: every triangle is sampled
 * about every metre, the samples inside the band a car occupies (0.35 to 4 m
 * over the base) mark 2 m cells, and each connected group of cells becomes
 * one convex outline. The stadium's tower counts by its foot, not by its
 * leaning top; the coaster's supports stay separate posts; a paved plaza
 * lower than 0.35 m stays open.
 * @returns [{ id, ring: [[x, n]], y0, y1 }]
 */
export function landmarkFootprints(THREE, objects) {
  const CELL = 2;
  const out = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const m = new THREE.Matrix4(), mi = new THREE.Matrix4();
  for (const g of objects) {
    g.updateMatrixWorld(true);
    const base = g.position.y, lo = base + 0.35, hi = base + 4;
    const cells = new Map();
    let top = base;
    const mark = (x, y, z) => {
      if (y < lo || y > hi) return;
      const i = Math.floor(x / CELL), j = Math.floor(-z / CELL);
      cells.set(`${i},${j}`, [i, j]);
    };
    g.traverse((o) => {
      if (!o.isMesh) return;
      const pos = o.geometry.attributes.position, index = o.geometry.index;
      const tris = (index ? index.count : pos.count) / 3;
      const copies = o.isInstancedMesh ? o.count : 1;
      for (let k = 0; k < copies; k++) {
        if (o.isInstancedMesh) { o.getMatrixAt(k, mi); m.multiplyMatrices(o.matrixWorld, mi); } else m.copy(o.matrixWorld);
        for (let t = 0; t < tris; t++) {
          const at = (q) => (index ? index.getX(t * 3 + q) : t * 3 + q);
          a.fromBufferAttribute(pos, at(0)).applyMatrix4(m);
          b.fromBufferAttribute(pos, at(1)).applyMatrix4(m);
          c.fromBufferAttribute(pos, at(2)).applyMatrix4(m);
          top = Math.max(top, a.y, b.y, c.y);
          if (Math.max(a.y, b.y, c.y) < lo || Math.min(a.y, b.y, c.y) > hi) continue;
          // Barycentric samples no more than a metre apart.
          const steps = Math.min(400, Math.ceil(Math.max(a.distanceTo(b), b.distanceTo(c), c.distanceTo(a)) / 1));
          for (let u = 0; u <= steps; u++) {
            for (let w = 0; w <= steps - u; w++) {
              const U = u / steps, W = w / steps, V = 1 - U - W;
              mark(a.x * V + b.x * U + c.x * W, a.y * V + b.y * U + c.y * W, a.z * V + b.z * U + c.z * W);
            }
          }
        }
      }
    });
    // Connected groups of cells (8-neighbourhood), one outline each.
    const seen = new Set();
    for (const [key, cell] of cells) {
      if (seen.has(key)) continue;
      const pts = [];
      const stack = [cell];
      seen.add(key);
      while (stack.length) {
        const [i, j] = stack.pop();
        pts.push([i * CELL, j * CELL], [(i + 1) * CELL, j * CELL], [(i + 1) * CELL, (j + 1) * CELL], [i * CELL, (j + 1) * CELL]);
        for (let di = -1; di <= 1; di++) {
          for (let dj = -1; dj <= 1; dj++) {
            const k2 = `${i + di},${j + dj}`;
            if (!seen.has(k2) && cells.has(k2)) { seen.add(k2); stack.push(cells.get(k2)); }
          }
        }
      }
      out.push({ id: g.userData.landmark, ring: convexHull(pts), y0: base - 0.5, y1: top });
    }
  }
  return out;
}

function groundAt(layout, x, n) {
  return layout.terrain.inside(x, n) ? layout.terrain.height(x, n) : 0.15;
}

// ------------------------------------------------------------- helpers --

function box(ctx, w, h, d, mat, x = 0, y = 0, z = 0, name) {
  const m = new ctx.THREE.Mesh(new ctx.THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y + h / 2, z);
  if (name) m.name = name;
  return m;
}

function cyl(ctx, r0, r1, h, mat, x = 0, y = 0, z = 0, seg = 16) {
  const m = new ctx.THREE.Mesh(new ctx.THREE.CylinderGeometry(r1, r0, h, seg), mat);
  m.position.set(x, y + h / 2, z);
  return m;
}

function group(ctx, ...children) {
  const g = new ctx.THREE.Group();
  for (const c of children.flat()) if (c) g.add(c);
  return g;
}

/** A prism from a ring in local (x, z) and a height, with facade UVs. */
function prism(ctx, ring, y0, y1, mat, bay = 3, floorH = 3.6) {
  const { THREE } = ctx;
  const pos = [], nor = [], uv = [], idx = [];
  let k = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz);
    // Ring counter-clockwise seen from above (x right, -z up): outward normal.
    const nx = -dz / len, nz = dx / len;
    const bays = Math.max(1, Math.round(len / bay)), floors = (y1 - y0) / floorH;
    pos.push(a[0], y0, a[1], b[0], y0, b[1], b[0], y1, b[1], a[0], y1, a[1]);
    for (let j = 0; j < 4; j++) nor.push(nx, 0, nz);
    uv.push(0, 0, bays, 0, bays, floors, 0, floors);
    idx.push(k, k + 1, k + 2, k, k + 2, k + 3);
    k += 4;
  }
  // Roof.
  const shape = new THREE.Shape(ring.map(([x, z]) => new THREE.Vector2(x, -z)));
  const tri = THREE.ShapeUtils.triangulateShape(shape.getPoints(), []);
  const pts = shape.getPoints();
  const base = k;
  for (const p of pts) { pos.push(p.x, y1, -p.y); nor.push(0, 1, 0); uv.push(p.x, p.y); k++; }
  for (const [a, b, c] of tri) {
    // Counter-clockwise in (x, n) faces up; flip anything that is not.
    const A = pts[a], B = pts[b], C = pts[c];
    const cross = (B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x);
    if (cross >= 0) idx.push(base + a, base + b, base + c); else idx.push(base + a, base + c, base + b);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return new THREE.Mesh(g, mat);
}

/** Facade-atlas material for a landmark: a clone that ignores per-building attributes. */
function facadeLike(ctx, facade) {
  // The atlas shader needs per-vertex attributes; landmarks use plain PBR
  // stand-ins with an emissive window grid texture instead.
  const { THREE, M } = ctx;
  const key = 'LM_' + facade;
  if (M[key]) return M[key];
  const colours = { glass_silver: 0x7d8a94, glass_blue: 0x2f4a63, stone: 0x9d978a, concrete: 0x8f8c86, glass_dark: 0x1e262d };
  const m = new THREE.MeshStandardMaterial({ color: colours[facade] || 0x888888, roughness: 0.35, metalness: 0.45, name: key });
  if (ctx.canvas) {
    m.emissiveMap = windowGrid(THREE, facade);
    m.emissive = new THREE.Color(0xffc98a);
    m.emissiveIntensity = 1.1;
  }
  M[key] = m;
  return m;
}

function windowGrid(THREE, seedKey) {
  const W = 256, H = 512;
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H });
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);
  const R = rng(seedKey.length * 131);
  const cols = 16, rows = 32;
  for (let j = 0; j < rows; j++) {
    const floorLit = R() < 0.45;
    for (let i = 0; i < cols; i++) {
      if (!(floorLit ? R() < 0.85 : R() < 0.08)) continue;
      const v = 0.5 + R() * 0.5;
      g.fillStyle = `rgba(255,255,255,${v})`;
      g.fillRect(i * (W / cols) + 2, j * (H / rows) + 3, W / cols - 4, H / rows - 6);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  // UVs count bays and floors: one repeat covers 16 bays and 32 floors.
  t.repeat.set(1 / 16, 1 / 32);
  return t;
}

function lit(ctx, hex, strength) {
  const key = 'Glow_' + hex.toString(16) + '_' + strength;
  if (!ctx.M[key]) {
    const m = new ctx.THREE.MeshBasicMaterial({ color: new ctx.THREE.Color(hex).multiplyScalar(strength) });
    m.name = key;
    ctx.M[key] = m;
  }
  return ctx.M[key];
}

function textSign(ctx, lines, w, h, opts) {
  const { THREE } = ctx;
  if (!ctx.canvas) return null;
  const t = textPanel(THREE, lines, opts);
  const m = new THREE.MeshBasicMaterial({ map: t, transparent: !!opts.transparent, name: 'Enseigne', side: THREE.DoubleSide,
    color: new THREE.Color(opts.glow || 0xffffff).multiplyScalar(opts.strength || 1) });
  return new THREE.Mesh(new THREE.PlaneGeometry(w, h), m);
}

// -------------------------------------------------------------- models --

const MODELS = {
  // Place Ville Marie: a cruciform tower, and the four searchlights sweeping
  // the sky from its roof — the most recognisable thing in the night skyline.
  pvm(ctx, lm) {
    const { THREE } = ctx;
    const a = 13, L = 38, H = 188;
    const ring = [[-a, -L], [a, -L], [a, -a], [L, -a], [L, a], [a, a], [a, L], [-a, L], [-a, a], [-L, a], [-L, -a], [-a, -a]];
    const tower = prism(ctx, ring.slice().reverse(), 0, H, facadeLike(ctx, 'glass_silver'), 3.2, 3.9);
    const plaza = box(ctx, 110, 0.6, 110, ctx.M.Plaza, 0, 0, 0);
    const beacon = new THREE.Group();
    beacon.position.y = H + 2;
    for (let i = 0; i < 4; i++) {
      // Apex at the lamp, widening outwards and upwards.
      const cone = new THREE.ConeGeometry(30, 900, 12, 1, true);
      cone.rotateX(Math.PI);
      cone.translate(0, 450, 0);
      const beam = new THREE.Mesh(cone, ctx.M.Beacon);
      beam.rotation.z = -0.95;
      const arm = new THREE.Group();
      arm.rotation.y = (i * Math.PI) / 2;
      arm.add(beam);
      beacon.add(arm);
    }
    beacon.userData.animated = true;
    ctx.animated.push({ object: beacon, update: (t) => { beacon.rotation.y = t * 0.25; } });
    const lamps = box(ctx, 8, 3, 8, lit(ctx, 0xfff1d0, 2.5), 0, H, 0);
    return group(ctx, plaza, tower, lamps, beacon);
  },

  // 1000 De La Gauchetière: the tallest, under its green copper pyramid.
  gauchetiere(ctx) {
    const s = 22, c = 7;
    const ring = [[-s + c, -s], [s - c, -s], [s, -s + c], [s, s - c], [s - c, s], [-s + c, s], [-s, s - c], [-s, -s + c]];
    const shaft = prism(ctx, ring.slice().reverse(), 0, 176, facadeLike(ctx, 'glass_blue'), 3.2, 3.9);
    const roof = new ctx.THREE.Mesh(new ctx.THREE.ConeGeometry(s * 1.2, 30, 4), ctx.M.Copper);
    roof.position.y = 176 + 15;
    roof.rotation.y = Math.PI / 4;
    const spire = cyl(ctx, 0.6, 0.2, 14, ctx.M.Metal, 0, 206);
    const tip = box(ctx, 1.2, 1.2, 1.2, lit(ctx, 0xff3b30, 3), 0, 219.5, 0);
    return group(ctx, shaft, roof, spire, tip);
  },

  // Centre Bell: a long box with a glass front.
  arena(ctx) {
    // Sized to its block (Crescent to Peel, Saint-Antoine to René-Lévesque),
    // not to the real building: the compressed grid leaves 126 m.
    const body = box(ctx, 116, 30, 108, ctx.M.Concrete_Dark, 0, 0, 0);
    const front = box(ctx, 108, 26, 2, ctx.M.Glass, 0, 2, -55);
    const band = box(ctx, 110, 2, 2.4, lit(ctx, 0xd81e2c, 3), 0, 27, -55.5);
    const roof = box(ctx, 112, 3, 104, ctx.M.Metal, 0, 30, 0);
    return group(ctx, body, front, band, roof);
  },

  // Notre-Dame Basilica: twin towers on the square, nave behind, floodlit.
  basilica(ctx) {
    // Notre-Dame to Saint-Paul is 64 m here: the nave is shortened to fit.
    const stone = ctx.M.Stone_Dark;
    const nave = box(ctx, 36, 26, 44, stone, 0, 0, 8);
    const roof = gableRoof(ctx, 36, 12, 44, ctx.M.Copper, 0, 26, 8);
    const towers = [-14, 14].map((x) => group(ctx,
      box(ctx, 12, 62, 12, stone, x, 0, -18),
      pyramid(ctx, 12, 8, ctx.M.Copper, x, 62, -18)));
    const front = box(ctx, 16, 30, 4, stone, 0, 0, -22);
    const rose = new ctx.THREE.Mesh(new ctx.THREE.CircleGeometry(4.5, 20), lit(ctx, 0x3d6bff, 2.2));
    rose.position.set(0, 21, -24.1);
    rose.rotation.y = Math.PI;
    const arches = [-6, 0, 6].map((x) => box(ctx, 3.6, 8, 0.4, lit(ctx, 0xffc27a, 1.4), x, 0.5, -24.2));
    const flood = box(ctx, 44, 0.3, 6, lit(ctx, 0xffd9a0, 0.6), 0, 0, -26);
    return group(ctx, nave, roof, towers, front, rose, arches, flood);
  },

  // City hall: Second Empire, mansard and central tower.
  cityhall(ctx) {
    const s = ctx.M.Stone;
    const body = box(ctx, 90, 20, 34, s, 0, 0, 0);
    const mans = mansardRoof(ctx, 90, 34, 7, ctx.M.Copper, 20);
    const tower = group(ctx, box(ctx, 14, 44, 14, s, 0, 0, -4), pyramid(ctx, 15, 10, ctx.M.Copper, 0, 44, -4));
    const flag = cyl(ctx, 0.15, 0.1, 10, ctx.M.Metal, 0, 54, -4, 6);
    return group(ctx, body, mans, tower, flag);
  },

  // Marché Bonsecours: a long neoclassical hall and its silver dome.
  bonsecours(ctx) {
    const body = box(ctx, 94, 15, 22, ctx.M.Stone, 0, 0, 0);
    const roof = gableRoof(ctx, 94, 5, 22, ctx.M.Metal_Dark, 0, 15, 0, true);
    const drum = cyl(ctx, 8, 8, 8, ctx.M.Stone, 0, 17);
    const dome = new ctx.THREE.Mesh(new ctx.THREE.SphereGeometry(8.5, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), ctx.M.Metal);
    dome.position.y = 25;
    const portico = [-6, -2, 2, 6].map((x) => cyl(ctx, 0.8, 0.8, 12, ctx.M.White, x, 0, -12.5, 8));
    return group(ctx, body, roof, drum, dome, portico);
  },

  // Clock tower at the end of its pier, clock faces lit.
  clocktower(ctx) {
    const t = group(ctx, box(ctx, 9, 38, 9, ctx.M.White, 0, 0, 0), pyramid(ctx, 10, 6, ctx.M.Copper, 0, 38, 0));
    for (let i = 0; i < 4; i++) {
      const face = new ctx.THREE.Mesh(new ctx.THREE.CircleGeometry(2.6, 20), lit(ctx, 0xfff4dc, 1.6));
      const a = (i * Math.PI) / 2;
      face.position.set(Math.sin(a) * 4.62, 32, Math.cos(a) * 4.62);
      face.rotation.y = a;
      t.add(face);
    }
    return t;
  },

  // La Grande Roue: 60 m, turning slowly, lit rim.
  wheel(ctx) {
    const { THREE } = ctx;
    const R = 28, hub = R + 4;
    const wheel = new THREE.Group();
    wheel.position.y = hub;
    const rim = new THREE.Mesh(new THREE.TorusGeometry(R, 0.45, 6, 64), lit(ctx, 0x7fd4ff, 2.2));
    wheel.add(rim);
    const rim2 = rim.clone();
    rim2.position.z = 3;
    wheel.add(rim2);
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.3, R, 0.3), ctx.M.Metal);
      spoke.position.set(Math.cos(a) * R / 2, Math.sin(a) * R / 2, 1.5);
      spoke.rotation.z = a - Math.PI / 2;
      wheel.add(spoke);
      const cab = new THREE.Mesh(new THREE.BoxGeometry(2.6, 2.6, 2.6), ctx.M.White);
      cab.position.set(Math.cos(a) * R, Math.sin(a) * R - 1.6, 1.5);
      wheel.add(cab);
    }
    wheel.userData.animated = true;
    ctx.animated.push({ object: wheel, update: (t) => { wheel.rotation.z = t * 0.04; } });
    const legs = [-1, 1].map((s) => {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(1, hub + 2, 1), ctx.M.Metal);
      leg.position.set(s * 9, hub / 2, 1.5);
      leg.rotation.z = s * 0.28;
      return leg;
    });
    return group(ctx, wheel, legs, box(ctx, 30, 4, 12, ctx.M.Concrete, 0, 0, 1.5));
  },

  // Silo No. 5: a row of grain bins and the tall head house.
  silo(ctx) {
    const parts = [];
    // Six bins a row: the silo stands between the canal and Wellington.
    for (let i = 0; i < 6; i++) parts.push(cyl(ctx, 5, 5, 36, ctx.M.Concrete, 0, 0, -40 + i * 10.2, 14));
    for (let i = 0; i < 6; i++) parts.push(cyl(ctx, 5, 5, 36, ctx.M.Concrete, 10.2, 0, -40 + i * 10.2, 14));
    parts.push(box(ctx, 22, 58, 20, ctx.M.Concrete, 5, 0, 26));
    parts.push(box(ctx, 4, 4, 80, ctx.M.Concrete_Dark, 5, 40, -5));
    return group(ctx, parts);
  },

  // Farine Five Roses: the red neon sign on its steel frame over the mill.
  fiveroses(ctx) {
    const mill = box(ctx, 60, 30, 24, ctx.M.Brick, 0, 0, 0);
    const frame = box(ctx, 44, 16, 0.8, ctx.M.Metal_Dark, 0, 30, 0);
    const parts = [mill, frame];
    const sign = textSign(ctx, ['FARINE', 'FIVE ROSES'], 42, 15, {
      bg: 'rgba(0,0,0,0)', fg: '#ff3b2a', width: 1024, height: 360, border: false, transparent: true, glow: 0xffffff, strength: 3.2, weight: 800,
    });
    if (sign) {
      sign.position.set(0, 38.2, -0.6);
      sign.rotation.y = Math.PI;
      parts.push(sign);
    } else {
      parts.push(box(ctx, 40, 12, 0.4, ctx.M.Neon_Red, 0, 32, -0.6));
    }
    return group(ctx, parts);
  },

  // Habitat 67: concrete boxes stacked in stepped, staggered piles.
  habitat(ctx, lm) {
    const R = rng(67);
    const parts = [];
    const mat = ctx.M.Concrete;
    const clusters = [[-45, 0, 9], [0, 10, 12], [45, -5, 8]];
    for (const [cx, cz, levels] of clusters) {
      for (let lv = 0; lv < levels; lv++) {
        const count = Math.max(1, Math.round((levels - lv) * 1.6));
        for (let k = 0; k < count; k++) {
          const rot = R() < 0.5;
          const w = rot ? 5.3 : 11.7, d = rot ? 11.7 : 5.3;
          const x = cx + (R() - 0.5) * (levels - lv) * 6;
          const z = cz + (R() - 0.5) * (levels - lv) * 5;
          parts.push(box(ctx, w, 3, d, mat, x, lv * 3, z));
          if (R() < 0.35) parts.push(box(ctx, w * 0.6, 1.6, 0.1, lit(ctx, 0xffc98a, 1.2), x, lv * 3 + 0.7, z - d / 2 - 0.06));
        }
      }
    }
    return group(ctx, parts);
  },

  // Biosphère: Buckminster Fuller's sphere, struts only, lit faintly blue.
  biosphere(ctx) {
    const { THREE } = ctx;
    const R = 38;
    const ico = new THREE.IcosahedronGeometry(R, 4);
    const pos = ico.attributes.position;
    const edges = new Map();
    for (let i = 0; i < pos.count; i += 3) {
      for (const [a, b] of [[i, i + 1], [i + 1, i + 2], [i + 2, i]]) {
        const pa = new THREE.Vector3().fromBufferAttribute(pos, a), pb = new THREE.Vector3().fromBufferAttribute(pos, b);
        if (pa.y < -R * 0.45 && pb.y < -R * 0.45) continue;
        const key = [pa, pb].map((p) => p.toArray().map((v) => v.toFixed(2)).join(',')).sort().join('|');
        if (!edges.has(key)) edges.set(key, [pa, pb]);
      }
    }
    const strut = new THREE.BoxGeometry(0.35, 0.35, 1);
    const mesh = new THREE.InstancedMesh(strut, ctx.M.Metal, edges.size);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    let i = 0;
    for (const [a, b] of edges.values()) {
      p.copy(a).add(b).multiplyScalar(0.5);
      const dir = new THREE.Vector3().subVectors(b, a);
      s.set(1, 1, dir.length());
      q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.normalize());
      m.compose(p, q, s);
      mesh.setMatrixAt(i++, m);
    }
    mesh.position.y = R * 0.45;
    const glow = new THREE.Mesh(new THREE.SphereGeometry(R * 0.97, 24, 16), lit(ctx, 0x3a6cff, 0.35));
    glow.material = glow.material.clone();
    glow.material.transparent = true;
    glow.material.opacity = 0.35;
    glow.material.side = THREE.BackSide;
    glow.material.depthWrite = false;
    glow.position.y = R * 0.45;
    return group(ctx, mesh, glow);
  },

  // La Ronde: a coaster loop on stilts.
  coaster(ctx) {
    const { THREE } = ctx;
    const pts = [];
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const r = 60 + 15 * Math.sin(a * 3);
      const h = 6 + 30 * Math.max(0, Math.sin(a)) ** 3 + 8 * Math.max(0, Math.sin(a * 2 + 1));
      pts.push(new THREE.Vector3(Math.cos(a) * r, h, Math.sin(a) * r * 0.7));
    }
    const curve = new THREE.CatmullRomCurve3(pts, true);
    const track = new THREE.Mesh(new THREE.TubeGeometry(curve, 240, 0.7, 5, true), lit(ctx, 0xff6ec7, 1.6));
    const parts = [track];
    for (let i = 0; i < 80; i++) {
      const p = curve.getPoint(i / 80);
      parts.push(box(ctx, 0.5, p.y, 0.5, ctx.M.Wood, p.x, 0, p.z));
    }
    return group(ctx, parts);
  },

  // Casino: the old French pavilion's stacked, flaring plates, lit gold.
  casino(ctx) {
    const parts = [];
    const gold = lit(ctx, 0xffb347, 0.8);
    for (let i = 0; i < 6; i++) {
      const w = 46 + i * 7;
      parts.push(box(ctx, w, 7.5, w * 0.8, i % 2 ? ctx.M.Glass : ctx.M.Metal, 0, i * 8, 0));
      parts.push(box(ctx, w + 1, 0.4, 0.4, gold, 0, i * 8 + 7.5, -(w * 0.8 + 1) / 2));
    }
    return group(ctx, parts);
  },

  // The Wall of Champions, at the exit of the last chicane.
  championswall(ctx) {
    const wall = box(ctx, 30, 1.4, 0.8, ctx.M.Concrete, 0, 0, 0);
    const parts = [wall];
    const sign = textSign(ctx, ['BIENVENUE AU QUÉBEC'], 28, 1.2, { bg: '#f2f2f2', fg: '#1a1a1a', width: 1024, height: 64, border: false, weight: 800 });
    if (sign) {
      sign.position.set(0, 0.75, -0.42);
      sign.rotation.y = Math.PI;
      sign.material.color.setScalar(0.7);
      parts.push(sign);
    }
    return group(ctx, parts);
  },

  // Olympic Stadium: the ribbed bowl, the membrane roof, and the leaning
  // tower — 165 m at 45°, the tallest inclined tower in the world.
  stadium(ctx) {
    const { THREE } = ctx;
    const parts = [];
    const A = 150, B = 125;                 // outer half-axes
    // The bowl: a lathe of an ellipse profile, squashed on z.
    const prof = [];
    for (let i = 0; i <= 10; i++) {
      const t = i / 10;
      prof.push(new THREE.Vector2(1 - 0.28 * t * t, t * 46));
    }
    prof.push(new THREE.Vector2(0.62, 50));
    const bowl = new THREE.Mesh(new THREE.LatheGeometry(prof, 48), ctx.M.Concrete);
    bowl.scale.set(A, 1, B);
    parts.push(bowl);
    // The ribs: 34 concrete consoles rising from the ground to the rim.
    for (let i = 0; i < 34; i++) {
      const a = (i / 34) * Math.PI * 2;
      const rib = new THREE.Group();
      for (let k = 0; k < 6; k++) {
        const t = k / 6;
        const seg = box(ctx, 3, 9, 4, ctx.M.Concrete, 0, 0, 0);
        const r = 1.04 - 0.3 * t * t;
        seg.position.set(Math.cos(a) * A * r, t * 46, Math.sin(a) * B * r);
        seg.rotation.y = -a;
        rib.add(seg);
      }
      parts.push(rib);
    }
    // The roof membrane over the opening.
    const roof = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 8, 0, Math.PI * 2, 0, Math.PI / 5), ctx.M.White);
    roof.scale.set(A * 0.66, 30, B * 0.66);
    roof.position.y = 26;
    parts.push(roof);
    const glow = new THREE.Mesh(new THREE.TorusGeometry(1, 0.012, 4, 64), lit(ctx, 0xffffff, 1.6));
    glow.rotation.x = Math.PI / 2;
    glow.scale.set(A * 0.62, B * 0.62, 1);
    glow.position.y = 50;
    parts.push(glow);
    // The tower: sections along a curve leaning over the bowl from the west.
    const tower = new THREE.Group();
    const base = new THREE.Vector3(-A - 20, 0, 0);
    for (let k = 0; k < 18; k++) {
      const t = k / 18, t2 = (k + 1) / 18;
      const p0 = towerPoint(base, t), p1 = towerPoint(base, t2);
      const len = p0.distanceTo(p1);
      const w = 26 - 14 * t;
      const seg = new THREE.Mesh(new THREE.BoxGeometry(w, len + 0.6, w * 0.8), ctx.M.Concrete);
      seg.position.copy(p0).add(p1).multiplyScalar(0.5);
      seg.lookAt(p1);
      seg.rotateX(Math.PI / 2);
      tower.add(seg);
    }
    const top = towerPoint(base, 1);
    const obs = new THREE.Mesh(new THREE.BoxGeometry(22, 12, 18), ctx.M.Glass);
    obs.position.copy(top).add(new THREE.Vector3(-3, -8, 0));
    tower.add(obs);
    const obsGlow = box(ctx, 22.4, 1.5, 18.4, lit(ctx, 0xfff0d2, 2.2), 0, 0, 0);
    obsGlow.position.copy(obs.position).add(new THREE.Vector3(0, 2, 0));
    tower.add(obsGlow);
    const beacon = box(ctx, 2, 2, 2, lit(ctx, 0xff2b2b, 3), 0, 0, 0);
    beacon.position.copy(top).add(new THREE.Vector3(0, 2, 0));
    tower.add(beacon);
    // Cables from the tower to the roof.
    for (let i = 0; i < 8; i++) {
      const a = -0.6 + (i / 7) * 1.2;
      const end = new THREE.Vector3(Math.cos(a) * A * 0.3 - 20, 40, Math.sin(a) * B * 0.45);
      const from = towerPoint(base, 0.78);
      const len = from.distanceTo(end);
      const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, len, 4), ctx.M.Metal_Dark);
      cable.position.copy(from).add(end).multiplyScalar(0.5);
      cable.lookAt(end);
      cable.rotateX(Math.PI / 2);
      tower.add(cable);
    }
    parts.push(tower);
    return group(ctx, parts);
  },

  // Biodôme (the old velodrome): a shell of scalloped roof.
  biodome(ctx) {
    const { THREE } = ctx;
    const g = new THREE.SphereGeometry(1, 48, 10, 0, Math.PI * 2, 0, Math.PI / 2);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const a = Math.atan2(z, x);
      p.setY(i, y * (0.85 + 0.15 * Math.cos(a * 6)));
    }
    g.computeVertexNormals();
    const shell = new THREE.Mesh(g, ctx.M.Concrete);
    shell.scale.set(80, 26, 62);
    const glass = box(ctx, 120, 6, 1, ctx.M.Glass, 0, 0, -58);
    return group(ctx, shell, glass);
  },

  // The cross on Mount Royal: 31 m of lattice, lit white, seen from the whole
  // island. Built from lit bars so it reads at night from 3 km away.
  cross(ctx) {
    const white = lit(ctx, 0xf4f7ff, 1.35);
    return group(ctx,
      box(ctx, 6, 2, 6, ctx.M.Concrete, 0, 0, 0),
      box(ctx, 2.2, 31, 2.2, white, 0, 2, 0),
      box(ctx, 11, 2.2, 2.2, white, 0, 23, 0));
  },

  // Chalet du Mont-Royal and the Kondiaronk lookout terrace.
  chalet(ctx) {
    const body = box(ctx, 52, 11, 18, ctx.M.Stone, 0, 0, 0);
    const roof = gableRoof(ctx, 54, 6, 20, ctx.M.Metal_Dark, 0, 11, 0);
    const terrace = box(ctx, 90, 0.6, 40, ctx.M.Plaza, 0, -0.3, -30);
    const rail = box(ctx, 90, 1.1, 0.3, ctx.M.Stone, 0, 0.3, -50);
    const windows = box(ctx, 44, 4, 0.2, lit(ctx, 0xffc98a, 1.1), 0, 3, -9.2);
    return group(ctx, body, roof, terrace, rail, windows);
  },

  // Saint Joseph's Oratory: the dome, second largest of its kind, on its
  // terraces above Queen-Mary.
  oratory(ctx) {
    const { THREE } = ctx;
    const stone = ctx.M.Stone;
    const body = box(ctx, 56, 36, 100, stone, 0, 0, 0);
    const roof = gableRoof(ctx, 56, 10, 100, ctx.M.Copper, 0, 36, 0);
    const drum = cyl(ctx, 21, 21, 16, stone, 0, 40, 6, 24);
    const dome = new THREE.Mesh(new THREE.SphereGeometry(21, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), ctx.M.Copper);
    dome.position.set(0, 56, 6);
    dome.scale.y = 1.3;
    const lantern = cyl(ctx, 3, 3, 8, stone, 0, 83, 6, 12);
    const cross = box(ctx, 0.8, 8, 0.8, ctx.M.Metal, 0, 91, 6);
    const portico = [-15, -9, -3, 3, 9, 15].map((x) => cyl(ctx, 1.4, 1.4, 22, ctx.M.White, x, 0, -52, 10));
    const terraces = [0, 1, 2, 3, 4].map((k) => box(ctx, 80 - k * 8, 3, 14, stone, 0, -3 * (k + 1), -60 - k * 14));
    const flood = box(ctx, 40, 20, 0.3, lit(ctx, 0xffd9a0, 0.5), 0, 4, -50.5);
    return group(ctx, body, roof, drum, dome, lantern, cross, portico, terraces, flood);
  },

  // Marché Jean-Talon: three long open sheds.
  market(ctx) {
    const parts = [];
    for (const z of [-24, 0, 24]) {
      parts.push(gableRoof(ctx, 100, 3, 16, ctx.M.Metal_Green, 0, 5, z));
      for (let x = -48; x <= 48; x += 8) {
        parts.push(box(ctx, 0.4, 5, 0.4, ctx.M.Metal_Dark, x, 0, z - 7.5));
        parts.push(box(ctx, 0.4, 5, 0.4, ctx.M.Metal_Dark, x, 0, z + 7.5));
      }
      parts.push(box(ctx, 96, 0.3, 14, lit(ctx, 0xffd08a, 0.5), 0, 4.6, z));
    }
    return group(ctx, parts);
  },

  // Marché Atwater: art deco hall and its clock tower on the canal.
  atwater(ctx) {
    const hall = box(ctx, 110, 12, 28, ctx.M.Brick, 0, 0, 0);
    const tower = group(ctx, box(ctx, 10, 40, 10, ctx.M.Stone, 0, 0, -8), box(ctx, 6, 6, 6, ctx.M.Stone, 0, 40, -8));
    const clock = box(ctx, 5, 5, 0.3, lit(ctx, 0xfff4dc, 1.4), 0, 32, -13.2);
    const sign = box(ctx, 30, 1.6, 0.3, lit(ctx, 0xff5a3a, 2.4), 0, 13, -14.2);
    return group(ctx, hall, tower, clock, sign);
  },
};

function towerPoint(base, t) {
  // A curve that leaves the ground at ~60° and ends leaning at ~45° over the
  // bowl, 165 m along.
  const x = base.x + 118 * t + 12 * t * t;
  const y = 150 * t - 18 * t * t + 30 * t * (1 - t);
  return new base.constructor(x, y, 0);
}

function pyramid(ctx, w, h, mat, x = 0, y = 0, z = 0) {
  const m = new ctx.THREE.Mesh(new ctx.THREE.ConeGeometry(w / Math.SQRT2, h, 4), mat);
  m.position.set(x, y + h / 2, z);
  m.rotation.y = Math.PI / 4;
  return m;
}

function gableRoof(ctx, w, h, d, mat, x = 0, y = 0, z = 0, alongX = false) {
  // A triangular prism: ridge along z (or x).
  const { THREE } = ctx;
  const shape = new THREE.Shape([new THREE.Vector2(-w / 2, 0), new THREE.Vector2(w / 2, 0), new THREE.Vector2(0, h)]);
  let geo;
  if (alongX) {
    const s2 = new THREE.Shape([new THREE.Vector2(-d / 2, 0), new THREE.Vector2(d / 2, 0), new THREE.Vector2(0, h)]);
    geo = new THREE.ExtrudeGeometry(s2, { depth: w, bevelEnabled: false });
    geo.translate(0, 0, -w / 2);
    geo.rotateY(Math.PI / 2);
  } else {
    geo = new THREE.ExtrudeGeometry(shape, { depth: d, bevelEnabled: false });
    geo.translate(0, 0, -d / 2);
  }
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  return m;
}

function mansardRoof(ctx, w, d, h, mat, y) {
  const { THREE } = ctx;
  const g = new THREE.CylinderGeometry(Math.SQRT1_2 * 0.82, Math.SQRT1_2, 1, 4, 1);
  g.rotateY(Math.PI / 4);
  const m = new THREE.Mesh(g, mat);
  m.scale.set(w, h, d);
  m.position.y = y + h / 2;
  return m;
}

// -------------------------------------------------- Pont Jacques-Cartier --

/**
 * The bridge's steel: a through truss over the main channel, painted green,
 * with its lighting, and the river piers. Follows the bridge's own samples.
 */
export function buildJacquesCartier(THREE, layout, M) {
  const r = layout.roadById['pont-jacques-cartier'];
  if (!r) return null;
  const S = r.samples.filter((p) => p.gk === 'water' || (p.n < -690 && p.n > -1030));
  if (S.length < 2) return null;
  const g = new THREE.Group();
  g.name = 'Pont Jacques-Cartier';
  g.userData.zone = 'reperes';
  const s0 = S[0].s, s1 = S[S.length - 1].s, L = s1 - s0;
  const glowMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0x66d9ff).multiplyScalar(1.6), name: 'Connexions_vivantes' });
  const members = [];
  const lights = [];
  const at = (s) => {
    let k = 0;
    while (k < S.length - 2 && S[k + 1].s < s) k++;
    const a = S[k], b = S[k + 1];
    const t = Math.min(1, Math.max(0, (s - a.s) / Math.max(0.01, b.s - a.s)));
    return { x: a.x + (b.x - a.x) * t, n: a.n + (b.n - a.n) * t, y: a.y + (b.y - a.y) * t, lx: a.lx, ln: a.ln, tx: a.tx, tn: a.tn };
  };
  // Top chord height: tall over the piers, lower at mid-span (cantilevers).
  const topH = (u) => 12 + 22 * Math.pow(Math.abs(Math.cos(u * Math.PI)), 1.4);
  const off = r.half + 0.6;
  const step = 10;
  for (let s = s0; s <= s1 + 0.01; s += step) {
    const u = (s - s0) / L;
    const p = at(s), q = at(Math.min(s1, s + step));
    const h0 = topH(u), h1 = topH(Math.min(1, (s + step - s0) / L));
    for (const side of [1, -1]) {
      const bx = p.x + p.lx * off * side, bn = p.n + p.ln * off * side;
      const cx = q.x + q.lx * off * side, cn = q.n + q.ln * off * side;
      members.push([[bx, bn, p.y], [bx, bn, p.y + h0], 0.7]);           // vertical
      if (s + step <= s1 + 0.01) {
        members.push([[bx, bn, p.y + h0], [cx, cn, q.y + h1], 0.8]);     // top chord
        members.push([[bx, bn, p.y + 0.5], [cx, cn, q.y + 0.5], 0.8]);   // bottom chord
        members.push([[bx, bn, p.y], [cx, cn, q.y + h1], 0.45]);         // diagonal
        lights.push([bx, bn, p.y + h0 + 0.8]);
      }
    }
    // Cross bracing over the deck.
    members.push([[p.x + p.lx * off, p.n + p.ln * off, p.y + h0], [p.x - p.lx * off, p.n - p.ln * off, p.y + h0], 0.5]);
  }
  const geo = new THREE.BoxGeometry(1, 1, 1);
  geo.translate(0, 0, 0.5);
  const mesh = new THREE.InstancedMesh(geo, M.Metal_Green, members.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p0 = new THREE.Vector3(), p1 = new THREE.Vector3();
  const Z = new THREE.Vector3(0, 0, 1);
  members.forEach(([a, b, w], i) => {
    p0.set(a[0], a[2], -a[1]);
    p1.set(b[0], b[2], -b[1]);
    const d = new THREE.Vector3().subVectors(p1, p0);
    sc.set(w, w, d.length());
    q.setFromUnitVectors(Z, d.normalize());
    m.compose(p0, q, sc);
    mesh.setMatrixAt(i, m);
  });
  mesh.name = 'Treillis';
  g.add(mesh);
  const lg = new THREE.BoxGeometry(0.8, 0.8, 0.8);
  const lmesh = new THREE.InstancedMesh(lg, glowMat, lights.length);
  lights.forEach(([x, n, y], i) => { m.makeTranslation(x, y, -n); lmesh.setMatrixAt(i, m); });
  lmesh.name = 'Eclairage';
  g.add(lmesh);
  // Piers at both ends of the channel span.
  for (const s of [s0, s1]) {
    const p = at(s);
    const pier = new THREE.Mesh(new THREE.BoxGeometry(r.width + 6, p.y + 8, 10), M.Concrete);
    pier.position.set(p.x, (p.y - 8) / 2 - 1.2, -p.n);
    pier.rotation.y = Math.atan2(p.tx, p.tn);
    g.add(pier);
  }
  return g;
}
