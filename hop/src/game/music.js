// The soundtrack, generated.
//
// There is no music file here and there is not going to be one. Anything worth
// listening to is either megabytes or licensed, and this whole game is meant
// to load in seconds off a static host. So the score is synthesised in the
// same Web Audio graph as the engine.
//
// The design is deliberately unambitious: a slow chord bed, a sparse melody on
// a pentatonic scale, and a soft pulse. Pentatonic is the trick — every note in
// the scale sounds acceptable over every chord, so a random walk cannot produce
// a wrong note, and a generative piece that never plays a wrong note can run
// for an hour without anyone reaching for the mute button.
//
// It also listens to the driving. Speed opens the filter and brings up the
// pulse; standing still, the piece thins out to almost nothing. That is what
// keeps it from feeling like a radio playing over the top of a game.

// Root notes of four chords, in semitones from A. A minor, F, C, G — the
// progression underneath about a third of all popular music, for good reason.
const PROGRESSION = [0, -4, 3, -2];

// A minor pentatonic, in semitones. Two octaves' worth.
const SCALE = [0, 3, 5, 7, 10, 12, 15, 17, 19, 22, 24];

const BASE_HZ = 110;    // A2

function hzFor(semitones) {
  return BASE_HZ * Math.pow(2, semitones / 12);
}

export class Music {
  /**
   * Shares the caller's AudioContext so there is only ever one, and hangs off
   * its own gain node so the engine's volume slider and this one stay separate.
   *
   * @param {object} opts {getContext:() => AudioContext|null}
   */
  constructor(opts = {}) {
    this.getContext = opts.getContext || (() => null);
    this.enabled = true;
    this.volume = 0.4;
    this.ctx = null;
    this.out = null;
    this.filter = null;
    this.pad = null;
    this._nextNote = 0;
    this._nextChord = 0;
    this._chord = 0;
    this._bar = 0;
    this._melodyStep = 4;
    this._energy = 0;
    this._seed = 1337;
  }

  _rand() {
    this._seed = (Math.imul(this._seed, 1664525) + 1013904223) >>> 0;
    return this._seed / 4294967296;
  }

  /** Build the graph the first time there is a context to build it in. */
  _ensure() {
    if (this.out) return true;
    const ctx = this.getContext();
    if (!ctx) return false;
    this.ctx = ctx;

    this.out = ctx.createGain();
    this.out.gain.value = 0;

    // One filter over everything. Sweeping it with speed is most of what makes
    // the piece feel connected to the car.
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 900;
    this.filter.Q.value = 0.6;

    // A long reverb-ish tail, faked with a feedback delay. A real convolver
    // needs an impulse response, which is a file, which is the thing we are
    // avoiding.
    const delay = ctx.createDelay(1.2);
    delay.delayTime.value = 0.37;
    const fb = ctx.createGain();
    fb.gain.value = 0.34;
    const wet = ctx.createGain();
    wet.gain.value = 0.42;
    delay.connect(fb).connect(delay);
    this.filter.connect(delay).connect(wet).connect(this.out);

    this.filter.connect(this.out);
    this.out.connect(ctx.destination);

    // The pad: three detuned triangles held forever, retuned at each chord
    // change. Holding them avoids the click that restarting oscillators gives
    // you, and a pad has no attack worth hearing anyway.
    this.pad = { gain: ctx.createGain(), oscs: [] };
    this.pad.gain.gain.value = 0;
    this.pad.gain.connect(this.filter);
    for (let i = 0; i < 3; i++) {
      const osc = ctx.createOscillator();
      osc.type = i === 2 ? 'sine' : 'triangle';
      osc.frequency.value = 110;
      osc.detune.value = (i - 1) * 7;
      const g = ctx.createGain();
      g.gain.value = i === 2 ? 0.22 : 0.3;
      osc.connect(g).connect(this.pad.gain);
      osc.start();
      this.pad.oscs.push(osc);
    }

    this._nextChord = ctx.currentTime;
    this._nextNote = ctx.currentTime + 1;
    return true;
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (!on && this.out && this.ctx) {
      this.out.gain.setTargetAtTime(0, this.ctx.currentTime, 0.4);
    }
  }

  setVolume(v) { this.volume = Math.max(0, Math.min(1, v)); }

  /**
   * @param {number} dt
   * @param {object} state {speed, rpm, redline, chain}
   */
  update(dt, state = {}) {
    if (!this.enabled) return;
    if (!this._ensure()) return;
    const ctx = this.ctx;
    if (ctx.state !== 'running') return;
    const t = ctx.currentTime;

    // Energy follows speed but lags well behind it, so a brief stop at a light
    // does not make the music duck and swell.
    const speedT = Math.min(1, (state.speed || 0) / 34);
    this._energy += (speedT - this._energy) * Math.min(1, dt * 0.5);

    this.out.gain.setTargetAtTime(this.volume * 0.5, t, 0.8);
    this.pad.gain.gain.setTargetAtTime(0.05 + this._energy * 0.05, t, 1.2);
    this.filter.frequency.setTargetAtTime(620 + this._energy * 2400, t, 0.9);

    // --- chord changes, every eight seconds ---------------------------------
    if (t >= this._nextChord) {
      this._chord = (this._chord + 1) % PROGRESSION.length;
      this._bar++;
      const root = PROGRESSION[this._chord];
      const voicing = [root, root + 7, root + 12];
      for (let i = 0; i < this.pad.oscs.length; i++) {
        this.pad.oscs[i].frequency.setTargetAtTime(hzFor(voicing[i]) / 2, t, 1.4);
      }
      this._nextChord = t + 8;
    }

    // --- melody -------------------------------------------------------------
    if (t >= this._nextNote) {
      // A random walk on the scale, biased back toward the middle so the line
      // does not wander off the top of the keyboard and stay there.
      const drift = this._rand();
      const pull = (this._melodyStep - 5) * 0.06;
      this._melodyStep += (drift - 0.5 - pull) > 0 ? 1 : -1;
      if (this._rand() < 0.22) this._melodyStep += this._rand() < 0.5 ? 2 : -2;
      this._melodyStep = Math.max(0, Math.min(SCALE.length - 1, this._melodyStep));

      const rest = this._rand() < 0.3 - this._energy * 0.18;
      if (!rest) {
        const semis = SCALE[this._melodyStep] + PROGRESSION[this._chord] + 12;
        this._pluck(hzFor(semis), 0.1 + this._energy * 0.08);
        // A fifth above, quietly, on about a third of the notes. Two voices
        // is the cheapest way to sound arranged rather than generated.
        if (this._rand() < 0.34) this._pluck(hzFor(semis + 7), 0.045);
      }
      // Faster the quicker you are going, but never metronomic.
      const beat = 1.05 - this._energy * 0.45;
      this._nextNote = t + beat * (0.75 + this._rand() * 0.7);
    }
  }

  /** One plucked note: a filtered triangle with a fast decay. */
  _pluck(freq, level) {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = freq;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.004, level), t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.7);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(freq * 6, t);
    lp.frequency.exponentialRampToValueAtTime(Math.max(220, freq * 1.6), t + 0.7);

    osc.connect(lp).connect(g).connect(this.filter);
    osc.start(t);
    osc.stop(t + 1.8);
  }

  dispose() {
    if (!this.pad) return;
    for (const o of this.pad.oscs) {
      try { o.stop(); } catch { /* already stopped */ }
    }
    this.pad = null;
    this.out = null;
  }
}
