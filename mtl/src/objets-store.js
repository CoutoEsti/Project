// The editor's working copy of the custom objects (objets.html), shared with
// the game for its preview (index.html?objets=local): the placements in
// localStorage, the .glb files in IndexedDB, keyed by their path in the file
// ('objets/maison.glb'). Only this browser sees them; what every player gets
// is mtl/objets.json and mtl/objets/, once exported and published.

const KEY = 'mtl.objets.v1';
const DB = 'mtl-objets';
const STORE = 'modeles';

export function readDoc() {
  try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; }
}

export function writeDoc(doc) {
  try { localStorage.setItem(KEY, JSON.stringify(doc)); return true; } catch (e) { return false; }
}

function open() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB indisponible')); return; }
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); resolve(req && req.result); };
    t.onerror = () => { db.close(); reject(t.error); };
  });
}

/** The model's bytes (ArrayBuffer), or null. */
export async function getModel(path) {
  try { return (await tx('readonly', (s) => s.get(path))) || null; } catch (e) { return null; }
}

export function putModel(path, bytes) {
  return tx('readwrite', (s) => s.put(bytes, path));
}

export function deleteModel(path) {
  return tx('readwrite', (s) => s.delete(path));
}

export async function listModels() {
  try { return (await tx('readonly', (s) => s.getAllKeys())) || []; } catch (e) { return []; }
}
