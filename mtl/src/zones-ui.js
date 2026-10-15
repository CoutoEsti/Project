// zones.html — draw the part of Montréal to play. A flat plan of the real
// streets and water, and shapes on top of it (polygon, freehand, rectangle,
// ellipse) and routes (a road kept alone, map/routes.js); their union is the zone. The zone leaves as ?forme=… in the page's
// address (shareable), in localStorage, and as a JSON to paste in carte.json.
//
// Frame: the game's own — metres, x east, n north, origin at Peel and
// Sainte-Catherine — so what is drawn here is what map/zones.js reads.

import * as G from './map/geom.js';
import { decodeRoads, decodeSurfaces, decodeBuildings, fetchReader } from './map/source.js';
import { ZONES, makeZone, normalizeShape, encodeShape, decodeShape } from './map/zones.js';
import { buildRoadGraph, pickRoad, routeBetween, twinRoute, roadHalf, ROUTE_MARGIN } from './map/routes.js';

const $ = (id) => document.getElementById(id);
const KEY = 'mtl.zones.v1';
const REGION = { x0: -5000, n0: -4200, x1: 7200, n1: 7200 };   // what the data covers

// --------------------------------------------------------------- state ------

const S = {
  shapes: [],               // { kind: 'poly' | 'rect' | 'ellipse', pts: [[x, n]…], p?: { cx, cn, w, h, rot } }
                            // or { kind: 'route', pts: centre line, h: half width, nom }
  sel: -1,
  tool: 'select',
  nom: '',
  view: { cx: 500, cn: 0, ppm: 0.1 },
  draft: null,              // a polygon being clicked out: { pts }, or a drag in progress
  drag: null,
  cursor: null,             // world position of the pointer
  from: null,               // route tool: where the next piece starts (a pickRoad point)
  pick: null,               // route tool: the street under the pointer
  preview: null,            // route tool: the way from `from` to `pick`
};
const data = { roads: [], water: [], green: [], quartiers: [], centroids: null, graph: null, ready: false };

// -------------------------------------------------------------- shapes ------

const rot2 = (x, n, a) => [x * Math.cos(a) - n * Math.sin(a), x * Math.sin(a) + n * Math.cos(a)];

function regen(sh) {
  const { cx, cn, w, h, rot } = sh.p;
  const local = sh.kind === 'rect'
    ? [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]]
    : Array.from({ length: 48 }, (_, i) => [Math.cos((i / 48) * Math.PI * 2) * w / 2, Math.sin((i / 48) * Math.PI * 2) * h / 2]);
  sh.pts = local.map(([x, n]) => { const r = rot2(x, n, rot); return [cx + r[0], cn + r[1]]; });
}

function paramShape(kind, cx, cn, w, h, rot = 0) {
  const sh = { kind, pts: [], p: { cx, cn, w, h, rot } };
  regen(sh);
  return sh;
}

/** The frame handles live in: centre, angle, half sizes. Polygons stay axis-aligned. */
function frame(sh) {
  if (sh.p) return { cx: sh.p.cx, cn: sh.p.cn, rot: sh.p.rot, hw: sh.p.w / 2, hh: sh.p.h / 2 };
  const b = G.ringBBox(sh.pts);
  return { cx: (b.x0 + b.x1) / 2, cn: (b.n0 + b.n1) / 2, rot: 0, hw: (b.x1 - b.x0) / 2, hh: (b.n1 - b.n0) / 2 };
}
const toWorld = (f, lx, ln) => { const r = rot2(lx, ln, f.rot); return [f.cx + r[0], f.cn + r[1]]; };
const toLocal = (f, x, n) => { const r = rot2(x - f.cx, n - f.cn, -f.rot); return r; };
const CORNERS = [[-1, -1], [1, -1], [1, 1], [-1, 1]];

function moveShape(sh, dx, dn) {
  for (const p of sh.pts) { p[0] += dx; p[1] += dn; }
  if (sh.p) { sh.p.cx += dx; sh.p.cn += dn; }
}

function polygons() {
  return S.shapes.filter((s) => s.kind !== 'route').map((s) => s.pts).filter((r) => r.length >= 3);
}

const isRoute = (sh) => sh && sh.kind === 'route';

function routeDist(sh, x, n) {
  let best = Infinity;
  for (let i = 0; i + 1 < sh.pts.length; i++) {
    const a = sh.pts[i], b = sh.pts[i + 1];
    best = Math.min(best, G.segDist2(x, n, a[0], a[1], b[0], b[1]).d2);
  }
  return Math.sqrt(best);
}

// --------------------------------------------------------------- view -------

const base = $('base'), over = $('over'), stage = $('stage');
const bctx = base.getContext('2d'), octx = over.getContext('2d');
let W = 0, H = 0, dpr = 1;
const sx = (x) => (x - S.view.cx) * S.view.ppm + W / 2;
const sy = (n) => H / 2 - (n - S.view.cn) * S.view.ppm;
const wx = (px) => (px - W / 2) / S.view.ppm + S.view.cx;
const wn = (py) => (H / 2 - py) / S.view.ppm + S.view.cn;

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
  if (!queued) { queued = true; requestAnimationFrame(frame_); }
}
function frame_() {
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
  S.view.ppm = Math.min(3, Math.max(0.012, S.view.ppm * k));
  S.view.cx = x - (px - W / 2) / S.view.ppm;
  S.view.cn = n + (py - H / 2) / S.view.ppm;
  invalidate();
}

// ---------------------------------------------------------- base layer ------

const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const dark = () => !matchMedia('(prefers-color-scheme: light)').matches;

function drawBase() {
  const c = bctx, d = dark();
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.fillStyle = d ? '#0f1620' : '#dfe6ec';
  c.fillRect(0, 0, W, H);
  const v = S.view, ppm = v.ppm;
  const x0 = wx(0), x1 = wx(W), n0 = wn(H), n1 = wn(0);
  // Greens, then water.
  c.fillStyle = d ? '#16261d' : '#c5d9c0';
  for (const g of data.green) {
    if (g.bb.x1 < x0 || g.bb.x0 > x1 || g.bb.n1 < n0 || g.bb.n0 > n1) continue;
    if ((g.bb.x1 - g.bb.x0) * ppm < 3 && (g.bb.n1 - g.bb.n0) * ppm < 3) continue;
    fillMulti(c, g.poly);
  }
  c.fillStyle = d ? '#12324a' : '#a9cbe3';
  for (const w of data.water) {
    if (w.bb.x1 < x0 || w.bb.x0 > x1 || w.bb.n1 < n0 || w.bb.n0 > n1) continue;
    fillMulti(c, w.poly);
  }
  // Grid every km, labelled from Peel / Sainte-Catherine.
  c.strokeStyle = d ? 'rgba(255,255,255,.06)' : 'rgba(0,0,0,.07)';
  c.lineWidth = 1;
  const step = ppm > 0.05 ? 500 : 1000;
  c.beginPath();
  for (let x = Math.ceil(x0 / step) * step; x <= x1; x += step) { c.moveTo(sx(x), 0); c.lineTo(sx(x), H); }
  for (let n = Math.ceil(n0 / step) * step; n <= n1; n += step) { c.moveTo(0, sy(n)); c.lineTo(W, sy(n)); }
  c.stroke();
  // Streets, the minor ones only once zoomed in.
  const classes = [
    ['minor', 0.03, 0.6, d ? '#3b4756' : '#b5bfca'],
    ['mid', 0, 0.9, d ? '#5a6878' : '#98a4b1'],
    ['major', 0, 1.6, d ? '#9a7a45' : '#c49a5a'],
  ];
  c.lineCap = 'round';
  for (const [key, minPpm, lw, col] of classes) {
    if (ppm < minPpm) continue;
    const list = data.roads[key];
    if (!list) continue;
    c.strokeStyle = col;
    c.lineWidth = lw * (ppm > 0.4 ? 2.2 : ppm > 0.15 ? 1.5 : 1);
    c.beginPath();
    for (let i = 0; i < list.length; i += 4) {
      const ax = list[i], an = list[i + 1], bx = list[i + 2], bn = list[i + 3];
      if ((ax < x0 && bx < x0) || (ax > x1 && bx > x1) || (an < n0 && bn < n0) || (an > n1 && bn > n1)) continue;
      c.moveTo(sx(ax), sy(an));
      c.lineTo(sx(bx), sy(bn));
    }
    c.stroke();
  }
  // The named zones, dashed, and the origin.
  c.setLineDash([6, 5]);
  c.strokeStyle = d ? 'rgba(255,255,255,.35)' : 'rgba(0,0,0,.35)';
  c.fillStyle = d ? 'rgba(255,255,255,.5)' : 'rgba(0,0,0,.55)';
  c.font = '11px system-ui, sans-serif';
  for (const z of Object.values(ZONES)) {
    if (z.box) {
      const [a, b, e, f] = z.box;
      c.strokeRect(sx(a), sy(f), (e - a) * ppm, (f - b) * ppm);
      c.fillText(z.nom, sx(a) + 4, sy(f) + 13);
      continue;
    }
    for (const ring of z.poly) {
      c.beginPath();
      ring.forEach(([x, n], i) => (i ? c.lineTo(sx(x), sy(n)) : c.moveTo(sx(x), sy(n))));
      c.closePath();
      c.stroke();
    }
    const [x, n] = z.poly[0].reduce((m, p) => (p[1] > m[1] ? p : m));
    c.fillText(z.nom, sx(x) + 4, sy(n) + 13);
  }
  c.setLineDash([]);
  c.beginPath();
  c.arc(sx(0), sy(0), 4, 0, Math.PI * 2);
  c.fill();
  c.fillText('Peel / Sainte-Catherine', sx(0) + 8, sy(0) + 4);
  // District names, when there is room for them.
  if (ppm > 0.045) {
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
  }
}

function fillMulti(c, multi) {
  c.beginPath();
  for (const poly of multi) {
    for (const ring of poly) {
      for (let i = 0; i < ring.length; i++) {
        const X = sx(ring[i][0]), Y = sy(ring[i][1]);
        if (i) c.lineTo(X, Y); else c.moveTo(X, Y);
      }
      c.closePath();
    }
  }
  c.fill('evenodd');
}

// --------------------------------------------------------- overlay ----------

const ACCENT = '#ffb03a';

function drawOver() {
  const c = octx;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, W, H);
  S.shapes.forEach((sh, i) => {
    if (isRoute(sh)) return;
    path(c, sh.pts);
    c.fillStyle = i === S.sel ? 'rgba(255,176,58,.30)' : 'rgba(255,176,58,.20)';
    c.fill();
    c.strokeStyle = ACCENT;
    c.lineWidth = i === S.sel ? 2.5 : 1.6;
    c.stroke();
  });
  // Routes: the corridor the zone keeps, and the road down its middle.
  c.lineCap = 'round'; c.lineJoin = 'round';
  S.shapes.forEach((sh, i) => {
    if (!isRoute(sh)) return;
    line(c, sh.pts);
    c.strokeStyle = i === S.sel ? 'rgba(255,176,58,.5)' : 'rgba(255,176,58,.32)';
    c.lineWidth = Math.max(4, sh.h * 2 * S.view.ppm);
    c.stroke();
    c.strokeStyle = ACCENT;
    c.lineWidth = i === S.sel ? 2.5 : 1.5;
    c.stroke();
  });
  if (S.tool === 'route') {
    if (S.preview) {
      c.setLineDash([6, 4]); c.strokeStyle = ACCENT; c.lineWidth = 2.5;
      for (const r of S.preview) { line(c, r.pts); c.stroke(); }
      c.setLineDash([]);
    }
    for (const p of [S.from, S.pick]) {
      if (!p) continue;
      c.beginPath(); c.arc(sx(p.x), sy(p.n), p === S.from ? 6 : 4, 0, Math.PI * 2);
      c.fillStyle = p === S.from ? ACCENT : '#fff'; c.fill();
      c.strokeStyle = '#1b1204'; c.lineWidth = 1.5; c.stroke();
    }
  }
  // The draft.
  const dr = S.draft;
  if (dr) {
    c.strokeStyle = ACCENT; c.lineWidth = 2; c.setLineDash([6, 4]);
    if (dr.kind === 'poly') {
      c.beginPath();
      dr.pts.forEach((p, i) => (i ? c.lineTo(sx(p[0]), sy(p[1])) : c.moveTo(sx(p[0]), sy(p[1]))));
      if (S.cursor) c.lineTo(sx(S.cursor[0]), sy(S.cursor[1]));
      c.stroke();
    } else if (dr.pts) {
      path(c, dr.pts);
      c.fillStyle = 'rgba(255,176,58,.15)'; c.fill(); c.stroke();
    }
    c.setLineDash([]);
    c.fillStyle = ACCENT;
    for (const p of dr.pts || []) { c.beginPath(); c.arc(sx(p[0]), sy(p[1]), 4, 0, Math.PI * 2); c.fill(); }
  }
  // Handles of the chosen shape.
  const sh = S.shapes[S.sel];
  if (sh && !isRoute(sh) && S.tool === 'select') {
    for (const h of handles(sh)) {
      c.beginPath();
      if (h.type === 'vertex') c.arc(h.px, h.py, 5, 0, Math.PI * 2);
      else if (h.type === 'rotate') c.arc(h.px, h.py, 7, 0, Math.PI * 2);
      else c.rect(h.px - 6, h.py - 6, 12, 12);
      c.fillStyle = h.type === 'rotate' ? ACCENT : '#fff';
      c.fill();
      c.strokeStyle = '#1b1204'; c.lineWidth = 1.5; c.stroke();
    }
    const f = frame(sh);
    const top = toWorld(f, 0, f.hh), tp = [sx(top[0]), sy(top[1])];
    const rp = rotateHandle(sh);
    c.strokeStyle = ACCENT; c.lineWidth = 1; c.beginPath(); c.moveTo(tp[0], tp[1]); c.lineTo(rp[0], rp[1]); c.stroke();
  }
}

function line(c, pts) {
  c.beginPath();
  pts.forEach((p, i) => (i ? c.lineTo(sx(p[0]), sy(p[1])) : c.moveTo(sx(p[0]), sy(p[1]))));
}

function path(c, pts) {
  c.beginPath();
  pts.forEach((p, i) => (i ? c.lineTo(sx(p[0]), sy(p[1])) : c.moveTo(sx(p[0]), sy(p[1]))));
  c.closePath();
}

/** Screen position of the rotation handle: above the frame's top edge, a fixed 30 px. */
function rotateHandle(sh) {
  const f = frame(sh);
  const top = toWorld(f, 0, f.hh);
  const up = rot2(0, 1, f.rot);
  return [sx(top[0]) + up[0] * 30, sy(top[1]) - up[1] * 30];
}

function handles(sh) {
  const out = [];
  const f = frame(sh);
  CORNERS.forEach(([a, b], i) => {
    const p = toWorld(f, a * f.hw, b * f.hh);
    out.push({ type: 'corner', i, px: sx(p[0]), py: sy(p[1]) });
  });
  const r = rotateHandle(sh);
  out.push({ type: 'rotate', px: r[0], py: r[1] });
  if (!sh.p) sh.pts.forEach((p, i) => out.push({ type: 'vertex', i, px: sx(p[0]), py: sy(p[1]) }));
  return out;
}

// ------------------------------------------------------------- pointers -----

const pointers = new Map();
let gesture = null;        // two fingers: pan and pinch

function pos(e) {
  const r = stage.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

over.addEventListener('pointerdown', (e) => {
  over.setPointerCapture(e.pointerId);
  const p = pos(e);
  pointers.set(e.pointerId, p);
  if (pointers.size === 2) {
    // A second finger: whatever was under way is abandoned, pan and pinch take over.
    S.drag = null;
    if (S.draft && S.draft.kind !== 'poly') S.draft = null;
    const [a, b] = [...pointers.values()];
    gesture = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), m: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
    invalidate();
    return;
  }
  if (pointers.size > 2) return;
  const pan = e.button === 1 || e.button === 2 || e.altKey || spaceDown;
  down(p, e, pan);
});

over.addEventListener('pointermove', (e) => {
  const p = pos(e);
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);
  S.cursor = [wx(p[0]), wn(p[1])];
  $('hover').textContent = `x ${Math.round(S.cursor[0])} m · n ${Math.round(S.cursor[1])} m`;
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
  if (S.tool === 'route' && !S.drag) hoverRoute(p);
  if (S.drag) move(p, e); else if (S.draft && S.draft.kind === 'poly') invalidate(false);
  over.style.cursor = S.drag ? 'grabbing' : S.tool === 'select' ? cursorFor(p) : 'crosshair';
});

function up(e) {
  const had = pointers.delete(e.pointerId);
  if (pointers.size < 2) gesture = null;
  if (!had) return;
  if (S.drag && !pointers.size) end(pos(e), e);
}
over.addEventListener('pointerup', up);
over.addEventListener('pointercancel', (e) => { pointers.delete(e.pointerId); gesture = null; S.drag = null; invalidate(); });
over.addEventListener('contextmenu', (e) => e.preventDefault());
over.addEventListener('wheel', (e) => {
  e.preventDefault();
  const p = pos(e);
  zoomAt(p[0], p[1], Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018)));
}, { passive: false });
over.addEventListener('dblclick', (e) => { if (S.tool === 'poly' && S.draft) finishPoly(true); e.preventDefault(); });

let spaceDown = false;
addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.code === 'Space') { spaceDown = true; e.preventDefault(); return; }
  const k = e.key.toLowerCase();
  if (k === 'escape' && S.tool === 'route' && S.from) { S.from = null; S.preview = null; invalidate(false); }
  else if (k === 'escape') { S.draft = null; S.drag = null; setTool('select'); invalidate(false); }
  else if (k === 'enter') finishPoly(false);
  else if ((k === 'delete' || k === 'backspace') && S.sel >= 0) removeSel();
  else if (k === 'v') setTool('select');
  else if (k === 'p') setTool('poly');
  else if (k === 'd') setTool('free');
  else if (k === 'r') setTool('rect');
  else if (k === 'o') setTool('ellipse');
  else if (k === 't') setTool('route');
  else if (k === 'z' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); undo(); }
});
addEventListener('keyup', (e) => { if (e.code === 'Space') spaceDown = false; });

const grab = () => (matchMedia('(pointer: coarse)').matches ? 16 : 10);

function pickHandle(sh, p) {
  if (isRoute(sh)) return null;
  let best = null, bd = grab();
  for (const h of handles(sh)) {
    const d = Math.hypot(h.px - p[0], h.py - p[1]);
    // Rotation and corners win over vertices when they overlap.
    const bias = h.type === 'vertex' ? 0.8 : 1;
    if (d < bd * bias || (d < bd && !best)) { best = h; bd = d; }
  }
  return best;
}

function shapeAt(x, n) {
  // Routes first: they lie over the polygons, and are thin.
  for (let i = S.shapes.length - 1; i >= 0; i--) {
    const sh = S.shapes[i];
    if (isRoute(sh) && routeDist(sh, x, n) <= Math.max(sh.h, grab() / S.view.ppm)) return i;
  }
  for (let i = S.shapes.length - 1; i >= 0; i--) if (!isRoute(S.shapes[i]) && G.pointInRing(x, n, S.shapes[i].pts)) return i;
  return -1;
}

function cursorFor(p) {
  const sh = S.shapes[S.sel];
  if (sh) {
    const h = pickHandle(sh, p);
    if (h) return h.type === 'rotate' ? 'alias' : 'pointer';
  }
  return shapeAt(wx(p[0]), wn(p[1])) >= 0 ? 'move' : 'grab';
}

// ------------------------------------------------------------- actions ------

let undoStack = [];
function snapshot() {
  undoStack.push(JSON.stringify({ shapes: S.shapes, sel: S.sel }));
  if (undoStack.length > 60) undoStack.shift();
}
function undo() {
  const last = undoStack.pop();
  if (!last) return;
  const o = JSON.parse(last);
  S.shapes = o.shapes; S.sel = Math.min(o.sel, S.shapes.length - 1);
  changed(false);
}

function down(p, e, pan) {
  const x = wx(p[0]), n = wn(p[1]);
  if (pan) { S.drag = { type: 'pan', from: p, cx: S.view.cx, cn: S.view.cn }; return; }
  if (S.tool === 'poly') {
    if (!S.draft) S.draft = { kind: 'poly', pts: [] };
    const first = S.draft.pts[0];
    if (first && S.draft.pts.length >= 3 && Math.hypot(sx(first[0]) - p[0], sy(first[1]) - p[1]) < grab()) { finishPoly(false); return; }
    const last = S.draft.pts[S.draft.pts.length - 1];
    if (!last || Math.hypot(sx(last[0]) - p[0], sy(last[1]) - p[1]) > 4) S.draft.pts.push([x, n]);
    $('finish').hidden = false;
    invalidate(false);
    return;
  }
  if (S.tool === 'route') { clickRoute(p); return; }
  if (S.tool === 'free') { S.drag = { type: 'free' }; S.draft = { kind: 'free', pts: [[x, n]] }; return; }
  if (S.tool === 'rect' || S.tool === 'ellipse') {
    S.drag = { type: 'box', a: [x, n] };
    S.draft = { kind: S.tool, pts: [] };
    return;
  }
  // Select.
  const sh = S.shapes[S.sel];
  if (sh) {
    const h = pickHandle(sh, p);
    if (h) {
      snapshot();
      const f = frame(sh);
      if (h.type === 'rotate') S.drag = { type: 'rotate', f, a0: Math.atan2(n - f.cn, x - f.cx), orig: clone(sh) };
      else if (h.type === 'corner') S.drag = { type: 'corner', i: h.i, f, orig: clone(sh) };
      else S.drag = { type: 'vertex', i: h.i };
      return;
    }
  }
  const hit = shapeAt(x, n);
  if (hit >= 0 && isRoute(S.shapes[hit])) {
    // A route follows the streets: chosen, never dragged off them.
    S.sel = hit;
    syncButtons();
    S.drag = { type: 'pan', from: p, cx: S.view.cx, cn: S.view.cn };
    invalidate(false);
  } else if (hit >= 0) {
    S.sel = hit;
    snapshot();
    S.drag = { type: 'move', from: [x, n], moved: false };
    syncButtons();
    invalidate(false);
  } else {
    S.sel = -1;
    syncButtons();
    S.drag = { type: 'pan', from: p, cx: S.view.cx, cn: S.view.cn };
    invalidate(false);
  }
}

const clone = (sh) => JSON.parse(JSON.stringify(sh));

function move(p, e) {
  const d = S.drag, x = wx(p[0]), n = wn(p[1]);
  const sh = S.shapes[S.sel];
  if (d.type === 'pan') {
    S.view.cx = d.cx - (p[0] - d.from[0]) / S.view.ppm;
    S.view.cn = d.cn + (p[1] - d.from[1]) / S.view.ppm;
    invalidate();
  } else if (d.type === 'move') {
    moveShape(sh, x - d.from[0], n - d.from[1]);
    d.from = [x, n]; d.moved = true;
    invalidate(false);
  } else if (d.type === 'vertex') {
    sh.pts[d.i] = [x, n];
    invalidate(false);
  } else if (d.type === 'rotate') {
    let da = Math.atan2(n - d.f.cn, x - d.f.cx) - d.a0;
    if (e.shiftKey) da = Math.round(da / (Math.PI / 12)) * (Math.PI / 12);
    const o = d.orig;
    if (sh.p) { sh.p.rot = o.p.rot + da; regen(sh); }
    else {
      sh.pts = o.pts.map(([px, pn]) => { const r = rot2(px - d.f.cx, pn - d.f.cn, da); return [d.f.cx + r[0], d.f.cn + r[1]]; });
    }
    invalidate(false);
  } else if (d.type === 'corner') {
    const f = d.f, [ca, cb] = CORNERS[d.i];
    const q = toLocal(f, x, n);
    const ox = -ca * f.hw, on = -cb * f.hh;                 // the opposite corner, fixed
    const nx0 = Math.min(q[0], ox), nx1 = Math.max(q[0], ox), nn0 = Math.min(q[1], on), nn1 = Math.max(q[1], on);
    const hw = Math.max(3, (nx1 - nx0) / 2), hh = Math.max(3, (nn1 - nn0) / 2);
    const c = toWorld(f, (nx0 + nx1) / 2, (nn0 + nn1) / 2);
    const o = d.orig;
    if (sh.p) { Object.assign(sh.p, { cx: c[0], cn: c[1], w: hw * 2, h: hh * 2 }); regen(sh); }
    else {
      const kx = hw / (f.hw || 1), kn = hh / (f.hh || 1);
      sh.pts = o.pts.map(([px, pn]) => [c[0] + (px - f.cx) * kx, c[1] + (pn - f.cn) * kn]);
    }
    invalidate(false);
  } else if (d.type === 'free') {
    const last = S.draft.pts[S.draft.pts.length - 1];
    if (Math.hypot(sx(last[0]) - p[0], sy(last[1]) - p[1]) > 3) S.draft.pts.push([x, n]);
    invalidate(false);
  } else if (d.type === 'box') {
    const [ax, an] = d.a;
    const cx = (ax + x) / 2, cn = (an + n) / 2, w = Math.abs(x - ax), h = Math.abs(n - an);
    const sh2 = paramShape(S.tool, cx, cn, Math.max(w, 1), Math.max(h, 1));
    S.draft.pts = sh2.pts; S.draft.p = sh2.p;
    invalidate(false);
  }
}

function end(p, e) {
  const d = S.drag;
  S.drag = null;
  if (d.type === 'free' && S.draft) {
    const tol = Math.max(2, 3 / S.view.ppm);
    let pts = G.simplify(S.draft.pts, tol);
    // Very long strokes: relax until the polygon is a hand's worth of vertices.
    for (let t = tol; pts.length > 160; t *= 1.4) pts = G.simplify(S.draft.pts, t);
    S.draft = null;
    if (pts.length >= 3 && Math.abs(G.ringArea(pts)) > 400) addShape({ kind: 'poly', pts });
    else invalidate(false);
  } else if (d.type === 'box' && S.draft) {
    const dr = S.draft;
    S.draft = null;
    if (dr.p && dr.p.w > 8 && dr.p.h > 8) addShape({ kind: S.tool, pts: dr.pts, p: dr.p });
    else invalidate(false);
  } else if (d.type === 'move' && !d.moved) {
    undoStack.pop();
  } else if (d.type !== 'pan') {
    changed();
  } else invalidate();
  if (d.type === 'move' && d.moved) changed();
}

function addShape(sh) {
  snapshot();
  S.shapes.push(sh);
  S.sel = S.shapes.length - 1;
  setTool('select');
  changed();
}

// ------------------------------------------------------------- routes -------

/** The street under a screen point, within a few pixels. */
function streetAt(p) {
  if (!data.graph) return null;
  return pickRoad(data.graph, wx(p[0]), wn(p[1]), Math.max(2, 14 / S.view.ppm));
}

const roadName = (r) => [r.name, r.ref].filter(Boolean).join(' · ') || 'rue sans nom';

function hoverRoute(p) {
  S.pick = streetAt(p);
  S.preview = null;
  if (S.pick) {
    const r = data.graph.edges[S.pick.e].road;
    $('hover').textContent = roadName(r) + (S.from ? ' — clic : garder jusqu’ici' : ' — clic : la route commence ici');
    if (S.from) {
      const way = routeBetween(data.graph, S.from, S.pick);
      if (way) S.preview = [way];
    }
  } else if (!data.graph) $('hover').textContent = 'Chargement des rues…';
  invalidate(false);
}

function clickRoute(p) {
  const at = streetAt(p);
  if (!at) return;
  if (!S.from) { S.from = at; invalidate(false); return; }
  const way = routeBetween(data.graph, S.from, at);
  if (!way) { $('warn').textContent = 'Pas de chemin par les rues entre ces deux points.'; return; }
  snapshot();
  const half = (w) => Math.ceil(Math.max(...w.edges.map((e) => roadHalf(e.road))) + ROUTE_MARGIN);
  const nom = roadName(data.graph.edges[S.from.e].road);
  S.shapes.push({ kind: 'route', pts: way.pts, h: half(way), nom });
  // A divided road: the other carriageway between the same two places.
  const twin = twinRoute(data.graph, S.from, at, way);
  if (twin) S.shapes.push({ kind: 'route', pts: twin.pts, h: half(twin), nom });
  S.sel = S.shapes.length - 1;
  S.from = at;       // the next click carries on from here
  S.preview = null;
  changed();
}

function finishPoly(fromDouble) {
  const dr = S.draft;
  if (!dr || dr.kind !== 'poly') return;
  // A double-click adds the same point twice: the last one is a duplicate.
  if (fromDouble && dr.pts.length > 3) dr.pts.pop();
  S.draft = null;
  $('finish').hidden = true;
  if (dr.pts.length >= 3) addShape({ kind: 'poly', pts: dr.pts });
  else invalidate(false);
}

function removeSel() {
  if (S.sel < 0) return;
  snapshot();
  S.shapes.splice(S.sel, 1);
  S.sel = -1;
  changed();
}

function setTool(t) {
  S.tool = t;
  if (t !== 'poly') { S.draft = S.draft && S.draft.kind === 'poly' ? null : S.draft; $('finish').hidden = true; }
  if (t !== 'route') { S.from = null; S.pick = null; S.preview = null; }
  for (const b of document.querySelectorAll('[data-tool]')) b.classList.toggle('on', b.dataset.tool === t);
  over.style.cursor = t === 'select' ? 'grab' : 'crosshair';
  invalidate(false);
}

function syncButtons() {
  const sh = S.shapes[S.sel];
  $('del').disabled = !sh;
  $('topoly').disabled = !(sh && sh.p);
}

document.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
$('finish').addEventListener('click', () => finishPoly(false));
$('del').addEventListener('click', removeSel);
$('topoly').addEventListener('click', () => {
  const sh = S.shapes[S.sel];
  if (!sh || !sh.p) return;
  snapshot();
  sh.kind = 'poly';
  delete sh.p;
  changed();
});
$('clear').addEventListener('click', () => {
  if (!S.shapes.length) return;
  snapshot();
  S.shapes = []; S.sel = -1;
  changed();
});
document.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => {
  const z = ZONES[b.dataset.preset];
  snapshot();
  if (z.poly) S.shapes = z.poly.map((pts) => ({ kind: 'poly', pts: pts.map((p) => p.slice()) }));
  else {
    const [x0, n0, x1, n1] = z.box;
    S.shapes = [paramShape('rect', (x0 + x1) / 2, (n0 + n1) / 2, x1 - x0, n1 - n0)];
  }
  S.sel = 0;
  if (!S.nom) { S.nom = z.nom; $('nom').value = S.nom; }
  changed();
  fit(x0, n0, x1, n1);
  invalidate();
}));
$('nom').addEventListener('input', () => { S.nom = $('nom').value; changed(false); });

// ------------------------------------------------------ persistence, stats --

function shape() {
  const round = (r) => r.map(([x, n]) => [Math.round(x), Math.round(n)]);
  const poly = polygons().map(round);
  const routes = S.shapes.filter(isRoute).map((sh) => ({ h: sh.h, pts: round(G.simplify(sh.pts, 0.5)) }));
  return routes.length ? { nom: S.nom.trim(), poly, routes } : { nom: S.nom.trim(), poly };
}
const filled = (f) => f.poly.length > 0 || !!f.routes;

let statTimer = 0;
function changed(pushHistory = true) {
  syncButtons();
  invalidate(false);
  const f = shape();
  try { localStorage.setItem(KEY, JSON.stringify({ nom: S.nom, shapes: S.shapes })); } catch (e) { /* private mode: not remembered */ }
  try {
    const code = filled(f) ? encodeShape(f) : '';
    history_replace(code);
    $('play').href = code ? `index.html?forme=${code}` : 'index.html';
  } catch (e) { /* the address is a courtesy */ }
  $('play').classList.toggle('primary', filled(f));
  clearTimeout(statTimer);
  statTimer = setTimeout(stats, 120);
}

function history_replace(code) {
  const url = new URL(location.href);
  if (code) url.searchParams.set('forme', code); else url.searchParams.delete('forme');
  url.searchParams.delete('zone');
  window.history.replaceState(null, '', url);
}

function stats() {
  const f = shape();
  const zone = filled(f) ? makeZone(f) : null;
  const fmt = (v, d = 0) => v.toLocaleString('fr-CA', { maximumFractionDigits: d, minimumFractionDigits: d });
  const w = [];
  if (!zone) {
    for (const id of ['s-area', 's-bld', 's-len', 's-roads']) $(id).textContent = '—';
    $('warn').textContent = filled(f) ? 'Forme sans surface.' : 'Dessine une forme ou choisis une route pour commencer.';
    return;
  }
  const km2 = zone.area / 1e6;
  $('s-area').textContent = fmt(km2, km2 < 10 ? 2 : 1);
  if (km2 > 60) w.push('Grande zone : le chargement sera long, surtout sur téléphone.');
  else if (km2 > 25) w.push('Zone assez grande pour un téléphone modeste.');
  if (km2 < 0.1) w.push('Très petite zone.');
  const [bx0, bn0, bx1, bn1] = zone.bbox;
  if (bx0 < REGION.x0 || bn0 < REGION.n0 || bx1 > REGION.x1 || bn1 > REGION.n1) w.push('Déborde des données : cette partie sera vide.');
  $('warn').textContent = w.join(' ');
  $('warn').classList.toggle('warn', w.length > 0);
  if (!data.ready) return;
  let len = 0, roads = 0;
  for (const r of data.wayList) {
    let hit = false;
    for (let i = 0; i + 1 < r.length; i++) {
      const mx = (r[i][0] + r[i + 1][0]) / 2, mn = (r[i][1] + r[i + 1][1]) / 2;
      if (zone.contains(mx, mn)) { len += Math.hypot(r[i + 1][0] - r[i][0], r[i + 1][1] - r[i][1]); hit = true; }
    }
    if (hit) roads++;
  }
  $('s-len').textContent = fmt(len / 1000, 1);
  $('s-roads').textContent = fmt(roads);
  if (data.centroids) {
    let b = 0;
    const c = data.centroids;
    for (let i = 0; i < c.length; i += 2) if (zone.contains(c[i], c[i + 1])) b++;
    $('s-bld').textContent = '~' + fmt(b);
  } else $('s-bld').textContent = '…';
}

$('export').addEventListener('click', () => {
  const f = shape();
  if (!filled(f)) return;
  const doc = { zone: { ...f, nom: f.nom || 'Ma zone' }, echelle: 100 };
  const blob = new Blob([JSON.stringify(doc, null, 1) + '\n'], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'carte.json';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});

$('link').addEventListener('click', async () => {
  const b = $('link');
  try {
    await navigator.clipboard.writeText(location.href);
    b.textContent = 'Lien copié';
  } catch (e) {
    window.prompt('Copie ce lien :', location.href);
  }
  setTimeout(() => { b.textContent = 'Copier le lien'; }, 1600);
});

// ---------------------------------------------------------------- loading ---

function load() {
  const params = new URLSearchParams(location.search);
  let init = null;
  if (params.get('forme')) init = decodeShape(params.get('forme'));
  else if (params.get('zone') && ZONES[params.get('zone')]) {
    const z = ZONES[params.get('zone')];
    init = { nom: z.nom, box: z.box, poly: z.poly && z.poly.map((r) => r.map((p) => p.slice())), routes: z.routes };
  }
  if (init) {
    S.nom = init.nom || '';
    S.shapes = init.box
      ? [paramShape('rect', (init.box[0] + init.box[2]) / 2, (init.box[1] + init.box[3]) / 2, init.box[2] - init.box[0], init.box[3] - init.box[1])]
      : init.poly.map((pts) => ({ kind: 'poly', pts }));
    for (const r of init.routes || []) S.shapes.push({ kind: 'route', pts: r.pts, h: r.h, nom: '' });
    return true;
  }
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (saved && Array.isArray(saved.shapes)) {
      S.nom = saved.nom || '';
      S.shapes = saved.shapes.filter((s) => Array.isArray(s.pts) && s.pts.length >= (isRoute(s) ? 2 : 3));
      return S.shapes.length > 0;
    }
  } catch (e) { /* nothing remembered */ }
  return false;
}

async function loadData() {
  const read = fetchReader('data/');
  try {
    const [rues, surf, quartiers] = await Promise.all([read('rues.json', 'json'), read('surfaces.json', 'json'), read('quartiers.json', 'json')]);
    const roads = decodeRoads(rues);
    const buckets = { major: [], mid: [], minor: [] };
    const MAJOR = new Set(['motorway', 'trunk', 'primary']), MID = new Set(['secondary', 'tertiary']);
    for (const r of roads) {
      const list = MAJOR.has(r.cls) ? buckets.major : MID.has(r.cls) ? buckets.mid : buckets.minor;
      for (let i = 0; i + 1 < r.pts.length; i++) list.push(r.pts[i][0], r.pts[i][1], r.pts[i + 1][0], r.pts[i + 1][1]);
    }
    data.roads = { major: Float32Array.from(buckets.major), mid: Float32Array.from(buckets.mid), minor: Float32Array.from(buckets.minor) };
    // Estimates count what the game builds: streets a car can drive, not the alleys' worth of footpaths.
    data.wayList = roads.filter((r) => r.cls !== 'pedestrian').map((r) => r.pts);
    data.graph = buildRoadGraph(roads);
    const s = decodeSurfaces(surf);
    const box = (poly) => { const b = G.ringBBox(poly[0][0]); for (const p of poly) { const c = G.ringBBox(p[0]); b.x0 = Math.min(b.x0, c.x0); b.n0 = Math.min(b.n0, c.n0); b.x1 = Math.max(b.x1, c.x1); b.n1 = Math.max(b.n1, c.n1); } return b; };
    data.water = s.water.map((w) => ({ poly: w.poly, bb: box(w.poly) }));
    data.green = s.green.map((g) => ({ poly: g.poly, bb: box(g.poly) }));
    data.quartiers = quartiers.map((q) => ({ nom: q.nom, x: q.x, n: q.n, type: q.type }));
    data.ready = true;
    invalidate();
    stats();
  } catch (e) {
    $('warn').textContent = 'Plan indisponible : les formes se dessinent quand même (' + e.message + ').';
  }
  // The buildings are the heavy file: the count waits for them, the plan does not.
  try {
    const buf = await read('batiments.bin', 'bin');
    const list = decodeBuildings(buf, []);
    const c = new Float32Array(list.length * 2);
    list.forEach((b, i) => {
      let x = 0, n = 0;
      for (const p of b.ring) { x += p[0]; n += p[1]; }
      c[i * 2] = x / b.ring.length; c[i * 2 + 1] = n / b.ring.length;
    });
    data.centroids = c;
    stats();
  } catch (e) { /* the estimate stays "…" */ }
}

resize();
const had = load();
$('nom').value = S.nom;
if (had) {
  const all = S.shapes.flatMap((s) => s.pts);
  const b = G.ringBBox(all);
  fit(b.x0, b.n0, b.x1, b.n1);
} else fit(...ZONES.centre.box);
setTool('select');
changed(false);
loadData();
if (typeof ResizeObserver !== 'undefined') new ResizeObserver(resize).observe(stage);
