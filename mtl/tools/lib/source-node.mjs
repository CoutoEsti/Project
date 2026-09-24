// The real data, read from mtl/data/ under node (the page fetches it instead).

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSource } from '../../src/map/source.js';

const DATA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');

export function fsReader(dir = DATA) {
  return async (name, kind) => {
    const buf = await fs.readFile(path.join(dir, name));
    if (kind === 'json') return JSON.parse(buf.toString('utf8'));
    if (kind === 'text') return buf.toString('utf8');
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  };
}

export function loadSourceNode(dir) {
  return loadSource(fsReader(dir));
}
