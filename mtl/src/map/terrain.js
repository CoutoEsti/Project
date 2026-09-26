// The ground as a height function: Montréal's real relief (mtl/data/relief.bin,
// 10 m samples), resampled on a 20 m grid and read as the two triangles of
// each cell — exactly the surface the ground mesh draws. The streets, the
// buildings, the trees and the car all read this one function, so what you
// see and what you drive on can never disagree.
//
// Coordinates and heights come out scaled: at 85 % the map is 85 % as wide
// and the mountain 85 % as tall, so every slope keeps its real grade.

export const MESH = 20;          // real metres between mesh vertices

/**
 * @param relief { x0, n0, dx, dn, cols, rows, data } real metres
 * @param opts   { scale, base } base: real height that becomes y = 0
 */
export function createTerrain(relief, { scale = 1, base = 0 } = {}) {
  const step = Math.round(MESH / relief.dx);
  const cols = Math.floor((relief.cols - 1) / step) + 1;
  const rows = Math.floor((relief.rows - 1) / step) + 1;
  const cell = MESH * scale;
  const x0 = relief.x0 * scale, n0 = relief.n0 * scale;
  const h = new Float32Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      h[j * cols + i] = (relief.data[j * step * relief.cols + i * step] - base) * scale;
    }
  }
  const x1 = x0 + (cols - 1) * cell, n1 = n0 + (rows - 1) * cell;
  const pads = [];

  function at(i, j) {
    i = i < 0 ? 0 : i >= cols ? cols - 1 : i;
    j = j < 0 ? 0 : j >= rows ? rows - 1 : j;
    return h[j * cols + i];
  }

  /**
   * Height at (x, n). Each cell is split along the diagonal from its
   * (i, j) corner to (i + 1, j + 1); the mesh builder uses the same split.
   */
  function height(x, n) {
    return sample(h, x, n);
  }

  function sample(buf, x, n) {
    let u = (x - x0) / cell, v = (n - n0) / cell;
    let i = Math.floor(u), j = Math.floor(v);
    if (i < 0) { i = 0; u = 0; } else if (i >= cols - 1) { i = cols - 2; u = cols - 1; }
    if (j < 0) { j = 0; v = 0; } else if (j >= rows - 1) { j = rows - 2; v = rows - 1; }
    const fu = u - i, fv = v - j;
    const h00 = buf[j * cols + i], h11 = buf[(j + 1) * cols + i + 1];
    if (fu >= fv) {
      const h10 = buf[j * cols + i + 1];
      return h00 + (h10 - h00) * fu + (h11 - h10) * fv;
    }
    const h01 = buf[(j + 1) * cols + i];
    return h00 + (h01 - h00) * fv + (h11 - h01) * fu;
  }

  /** The height function as the ground is now, unaffected by later edits. */
  function frozen() {
    const copy = Float32Array.from(h);
    return (x, n) => sample(copy, x, n);
  }

  function inside(x, n) {
    return x >= x0 && x <= x1 && n >= n0 && n <= n1;
  }

  /** Slope along (dx, dn), central difference over a metre. */
  function grade(x, n, dx, dn) {
    const l = Math.hypot(dx, dn) || 1;
    const ux = dx / l, un = dn / l;
    return (height(x + ux * 0.5, n + un * 0.5) - height(x - ux * 0.5, n - un * 0.5));
  }

  /**
   * Level a round terrace for something that needs flat ground (a stadium, a
   * chalet), blended back to the natural slope over `blend` metres. Returns
   * its height. Must run before the ground mesh is built.
   */
  function flatten(x, n, r, blend = 25) {
    let acc = 0, k = 0;
    for (let a = 0; a < 8; a++) {
      acc += height(x + Math.cos(a * 0.785) * r * 0.6, n + Math.sin(a * 0.785) * r * 0.6);
      k++;
    }
    const target = (acc / k + height(x, n)) / 2;
    const i0 = Math.floor((x - r - blend - x0) / cell), i1 = Math.ceil((x + r + blend - x0) / cell);
    const j0 = Math.floor((n - r - blend - n0) / cell), j1 = Math.ceil((n + r + blend - n0) / cell);
    for (let j = Math.max(0, j0); j <= Math.min(rows - 1, j1); j++) {
      for (let i = Math.max(0, i0); i <= Math.min(cols - 1, i1); i++) {
        const d = Math.hypot(x0 + i * cell - x, n0 + j * cell - n);
        const w = d <= r ? 1 : d >= r + blend ? 0 : 1 - (d - r) / blend;
        const k2 = j * cols + i;
        h[k2] = h[k2] * (1 - w) + target * w;
      }
    }
    pads.push({ x, n, r, h: target });
    return target;
  }

  return {
    height, frozen, inside, grade, flatten, at, pads,
    grid: { x0, n0, cell, cols, rows, h },
    bbox: { x0, n0, x1, n1 },
    scale,
  };
}
