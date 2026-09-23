// A small geometry accumulator working in the map frame (x east, n north,
// y up), converted to three.js's frame (X = x, Y = y, Z = -n) on the way in.
// With that mapping a triangle counter-clockwise in (x, n) seen from above is
// front-facing from above, and a wall quad (a0, b0, b1, a1) faces the right of
// its direction a → b.

export class GeoBuilder {
  /** @param extra { name: itemSize } custom per-vertex attributes */
  constructor(extra = {}) {
    this.pos = [];
    this.nor = [];
    this.uv = [];
    this.idx = [];
    this.extra = {};
    for (const [k, size] of Object.entries(extra)) this.extra[k] = { size, data: [] };
    this.count = 0;
  }

  /** Add a vertex; normal given in the map frame. Returns its index. */
  v(x, n, y, nx, nn, ny, u, w, ...ex) {
    this.pos.push(x, y, -n);
    this.nor.push(nx, ny, -nn);
    this.uv.push(u, w);
    let k = 0;
    for (const a of Object.values(this.extra)) {
      for (let c = 0; c < a.size; c++) a.data.push(ex[k++] ?? 0);
    }
    return this.count++;
  }

  tri(a, b, c) { this.idx.push(a, b, c); }
  quad(a, b, c, d) { this.idx.push(a, b, c, a, c, d); }

  /**
   * A vertical quad from a to b, y0..y1 at a and b (they may differ), facing
   * the right of a → b. UVs in metres along and up unless `uvFn` is given.
   */
  wall(ax, an, bx, bn, a0, a1, b0, b1, u0 = 0, ex = [], flip = false) {
    let dx = bx - ax, dn = bn - an;
    const len = Math.hypot(dx, dn) || 1;
    dx /= len; dn /= len;
    let nx = dn, nn = -dx;                 // right of the direction
    if (flip) { nx = -nx; nn = -nn; }
    const i0 = this.v(ax, an, a0, nx, nn, 0, u0, a0, ...ex);
    const i1 = this.v(bx, bn, b0, nx, nn, 0, u0 + len, b0, ...ex);
    const i2 = this.v(bx, bn, b1, nx, nn, 0, u0 + len, b1, ...ex);
    const i3 = this.v(ax, an, a1, nx, nn, 0, u0, a1, ...ex);
    if (flip) this.quad(i1, i0, i3, i2); else this.quad(i0, i1, i2, i3);
    return len;
  }

  /** Horizontal polygon (triangulated elsewhere) — faces up unless `down`. */
  flat(points, tris, y, down = false, uvScale = 1, ex = []) {
    const base = this.count;
    const ny = down ? -1 : 1;
    for (const [x, n, yy] of points) this.v(x, n, yy ?? y, 0, 0, ny, x * uvScale, n * uvScale, ...ex);
    for (let i = 0; i < tris.length; i += 3) {
      if (down) this.tri(base + tris[i], base + tris[i + 2], base + tris[i + 1]);
      else this.tri(base + tris[i], base + tris[i + 1], base + tris[i + 2]);
    }
  }

  /** An axis-free box: centre, half extents along (ux,un), (vx,vn) and y. */
  box(cx, cn, y0, y1, ux, un, hu, hv, ex = []) {
    const vx = -un, vn = ux;
    const c = [
      [cx - ux * hu - vx * hv, cn - un * hu - vn * hv],
      [cx + ux * hu - vx * hv, cn + un * hu - vn * hv],
      [cx + ux * hu + vx * hv, cn + un * hu + vn * hv],
      [cx - ux * hu + vx * hv, cn - un * hu + vn * hv],
    ];
    // Ring c is counter-clockwise, so walls a → b face outward.
    let u = 0;
    for (let i = 0; i < 4; i++) {
      const a = c[i], b = c[(i + 1) % 4];
      u += this.wall(a[0], a[1], b[0], b[1], y0, y1, y0, y1, u, ex);
    }
    const top = c.map(([x, n]) => [x, n, y1]);
    this.flat(top, [0, 1, 2, 0, 2, 3], y1, false, 1, ex);
    const bot = c.map(([x, n]) => [x, n, y0]);
    this.flat(bot, [0, 1, 2, 0, 2, 3], y0, true, 1, ex);
  }

  get empty() { return this.idx.length === 0; }

  toGeometry(THREE) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    for (const [k, a] of Object.entries(this.extra)) g.setAttribute(k, new THREE.Float32BufferAttribute(a.data, a.size));
    const Index = this.count > 65535 ? Uint32Array : Uint16Array;
    g.setIndex(new THREE.BufferAttribute(new Index(this.idx), 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/**
 * Triangulate a polygon with holes in the map frame. Returns flat points and
 * triangle indices, all counter-clockwise from above.
 */
export function triangulate(THREE, poly) {
  const toV = (ring) => ring.map(([x, n]) => new THREE.Vector2(x, n));
  let outer = toV(poly[0]);
  if (THREE.ShapeUtils.isClockWise(outer)) outer = outer.reverse();
  const holes = poly.slice(1).map((r) => {
    let h = toV(r);
    if (!THREE.ShapeUtils.isClockWise(h)) h = h.reverse();
    return h;
  });
  const faces = THREE.ShapeUtils.triangulateShape(outer, holes);
  const pts = [...outer, ...holes.flat()].map((v) => [v.x, v.y]);
  const tris = [];
  for (const [a, b, c] of faces) {
    const A = pts[a], B = pts[b], C = pts[c];
    const area = (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]);
    if (area >= 0) tris.push(a, b, c); else tris.push(a, c, b);
  }
  return { pts, tris, outer: outer.map((v) => [v.x, v.y]), holes: holes.map((h) => h.map((v) => [v.x, v.y])) };
}

/** Make a mesh from a builder, or null when empty. */
export function meshOf(THREE, builder, material, name) {
  if (builder.empty) return null;
  const m = new THREE.Mesh(builder.toGeometry(THREE), material);
  m.name = name;
  m.matrixAutoUpdate = false;
  m.updateMatrix();
  return m;
}

/**
 * Concatenate geometries (position, normal, uv) into one non-indexed
 * geometry. Deliberately tiny: BufferGeometryUtils imports 'three' by name,
 * which the node export cannot resolve without an import map.
 */
export function concatGeometries(THREE, geos) {
  const parts = geos.map((g) => (g.index ? g.toNonIndexed() : g));
  let count = 0;
  for (const g of parts) count += g.attributes.position.count;
  const pos = new Float32Array(count * 3), nor = new Float32Array(count * 3), uv = new Float32Array(count * 2);
  let o = 0;
  for (const g of parts) {
    pos.set(g.attributes.position.array, o * 3);
    if (g.attributes.normal) nor.set(g.attributes.normal.array, o * 3);
    if (g.attributes.uv) uv.set(g.attributes.uv.array, o * 2);
    o += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.computeBoundingSphere();
  return out;
}

/**
 * Merge every static mesh under `root` into one mesh per material, keeping
 * animated sub-trees and instanced meshes as they are. A landmark built from
 * two hundred boxes becomes four draw calls.
 */
export function mergeStatic(THREE, root) {
  root.updateMatrixWorld(true);
  const inv = root.matrixWorld.clone().invert();
  const buckets = new Map();
  const drop = [];
  root.traverse((o) => {
    if (!o.isMesh || o.isInstancedMesh) return;
    for (let p = o; p && p !== root; p = p.parent) if (p.userData.animated) return;
    const g = o.geometry.clone();
    g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld));
    if (!buckets.has(o.material)) buckets.set(o.material, []);
    buckets.get(o.material).push(g);
    drop.push(o);
  });
  for (const o of drop) o.parent.remove(o);
  for (const [mat, geos] of buckets) {
    const mesh = new THREE.Mesh(concatGeometries(THREE, geos), mat);
    mesh.name = (mat.name || 'Repere') + '_fusion';
    root.add(mesh);
  }
  return root;
}
