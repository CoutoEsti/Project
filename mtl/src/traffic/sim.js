// City traffic: cars that keep to their lane, turn at junctions, stop at red
// lights and at stop signs, keep their distance (the Intelligent Driver
// Model), and live only in a bubble around the players. Plain game AI: a
// handful of rules per car, a few microseconds each.
//
// Built for multiplayer from the start:
//   - one Traffic runs on the host, at a fixed tick, for every player at once
//     (the bubble is the union of theirs);
//   - lights are a pure function of the shared clock (network.js lightAt), so
//     they cost nothing on the wire;
//   - encode() packs every car into a Float32Array a few kilobytes long, and
//     TrafficReplica on each other player turns it back into cars to draw and
//     to collide with. A replica never simulates: one authority, no drift.
//   - same seed, same players → same traffic, step for step (checked).

import { rng } from '../map/geom.js';
import { lightAt, span, pointOn, arrival, departure } from './network.js';

export const TICK = 1 / 20;        // traffic steps a second (the car's physics runs at 120)
export const CAR_LENGTH = 4.6;
const A_MAX = 1.8;                 // comfortable acceleration, m/s²
const B_COMF = 3.0;                // comfortable braking
const B_MAX = 8.0;
const GAP = 2.2;                   // bumper to bumper, standing
const HEADWAY = 1.3;               // seconds
const LAT_RATE = 1.3;              // lane change, m/s sideways
const A_LAT = 2.6;                 // cornering, m/s²
const LOOK = 70;                   // how far past the end of its edge a car looks
const STOP_HOLD = 0.9;             // seconds stopped at a stop sign
const RADIUS = 260;                // the bubble around each player
const MARGIN = 90;                 // a car leaves this far beyond it
const COLOURS = 8;
const FIELDS = 8;                  // floats per car on the wire

export class Traffic {
  /**
   * @param net   buildNetwork(layout)
   * @param opts  seed, max (cars), radius (m)
   */
  constructor(net, { seed = 1, max = 80, radius = RADIUS } = {}) {
    this.net = net;
    this.rand = rng(seed);
    this.max = max;
    this.radius = radius * net.scale;
    this.cars = [];
    this.byEd = new Map();
    this.busy = new Map();         // node id → cars inside its junction box
    this.time = 0;
    this.tick = 0;
    this.nextId = 1;
    this.filled = false;
    this.events = [];              // { type: 'horn', x, n } since the caller last read them
    this.count = { through: 0, red: 0 };   // junctions crossed, and on a red light (should stay 0)
    this._sp = {};
    this._sp2 = {};
    this._q = [];
  }

  // ------------------------------------------------------------- the loop --

  /**
   * One fixed step. `players`: [{ x, n, y, heading, speed }] — every player
   * the host knows of, itself included.
   */
  step(dt, players) {
    this.time += dt;
    this.tick++;
    for (const c of this.cars) this._drive(c, dt, players);
    for (const c of this.cars) this._move(c, dt);
    this._cull(players);
    this._spawn(players);
    for (const c of this.cars) {
      c.px = c.x; c.pn = c.n; c.py = c.y; c.ph = c.h; c.pp = c.p;
      this._pose(c, c);
    }
  }

  /** How long since this light changed matters to no one: the colour is enough. */
  light(node, ed) { return lightAt(node, ed, this.time); }

  // --------------------------------------------------------- the decisions --

  _drive(c, dt, players) {
    const sp = span(this.net, c.ed, this._sp);
    if (c.next === undefined) this._choose(c, sp);
    // Lanes: drift sideways towards the one the next turn needs.
    if (!c.conn) {
      const target = sp.offsets[Math.min(c.lane, sp.lanes - 1)] ?? 0;
      const d = target - c.lat, step = LAT_RATE * dt;
      c.lat += d > step ? step : d < -step ? -step : d;
    }

    let v0 = sp.e.speed * c.mood;
    const toEnd = sp.s1 - c.s;
    // Slow for the turn ahead: the speed its radius allows, braking into it.
    if (c.turn > 0.3 && !c.conn && toEnd < 60) {
      const r = Math.max(4, (c.connEst || 10) / c.turn);
      const vt = Math.sqrt(A_LAT * r);
      v0 = Math.min(v0, Math.sqrt(vt * vt + 2 * B_COMF * Math.max(0, toEnd - 2)));
    }
    if (c.hit > 0) { c.hit -= dt; v0 = 0.01; }

    // Everything ahead, as (gap, speed of what is there): the worst one wins.
    let worst = 0;
    const take = (gap, dv) => {
      const ss = GAP + Math.max(0, c.v * HEADWAY + (c.v * dv) / (2 * Math.sqrt(A_MAX * B_COMF)));
      const r = ss / Math.max(gap, 0.1);
      if (r > worst) worst = r;
    };
    const lead = this._leader(c, sp);
    if (lead) take(lead.gap, c.v - lead.v);
    // The players: a car ahead in the lane, whatever it is doing there.
    let blocked = false;
    const fx = Math.sin(c.h), fn = Math.cos(c.h);
    for (const p of players) {
      const dx = p.x - c.x, dn = p.n - c.n;
      const along = dx * fx + dn * fn;
      if (along <= 0 || along > 45) continue;
      if (Math.abs(dx * fn - dn * fx) > 2.3 || Math.abs((p.y ?? c.y) - c.y) > 3) continue;
      const pv = Math.max(0, (p.speed || 0) * Math.cos((p.heading || 0) - c.h));
      take(along - CAR_LENGTH, c.v - pv);
      if (along < 14 && pv < 1) blocked = true;
    }
    // The stop line.
    if (!c.committed && c.next >= 0) {
      if (this._mustStop(c, sp, toEnd)) take(toEnd + GAP - 0.8, c.v);
      else if (!c.committed && toEnd < 3 + c.v * TICK) this._commit(c, sp);
    }

    let a = A_MAX * (1 - (c.v / Math.max(v0, 0.1)) ** 4 - worst * worst);
    if (a < -B_MAX) a = -B_MAX;
    c.acc = a;
    c.v = Math.max(0, c.v + a * dt);

    // Reactions to the player: a horn when blocked, more so after a knock.
    c.honk -= dt;
    c.blocked = blocked && c.v < 0.5 ? c.blocked + dt : 0;
    if ((c.blocked > 3 || c.hit > 0) && c.honk <= 0) {
      c.honk = 4 + this.rand() * 3;
      this.events.push({ type: 'horn', x: c.x, n: c.n, id: c.id });
    }
  }

  /** Must the car stop at the line of the junction ahead? */
  _mustStop(c, sp, toEnd) {
    const node = this.net.nodes[sp.to];
    // The junction box beyond must have room for the car.
    if (node.control !== 'signal' && node.control !== 'stop') return false;
    if (toEnd < 12 && this._jammed(c)) return true;
    if (node.control === 'signal') {
      // Whoever entered the box on a green carries on through its median.
      if (this._inside(sp)) return false;
      const l = lightAt(node, c.ed, this.time);
      if (l === 'g') return false;
      if (l === 'r') return true;
      // Yellow: stop if there is room to, otherwise go, and stick to it.
      if ((c.v * c.v) / (2 * B_COMF) < toEnd - 1) return true;
      this._commit(c, sp);
      return false;
    }
    if (!node.allWay && sp.e.rank >= node.top) return false;   // the major way does not stop
    if (c.stopAt === null) {
      if (c.v < 0.4 && toEnd < 4.5) c.stopAt = this.time;
      return true;
    }
    if (this.time - c.stopAt < STOP_HOLD) return true;
    const inside = this.busy.get(node.id);
    if (inside && inside.size) return true;
    if (node.allWay) {
      // First stopped, first through; ties to the lower id.
      for (const ed of node.in) {
        for (const o of this.byEd.get(ed) || []) {
          if (o === c || o.conn || o.stopAt === null || o.committed) continue;
          if (o.stopAt < c.stopAt || (o.stopAt === c.stopAt && o.id < c.id)) return true;
        }
      }
      return false;
    }
    // A side street: wait for a gap in the major way's traffic.
    const sp2 = this._sp2;
    for (const ed of node.in) {
      if (ed === c.ed) continue;
      span(this.net, ed, sp2);
      if (sp2.e.rank < node.top) continue;
      for (const o of this.byEd.get(ed) || []) {
        const d = sp2.s1 - o.s;
        if (d > 0 && d < 60 && d / Math.max(o.v, 1) < 4.5) return true;
      }
    }
    return false;
  }

  /** A short link between two lit junctions (a boulevard's median): one box. */
  _inside(sp) {
    return sp.e.len < 30 * this.net.scale && this.net.nodes[sp.from].control === 'signal';
  }

  /** Is the start of the next edge full (a car standing just past the box)? */
  _jammed(c) {
    const list = this.byEd.get(c.next);
    if (!list) return false;
    const sp = span(this.net, c.next, this._sp2);
    for (const o of list) if (o.s < sp.s0 + CAR_LENGTH + 3 && o.v < 2 && o !== c) return true;
    return false;
  }

  _commit(c, sp) {
    c.committed = true;
    const at = this.net.nodes[sp.to];
    if (at.control === 'signal' || at.control === 'stop') {
      this.count.through++;
      if (at.control === 'signal' && !this._inside(sp) && lightAt(at, c.ed, this.time) === 'r') this.count.red++;
    }
    c.stopAt = null;
    // Into the box: whoever waits at a stop sign waits for it to empty.
    const node = sp.to;
    if (!this.busy.has(node)) this.busy.set(node, new Set());
    this.busy.get(node).add(c.id);
    c.box = node;
  }

  /** The nearest car ahead in the lane, on this edge or on the next one. */
  _leader(c, sp) {
    let best = null, gap = Infinity;
    for (const o of this.byEd.get(c.ed) || []) {
      if (o === c || o.s <= c.s || Math.abs(o.lat - c.lat) > 2.2) continue;
      const g = o.s - c.s - CAR_LENGTH;
      if (g < gap) { gap = g; best = o; }
    }
    const toEnd = sp.s1 - c.s;
    if (!best && c.next >= 0 && toEnd < LOOK) {
      const list = this.byEd.get(c.next);
      if (list) {
        const sp2 = span(this.net, c.next, this._sp2);
        const lat = sp2.offsets[c.nextLane] ?? 0;
        for (const o of list) {
          if (Math.abs(o.lat - lat) > 2.2) continue;
          const g = toEnd + (c.connEst || 0) + (o.s - sp2.s0) - CAR_LENGTH;
          if (g < gap) { gap = g; best = o; }
        }
      }
    }
    if (!best) return null;
    this._lead = this._lead || {};
    this._lead.gap = gap;
    this._lead.v = best.v;
    return this._lead;
  }

  /** Pick the way out of the junction ahead, and the lane it takes. */
  _choose(c, sp) {
    const net = this.net;
    const node = net.nodes[sp.to];
    const edge = c.ed >> 1;
    let opts = node.out.filter((o) => (o >> 1) !== edge);
    if (!opts.length) opts = node.out.filter((o) => o === (c.ed ^ 1));    // turn back at a dead end
    if (!opts.length) { c.next = -1; c.turn = 0; return; }
    const hIn = arrival(sp.e, sp.dir);
    const turns = opts.map((o) => wrap(departure(net.edges[o >> 1], o & 1) - hIn));
    // Mostly straight on, and onto ways at least as big as this one.
    const w = opts.map((o, i) => {
      const e = net.edges[o >> 1];
      return (Math.abs(turns[i]) < 0.6 ? 4 : 1) * (e.rank >= sp.e.rank ? 1.5 : 1) * (Math.abs(turns[i]) > 2.6 ? 0.1 : 1);
    });
    let r = this.rand() * w.reduce((a, b) => a + b, 0), k = 0;
    while (k < opts.length - 1 && (r -= w[k]) > 0) k++;
    const next = opts[k], th = turns[k];
    const sp2 = span(net, next, this._sp2);
    const L = sp.lanes, Ln = sp2.lanes;
    // Compass headings: a positive turn is to the right.
    let need = Math.min(c.lane, L - 1), nl;
    if (th > 0.5) { need = L - 1; nl = Ln - 1; }
    else if (th < -0.5) { need = 0; nl = 0; }
    else {
      // Straight on, or a fork: the rightmost branch takes the right lane.
      if (opts.length > 1 && node.control === 'merge') {
        if (th >= Math.max(...turns)) need = L - 1;
        else if (th <= Math.min(...turns)) need = 0;
      }
      nl = Math.max(0, Ln - 1 - Math.min(Ln - 1, L - 1 - need));
    }
    c.next = next;
    c.nextLane = nl;
    c.lane = need;
    c.turn = Math.abs(th);
    // Rough length of the connector, for gaps measured through the box.
    const a = pointOn(net, c.ed, sp.s1, sp.offsets[need] ?? 0, this._q[0] || (this._q[0] = {}));
    const b = pointOn(net, next, sp2.s0, sp2.offsets[nl] ?? 0, this._q[1] || (this._q[1] = {}));
    c.connEst = Math.hypot(b.x - a.x, b.n - a.n) * (1 + 0.2 * c.turn);
  }

  // ------------------------------------------------------------ the motion --

  _move(c, dt) {
    c.s += c.v * dt;
    for (let guard = 0; guard < 3; guard++) {
      const sp = span(this.net, c.ed, this._sp);
      if (c.conn) {
        if (c.s < sp.s0) return;
        // Out of the box.
        const inside = this.busy.get(c.conn.node);
        if (inside) inside.delete(c.id);
        if (c.box === c.conn.node) c.box = -1;
        c.conn = null;
        continue;
      }
      if (c.s < sp.s1) return;
      // A dead end (a one-way street into a lane or a car park, the edge of
      // the map): the car turns off there and leaves the simulation.
      if (c.next < 0) { c.s = sp.s1; c.v = 0; c.gone = true; return; }
      // Into the junction: a curve from here to the start of the next edge.
      const sp2 = span(this.net, c.next, this._sp2);
      const over = c.s - sp.s1;
      const from = pointOn(this.net, c.ed, sp.s1, c.lat, {});
      const lat = sp2.offsets[c.nextLane] ?? 0;
      const to = pointOn(this.net, c.next, sp2.s0, lat, {});
      if (c.box < 0) this._commit(c, sp);
      c.conn = connector(from, to, sp.to);
      this._leave(c);
      c.ed = c.next;
      c.lat = lat;
      c.lane = c.nextLane;
      c.s = sp2.s0 - c.conn.len + over;
      c.next = undefined;
      c.committed = false;
      c.stopAt = null;
      this._enter(c);
    }
  }

  _pose(c, out) {
    if (c.conn) {
      const sp = span(this.net, c.ed, this._sp);
      return c.conn.at(c.conn.len - (sp.s0 - c.s), out);
    }
    return pointOn(this.net, c.ed, c.s, c.lat, out);
  }

  _enter(c) {
    let l = this.byEd.get(c.ed);
    if (!l) { l = []; this.byEd.set(c.ed, l); }
    l.push(c);
  }

  _leave(c) {
    const l = this.byEd.get(c.ed);
    if (!l) return;
    const i = l.indexOf(c);
    if (i >= 0) l.splice(i, 1);
    if (!l.length) this.byEd.delete(c.ed);
  }

  // ------------------------------------------------------------ the bubble --

  _near(x, n, players) {
    let d = Infinity;
    for (const p of players) d = Math.min(d, Math.hypot(p.x - x, p.n - n));
    return d;
  }

  _cull(players) {
    const far = this.radius + MARGIN;
    let k = 0;
    for (const c of this.cars) {
      const d = players.length ? this._near(c.x, c.n, players) : Infinity;
      if (d > far || c.gone || !Number.isFinite(c.x)) { this._remove(c); continue; }
      this.cars[k++] = c;
    }
    this.cars.length = k;
  }

  _remove(c) {
    this._leave(c);
    for (const node of [c.box, c.conn ? c.conn.node : -1]) {
      const inside = this.busy.get(node);
      if (inside) inside.delete(c.id);
    }
  }

  _spawn(players) {
    if (!players.length || this.cars.length >= this.max) return;
    const net = this.net, R = this.radius;
    // The first fill puts cars everywhere; after that they come in from the
    // edge of the bubble, out of sight more often than not.
    // A player who jumps (teleport, free flight) gets a full bubble at once.
    const burst = !this.filled || this.cars.length < this.max / 2;
    const inner = burst ? 12 : R * 0.55;
    let tries = burst ? 400 : 4;
    const sp = this._sp, tmp = this._found || (this._found = []);
    while (tries-- > 0 && this.cars.length < this.max) {
      const p = players[Math.floor(this.rand() * players.length)];
      const ang = this.rand() * Math.PI * 2, r = inner + this.rand() * (R - inner);
      const x = p.x + Math.sin(ang) * r, n = p.n + Math.cos(ang) * r;
      const found = net.grid.query(x, n, 30, tmp);
      if (!found.length) continue;
      const e = found[Math.floor(this.rand() * found.length)];
      const dirs = [0, 1].filter((d) => e.lanes[d] > 0);
      const ed = e.id * 2 + dirs[Math.floor(this.rand() * dirs.length)];
      span(net, ed, sp);
      if (sp.s1 - sp.s0 < 14) continue;
      const s = sp.s0 + 5 + this.rand() * (sp.s1 - sp.s0 - 10);
      const lane = Math.floor(this.rand() * sp.lanes);
      if ((this.byEd.get(ed) || []).some((o) => Math.abs(o.s - s) < 16)) continue;
      const c = {
        id: this.nextId++, ed, s, v: 0, lane, lat: sp.offsets[lane] ?? 0,
        next: undefined, nextLane: 0, turn: 0, connEst: 0, conn: null, box: -1,
        committed: false, stopAt: null, mood: 0.88 + this.rand() * 0.22,
        colour: Math.floor(this.rand() * COLOURS), hit: 0, honk: 0, blocked: 0, acc: 0,
        x: 0, n: 0, y: 0, h: 0, p: 0, px: 0, pn: 0, py: 0, ph: 0, pp: 0,
      };
      this._pose(c, c);
      if (players.some((q) => Math.hypot(q.x - c.x, q.n - c.n) < 25)) continue;
      c.v = sp.e.speed * 0.6;
      c.px = c.x; c.pn = c.n; c.py = c.y; c.ph = c.h; c.pp = c.p;
      this.cars.push(c);
      this._enter(c);
    }
    this.filled = true;
  }

  // ------------------------------------------------------- the player's car --

  /** The player hit something: the traffic car it hit stops and protests. */
  knock(x, n) {
    let best = null, bd = 4;
    for (const c of this.cars) {
      const d = Math.hypot(c.x - x, c.n - n);
      if (d < bd) { bd = d; best = c; }
    }
    if (best) { best.hit = 2.5; best.honk = 0; }
    return best;
  }

  /** Collision shapes near (x, n), appended to out (map/collide.js format). */
  near(x, n, r, out, alpha = 1) {
    return nearShapes(this.cars, x, n, r, out, alpha);
  }

  /** Every car's pose, blended between the last two ticks. */
  poses(alpha, out = []) { return blendPoses(this.cars, alpha, out); }

  // ---------------------------------------------------------- the network --

  /** Every car, for the other players: [time, count, then FIELDS per car]. */
  encode() {
    const buf = new Float32Array(2 + this.cars.length * FIELDS);
    buf[0] = this.time;
    buf[1] = this.cars.length;
    let k = 2;
    for (const c of this.cars) {
      buf[k++] = c.id; buf[k++] = c.x; buf[k++] = c.n; buf[k++] = c.y;
      buf[k++] = c.h; buf[k++] = c.p; buf[k++] = c.v;
      buf[k++] = c.colour + (c.acc < -1 ? 16 : 0);
    }
    return buf;
  }

  /** Same seed, same players, same state: a fingerprint to compare two runs. */
  digest() {
    let h = 0;
    for (const c of this.cars) h = (h * 31 + c.id * 7 + Math.round(c.s * 100) + Math.round(c.v * 100) * 13 + c.ed) % 2147483647;
    return `${this.cars.length}:${h}`;
  }
}

/**
 * Another player's copy of the traffic: cars from the host's snapshots,
 * blended between the last two. Lights come from the shared clock.
 */
export class TrafficReplica {
  constructor(net) {
    this.net = net;
    this.time = 0;
    this.cars = [];
    this.byId = new Map();
  }

  apply(buf) {
    this.time = buf[0];
    const count = buf[1];
    const seen = new Map();
    const cars = [];
    for (let i = 0, k = 2; i < count; i++, k += FIELDS) {
      const id = buf[k];
      const c = this.byId.get(id) || { id, x: buf[k + 1], n: buf[k + 2], y: buf[k + 3], h: buf[k + 4], p: buf[k + 5] };
      c.px = c.x; c.pn = c.n; c.py = c.y; c.ph = c.h; c.pp = c.p;
      c.x = buf[k + 1]; c.n = buf[k + 2]; c.y = buf[k + 3]; c.h = buf[k + 4]; c.p = buf[k + 5];
      c.v = buf[k + 6];
      c.colour = buf[k + 7] & 15;
      c.acc = buf[k + 7] >= 16 ? -2 : 0;
      seen.set(id, c);
      cars.push(c);
    }
    this.byId = seen;
    this.cars = cars;
  }

  light(node, ed) { return lightAt(node, ed, this.time); }
  near(x, n, r, out, alpha = 1) { return nearShapes(this.cars, x, n, r, out, alpha); }
  poses(alpha, out = []) { return blendPoses(this.cars, alpha, out); }
}

// ---------------------------------------------------------------- helpers --

function wrap(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function lerpAngle(a, b, t) { return a + wrap(b - a) * t; }

function blendPoses(cars, alpha, out) {
  out.length = cars.length;
  for (let i = 0; i < cars.length; i++) {
    const c = cars[i];
    const o = out[i] || (out[i] = {});
    o.x = c.px + (c.x - c.px) * alpha;
    o.n = c.pn + (c.n - c.pn) * alpha;
    o.y = c.py + (c.y - c.py) * alpha;
    o.h = lerpAngle(c.ph, c.h, alpha);
    o.p = c.pp + (c.p - c.pp) * alpha;
    o.colour = c.colour;
    o.brake = c.acc < -1 || c.v < 0.3;
    o.id = c.id;
  }
  return out;
}

const HALF = 1.35, RAD = 0.95, HEIGHT = 1.45;

function nearShapes(cars, x, n, r, out, alpha) {
  for (const c of cars) {
    const cx = c.px + (c.x - c.px) * alpha, cn = c.pn + (c.n - c.pn) * alpha;
    if (Math.abs(cx - x) > r + 4 || Math.abs(cn - n) > r + 4) continue;
    const h = lerpAngle(c.ph, c.h, alpha), y = c.py + (c.y - c.py) * alpha;
    const fx = Math.sin(h) * HALF, fn = Math.cos(h) * HALF;
    out.push({ ax: cx - fx, an: cn - fn, bx: cx + fx, bn: cn + fn, y0: y, y1: y + HEIGHT, r: RAD, car: c });
  }
  return out;
}

/** A cubic curve through the junction box, walked by arc length. */
function connector(a, b, node) {
  const d = Math.hypot(b.x - a.x, b.n - a.n);
  const k = Math.max(d * 0.42, 1);
  const p0 = [a.x, a.n, a.y], p3 = [b.x, b.n, b.y];
  const p1 = [a.x + Math.sin(a.h) * k, a.n + Math.cos(a.h) * k];
  const p2 = [b.x - Math.sin(b.h) * k, b.n - Math.cos(b.h) * k];
  const N = 10, cum = [0];
  let px = p0[0], pn = p0[1];
  for (let i = 1; i <= N; i++) {
    const [x, n] = bez(p0, p1, p2, p3, i / N);
    cum.push(cum[i - 1] + Math.hypot(x - px, n - pn));
    px = x; pn = n;
  }
  const len = Math.max(cum[N], 0.01);
  return {
    node, len,
    at(dist, out) {
      const dd = Math.min(len, Math.max(0, dist));
      let i = 1;
      while (i < N && cum[i] < dd) i++;
      const seg = cum[i] - cum[i - 1];
      const u = (i - 1 + (seg > 1e-9 ? (dd - cum[i - 1]) / seg : 0)) / N;
      const [x, n] = bez(p0, p1, p2, p3, u);
      const v = 1 - u;
      const dx = 3 * v * v * (p1[0] - p0[0]) + 6 * v * u * (p2[0] - p1[0]) + 3 * u * u * (p3[0] - p2[0]);
      const dn = 3 * v * v * (p1[1] - p0[1]) + 6 * v * u * (p2[1] - p1[1]) + 3 * u * u * (p3[1] - p2[1]);
      out.x = x; out.n = n;
      out.y = p0[2] + (p3[2] - p0[2]) * u;
      out.h = dx * dx + dn * dn > 1e-12 ? Math.atan2(dx, dn) : a.h;
      out.p = Math.atan2(p3[2] - p0[2], len);
      return out;
    },
  };
}

function bez(p0, p1, p2, p3, t) {
  const u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return [a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]];
}
