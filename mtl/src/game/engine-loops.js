// Recorded engine loops, mixed by revs and load.
//
// The standard way games make a real engine sound, and the one Unity and
// Unreal expect: a handful of short loops recorded at steady revs, on load
// (pulling) and off load (coasting). At any moment the two loops nearest the
// current revs play, crossfaded, each pitched by rpm / recorded rpm; throttle
// crossfades the on-load set against the off-load set.
//
// The loops and their revs live in a JSON file next to the sounds
// (sons/voiture-<id>/moteur.json, format in mtl/sons/LISEZMOI.md), so the same
// files and the same table import as-is into another engine. mixWeights() is
// the whole algorithm, kept free of Web Audio so it ports line for line.

const MIN_RATE = 0.5;
const MAX_RATE = 2;

/**
 * Gain and playback rate for every loop.
 * @param {{rpm:number, load:'on'|'off'|'both'}[]} loops
 * @param {number} rpm current revs
 * @param {number} throttle 0..1, already smoothed
 * @returns {{gain:number, rate:number}[]} same order as `loops`
 */
export function mixWeights(loops, rpm, throttle) {
  const out = loops.map((l) => ({ gain: 0, rate: clampRate(rpm / l.rpm) }));
  let on = loops.map((l, i) => i).filter((i) => loops[i].load !== 'off');
  let off = loops.map((l, i) => i).filter((i) => loops[i].load !== 'on');
  // A table with only one kind of loop still plays: that set covers both.
  if (!on.length) on = off;
  if (!off.length) off = on;
  const x = Math.max(0, Math.min(1, throttle));
  const sets = [
    [on, Math.sin(x * Math.PI / 2)],
    [off, Math.cos(x * Math.PI / 2)],
  ];
  for (const [set, setGain] of sets) {
    for (const [i, g] of neighbours(loops, set, rpm)) out[i].gain += g * setGain;
  }
  for (const o of out) o.gain = Math.min(1, o.gain);
  return out;
}

/** The two loops around `rpm` in one set, with equal-power weights. */
function neighbours(loops, set, rpm) {
  const sorted = [...set].sort((a, b) => loops[a].rpm - loops[b].rpm);
  if (!sorted.length) return [];
  if (rpm <= loops[sorted[0]].rpm) return [[sorted[0], 1]];
  const last = sorted[sorted.length - 1];
  if (rpm >= loops[last].rpm) return [[last, 1]];
  for (let k = 0; k < sorted.length - 1; k++) {
    const a = sorted[k];
    const b = sorted[k + 1];
    if (rpm <= loops[b].rpm) {
      const t = (rpm - loops[a].rpm) / (loops[b].rpm - loops[a].rpm);
      return [[a, Math.cos(t * Math.PI / 2)], [b, Math.sin(t * Math.PI / 2)]];
    }
  }
  return [];
}

function clampRate(r) {
  return Math.max(MIN_RATE, Math.min(MAX_RATE, r));
}

/** Check a parsed moteur.json; returns the loops or throws with the reason. */
export function parseTable(table) {
  const loops = table && Array.isArray(table.loops) ? table.loops : null;
  if (!loops || !loops.length) throw new Error('aucune boucle (« loops » vide)');
  return loops.map((l, i) => {
    if (typeof l.file !== 'string' || !l.file) throw new Error(`boucle ${i} : « file » manquant`);
    if (!(l.rpm > 0)) throw new Error(`boucle ${i} : « rpm » doit être un nombre positif`);
    const load = l.load ?? 'both';
    if (!['on', 'off', 'both'].includes(load)) throw new Error(`boucle ${i} : « load » vaut on, off ou both`);
    return { file: l.file, rpm: l.rpm, load, gain: l.gain ?? 1 };
  });
}

/**
 * Load a table and its sounds into `ctx`, playing into `destination`.
 * Resolves to null on any failure — a missing folder is the normal case and
 * the synthesised engine simply stays.
 */
export async function loadEngineLoops(ctx, url, destination) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const loops = parseTable(await res.json());
    const base = new URL(url, location.href);
    const buffers = await Promise.all(loops.map(async (l) => {
      const r = await fetch(new URL(l.file, base));
      if (!r.ok) throw new Error(`${l.file} introuvable`);
      const data = await r.arrayBuffer();
      // Callback form: older Safari has no promise-returning decodeAudioData.
      return new Promise((resolve, reject) => ctx.decodeAudioData(data, resolve, reject));
    }));
    return new EngineLoops(ctx, loops, buffers, destination);
  } catch (e) {
    console.warn(`sons moteur ignorés (${url}) :`, e.message || e);
    return null;
  }
}

export class EngineLoops {
  constructor(ctx, loops, buffers, destination) {
    this.ctx = ctx;
    this.loops = loops;
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(destination);
    // Every loop runs for the life of the car, silent until its turn: starting
    // and stopping sources is where sample engines click.
    this.voices = loops.map((l, i) => {
      const src = ctx.createBufferSource();
      src.buffer = buffers[i];
      src.loop = true;
      const g = ctx.createGain();
      g.gain.value = 0;
      src.connect(g).connect(this.out);
      // Staggered starts so identical loops never phase together.
      src.start(0, (i * 0.137) % Math.max(0.01, buffers[i].duration));
      return { src, g, gain: l.gain };
    });
  }

  update(rpm, throttle, level, t, smooth) {
    const w = mixWeights(this.loops, rpm, throttle);
    for (let i = 0; i < w.length; i++) {
      const v = this.voices[i];
      v.g.gain.setTargetAtTime(w[i].gain * v.gain, t, smooth);
      v.src.playbackRate.setTargetAtTime(w[i].rate, t, smooth);
    }
    this.out.gain.setTargetAtTime(level, t, smooth);
  }

  dispose() {
    for (const v of this.voices) {
      try { v.src.stop(); } catch { /* already stopped */ }
      v.src.disconnect();
    }
    this.out.disconnect();
  }
}
