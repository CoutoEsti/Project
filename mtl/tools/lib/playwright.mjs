// Playwright, wherever it is installed: a local node_modules if there is one,
// otherwise the global install next to the running node binary. Nothing in
// this project needs `npm install`.

import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    const prefix = path.resolve(path.dirname(process.execPath), '..');
    const candidates = [
      path.join(prefix, 'lib', 'node_modules', 'playwright', 'index.mjs'),
      path.join(prefix, 'node_modules', 'playwright', 'index.mjs'),
    ];
    for (const c of candidates) {
      try {
        return await import(pathToFileURL(c).href);
      } catch { /* try the next one */ }
    }
    throw new Error('Playwright introuvable : npm i -g playwright (ou npx playwright) puis relancer.');
  }
}
