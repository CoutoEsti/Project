// What two browsers say to each other, and nothing else.
//
// The rule that shapes this file: **positions travel as latitude and longitude,
// never as world metres.** Every client anchors its own local plane at the place
// it hopped into (see core/geo.js), so one player's x = 200 is a different
// street corner from another's. Geographic coordinates are the only frame the
// two agree on, and converting is one multiply at each end.
//
// Everything here is pure. No sockets, no three.js, no DOM — so it runs under
// plain node in the test, which is where the encoding is actually checked.

export const PROTOCOL = 1;

/** How many cars a room holds, counting yourself. A full mesh past this hurts. */
export const MAX_PLAYERS = 8;

/** Snapshots a second. Fifteen is smooth once interpolated and costs ~2 kB/s. */
export const SEND_HZ = 15;

/**
 * How far behind live we render other cars.
 *
 * Interpolation needs two snapshots to sit between, so we deliberately show the
 * past: at 15 Hz a packet lands every 67 ms, and 130 ms of delay leaves room for
 * one to be late without the car ever stopping to wait for it. This is the one
 * number that decides whether traffic looks smooth or teleports.
 */
export const INTERP_DELAY = 0.13;

/** Drop a car that has said nothing for this long — assume the tab froze. */
export const STALE_AFTER = 6.0;

// Flag bits packed into one snapshot field, rather than five JSON booleans.
export const FLAG = {
  BRAKING: 1,
  LIGHTS: 2,
  HANDBRAKE: 4,
  SKIDDING: 8,
  REVERSING: 16,
};

/**
 * The room everyone lands in.
 *
 * There is deliberately no code to type and no link to send: open the game and
 * you are already with everybody else. Typing a matching code into two browsers
 * is a step where things go wrong and, worse, where a failure is indistinguishable
 * from a bug — which is exactly what happened. One room removes the step.
 *
 * The cost is the ceiling: a full mesh holds eight cars, so the ninth player
 * finds it full. Lifting that means a relay, which means a server — see
 * README.md, « Passer à trente ou soixante joueurs ».
 */
export const DEFAULT_ROOM = 'MONTREAL';

/**
 * A room code a human can read aloud over the phone. Still here for `?room=`,
 * which is how you get a private session away from the public one.
 *
 * No vowels (so it cannot spell anything unfortunate), no 0/O/1/I/L (so nobody
 * mistypes it), six characters — about a billion rooms, which is more than
 * enough for a game whose rooms live for an afternoon.
 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function makeRoomCode(random = Math.random) {
  let out = '';
  for (let i = 0; i < 6; i++) out += ALPHABET[Math.floor(random() * ALPHABET.length)];
  return out;
}

/** Fold anything the player typed into a legal room code, or '' if hopeless. */
export function normaliseRoom(raw) {
  const clean = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return clean.length >= 3 && clean.length <= 12 ? clean : '';
}

/**
 * A name that can be shown above a car without thinking about it again.
 *
 * Strips control characters and the punctuation that turns text into markup,
 * then collapses runs of whitespace. It deliberately *keeps* accents, digits,
 * spaces, hyphens and apostrophes: a great many names in Montreal contain one
 * of those, and a filter that turns Jean-Guy into JeanGuy is a worse bug than
 * the injection it is guarding against — the name only ever reaches a canvas
 * and a textContent, and neither of those parses markup.
 */
export function normaliseName(raw) {
  const clean = String(raw || '')
    .replace(/[\u0000-\u001f\u007f<>&"'\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.slice(0, 16).trim();
}

/**
 * A stable colour for a name.
 *
 * Deliberately derived rather than chosen: two players who never spoke still get
 * different cars, and the colour survives a reconnect because it is a function
 * of the name and nothing else.
 */
export function colourForName(name, palette) {
  let h = 0x811c9dc5;
  const s = String(name || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return palette[(h >>> 0) % palette.length];
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

/** Round to a fixed number of decimals — JSON is the wire format, so digits are bytes. */
function round(v, places) {
  const f = 10 ** places;
  return Math.round(v * f) / f;
}

/**
 * Pack one car into the array that goes on the wire.
 *
 * An array, not an object: at fifteen packets a second to seven peers the key
 * names would be most of the traffic. Seven decimals of latitude is a
 * centimetre, which is far finer than anything the interpolator can show.
 *
 * @param {{lat,lon,yaw,speed,steer,spin,flags,seq}} s
 */
export function encodeState(s) {
  return [
    s.seq | 0,
    round(s.lat, 7),
    round(s.lon, 7),
    round(s.yaw, 3),
    round(s.speed, 2),
    round(s.steer, 3),
    round(s.spin, 2),
    s.flags | 0,
  ];
}

/** The inverse. Returns null for anything malformed — the wire is untrusted. */
export function decodeState(a) {
  if (!Array.isArray(a) || a.length < 8) return null;
  for (let i = 0; i < 8; i++) if (!Number.isFinite(a[i])) return null;
  if (Math.abs(a[1]) > 90 || Math.abs(a[2]) > 180) return null;
  return {
    seq: a[0] | 0,
    lat: a[1],
    lon: a[2],
    yaw: a[3],
    speed: a[4],
    steer: a[5],
    spin: a[6],
    flags: a[7] | 0,
  };
}

/**
 * Read the flags a remote car is carrying.
 * @param {number} flags
 */
export function unpackFlags(flags) {
  return {
    braking: !!(flags & FLAG.BRAKING),
    lights: !!(flags & FLAG.LIGHTS),
    handbrake: !!(flags & FLAG.HANDBRAKE),
    skidding: !!(flags & FLAG.SKIDDING),
    reversing: !!(flags & FLAG.REVERSING),
  };
}

/** Build the flag word for the local car. */
export function packFlags({ braking, lights, handbrake, skidding, reversing }) {
  return (braking ? FLAG.BRAKING : 0)
    | (lights ? FLAG.LIGHTS : 0)
    | (handbrake ? FLAG.HANDBRAKE : 0)
    | (skidding ? FLAG.SKIDDING : 0)
    | (reversing ? FLAG.REVERSING : 0);
}

// ---------------------------------------------------------------------------
// Interpolation
// ---------------------------------------------------------------------------

/** Shortest way round the circle from a to b. */
export function shortestAngle(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export function lerpAngle(a, b, t) {
  return a + shortestAngle(a, b) * t;
}

/**
 * A car's recent history, played back late.
 *
 * Samples are stamped on *arrival* rather than with the sender's clock. Two
 * browsers' clocks can disagree by seconds and neither is wrong, so trying to
 * reconcile them costs a whole synchronisation protocol to buy nothing: what the
 * interpolator actually needs is the spacing between packets, and arrival times
 * carry that already. Jitter is what the delay buffer above is for.
 */
export class StateBuffer {
  constructor(delay = INTERP_DELAY) {
    this.delay = delay;
    this.samples = [];      // {t, state}, oldest first
    this.lastSeq = -1;
  }

  /**
   * @param {object} state from decodeState
   * @param {number} now seconds, local monotonic clock
   * @returns {boolean} false if the packet was stale and got dropped
   */
  push(state, now) {
    // UDP-like transports reorder; an old snapshot arriving after a new one
    // would drag the car backwards, so it is simply thrown away. The wrap is
    // for a peer that reconnected and restarted its counter.
    if (this.lastSeq >= 0 && state.seq <= this.lastSeq && this.lastSeq - state.seq < 1000) {
      return false;
    }
    this.lastSeq = state.seq;
    this.samples.push({ t: now, state });
    // Two samples is the minimum to interpolate between; a handful more covers
    // a stall without letting the list grow for a peer nobody is watching.
    while (this.samples.length > 12) this.samples.shift();
    return true;
  }

  get last() {
    return this.samples.length ? this.samples[this.samples.length - 1].state : null;
  }

  get age() {
    return this.samples.length ? this.samples[this.samples.length - 1].t : -Infinity;
  }

  /**
   * Where the car is at render time, which is `delay` seconds in the past.
   *
   * Returns null until two samples exist. Past the newest sample it holds the
   * last pose rather than extrapolating: a car guessed forward through a corner
   * overshoots into a wall and then snaps back, and the snap is far more
   * noticeable than a car that pauses for a tenth of a second.
   */
  sample(now) {
    const n = this.samples.length;
    if (n === 0) return null;
    if (n === 1) return { ...this.samples[0].state, moving: false };

    const target = now - this.delay;
    if (target <= this.samples[0].t) return { ...this.samples[0].state, moving: false };

    for (let i = n - 1; i > 0; i--) {
      const a = this.samples[i - 1];
      const b = this.samples[i];
      if (target >= a.t && target <= b.t) {
        const span = b.t - a.t;
        const t = span > 1e-4 ? (target - a.t) / span : 1;
        return {
          seq: b.state.seq,
          lat: a.state.lat + (b.state.lat - a.state.lat) * t,
          lon: a.state.lon + (b.state.lon - a.state.lon) * t,
          yaw: lerpAngle(a.state.yaw, b.state.yaw, t),
          speed: a.state.speed + (b.state.speed - a.state.speed) * t,
          steer: a.state.steer + (b.state.steer - a.state.steer) * t,
          spin: a.state.spin + (b.state.spin - a.state.spin) * t,
          flags: b.state.flags,
          moving: true,
        };
      }
    }
    // Ahead of the newest sample: hold, and say so, so the wheels stop turning.
    return { ...this.samples[n - 1].state, moving: false };
  }
}
