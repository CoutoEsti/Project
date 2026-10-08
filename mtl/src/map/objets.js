// Custom objects: buildings and props a person made (Blender, Sketchfab…) and
// placed by hand in objets.html. They live in mtl/objets.json, next to their
// .glb files in mtl/objets/; the same file for every player, so every client
// builds the same world.
//
// The file carries everything the map needs without opening a model: where
// the object stands, its turn and size, and its outlines measured by the
// editor. So the ground can be levelled and the generated buildings cleared
// before anything is loaded, and under node too (tools/check.mjs).
//
// One object, as stored (real metres, the game's frame — origin at Peel and
// Sainte-Catherine, x "east", n "north"):
//   id, nom
//   modele    'objets/maison.glb', relative to mtl/
//   x, n      where the anchor stands
//   cap       degrees, clockwise from the street grid's north
//   echelle   the model's size factor (0.01 for a model authored in cm)
//   dy        metres above the ground (negative sinks it)
//   aplanir   level the ground under it
//   origine   [x, y, z] the anchor in model coordinates: the bottom centre
//   emprise   [[x, n]…] the outline of the whole model, model metres around
//             the anchor (x = model x, n = −model z), at echelle 1
//   solides   [{ ring, y0, y1 }] what a car hits: the model between 0.35 and
//             4 m over its base, same frame (see world/landmarks.js)
//   hauteur   model height, metres at echelle 1
//
// Model frame: glTF's own, +Y up; at cap 0 the model's −Z faces north.

import { pointInRing, ringBBox } from './geom.js';

export const VERSION = 1;
const BLEND = 20;               // real metres the levelled pad takes to rejoin the slope

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const ring = (r) => (Array.isArray(r) ? r.filter((p) => Array.isArray(p) && p.length >= 2).map((p) => [num(p[0]), num(p[1])]) : []);

/** The file's objects, cleaned: anything malformed is dropped, not fatal. */
export function normalizeObjets(doc) {
  const list = doc && Array.isArray(doc.objets) ? doc.objets : Array.isArray(doc) ? doc : [];
  const out = [];
  list.forEach((o, i) => {
    if (!o || typeof o.modele !== 'string' || !Number.isFinite(Number(o.x)) || !Number.isFinite(Number(o.n))) return;
    const e = num(o.echelle, 1);
    out.push({
      id: String(o.id || `objet-${i + 1}`),
      nom: String(o.nom || o.id || `Objet ${i + 1}`),
      modele: o.modele,
      x: num(o.x), n: num(o.n),
      cap: num(o.cap),
      echelle: e > 0 ? e : 1,
      dy: num(o.dy),
      aplanir: o.aplanir !== false,
      origine: Array.isArray(o.origine) ? [num(o.origine[0]), num(o.origine[1]), num(o.origine[2])] : [0, 0, 0],
      emprise: ring(o.emprise),
      solides: (Array.isArray(o.solides) ? o.solides : []).map((s) => ({ ring: ring(s && s.ring), y0: num(s && s.y0), y1: num(s && s.y1) }))
        .filter((s) => s.ring.length >= 3 && s.y1 > s.y0),
      hauteur: Math.max(0, num(o.hauteur)),
    });
  });
  return out;
}

/** A local outline point → map frame: turned clockwise by `cap`, sized by `k`, moved to (x, n). */
export function placer(x, n, cap, k) {
  const a = (cap * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return ([u, v]) => [x + (u * c + v * s) * k, n + (-u * s + v * c) * k];
}

/**
 * The objects of one zone at one scale, in the map frame: levels the ground
 * under them (before the ground mesh, the streets and the roads read it) and
 * says where each stands.
 *
 * @param list    normalizeObjets() output
 * @param terrain map/terrain.js, at the map's scale
 * @param s       the map's scale (echelle / 100)
 * @param inZone  (x, n) real metres → bool
 */
export function placeObjets(list, terrain, s, inZone = () => true) {
  const out = [];
  for (const o of list) {
    if (!inZone(o.x, o.n)) continue;
    const x = o.x * s, n = o.n * s, k = o.echelle * s;
    const to = placer(x, n, o.cap, k);
    const emprise = o.emprise.length >= 3 ? o.emprise.map(to) : [];
    let y;
    if (o.aplanir && emprise.length) {
      let r = 0;
      for (const [px, pn] of emprise) r = Math.max(r, Math.hypot(px - x, pn - n));
      // Past the outline by a mesh cell's diagonal: every triangle under it is level.
      y = terrain.flatten(x, n, r + 30 * s, BLEND * s);
    } else {
      // Not levelled: on the lowest ground it covers, so no corner floats.
      y = terrain.height(x, n);
      for (const [px, pn] of emprise) y = Math.min(y, terrain.height(px, pn));
    }
    y += o.dy * s;
    const solides = o.solides.map((q) => ({ ring: q.ring.map(to), y0: y + q.y0 * k - 0.5, y1: y + q.y1 * k }));
    // A model with no measured solid parts (written by hand): its whole outline.
    if (!solides.length && emprise.length && o.hauteur > 0) solides.push({ ring: emprise, y0: y - 0.5, y1: y + o.hauteur * k });
    out.push({ ...o, x, n, y, k, emprise, solides });
  }
  return out;
}

/** Whether a footprint (ring, centre) lies under any of the objects' outlines. */
export function underObjets(placed) {
  const boxes = placed.filter((o) => o.emprise.length >= 3).map((o) => ({ ring: o.emprise, bb: ringBBox(o.emprise) }));
  if (!boxes.length) return () => false;
  return (cx, cn, pts = []) => boxes.some(({ ring, bb }) => {
    if (cx < bb.x0 - 150 || cx > bb.x1 + 150 || cn < bb.n0 - 150 || cn > bb.n1 + 150) return false;
    return pointInRing(cx, cn, ring) || pts.some(([x, n]) => pointInRing(x, n, ring));
  });
}

/** The collision outlines, in the shape world.footprints has. */
export function objetFootprints(placed) {
  return placed.flatMap((o) => o.solides.map((q) => ({ id: o.id, ring: q.ring, y0: q.y0, y1: q.y1, objet: true })));
}
