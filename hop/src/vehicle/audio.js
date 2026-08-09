// Engine, tyres and wind, synthesised in the Web Audio graph.
//
// No samples, no loading, no scheduling. Every voice is a node that starts
// once and runs for the life of the page; driving only ever nudges parameters
// with setTargetAtTime. That is deliberate: sample-based engine loops are
// exactly where browser driving games pick up their clicks and stutters, and a
// synthesised engine cannot glitch on a buffer boundary because it has none.

const CYLINDERS = 4;

export class EngineAudio {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.enabled = true;
    this.volume = 0.7;
    this._nodes = null;
  }

  /** Must be called from a user gesture; browsers refuse otherwise. */
  async resume() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return false;
      try {
        this.ctx = new Ctx();
      } catch {
        return false;
      }
      this._build();
    }
    if (this.ctx.state === 'suspended') {
      try { await this.ctx.resume(); } catch { /* ignore */ }
    }
    this.ready = this.ctx.state === 'running';
    return this.ready;
  }

  _build() {
    const ctx = this.ctx;

    const master = ctx.createGain();
    master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 8;
    comp.attack.value = 0.004;
    comp.release.value = 0.18;
    master.connect(comp).connect(ctx.destination);

    // --- engine: a stack of saws an octave apart, shaped by a moving filter --
    const engineGain = ctx.createGain();
    engineGain.gain.value = 0;
    const engineFilter = ctx.createBiquadFilter();
    engineFilter.type = 'lowpass';
    engineFilter.frequency.value = 700;
    engineFilter.Q.value = 3.2;
    engineGain.connect(engineFilter).connect(master);

    const oscs = [];
    const partials = [
      { ratio: 0.5, type: 'sawtooth', gain: 0.42, detune: -6 },
      { ratio: 1.0, type: 'sawtooth', gain: 0.55, detune: 5 },
      { ratio: 1.5, type: 'square', gain: 0.14, detune: -9 },
      { ratio: 2.0, type: 'sawtooth', gain: 0.22, detune: 8 },
      { ratio: 3.0, type: 'triangle', gain: 0.10, detune: 0 },
    ];
    for (const p of partials) {
      const osc = ctx.createOscillator();
      osc.type = p.type;
      osc.frequency.value = 60 * p.ratio;
      osc.detune.value = p.detune;
      const g = ctx.createGain();
      g.gain.value = p.gain;
      osc.connect(g).connect(engineGain);
      osc.start();
      oscs.push({ osc, ratio: p.ratio });
    }

    // --- shared white noise, reused by wind and tyres -----------------------
    const noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    let seed = 22222;
    for (let i = 0; i < data.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      data[i] = (seed / 2147483648) - 1;
    }
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer;
    noise.loop = true;
    noise.start();

    const windFilter = ctx.createBiquadFilter();
    windFilter.type = 'bandpass';
    windFilter.frequency.value = 520;
    windFilter.Q.value = 0.7;
    const windGain = ctx.createGain();
    windGain.gain.value = 0;
    noise.connect(windFilter).connect(windGain).connect(master);

    const skidFilter = ctx.createBiquadFilter();
    skidFilter.type = 'bandpass';
    skidFilter.frequency.value = 1750;
    skidFilter.Q.value = 7;
    const skidGain = ctx.createGain();
    skidGain.gain.value = 0;
    noise.connect(skidFilter).connect(skidGain).connect(master);

    // --- impacts ------------------------------------------------------------
    const impactGain = ctx.createGain();
    impactGain.gain.value = 0.9;
    impactGain.connect(master);

    this._nodes = {
      master, engineGain, engineFilter, oscs,
      windGain, windFilter, skidGain, skidFilter, impactGain,
    };
  }

  /**
   * @param {object} state {rpm, throttle, speed, skid, load, redline}
   * @param {number} dt
   */
  update(state, dt) {
    if (!this.ready || !this._nodes) return;
    const n = this._nodes;
    const t = this.ctx.currentTime;
    const smooth = Math.max(0.02, Math.min(0.12, dt * 4));

    const target = this.enabled ? this.volume : 0;
    n.master.gain.setTargetAtTime(target, t, 0.05);
    if (!this.enabled) return;

    // Firing frequency of a four-stroke: rpm/60 × cylinders/2.
    const fundamental = Math.max(18, (state.rpm / 60) * (CYLINDERS / 2));
    for (const { osc, ratio } of n.oscs) {
      osc.frequency.setTargetAtTime(fundamental * ratio, t, smooth);
    }

    const rev = Math.min(1, state.rpm / (state.redline || 7000));
    const load = Math.min(1, state.throttle * 0.75 + rev * 0.45);
    n.engineGain.gain.setTargetAtTime(0.10 + load * 0.30, t, smooth);
    n.engineFilter.frequency.setTargetAtTime(420 + rev * 2600 + state.throttle * 900, t, smooth);

    const speed = Math.abs(state.speed);
    n.windGain.gain.setTargetAtTime(Math.min(0.16, (speed / 60) ** 1.8 * 0.20), t, 0.12);
    n.windFilter.frequency.setTargetAtTime(380 + speed * 12, t, 0.15);

    const screech = Math.min(1, state.skid) * Math.min(1, speed / 6);
    n.skidGain.gain.setTargetAtTime(screech * 0.16, t, 0.04);
    n.skidFilter.frequency.setTargetAtTime(1500 + screech * 900, t, 0.06);
  }

  /** A short filtered burst when the car hits something. */
  impact(strength) {
    if (!this.ready || !this._nodes || !this.enabled) return;
    const s = Math.min(1, strength / 14);
    if (s < 0.06) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(120 + s * 90, t);
    osc.frequency.exponentialRampToValueAtTime(45, t + 0.22);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.02, s * 0.55), t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);

    const bp = ctx.createBiquadFilter();
    bp.type = 'lowpass';
    bp.frequency.value = 900;

    osc.connect(bp).connect(g).connect(this._nodes.impactGain);
    osc.start(t);
    osc.stop(t + 0.32);
  }

  /**
   * The horn. Two detuned square waves a minor third apart, which is roughly
   * what a real car horn is — a single tone sounds like a test signal.
   */
  horn() {
    if (!this.ready || !this._nodes || !this.enabled) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16, t + 0.02);
    g.gain.setValueAtTime(0.16, t + 0.34);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.46);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2600;
    g.connect(lp).connect(this._nodes.master);

    for (const f of [370, 440]) {
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = f;
      osc.detune.value = f === 440 ? 6 : -6;
      const og = ctx.createGain();
      og.gain.value = 0.5;
      osc.connect(og).connect(g);
      osc.start(t);
      osc.stop(t + 0.5);
    }
  }

  /** A camera shutter: one click, made of filtered noise. */
  shutter() {
    if (!this.ready || !this._nodes || !this.enabled) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const len = Math.floor(ctx.sampleRate * 0.08);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let seed = 7717;
    for (let i = 0; i < len; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      // Two clicks: the mirror up, then the shutter closing.
      const env = Math.exp(-i / (ctx.sampleRate * 0.006))
        + 0.7 * Math.exp(-Math.abs(i - ctx.sampleRate * 0.035) / (ctx.sampleRate * 0.004));
      d[i] = ((seed / 2147483648) - 1) * env * 0.5;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2800;
    bp.Q.value = 1.1;
    const g = ctx.createGain();
    g.gain.value = 0.5;
    src.connect(bp).connect(g).connect(this._nodes.master);
    src.start(t);
  }

  setEnabled(on) { this.enabled = !!on; }
  setVolume(v) { this.volume = Math.max(0, Math.min(1, v)); }

  dispose() {
    if (this.ctx) {
      try { this.ctx.close(); } catch { /* ignore */ }
    }
    this.ctx = null;
    this.ready = false;
    this._nodes = null;
  }
}
