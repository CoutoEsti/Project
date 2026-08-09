// Skill chains, in the Forza tradition.
//
// The design idea worth stating: points are not a reward for finishing, they
// are a reward for *how*. A chain accumulates while you keep doing something
// interesting, a multiplier climbs the longer you sustain it, and hitting
// anything drops the lot. That single rule turns an empty street into a
// playground, because suddenly there is a reason to thread the gap between two
// parked positions at speed instead of driving down the middle.
//
// Everything here reads state the vehicle already computes — slip angles,
// speed, impacts — plus one distance query against the collision grid. No new
// simulation, no assets.

const DRIFT_SLIP = 0.16;        // rad of rear slip before it counts as a drift
const DRIFT_MIN_SPEED = 8;      // m/s
const NEAR_MISS_MAX = 1.9;      // metres from the car's shell
const NEAR_MISS_SPEED = 11;     // m/s
const NEAR_MISS_COOLDOWN = 0.55;
const FAST_SPEED = 22;          // m/s, ≈80 km/h
const CHAIN_TIMEOUT = 2.6;      // seconds of nothing before the chain banks
const MULTIPLIER_STEP = 900;    // chain points per extra multiplier
const MAX_MULTIPLIER = 8;

export class Score {
  constructor(opts = {}) {
    this.onEvent = opts.onEvent || (() => {});
    this.reset();
  }

  reset() {
    this.total = 0;
    this.chain = 0;
    this.multiplier = 1;
    this.idle = 0;
    this.driftTime = 0;
    this.nearMissCooldown = 0;
    this.cleanDistance = 0;
    this.best = { drift: 0, chain: 0 };
    this.lastEvent = null;
    this.flash = 0;
  }

  /** Bank the chain into the total and start over. */
  bank(reason) {
    if (this.chain > 0) {
      const banked = Math.round(this.chain * this.multiplier);
      this.total += banked;
      this.onEvent({ type: 'banked', points: banked, multiplier: this.multiplier, reason });
    }
    this.chain = 0;
    this.multiplier = 1;
    this.driftTime = 0;
    this.idle = 0;
  }

  /**
   * Points awarded outright, outside the chain — a finished challenge, say.
   * They go straight to the total: a reward you can lose by crashing on the
   * way home is not a reward.
   */
  award(points, label) {
    const p = Math.round(points);
    if (p <= 0) return;
    this.total += p;
    this.lastEvent = { label: label || 'Bonus', points: p };
    this.flash = 1;
    this.onEvent({ type: 'awarded', points: p, label });
  }

  /** Lose everything not yet banked. */
  drop() {
    if (this.chain > 0) this.onEvent({ type: 'lost', points: Math.round(this.chain * this.multiplier) });
    this.chain = 0;
    this.multiplier = 1;
    this.driftTime = 0;
    this.idle = 0;
    this.cleanDistance = 0;
  }

  _add(points, label) {
    this.chain += points;
    this.idle = 0;
    this.multiplier = Math.min(
      MAX_MULTIPLIER, 1 + Math.floor(this.chain / MULTIPLIER_STEP),
    );
    if (label) {
      this.lastEvent = { label, points: Math.round(points) };
      this.flash = 1;
    }
    if (this.chain > this.best.chain) this.best.chain = this.chain;
  }

  /**
   * @param {number} dt
   * @param {object} v the Vehicle
   * @param {number} nearestObstacle metres to the closest solid thing, or Infinity
   */
  update(dt, v, nearestObstacle) {
    this.flash = Math.max(0, this.flash - dt * 2.2);
    this.nearMissCooldown = Math.max(0, this.nearMissCooldown - dt);

    // Hitting something is the one thing that costs you the chain outright.
    if (v.lastImpact > 1.5) {
      this.drop();
      this.onEvent({ type: 'crash' });
      return;
    }

    const speed = v.speed;
    this.cleanDistance += speed * dt;

    // --- drift ---------------------------------------------------------------
    const slip = Math.abs(v.slipRear);
    if (slip > DRIFT_SLIP && speed > DRIFT_MIN_SPEED) {
      this.driftTime += dt;
      // Points scale with how sideways and how fast — a slow slither is worth
      // almost nothing, a committed drift at speed is worth a lot.
      this._add(slip * speed * 26 * dt, null);
      if (this.driftTime > this.best.drift) this.best.drift = this.driftTime;
      if (this.driftTime > 1.2 && Math.floor(this.driftTime * 2) % 4 === 0) {
        this.lastEvent = { label: `Dérive ${this.driftTime.toFixed(1)} s`, points: null };
        this.flash = 1;
      }
    } else if (this.driftTime > 0.8) {
      this._add(this.driftTime * 55, `Dérive ${this.driftTime.toFixed(1)} s`);
      this.driftTime = 0;
    } else {
      this.driftTime = 0;
    }

    // --- near miss ------------------------------------------------------------
    if (nearestObstacle < NEAR_MISS_MAX && speed > NEAR_MISS_SPEED
        && this.nearMissCooldown <= 0) {
      const closeness = 1 - (nearestObstacle - 0.95) / (NEAR_MISS_MAX - 0.95);
      this._add(60 + closeness * 140 + speed * 3, 'Frôlé');
      this.nearMissCooldown = NEAR_MISS_COOLDOWN;
    }

    // --- sustained speed ------------------------------------------------------
    if (speed > FAST_SPEED) this._add((speed - FAST_SPEED) * 4 * dt, null);

    // --- clean run milestones -------------------------------------------------
    if (this.cleanDistance > 1000) {
      this.cleanDistance -= 1000;
      this._add(250, 'Kilomètre propre');
    }

    // --- banking --------------------------------------------------------------
    // Drive normally for a couple of seconds and the chain is yours for good.
    if (this.chain > 0) {
      this.idle += dt;
      if (this.idle > CHAIN_TIMEOUT) this.bank('timeout');
    }
  }

  /** Everything the HUD needs, in one object. */
  snapshot() {
    return {
      total: Math.round(this.total),
      chain: Math.round(this.chain),
      multiplier: this.multiplier,
      label: this.lastEvent && this.flash > 0 ? this.lastEvent : null,
      flash: this.flash,
      driftTime: this.driftTime,
    };
  }
}

export function formatPoints(n) {
  return Math.round(n).toLocaleString('fr-CA');
}
