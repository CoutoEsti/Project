// Module resolution hooks: the page's import map, for node.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const VENDOR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'vendor');

export async function resolve(specifier, context, next) {
  if (specifier === 'three') return { url: pathToFileURL(path.join(VENDOR, 'three.module.min.js')).href, shortCircuit: true };
  if (specifier.startsWith('three/addons/')) return { url: pathToFileURL(path.join(VENDOR, 'jsm', specifier.slice(13))).href, shortCircuit: true };
  return next(specifier, context);
}
