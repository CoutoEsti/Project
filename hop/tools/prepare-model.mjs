// Squeeze an authored glTF down to something a phone can actually load.
//
//   node hop/tools/prepare-model.mjs voiture.glb hop/models/car.glb [--max 2048]
//
// A showroom model is typically 50-150 MB: 4K PBR texture sets and a million
// triangles. Neither is the problem you think it is — the download hurts, but
// what actually kills the tab is video memory. One uncompressed 4096×4096 RGBA
// texture occupies 67 MB in VRAM, 89 MB once mipmapped; a five-map PBR set for
// a single car is therefore about 450 MB, and Safari on iOS will kill the page
// long before that.
//
// So, in order of how much each step wins:
//   1. resize textures (quadratic: halving the edge quarters the memory)
//   2. re-encode them as WebP (three.js reads EXT_texture_webp natively)
//   3. quantize vertex attributes, then Draco-compress the geometry
//   4. drop everything unreferenced

import fs from 'node:fs';
import path from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import {
  dedup, prune, weld, quantize, draco, textureCompress, resample, flatten, join,
} from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import sharp from 'sharp';

const args = process.argv.slice(2);
const input = args[0];
const output = args[1];
const maxIndex = args.indexOf('--max');
const MAX_TEXTURE = maxIndex >= 0 ? Number(args[maxIndex + 1]) : 2048;

if (!input || !output) {
  console.error('usage: node prepare-model.mjs <in.glb|in.gltf> <out.glb> [--max 2048]');
  process.exit(2);
}

const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} Mo`;

async function main() {
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      'draco3d.decoder': await draco3d.createDecoderModule(),
      'draco3d.encoder': await draco3d.createEncoderModule(),
    });

  const before = fs.statSync(input).size;
  const doc = await io.read(input);

  const meshes = doc.getRoot().listMeshes();
  let tris = 0;
  for (const mesh of meshes) {
    for (const prim of mesh.listPrimitives()) {
      const idx = prim.getIndices();
      const pos = prim.getAttribute('POSITION');
      tris += (idx ? idx.getCount() : pos ? pos.getCount() : 0) / 3;
    }
  }
  const textures = doc.getRoot().listTextures();
  console.log(`entrée : ${mb(before)}, ${Math.round(tris)} triangles, ${textures.length} textures`);
  for (const t of textures) {
    const size = t.getSize();
    console.log(`  · ${t.getName() || '(sans nom)'} ${size ? `${size[0]}×${size[1]}` : '?'} ${t.getMimeType()}`);
  }

  await doc.transform(
    dedup(),
    flatten(),
    join(),
    weld(),
    resample(),
    // Textures first: this is where the memory is.
    textureCompress({
      encoder: sharp,
      targetFormat: 'webp',
      resize: [MAX_TEXTURE, MAX_TEXTURE],
      quality: 82,
    }),
    // Quantize before Draco — Draco compresses integers far better than floats.
    quantize({
      quantizePosition: 14,
      quantizeNormal: 10,
      quantizeTexcoord: 12,
      quantizeColor: 8,
    }),
    draco({ method: 'edgebreaker' }),
    prune({ keepAttributes: false, keepLeaves: false }),
  );

  fs.mkdirSync(path.dirname(output), { recursive: true });
  await io.write(output, doc);

  const after = fs.statSync(output).size;
  console.log(`sortie : ${mb(after)} (${(100 - (after / before) * 100).toFixed(0)} % en moins)`);
  if (after > 8e6) {
    console.log('⚠ toujours au-dessus de 8 Mo : relance avec --max 1024');
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
