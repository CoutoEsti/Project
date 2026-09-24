// The world is cut into square tiles, 1 km on a side at full scale. Every mesh
// belongs to one: the renderer culls whole tiles, the far ones drop their
// small things, and the Unity export writes one file per tile and layer.

export const TILE = 1000;        // real metres

export function tiling(map) {
  const size = TILE * map.scale;
  const W = map.world;
  const key = (x, n) => `${Math.floor(x / size)}_${Math.floor(n / size)}`;
  const bounds = (k) => {
    const [i, j] = k.split('_').map(Number);
    return { x0: i * size, n0: j * size, x1: (i + 1) * size, n1: (j + 1) * size };
  };
  const keys = [];
  for (let i = Math.floor(W.x0 / size); i * size < W.x1; i++) {
    for (let j = Math.floor(W.n0 / size); j * size < W.n1; j++) keys.push(`${i}_${j}`);
  }
  return { size, key, bounds, keys };
}

/** Group items into tiles by a point of each (e.g. its centroid). */
export function byTile(tiles, items, pointOf) {
  const out = new Map();
  for (const it of items) {
    const [x, n] = pointOf(it);
    const k = tiles.key(x, n);
    let list = out.get(k);
    if (!list) { list = []; out.set(k, list); }
    list.push(it);
  }
  return out;
}
