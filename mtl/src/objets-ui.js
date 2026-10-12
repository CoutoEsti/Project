// objets.html — put your own buildings and props (.glb) on the map. A flat
// plan of the real streets, water, parks and buildings; each model drawn by
// its outline, moved, turned and sized by hand. The game then levels the
// ground under it, clears the generated buildings it covers and gives it
// collisions (map/objets.js).
//
// The working copy stays in this browser (objets-store.js), which the game's
// preview reads (index.html?objets=local). « Exporter » gives the .zip to
// publish: objets.json and the objets/ folder, for mtl/.
//
// Frame: the game's own — metres, x east, n north, origin at Peel and
// Sainte-Catherine. A model's outline is measured here, once, so the game
// does not have to open it to know where it stands.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as G from './map/geom.js';
import { decodeRoads, decodeSurfaces, decodeBuildings, fetchReader } from './map/source.js';
import { ZONES, makeZone, zoneDef, resolveSettings } from './map/zones.js';
import { VERSION, normalizeObjets, placer, underObjets } from './map/objets.js';
import { landmarkFootprints } from './world/landmarks.js';
import { readDoc, writeDoc, getModel, putModel, deleteModel } from './objets-store.js';
import { zip } from './export/zip.js';

const $ = (id) => document.getElementById(id);
const ACCENT = '#ffb03a';
const HEAVY = 5 * 1024 * 1024;          // a model past this weighs on the first load
const fmt = (v, d = 0) => v.toLocaleString('fr-CA', { maximumFractionDigits: d, minimumFractionDigits: d });
const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

// --------------------------------------------------------------- state ------

const S = {
  objets: [],               // map/objets.js format
  sel: -1,
  view: { cx: 500, cn: 0, ppm: 0.1 },
  drag: null,
};
const models = new Map();   // modele path → { path, bytes, scene, info, solides: Map, error }
const data = { roads: null, water: [], green: [], quartiers: [], buildings: [], bgrid: new Map(), ready: false };
const BCELL = 250;
let homeZone = null, homeName = '';

// --------------------------------------------------------------- models -----

const loader = new GLTFLoader();

/** Read a .glb and measure it: its anchor (bottom centre), outline and size. */
async function analyze(bytes) {
  let gltf;
  try {
    gltf = await loader.parseAsync(bytes.slice(0), '');
  } catch (e) {
    const m = String(e && e.message);
    if (/draco/i.test(m)) throw new Error('compressé avec Draco : ré-exporte sans compression');
    throw new Error(`illisible (${m.slice(0, 80)})`);
  }
  const scene = gltf.scene || (gltf.scenes && gltf.scenes[0]);
  if (!scene) throw new Error('aucune scène dans le fichier');
  scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(scene);
  if (box.isEmpty()) throw new Error('aucune géométrie');
  const size = box.getSize(new THREE.Vector3());
  const origine = [round((box.min.x + box.max.x) / 2, 3), round(box.min.y, 3), round((box.min.z + box.max.z) / 2, 3)];
  const pts = [];
  const v = new THREE.Vector3();
  scene.traverse((o) => {
    if (!o.isMesh || !o.geometry || !o.geometry.attributes.position) return;
    const pos = o.geometry.attributes.position;
    const stride = Math.max(1, Math.ceil(pos.count / 40000));
    for (let i = 0; i < pos.count; i += stride) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      pts.push([v.x - origine[0], -(v.z - origine[2])]);
    }
  });
  const emprise = G.convexHull(pts).map(([x, n]) => [round(x), round(n)]);
  return { scene, info: { origine, emprise, dims: [size.x, size.y, size.z], hauteur: round(size.y) } };
}

/** What a car hits, at a given size: the model's base, from world/landmarks.js. */
function solidesFor(m, echelle) {
  const key = String(echelle);
  if (m.solides.has(key)) return m.solides.get(key);
  const o = m.info.origine;
  const wrap = new THREE.Group();
  wrap.add(m.scene);
  m.scene.position.set(-o[0], -o[1], -o[2]);
  wrap.scale.setScalar(echelle);
  let out = [];
  try {
    out = landmarkFootprints(THREE, [wrap]).map((f) => ({
      ring: f.ring.map(([x, n]) => [round(x / echelle), round(n / echelle)]), y0: 0, y1: round(f.y1 / echelle),
    })).filter((f) => f.ring.length >= 3);
  } catch (e) { out = []; }
  wrap.remove(m.scene);
  m.solides.set(key, out);
  return out;
}

async function registerModel(path, bytes, store = true) {
  const m = { path, bytes, scene: null, info: null, solides: new Map(), error: null };
  models.set(path, m);
  try {
    Object.assign(m, await analyze(bytes));
  } catch (e) {
    m.error = e.message;
  }
  if (store && !m.error) {
    try { await putModel(path, bytes); } catch (e) { status(`Modèle gardé pour cette session seulement : ${e.message}`, true); }
  }
  return m;
}

function slug(name) {
  const base = name.replace(/\.glb$/i, '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'modele';
  return base.slice(0, 40);
}

/** A free path for a new file: objets/<nom>.glb, numbered if taken by other bytes. */
function pathFor(name, bytes) {
  const base = slug(name);
  for (let k = 1; ; k++) {
    const p = `objets/${base}${k > 1 ? `-${k}` : ''}.glb`;
    const had = models.get(p);
    if (!had) return p;
    if (had.bytes.byteLength === bytes.byteLength) return p;      // same file again
  }
}

async function importFiles(files, at = null) {
  let placed = 0;
  for (const f of files) {
    if (/\.json$/i.test(f.name)) {
      try {
        const doc = JSON.parse(await f.text());
        const list = normalizeObjets(doc);
        if (S.objets.length && !confirm(`Remplacer tes ${S.objets.length} objet(s) par les ${list.length} de ${f.name} ?`)) continue;
        snapshot();
        S.objets = list;
        S.sel = -1;
        await ensureModels();
        changed();
        status(`${list.length} objet(s) importé(s) de ${f.name}.`);
      } catch (e) { status(`${f.name} : JSON illisible.`, true); }
      continue;
    }
    if (!/\.glb$/i.test(f.name)) { status(`${f.name} : seuls les .glb (glTF binaire) sont acceptés.`, true); continue; }
    const bytes = await f.arrayBuffer();
    const path = pathFor(f.name, bytes);
    status(`Lecture de ${f.name}…`);
    const m = models.get(path) && !models.get(path).error ? models.get(path) : await registerModel(path, bytes);
    if (m.error) { status(`${f.name} : ${m.error}`, true); renderModels(); continue; }
    status(`${f.name} ajouté${bytes.byteLength > HEAVY ? ` — lourd (${fmt(bytes.byteLength / 1048576, 1)} Mo), vise moins de 5 Mo` : ''}.`, bytes.byteLength > HEAVY);
    if (at) { place(path, at[0] + placed * 4, at[1]); placed++; }
  }
  renderModels();
}

/** Every model the placements name, from this browser, else from the site. */
async function ensureModels() {
  const paths = [...new Set(S.objets.map((o) => o.modele))].filter((p) => !models.has(p));
  for (const p of paths) {
    let bytes = await getModel(p), fresh = false;
    if (!bytes) {
      try {
        const r = await fetch(p);
        if (r.ok) { bytes = await r.arrayBuffer(); fresh = true; }
      } catch (e) { /* missing */ }
    }
    if (bytes) await registerModel(p, bytes, fresh);
    else models.set(p, { path: p, bytes: null, scene: null, info: null, solides: new Map(), error: 'fichier introuvable' });
  }
  renderModels();
}

// -------------------------------------------------------------- objects -----

function place(path, x, n) {
  const m = models.get(path);
  if (!m || m.error) return;
  snapshot();
  const name = path.replace(/^objets\//, '').replace(/\.glb$/, '');
  const big = Math.max(m.info.dims[0], m.info.dims[2]);
  const o = {
    id: `o-${Date.now().toString(36)}-${Math.floor(Math.random() * 1296).toString(36)}`,
    nom: name, modele: path, x: round(x), n: round(n), cap: 0,
    // A model hundreds of metres wide was almost surely authored in centimetres.
    echelle: big > 400 ? 0.01 : 1,
    dy: 0, aplanir: true,
    origine: m.info.origine, emprise: m.info.emprise, solides: [], hauteur: m.info.hauteur,
  };
  o.solides = solidesFor(m, o.echelle);
  S.objets.push(o);
  S.sel = S.objets.length - 1;
  changed();
}

/** The outline in the map frame, and the local box the handles sit on. */
function shapeOf(o) {
  const to = placer(o.x, o.n, o.cap, o.echelle);
  const E = o.emprise.length >= 3 ? o.emprise : [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]];
  const bb = G.ringBBox(E);
  return { ring: E.map(to), to, bb };
}

function objetAt(x, n, p) {
  for (let i = S.objets.length - 1; i >= 0; i--) {
    const o = S.objets[i], sh = shapeOf(o);
    if (G.pointInRing(x, n, sh.ring)) return i;
    // Small things: a few pixels around their anchor.
    if (Math.hypot(sx(o.x) - p[0], sy(o.n) - p[1]) < grab()) return i;
  }
  return -1;
}

let under = () => false;
function refreshUnder() {
  under = underObjets(S.objets.map((o) => ({ emprise: o.emprise.length >= 3 ? shapeOf(o).ring : [] })));
}

/** Generated buildings the object will clear. */
function clearedBy(o) {
  const u = underObjets([{ emprise: shapeOf(o).ring }]);
  let k = 0;
  for (const b of buildingsNear(o.x, o.n, 300)) if (u(b.cx, b.cn, b.ring)) k++;
  return k;
}

// --------------------------------------------------------------- view -------

const base = $('base'), over = $('over'), stage = $('stage');
const bctx = base.getContext('2d'), octx = over.getContext('2d');
let W = 0, H = 0, dpr = 1;
const sx = (x) => (x - S.view.cx) * S.view.ppm + W / 2;
const sy = (n) => H / 2 - (n - S.view.cn) * S.view.ppm;
const wx = (px) => (px - W / 2) / S.view.ppm + S.view.cx;
const wn = (py) => (H / 2 - py) / S.view.ppm + S.view.cn;
const grab = () => (matchMedia('(pointer: coarse)').matches ? 16 : 10);

function resize() {
  const r = stage.getBoundingClientRect();
  dpr = Math.min(devicePixelRatio || 1, 2);
  W = r.width; H = r.height;
  for (const c of [base, over]) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
  invalidate();
}
addEventListener('resize', resize);

let baseDirty = true, overDirty = true, queued = false;
function invalidate(baseToo = true) {
  if (baseToo) baseDirty = true;
  overDirty = true;
  if (!queued) { queued = true; requestAnimationFrame(frame); }
}
function frame() {
  queued = false;
  if (baseDirty) { drawBase(); baseDirty = false; }
  if (overDirty) { drawOver(); overDirty = false; }
}

function fit(x0, n0, x1, n1) {
  S.view.cx = (x0 + x1) / 2; S.view.cn = (n0 + n1) / 2;
  S.view.ppm = Math.min(W / (x1 - x0), H / (n1 - n0)) * 0.9;
}

function zoomAt(px, py, k) {
  const x = wx(px), n = wn(py);
  S.view.ppm = Math.min(12, Math.max(0.012, S.view.ppm * k));
  S.view.cx = x - (px - W / 2) / S.view.ppm;
  S.view.cn = n + (py - H / 2) / S.view.ppm;
  invalidate();
}

const dark = () => !matchMedia('(prefers-color-scheme: light)').matches;

function buildingsNear(x, n, r) {
  const out = [];
  for (let i = Math.floor((x - r) / BCELL); i <= Math.floor((x + r) / BCELL); i++) {
    for (let j = Math.floor((n - r) / BCELL); j <= Math.floor((n + r) / BCELL); j++) {
      const list = data.bgrid.get(`${i},${j}`);
      if (list) out.push(...list);
    }
  }
  return out;
}

function drawBase() {
  const c = bctx, d = dark();
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.fillStyle = d ? '#0f1620' : '#dfe6ec';
  c.fillRect(0, 0, W, H);
  const ppm = S.view.ppm;
  const x0 = wx(0), x1 = wx(W), n0 = wn(H), n1 = wn(0);
  const visible = (bb) => !(bb.x1 < x0 || bb.x0 > x1 || bb.n1 < n0 || bb.n0 > n1);
  c.fillStyle = d ? '#16261d' : '#c5d9c0';
  for (const g of data.green) if (visible(g.bb)) fillMulti(c, g.poly);
  c.fillStyle = d ? '#12324a' : '#a9cbe3';
  for (const w of data.water) if (visible(w.bb)) fillMulti(c, w.poly);
  // Buildings, once they are more than specks.
  if (ppm > 0.2) {
    const keep = [], gone = [];
    for (const b of buildingsNear((x0 + x1) / 2, (n0 + n1) / 2, Math.max(x1 - x0, n1 - n0) / 2 + BCELL)) {
      if (!visible(b.bb)) continue;
      (under(b.cx, b.cn, b.ring) ? gone : keep).push(b);
    }
    c.fillStyle = d ? '#26303c' : '#c9cfd6';
    c.beginPath();
    for (const b of keep) ringPath(c, b.ring);
    c.fill();
    if (ppm > 1) { c.strokeStyle = d ? '#34404e' : '#b3bbc4'; c.lineWidth = 1; c.stroke(); }
    c.fillStyle = d ? 'rgba(255,107,107,.45)' : 'rgba(198,40,40,.35)';
    c.beginPath();
    for (const b of gone) ringPath(c, b.ring);
    c.fill();
  }
  // Streets, the minor ones only once zoomed in.
  const classes = [
    ['minor', 0.03, 0.6, d ? '#3b4756' : '#b5bfca'],
    ['mid', 0, 0.9, d ? '#5a6878' : '#98a4b1'],
    ['major', 0, 1.6, d ? '#9a7a45' : '#c49a5a'],
  ];
  c.lineCap = 'round';
  for (const [key, minPpm, lw, col] of classes) {
    if (ppm < minPpm || !data.roads) continue;
    const list = data.roads[key];
    c.strokeStyle = col;
    // Close up, at about their real width.
    c.lineWidth = ppm > 0.6 ? Math.max(lw * 2.2, (key === 'major' ? 14 : key === 'mid' ? 10 : 7) * ppm * 0.6) : lw * (ppm > 0.15 ? 1.5 : 1);
    c.beginPath();
    for (let i = 0; i < list.length; i += 4) {
      const ax = list[i], an = list[i + 1], bx = list[i + 2], bn = list[i + 3];
      if ((ax < x0 && bx < x0) || (ax > x1 && bx > x1) || (an < n0 && bn < n0) || (an > n1 && bn > n1)) continue;
      c.moveTo(sx(ax), sy(an));
      c.lineTo(sx(bx), sy(bn));
    }
    c.stroke();
  }
  // The named zones, dashed.
  c.setLineDash([6, 5]);
  c.strokeStyle = d ? 'rgba(255,255,255,.35)' : 'rgba(0,0,0,.35)';
  c.fillStyle = d ? 'rgba(255,255,255,.5)' : 'rgba(0,0,0,.55)';
  c.font = '11px system-ui, sans-serif';
  c.lineWidth = 1;
  for (const z of Object.values(ZONES)) {
    const [a, b, e, f] = z.box;
    c.strokeRect(sx(a), sy(f), (e - a) * ppm, (f - b) * ppm);
    c.fillText(z.nom, sx(a) + 4, sy(f) + 13);
  }
  c.setLineDash([]);
  if (ppm > 0.045 && ppm < 1.5) {
    c.font = '12px system-ui, sans-serif';
    c.fillStyle = d ? 'rgba(230,235,241,.7)' : 'rgba(22,32,43,.7)';
    c.textAlign = 'center';
    for (const q of data.quartiers) {
      if (q.x < x0 || q.x > x1 || q.n < n0 || q.n > n1) continue;
      if (q.type !== 'neighborhood' && ppm < 0.09) continue;
      c.fillText(q.nom, sx(q.x), sy(q.n));
    }
    c.textAlign = 'start';
  }
  if (!data.ready) {
    c.fillStyle = d ? 'rgba(230,235,241,.7)' : 'rgba(22,32,43,.7)';
    c.font = '14px system-ui, sans-serif';
    c.fillText('Chargement du plan…', 16, H - 34);
  } else if (ppm <= 0.2) {
    c.fillStyle = d ? 'rgba(230,235,241,.55)' : 'rgba(22,32,43,.55)';
    c.font = '12px system-ui, sans-serif';
    c.fillText('Zoome pour voir les bâtiments', 16, H - 34);
  }
}

function ringPath(c, ring) {
  for (let i = 0; i < ring.length; i++) {
    const X = sx(ring[i][0]), Y = sy(ring[i][1]);
    if (i) c.lineTo(X, Y); else c.moveTo(X, Y);
  }
  c.closePath();
}

function fillMulti(c, multi) {
  c.beginPath();
  for (const poly of multi) for (const ring of poly) ringPath(c, ring);
  c.fill('evenodd');
}

function drawOver() {
  const c = octx;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, W, H);
  S.objets.forEach((o, i) => {
    const sh = shapeOf(o), on = i === S.sel;
    const m = models.get(o.modele);
    const broken = !m || m.error;
    c.beginPath();
    ringPath(c, sh.ring);
    c.fillStyle = broken ? 'rgba(255,107,107,.35)' : on ? 'rgba(255,176,58,.55)' : 'rgba(255,176,58,.35)';
    c.fill();
    c.strokeStyle = broken ? '#ff6b6b' : ACCENT;
    c.lineWidth = on ? 2.5 : 1.5;
    c.stroke();
    // The anchor and the way it faces.
    const p = [sx(o.x), sy(o.n)];
    const front = sh.to([0, Math.max(sh.bb.n1, 0.5)]);
    c.beginPath(); c.arc(p[0], p[1], 3.5, 0, Math.PI * 2); c.fillStyle = ACCENT; c.fill();
    c.beginPath(); c.moveTo(p[0], p[1]); c.lineTo(sx(front[0]), sy(front[1])); c.stroke();
    if (S.view.ppm > 0.6 || on) {
      c.font = '12px system-ui, sans-serif';
      c.fillStyle = dark() ? '#fff' : '#111';
      c.fillText(o.nom, p[0] + 7, p[1] - 7);
    }
  });
  const o = S.objets[S.sel];
  if (o) {
    for (const h of handles(o)) {
      c.beginPath();
      if (h.type === 'rotate') c.arc(h.px, h.py, 7, 0, Math.PI * 2); else c.rect(h.px - 6, h.py - 6, 12, 12);
      c.fillStyle = h.type === 'rotate' ? ACCENT : '#fff';
      c.fill();
      c.strokeStyle = '#1b1204'; c.lineWidth = 1.5; c.stroke();
    }
  }
}

function handles(o) {
  const sh = shapeOf(o);
  const tip = sh.to([0, Math.max(sh.bb.n1, 0.5)]);
  const a = (o.cap * Math.PI) / 180;
  const corner = sh.to([Math.max(sh.bb.x1, 0.5), Math.min(sh.bb.n0, -0.5)]);
  return [
    { type: 'rotate', px: sx(tip[0]) + Math.sin(a) * 26, py: sy(tip[1]) - Math.cos(a) * 26 },
    { type: 'scale', px: sx(corner[0]), py: sy(corner[1]) },
  ];
}

// ------------------------------------------------------------- pointers -----

const pointers = new Map();
let gesture = null;

function pos(e) {
  const r = stage.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

over.addEventListener('pointerdown', (e) => {
  over.setPointerCapture(e.pointerId);
  const p = pos(e);
  pointers.set(e.pointerId, p);
  if (pointers.size === 2) {
    S.drag = null;
    const [a, b] = [...pointers.values()];
    gesture = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), m: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
    return;
  }
  if (pointers.size > 2) return;
  down(p, e);
});

over.addEventListener('pointermove', (e) => {
  const p = pos(e);
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);
  $('hover').textContent = `x ${Math.round(wx(p[0]))} m · n ${Math.round(wn(p[1]))} m`;
  if (gesture && pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a[0] - b[0], a[1] - b[1]), m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    S.view.cx -= (m[0] - gesture.m[0]) / S.view.ppm;
    S.view.cn += (m[1] - gesture.m[1]) / S.view.ppm;
    if (gesture.d > 0) zoomAt(m[0], m[1], d / gesture.d);
    gesture = { d, m };
    invalidate();
    return;
  }
  if (S.drag) move(p, e);
  else over.style.cursor = cursorFor(p);
});

function up(e) {
  const had = pointers.delete(e.pointerId);
  if (pointers.size < 2) gesture = null;
  if (!had || !S.drag || pointers.size) return;
  const d = S.drag;
  S.drag = null;
  if (d.type === 'scale') {
    const o = S.objets[S.sel], m = models.get(o.modele);
    if (m && !m.error) o.solides = solidesFor(m, o.echelle);
  }
  if (d.type !== 'pan') changed(false);
}
over.addEventListener('pointerup', up);
over.addEventListener('pointercancel', (e) => { pointers.delete(e.pointerId); gesture = null; S.drag = null; invalidate(); });
over.addEventListener('contextmenu', (e) => e.preventDefault());
over.addEventListener('wheel', (e) => {
  e.preventDefault();
  const p = pos(e);
  zoomAt(p[0], p[1], Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018)));
}, { passive: false });

function pickHandle(o, p) {
  let best = null, bd = grab();
  for (const h of handles(o)) {
    const d = Math.hypot(h.px - p[0], h.py - p[1]);
    if (d < bd) { best = h; bd = d; }
  }
  return best;
}

function cursorFor(p) {
  const o = S.objets[S.sel];
  if (o) {
    const h = pickHandle(o, p);
    if (h) return h.type === 'rotate' ? 'alias' : 'nwse-resize';
  }
  return objetAt(wx(p[0]), wn(p[1]), p) >= 0 ? 'move' : 'grab';
}

function down(p, e) {
  const x = wx(p[0]), n = wn(p[1]);
  const pan = e.button === 1 || e.button === 2;
  const o = S.objets[S.sel];
  if (!pan && o) {
    const h = pickHandle(o, p);
    if (h) {
      snapshot();
      S.drag = h.type === 'rotate'
        ? { type: 'rotate' }
        : { type: 'scale', e0: o.echelle, d0: Math.max(1e-3, Math.hypot(h.px - sx(o.x), h.py - sy(o.n))) };
      return;
    }
  }
  const i = pan ? -1 : objetAt(x, n, p);
  if (i >= 0) {
    snapshot();
    S.sel = i;
    S.drag = { type: 'move', dx: S.objets[i].x - x, dn: S.objets[i].n - n };
    syncPanel();
    invalidate(false);
    return;
  }
  if (!pan && S.sel >= 0) { S.sel = -1; syncPanel(); invalidate(false); }
  S.drag = { type: 'pan', from: p, cx: S.view.cx, cn: S.view.cn };
}

function move(p, e) {
  const d = S.drag, o = S.objets[S.sel];
  const x = wx(p[0]), n = wn(p[1]);
  if (d.type === 'pan') {
    S.view.cx = d.cx - (p[0] - d.from[0]) / S.view.ppm;
    S.view.cn = d.cn + (p[1] - d.from[1]) / S.view.ppm;
    invalidate();
    return;
  }
  if (!o) return;
  if (d.type === 'move') {
    o.x = round(x + d.dx); o.n = round(n + d.dn);
  } else if (d.type === 'rotate') {
    // Snaps to every 15° when close; Shift turns freely.
    let cap = round((Math.atan2(x - o.x, n - o.n) * 180) / Math.PI, 1);
    if (!e.shiftKey && Math.abs(cap - Math.round(cap / 15) * 15) < 3) cap = Math.round(cap / 15) * 15;
    o.cap = ((cap % 360) + 360) % 360;
  } else if (d.type === 'scale') {
    const r = Math.hypot(p[0] - sx(o.x), p[1] - sy(o.n));
    o.echelle = Math.max(0.001, round(d.e0 * (r / d.d0), 3));
  }
  refreshUnder();
  syncPanel();
  invalidate();
}

addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  const k = e.key.toLowerCase();
  const o = S.objets[S.sel];
  if (k === 'z' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); undo(); return; }
  if (!o) return;
  if (k === 'delete' || k === 'backspace') { e.preventDefault(); removeSel(); return; }
  if (k === 'd' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); duplicate(); return; }
  const step = e.shiftKey ? 10 : 1;
  const nudge = { arrowleft: [-step, 0], arrowright: [step, 0], arrowup: [0, step], arrowdown: [0, -step] }[k];
  if (nudge) { e.preventDefault(); snapshot(); o.x = round(o.x + nudge[0]); o.n = round(o.n + nudge[1]); changed(false); return; }
  if (k === 'q' || k === 'e') { snapshot(); o.cap = (((o.cap + (k === 'e' ? 1 : -1) * (e.shiftKey ? 1 : 15)) % 360) + 360) % 360; changed(false); }
});

// ------------------------------------------------------------- actions ------

const undoStack = [];
function snapshot() {
  undoStack.push(JSON.stringify({ objets: S.objets, sel: S.sel }));
  if (undoStack.length > 80) undoStack.shift();
}
function undo() {
  const last = undoStack.pop();
  if (!last) return;
  const o = JSON.parse(last);
  S.objets = o.objets;
  S.sel = Math.min(o.sel, S.objets.length - 1);
  changed(false);
}

function removeSel() {
  if (S.sel < 0) return;
  snapshot();
  S.objets.splice(S.sel, 1);
  S.sel = -1;
  changed(false);
}

function duplicate() {
  const o = S.objets[S.sel];
  if (!o) return;
  snapshot();
  const big = Math.max(4, (G.ringBBox(o.emprise.length ? o.emprise : [[0, 0]]).x1 || 2) * o.echelle * 2.2);
  const copy = JSON.parse(JSON.stringify(o));
  copy.id = `o-${Date.now().toString(36)}-${Math.floor(Math.random() * 1296).toString(36)}`;
  copy.x = round(o.x + big);
  S.objets.push(copy);
  S.sel = S.objets.length - 1;
  changed(false);
}

let saveTimer = 0;
function changed() {
  refreshUnder();
  syncPanel();
  renderModels();
  invalidate();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 150);
}

function doc() {
  return {
    version: VERSION,
    objets: S.objets.map((o) => ({
      id: o.id, nom: o.nom, modele: o.modele,
      x: round(o.x), n: round(o.n), cap: round(o.cap, 1), echelle: round(o.echelle, 4), dy: round(o.dy), aplanir: !!o.aplanir,
      origine: o.origine, emprise: o.emprise, solides: o.solides, hauteur: o.hauteur,
    })),
  };
}

function save() {
  clearTimeout(saveTimer);
  if (!writeDoc(doc())) status('Navigateur en mode privé : rien n’est gardé ici, exporte avant de fermer.', true);
}

function status(text, warn = false) {
  $('status').textContent = text;
  $('status').classList.toggle('bad', warn);
}

/** The address of the game looking at (x, n), with the zone that holds it. */
function gameUrl(x, n) {
  let zone = '';
  if (homeZone && !homeZone.contains(x, n)) {
    const z = Object.entries(ZONES).find(([, v]) => makeZone(v).contains(x, n));
    if (z) zone = `&zone=${z[0]}`;
  }
  return `index.html?objets=local&voir=${Math.round(x)},${Math.round(n)}${zone}`;
}

function look(x, n) {
  save();
  window.open(gameUrl(x, n), '_blank', 'noopener');
}

function inSomeZone(x, n) {
  if (homeZone && homeZone.contains(x, n)) return homeName;
  const z = Object.values(ZONES).find((v) => makeZone(v).contains(x, n));
  return z ? z.nom : null;
}

// ---------------------------------------------------------------- panel -----

const F = {
  nom: $('f-nom'), x: $('f-x'), n: $('f-n'), cap: $('f-cap'), echelle: $('f-echelle'), dy: $('f-dy'), aplanir: $('f-aplanir'),
};

function syncPanel() {
  const o = S.objets[S.sel];
  $('sel').hidden = !o;
  $('count').textContent = S.objets.length
    ? `${S.objets.length} objet(s) placé(s).` : 'Aucun objet placé. Ajoute un .glb puis « Placer ».';
  if (!o) return;
  const active = document.activeElement;
  const set = (el, v) => { if (el !== active) el.value = v; };
  set(F.nom, o.nom);
  set(F.x, round(o.x, 1)); set(F.n, round(o.n, 1));
  set(F.cap, round(o.cap, 1)); set(F.echelle, o.echelle); set(F.dy, o.dy);
  F.aplanir.checked = !!o.aplanir;
  const m = models.get(o.modele);
  const info = [];
  if (m && m.info) {
    const [a, b, c] = m.info.dims.map((v) => v * o.echelle);
    info.push(`${fmt(a, 1)} × ${fmt(c, 1)} m au sol, ${fmt(b, 1)} m de haut`);
  }
  if (data.ready && data.buildings.length) {
    const k = clearedBy(o);
    info.push(k ? `retire ${k} bâtiment(s) généré(s)` : 'ne retire aucun bâtiment');
  }
  if (!o.solides.length) info.push('aucune collision (trop bas ou trop fin)');
  $('f-info').textContent = info.join(' · ');
  const w = [];
  if (!m || m.error) w.push(`Modèle ${o.modele} : ${m ? m.error : 'absent'}.`);
  const z = inSomeZone(o.x, o.n);
  if (!z) w.push('Hors des zones du jeu : il n’apparaîtra pas.');
  else if (z !== homeName) w.push(`Hors de la zone de départ : visible avec la zone ${z}.`);
  if (m && m.info && Math.max(m.info.dims[0], m.info.dims[2]) * o.echelle > 400) w.push('Très grand : le modèle est-il en centimètres ? Essaie l’échelle 0,01.');
  $('f-warn').textContent = w.join(' ');
}

function edit(fn, solids = false) {
  const o = S.objets[S.sel];
  if (!o) return;
  snapshot();
  fn(o);
  if (solids) {
    const m = models.get(o.modele);
    if (m && !m.error) o.solides = solidesFor(m, o.echelle);
  }
  changed(false);
}
const numIn = (el) => { const v = Number(el.value); return Number.isFinite(v) ? v : null; };
F.nom.addEventListener('input', () => { const o = S.objets[S.sel]; if (o) { o.nom = F.nom.value.slice(0, 60); changed(false); } });
F.x.addEventListener('change', () => { const v = numIn(F.x); if (v !== null) edit((o) => { o.x = v; }); });
F.n.addEventListener('change', () => { const v = numIn(F.n); if (v !== null) edit((o) => { o.n = v; }); });
F.cap.addEventListener('change', () => { const v = numIn(F.cap); if (v !== null) edit((o) => { o.cap = ((v % 360) + 360) % 360; }); });
F.echelle.addEventListener('change', () => { const v = numIn(F.echelle); if (v > 0) edit((o) => { o.echelle = v; }, true); });
F.dy.addEventListener('change', () => { const v = numIn(F.dy); if (v !== null) edit((o) => { o.dy = v; }); });
F.aplanir.addEventListener('change', () => edit((o) => { o.aplanir = F.aplanir.checked; }));
$('dup').addEventListener('click', duplicate);
$('del').addEventListener('click', removeSel);
$('look').addEventListener('click', () => { const o = S.objets[S.sel]; if (o) look(o.x, o.n); });
$('play').addEventListener('click', () => {
  const o = S.objets[S.sel] || S.objets[S.objets.length - 1];
  if (o) look(o.x, o.n); else look(S.view.cx, S.view.cn);
});

function renderModels() {
  const box = $('models');
  box.textContent = '';
  if (!models.size) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'Aucun modèle pour l’instant.';
    box.append(p);
    return;
  }
  for (const m of models.values()) {
    const used = S.objets.filter((o) => o.modele === m.path).length;
    const el = document.createElement('div');
    el.className = 'model';
    const b = document.createElement('b');
    b.textContent = m.path.replace(/^objets\//, '');
    b.title = m.path;
    const span = document.createElement('span');
    if (m.error) { span.textContent = m.error; span.classList.add('bad'); } else {
      const [x, y, z] = m.info.dims;
      const mb = m.bytes.byteLength / 1048576;
      span.textContent = `${fmt(x, 1)} × ${fmt(z, 1)} × ${fmt(y, 1)} m · ${fmt(mb, mb < 1 ? 2 : 1)} Mo${used ? ` · placé ${used}×` : ''}`;
      if (m.bytes.byteLength > HEAVY) span.classList.add('bad');
    }
    const row = document.createElement('div');
    row.className = 'row';
    if (!m.error) {
      const put = document.createElement('button');
      put.className = 'small';
      put.textContent = 'Placer';
      put.title = 'Au centre de la vue';
      put.addEventListener('click', () => place(m.path, S.view.cx, S.view.cn));
      row.append(put);
    }
    if (!used) {
      const rm = document.createElement('button');
      rm.className = 'small';
      rm.textContent = '×';
      rm.title = 'Retirer ce modèle';
      rm.addEventListener('click', async () => {
        models.delete(m.path);
        try { await deleteModel(m.path); } catch (e) { /* gone anyway */ }
        renderModels();
      });
      row.append(rm);
    }
    el.append(b, row, span);
    box.append(el);
  }
}

// ------------------------------------------------------- import / export ----

$('add').addEventListener('click', () => $('file').click());
$('import').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', async () => {
  const files = [...$('file').files];
  $('file').value = '';
  await importFiles(files);
});
stage.addEventListener('dragover', (e) => { e.preventDefault(); stage.classList.add('drop'); });
stage.addEventListener('dragleave', () => stage.classList.remove('drop'));
stage.addEventListener('drop', async (e) => {
  e.preventDefault();
  stage.classList.remove('drop');
  const p = pos(e);
  await importFiles([...e.dataTransfer.files], [wx(p[0]), wn(p[1])]);
});

$('export').addEventListener('click', () => {
  const d = doc();
  const files = [{ name: 'objets.json', data: JSON.stringify(d, null, 1) + '\n' }];
  const missing = [];
  for (const path of new Set(d.objets.map((o) => o.modele))) {
    const m = models.get(path);
    if (m && m.bytes) files.push({ name: path, data: m.bytes }); else missing.push(path);
  }
  const blob = new Blob([zip(files)], { type: 'application/zip' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'mtl-objets.zip';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  status(missing.length ? `Exporté, sans ${missing.join(', ')} (introuvable).`
    : `Exporté : objets.json et ${files.length - 1} modèle(s). Dézippe dans mtl/ et publie.`, missing.length > 0);
});

$('reset').addEventListener('click', async () => {
  if (!confirm('Remplacer ta copie de travail par les objets publiés ? Ce que tu n’as pas exporté sera perdu.')) return;
  snapshot();
  S.objets = normalizeObjets(await published());
  S.sel = -1;
  await ensureModels();
  changed(false);
  status('Version publiée rechargée.');
});

async function published() {
  try {
    const r = await fetch('objets.json', { cache: 'no-store' });
    if (r.ok) return await r.json();
  } catch (e) { /* none */ }
  return null;
}

// ---------------------------------------------------------------- loading ---

async function loadData() {
  const read = fetchReader('data/');
  try {
    const [rues, surf, quartiers] = await Promise.all([read('rues.json', 'json'), read('surfaces.json', 'json'), read('quartiers.json', 'json')]);
    const buckets = { major: [], mid: [], minor: [] };
    const MAJOR = new Set(['motorway', 'trunk', 'primary']), MID = new Set(['secondary', 'tertiary']);
    for (const r of decodeRoads(rues)) {
      const list = MAJOR.has(r.cls) ? buckets.major : MID.has(r.cls) ? buckets.mid : buckets.minor;
      for (let i = 0; i + 1 < r.pts.length; i++) list.push(r.pts[i][0], r.pts[i][1], r.pts[i + 1][0], r.pts[i + 1][1]);
    }
    data.roads = { major: Float32Array.from(buckets.major), mid: Float32Array.from(buckets.mid), minor: Float32Array.from(buckets.minor) };
    const s = decodeSurfaces(surf);
    const box = (poly) => {
      const b = G.ringBBox(poly[0][0]);
      for (const p of poly) { const c = G.ringBBox(p[0]); b.x0 = Math.min(b.x0, c.x0); b.n0 = Math.min(b.n0, c.n0); b.x1 = Math.max(b.x1, c.x1); b.n1 = Math.max(b.n1, c.n1); }
      return b;
    };
    data.water = s.water.map((w) => ({ poly: w.poly, bb: box(w.poly) }));
    data.green = s.green.map((g) => ({ poly: g.poly, bb: box(g.poly) }));
    data.quartiers = quartiers.map((q) => ({ nom: q.nom, x: q.x, n: q.n, type: q.type }));
    data.ready = true;
    invalidate();
  } catch (e) {
    status(`Plan indisponible (${e.message}) : les objets se placent quand même.`, true);
  }
  try {
    const list = decodeBuildings(await read('batiments.bin', 'bin'), []);
    for (const b of list) {
      let x = 0, n = 0;
      for (const p of b.ring) { x += p[0]; n += p[1]; }
      const item = { ring: b.ring, cx: x / b.ring.length, cn: n / b.ring.length, bb: G.ringBBox(b.ring) };
      const key = `${Math.floor(item.cx / BCELL)},${Math.floor(item.cn / BCELL)}`;
      let cell = data.bgrid.get(key);
      if (!cell) { cell = []; data.bgrid.set(key, cell); }
      cell.push(item);
      data.buildings.push(item);
    }
    syncPanel();
    invalidate();
  } catch (e) { /* the plan goes without buildings */ }
}

async function start() {
  resize();
  try {
    const r = await fetch('carte.json');
    const settings = resolveSettings(r.ok ? await r.json() : {}, null);
    const def = zoneDef(settings);
    homeZone = makeZone(def);
    homeName = def.nom || settings.zone;
  } catch (e) { homeZone = makeZone(ZONES.anneau); homeName = ZONES.anneau.nom; }
  const saved = readDoc();
  S.objets = normalizeObjets(saved || await published());
  if (S.objets.length) {
    const b = G.ringBBox(S.objets.map((o) => [o.x, o.n]));
    fit(b.x0 - 150, b.n0 - 150, b.x1 + 150, b.n1 + 150);
  } else {
    S.view = { cx: 0, cn: 0, ppm: 0.5 };       // Peel and Sainte-Catherine, buildings in view
  }
  changed(false);
  loadData();
  await ensureModels();
  changed(false);
  window.__objets = { ready: true, state: S, models, doc, place, importFiles };
}

start();
if (typeof ResizeObserver !== 'undefined') new ResizeObserver(resize).observe(stage);
