// Check the recorded engine loops before committing them:
//
//   node mtl/tools/sons.mjs
//
// For every sons/voiture-<id>/moteur.json: the table parses, every file is
// there, and each WAV loops cleanly — a jump between its last and first
// sample is the click you would hear once per loop.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTable } from '../src/game/engine-loops.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'sons');
let problems = 0;
const bad = (msg) => { problems++; console.log(`  ✗ ${msg}`); };

/** First and last samples of a PCM WAV, plus its peak, all as -1..1. */
function wavInfo(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let off = 12, fmt = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === 'data' && fmt) {
      if (fmt.format !== 1 || fmt.bits !== 16) return { ...fmt, unsupported: true };
      const frames = Math.floor(size / (2 * fmt.channels));
      const at = (i) => buf.readInt16LE(body + i * 2 * fmt.channels) / 32768;
      let peak = 0;
      for (let i = 0; i < frames; i++) peak = Math.max(peak, Math.abs(at(i)));
      return { ...fmt, seconds: frames / fmt.rate, first: at(0), second: at(1), last: at(frames - 1), peak };
    }
    off = body + size + (size & 1);
  }
  return null;
}

const dirs = (await fs.readdir(ROOT, { withFileTypes: true }).catch(() => []))
  .filter((d) => d.isDirectory()).map((d) => d.name).sort();
if (!dirs.length) console.log('aucun dossier dans mtl/sons/ — le moteur reste synthétisé partout');

for (const dir of dirs) {
  const table = path.join(ROOT, dir, 'moteur.json');
  console.log(`${dir}/moteur.json`);
  let loops;
  try {
    loops = parseTable(JSON.parse(await fs.readFile(table, 'utf8')));
  } catch (e) {
    bad(e.code === 'ENOENT' ? 'fichier absent' : e.message);
    continue;
  }
  for (const l of loops) {
    const file = path.join(ROOT, dir, l.file);
    const buf = await fs.readFile(file).catch(() => null);
    if (!buf) { bad(`${l.file} introuvable`); continue; }
    const label = `${l.file} (${l.rpm} tr/min, ${l.load})`;
    if (!l.file.toLowerCase().endsWith('.wav')) { console.log(`  ? ${label} : pas un WAV, bouclage non vérifié`); continue; }
    const w = wavInfo(buf);
    if (!w) { bad(`${label} : WAV illisible`); continue; }
    if (w.unsupported) { console.log(`  ? ${label} : WAV ${w.bits} bits, bouclage non vérifié`); continue; }
    // The seam is fine if it is no bigger than an ordinary step inside the sound.
    const seam = Math.abs(w.first - w.last);
    const step = Math.abs(w.second - w.first);
    const kb = Math.round(buf.length / 1024);
    const note = `${w.seconds.toFixed(2)} s, ${w.channels === 1 ? 'mono' : `${w.channels} canaux`}, ${kb} ko`;
    if (w.peak < 0.05) bad(`${label} : presque silencieux (crête ${w.peak.toFixed(3)})`);
    else if (seam > Math.max(0.02, step * 4) * Math.max(1, w.peak)) bad(`${label} : clic au raccord (saut de ${seam.toFixed(3)}) — ${note}`);
    else console.log(`  ✓ ${label} — ${note}`);
  }
}
console.log(problems ? `\n${problems} problème(s)` : '\nrien à redire');
process.exitCode = problems ? 1 : 0;
