// Before and after pictures of the junctions, for any change to the map: the
// fixed views of shots.mjs JUNCTIONS, shot on a committed revision (a git
// worktree) and on the working tree, then put side by side with what changed
// in red, and the share of the picture that changed.
//
//   node mtl/tools/avant-apres.mjs                       → HEAD against the working tree
//   node mtl/tools/avant-apres.mjs --base origin/main    → against another revision
//   node mtl/tools/avant-apres.mjs --only decarie-centre,turcot --out DIR --nuit
//
// The numbers of tools/filet.mjs say whether something moved; these say what
// it looks like. Slow (SwiftShader, twice), so not part of check.mjs.

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { shoot, JUNCTIONS } from './shots.mjs';
import { loadPlaywright } from './lib/playwright.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(ROOT, '..');
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const BASE = arg('--base', 'HEAD');
const OUT = path.resolve(arg('--out', path.join(ROOT, '.shots', 'avant-apres')));
const ONLY = arg('--only', null) ? arg('--only', null).split(',') : null;
const DAY = !args.includes('--nuit');   // daylight shows the shapes
const query = { zone: arg('--zone', 'anneau'), echelle: arg('--echelle', null) };
const git = (...a) => execFileSync('git', ['-C', REPO, ...a], { encoding: 'utf8' }).trim();

async function main() {
  const sha = git('rev-parse', '--short', BASE);
  const tree = path.join(os.tmpdir(), `mtl-avant-${sha}`);
  try { await fs.access(path.join(tree, 'mtl', 'index.html')); } catch {
    try { git('worktree', 'remove', '--force', tree); } catch { /* not there */ }
    git('worktree', 'add', '--detach', tree, sha);
  }
  console.log(`avant : ${BASE} (${sha}), après : la copie de travail`);
  const before = await shoot({ root: path.join(tree, 'mtl'), views: JUNCTIONS, out: path.join(OUT, 'avant'), day: DAY, only: ONLY, query, clean: true });
  const after = await shoot({ root: ROOT, views: JUNCTIONS, out: path.join(OUT, 'apres'), day: DAY, only: ONLY, query, clean: true });

  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const report = [];
  for (const a of before) {
    const b = after.find((s) => s.name === a.name);
    if (!b) continue;
    const [da, db] = await Promise.all([a.file, b.file].map(async (f) => `data:image/png;base64,${(await fs.readFile(f)).toString('base64')}`));
    const { png, changed } = await page.evaluate(compose, { da, db, name: a.name, base: `${BASE} (${sha})` });
    const file = path.join(OUT, `${a.name}${DAY ? '-jour' : ''}.png`);
    await fs.writeFile(file, Buffer.from(png.split(',')[1], 'base64'));
    report.push([a.name, changed]);
    console.log(`${a.name} : ${(changed * 100).toFixed(1)} % de l'image change — ${path.relative(process.cwd(), file)}`);
  }
  await browser.close();
  return report;
}

// In the page: before | after | after dimmed with the changed pixels in red.
async function compose({ da, db, name, base }) {
  const load = (src) => new Promise((ok) => { const i = new Image(); i.onload = () => ok(i); i.src = src; });
  const [A, B] = await Promise.all([load(da), load(db)]);
  const w = A.width, h = A.height;
  const px = (img) => { const c = new OffscreenCanvas(w, h), g = c.getContext('2d'); g.drawImage(img, 0, 0); return g.getImageData(0, 0, w, h); };
  const pa = px(A), pb = px(B);
  const diff = new ImageData(w, h);
  let changed = 0;
  for (let i = 0; i < pa.data.length; i += 4) {
    const d = Math.max(Math.abs(pa.data[i] - pb.data[i]), Math.abs(pa.data[i + 1] - pb.data[i + 1]), Math.abs(pa.data[i + 2] - pb.data[i + 2]));
    const hit = d > 24;
    if (hit) changed++;
    const grey = (pb.data[i] + pb.data[i + 1] + pb.data[i + 2]) / 9;
    diff.data[i] = hit ? 255 : grey; diff.data[i + 1] = hit ? 40 : grey; diff.data[i + 2] = hit ? 40 : grey; diff.data[i + 3] = 255;
  }
  const s = 0.5, W = Math.round(w * s), H = Math.round(h * s), top = 34;
  const c = document.createElement('canvas');
  c.width = W * 3; c.height = H + top;
  const g = c.getContext('2d');
  g.fillStyle = '#111'; g.fillRect(0, 0, c.width, c.height);
  const dc = new OffscreenCanvas(w, h); dc.getContext('2d').putImageData(diff, 0, 0);
  g.drawImage(A, 0, top, W, H); g.drawImage(B, W, top, W, H); g.drawImage(dc, 2 * W, top, W, H);
  g.fillStyle = '#eee'; g.font = '18px sans-serif';
  g.fillText(`${name} — avant : ${base}`, 10, 23);
  g.fillText('après', W + 10, 23);
  g.fillText(`changements : ${(changed / (w * h) * 100).toFixed(1)} %`, 2 * W + 10, 23);
  return { png: c.toDataURL('image/png'), changed: changed / (w * h) };
}

main().catch((e) => { console.error(e); process.exit(1); });
