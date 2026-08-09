// Collision against the world's solid geometry.
//
// Everything solid — building walls, parked cars — is reduced to 2D line
// segments and dropped into a uniform grid per tile. The car is approximated
// by three circles down its centre line, which is accurate enough to stop you
// driving through a triplex and cheap enough to run at 120 Hz.

const CELL = 12;

export class CollisionGrid {
  /**
   * @param {Float32Array} segments  flat [x1,z1,x2,z2, …]
   * @param {{x0,z0,x1,z1}} bounds
   */
  constructor(segments, bounds) {
    this.segments = segments;
    this.x0 = Math.min(bounds.x0, bounds.x1) - CELL;
    this.z0 = Math.min(bounds.z0, bounds.z1) - CELL;
    const x1 = Math.max(bounds.x0, bounds.x1) + CELL;
    const z1 = Math.max(bounds.z0, bounds.z1) + CELL;
    this.cols = Math.max(1, Math.ceil((x1 - this.x0) / CELL));
    this.rows = Math.max(1, Math.ceil((z1 - this.z0) / CELL));
    this.buckets = new Array(this.cols * this.rows);

    const n = segments.length / 4;
    for (let i = 0; i < n; i++) {
      const ax = segments[i * 4], az = segments[i * 4 + 1];
      const bx = segments[i * 4 + 2], bz = segments[i * 4 + 3];
      const cxa = this._col(Math.min(ax, bx));
      const cxb = this._col(Math.max(ax, bx));
      const cza = this._row(Math.min(az, bz));
      const czb = this._row(Math.max(az, bz));
      for (let cz = cza; cz <= czb; cz++) {
        for (let cx = cxa; cx <= cxb; cx++) {
          const k = cz * this.cols + cx;
          if (k < 0 || k >= this.buckets.length) continue;
          (this.buckets[k] || (this.buckets[k] = [])).push(i);
        }
      }
    }
  }

  _col(x) { return Math.max(0, Math.min(this.cols - 1, Math.floor((x - this.x0) / CELL))); }
  _row(z) { return Math.max(0, Math.min(this.rows - 1, Math.floor((z - this.z0) / CELL))); }

  /** Call `cb(ax, az, bx, bz)` for every segment in the cells around (x,z). */
  forEachNear(x, z, cb) {
    const c0 = this._col(x - CELL), c1 = this._col(x + CELL);
    const r0 = this._row(z - CELL), r1 = this._row(z + CELL);
    const seen = SEEN;
    seen.clear();
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const bucket = this.buckets[r * this.cols + c];
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          const s = bucket[i];
          if (seen.has(s)) continue;
          seen.add(s);
          cb(this.segments[s * 4], this.segments[s * 4 + 1],
             this.segments[s * 4 + 2], this.segments[s * 4 + 3]);
        }
      }
    }
  }
}

const SEEN = new Set();

/** Closest point on segment ab to p, written into `out`. */
function closestOnSegment(ax, az, bx, bz, px, pz, out) {
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz;
  if (l2 < 1e-9) { out.x = ax; out.z = az; return; }
  let t = ((px - ax) * dx + (pz - az) * dz) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  out.x = ax + dx * t;
  out.z = az + dz * t;
}

const _c = { x: 0, z: 0 };

// Three probes along the car's centre line: nose, middle, tail.
const PROBES = [1.45, 0, -1.45];
const PROBE_RADIUS = 0.93;

/**
 * Push the car out of anything it has driven into, and take the energy out of
 * the impact.
 *
 * @param {object} car    mutated: x, z, vx, vz, yawRate
 * @param {number} yaw
 * @param {Array<CollisionGrid>} grids
 * @returns {number} impact speed, for sound and camera shake
 */
export function resolveCollisions(car, yaw, grids) {
  if (!grids.length) return 0;

  const fx = Math.sin(yaw), fz = Math.cos(yaw);
  let impact = 0;

  for (let p = 0; p < PROBES.length; p++) {
    const px = car.x + fx * PROBES[p];
    const pz = car.z + fz * PROBES[p];

    let pushX = 0, pushZ = 0, hits = 0;

    for (let g = 0; g < grids.length; g++) {
      grids[g].forEachNear(px, pz, (ax, az, bx, bz) => {
        closestOnSegment(ax, az, bx, bz, px, pz, _c);
        let dx = px - _c.x, dz = pz - _c.z;
        let d = Math.hypot(dx, dz);
        if (d >= PROBE_RADIUS) return;
        if (d < 1e-5) {
          // Dead centre on the wall: push along the wall's normal instead.
          const wx = bx - ax, wz = bz - az;
          const wl = Math.hypot(wx, wz) || 1;
          dx = -wz / wl; dz = wx / wl; d = 1e-5;
        }
        const depth = PROBE_RADIUS - d;
        pushX += (dx / d) * depth;
        pushZ += (dz / d) * depth;
        hits++;
      });
    }

    if (!hits) continue;

    // Average the corrections so a corner between two walls does not double up.
    pushX /= hits;
    pushZ /= hits;
    const len = Math.hypot(pushX, pushZ);
    if (len < 1e-6) continue;
    const nx = pushX / len, nz = pushZ / len;

    car.x += pushX;
    car.z += pushZ;

    const vn = car.vx * nx + car.vz * nz;
    if (vn < 0) {
      impact = Math.max(impact, -vn);
      // Kill the inbound component, keep most of the sliding component.
      car.vx -= vn * nx * 1.18;
      car.vz -= vn * nz * 1.18;
      const tx = -nz, tz = nx;
      const vt = car.vx * tx + car.vz * tz;
      car.vx -= vt * tx * 0.16;
      car.vz -= vt * tz * 0.16;
      // Hitting off-centre spins the car, which is what makes scrapes feel real.
      car.yawRate += (-vn * PROBES[p] * 0.055);
      car.yawRate = Math.max(-3.5, Math.min(3.5, car.yawRate));
    }
  }

  return impact;
}

/**
 * How far along the segment a->b you can travel before hitting a wall.
 *
 * Used to keep the chase camera out of buildings: in a Montréal back alley the
 * camera's resting position is often inside the triplex behind you, and the
 * fix is to pull it in rather than to let the view clip through brick.
 *
 * @returns {number} t in [0,1]; 1 means the whole segment is clear.
 */
export function rayClearance(grids, ax, az, bx, bz, padding = 0.55) {
  const dx = bx - ax, dz = bz - az;
  const len = Math.hypot(dx, dz);
  if (len < 1e-4 || !grids.length) return 1;
  let best = 1;

  // Probe from a few points along the ray so the uniform grid's cell radius
  // covers the whole span, however long it is.
  const probes = Math.max(2, Math.ceil(len / 10));
  for (let p = 0; p <= probes; p++) {
    const t = p / probes;
    const px = ax + dx * t, pz = az + dz * t;
    for (let g = 0; g < grids.length; g++) {
      grids[g].forEachNear(px, pz, (sx, sz, ex, ez) => {
        const hit = segmentHit(ax, az, dx, dz, sx, sz, ex, ez);
        if (hit >= 0 && hit < best) best = hit;
      });
    }
  }
  if (best >= 1) return 1;
  return Math.max(0, best - padding / len);
}

/** Parametric position along (a + t·d) where it crosses segment s->e. */
function segmentHit(ax, az, dx, dz, sx, sz, ex, ez) {
  const wx = ex - sx, wz = ez - sz;
  const denom = dx * wz - dz * wx;
  if (Math.abs(denom) < 1e-9) return -1;
  const rx = sx - ax, rz = sz - az;
  const t = (rx * wz - rz * wx) / denom;
  const u = (rx * dz - rz * dx) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return -1;
  return t;
}

/**
 * Distance from the car's shell to the closest solid geometry, or Infinity.
 * Used to spot a near miss: the gap you just threaded at speed.
 */
export function nearestObstacle(x, z, yaw, grids, limit = 3) {
  if (!grids.length) return Infinity;
  const fx = Math.sin(yaw), fz = Math.cos(yaw);
  let best = Infinity;
  for (let p = 0; p < PROBES.length; p++) {
    const px = x + fx * PROBES[p];
    const pz = z + fz * PROBES[p];
    for (let g = 0; g < grids.length; g++) {
      grids[g].forEachNear(px, pz, (ax, az, bx, bz) => {
        closestOnSegment(ax, az, bx, bz, px, pz, _c);
        const d = Math.hypot(px - _c.x, pz - _c.z);
        if (d < best) best = d;
      });
    }
  }
  return best > limit ? Infinity : best;
}

export { PROBE_RADIUS };
