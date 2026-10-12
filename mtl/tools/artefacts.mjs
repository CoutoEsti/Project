// The artefacts a driver sees: something solid standing on the asphalt (a
// wall, a barrier, a pillar or a building across a road or a street, at the
// height of the car on it), and holes (a place inside a road or a street
// where the wheels find nothing at its level).
//
//   node mtl/tools/artefacts.mjs                       → counts, the worst places
//   node mtl/tools/artefacts.mjs --zone coeur --all    → every place
//   node mtl/tools/artefacts.mjs --json f              → every place, written to f
//   node mtl/tools/artefacts.mjs --forme <code>        → a drawn zone (zones.html)
//
// Obstacles: every wall, barrier, fence, pillar and building edge, sampled
// every metre. A sample counts when it stands more than a metre inside a
// road or street ribbon and its height range covers a car on that surface
// (map/collide.js: 0.28 to 1.45 m over it). An obstacle on its own road's edge
// is not inside by a metre and does not count.
// Holes: across every road and street, a probe every 2 m along and every
// 1.5 m across, a metre in from the edges; a hole where the surface under the
// car (map/surface.js) is void or more than 0.6 m below the road there.
// Places are merged within 15 m. The measure itself is tools/lib/mesures.mjs.

import fs from 'node:fs';
import * as THREE from '../vendor/three.module.min.js';
import { buildWorld } from '../src/world/build.js';
import { loadSourceNode } from './lib/source-node.mjs';
import { decodeShape } from '../src/map/zones.js';
import { artefacts } from './lib/mesures.mjs';

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const settings = { zone: arg('--zone', 'anneau'), echelle: Number(arg('--echelle', 100)) };
if (arg('--forme', null)) Object.assign(settings, { zone: 'perso', forme: decodeShape(arg('--forme', null)) });
const ALL = args.includes('--all');
const IN = Number(arg('--in', 1.0));   // metres inside a ribbon before something counts

const world = await buildWorld(THREE, await loadSourceNode(), { settings, outside: false });
const scale = world.layout.map.scale || 1;
const places = artefacts(world, { IN });

// --- report -----------------------------------------------------------------
const sum = (l) => l.reduce((a, p) => a + p.len, 0);
console.log(`${settings.zone} à ${settings.echelle} % — ${places.obstacle.length} obstacles sur la chaussée (${sum(places.obstacle).toFixed(0)} m), `
  + `${places.hole.length} trous (${sum(places.hole).toFixed(0)} m²)`);
const kinds = new Map();
for (const p of places.obstacle) {
  const k = p.what.replace(/ (de|r?\d).*$/, '').replace(/ \d+.*$/, '');
  kinds.set(k, (kinds.get(k) || 0) + 1);
}
console.log('  obstacles par genre : ' + [...kinds].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', '));
const show = (l) => (ALL ? l : l.slice(0, 25)).forEach((p) => console.log(
  `  ${p.kind === 'hole' ? 'trou' : 'obstacle'} (${Math.round(p.x / scale)}, ${Math.round(p.n / scale)}) y ${p.y.toFixed(1)} — ${p.what} sur ${p.on}, ${p.len.toFixed(0)} ${p.kind === 'hole' ? 'm²' : 'm'}`));
places.obstacle.sort((a, b) => b.len - a.len);
places.hole.sort((a, b) => b.len - a.len);
show(places.obstacle);
show(places.hole);
if (arg('--json', null)) fs.writeFileSync(arg('--json', null), JSON.stringify(places, null, 1));
