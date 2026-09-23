// Export the map for Unity from the command line.
//
//   node mtl/tools/export.mjs            → mtl/export/*.glb + map.json
//   node mtl/tools/export.mjs --out DIR
//
// Same code as the E key in the page. Without a canvas in node the textures
// are left out: Unity maps the materials by name (see unity/README.md).

import fs from 'node:fs/promises';
import path from 'node:path';
import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const OUT = path.resolve(args.includes('--out') ? args[args.indexOf('--out') + 1] : path.join(ROOT, 'export'));

// The page's import map, for node: 'three' and 'three/addons/' → vendor/.
register(pathToFileURL(path.join(ROOT, 'tools', 'lib', 'three-hooks.mjs')));
// GLTFExporter reads its Blob back through FileReader, which node lacks.
globalThis.FileReader ??= class {
  readAsArrayBuffer(b) { b.arrayBuffer().then((r) => { this.result = r; this.onloadend?.(); }); }
  readAsDataURL(b) { b.arrayBuffer().then((r) => { this.result = `data:${b.type};base64,${Buffer.from(r).toString('base64')}`; this.onloadend?.(); }); }
};

const THREE = await import('three');
const { buildWorld } = await import('../src/world/build.js');
const { exportZones } = await import('../src/export/gltf.js');

const t0 = Date.now();
const world = await buildWorld(THREE, {});
const files = await exportZones(THREE, world);
await fs.mkdir(OUT, { recursive: true });
let total = 0;
for (const f of files) {
  const buf = typeof f.data === 'string' ? Buffer.from(f.data) : Buffer.from(f.data);
  total += buf.length;
  await fs.writeFile(path.join(OUT, f.name), buf);
  console.log(`${f.name.padEnd(28)} ${(buf.length / 1e6).toFixed(2)} Mo`);
}
console.log(`${files.length} fichiers, ${(total / 1e6).toFixed(1)} Mo, ${((Date.now() - t0) / 1000).toFixed(1)} s → ${OUT}`);
