#!/usr/bin/env node
// The City of Montréal's own 3D buildings (LOD2: real roofs and walls) for
// the boroughs it has modelled, read from its open data portal and written to
// mtl/data/lod2/, one file per tile, in the street-grid frame.
//
//   node mtl/tools/lod2.mjs                  # every borough (several GB read, a few minutes)
//   node mtl/tools/lod2.mjs --arr VM,PMR     # only these boroughs
//   node mtl/tools/lod2.mjs --force          # redo tiles already written
//
// Only the CityGML is read; the textures in the same archives are skipped
// as they stream past. Nothing is kept but mtl/data/lod2/. Licence: CC BY 4.0,
// Ville de Montréal.
//
// Where the city has no model, the game keeps Overture's extruded footprints.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import * as THREE from '../vendor/three.module.min.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, 'data', 'lod2');
const TMP = path.join(ROOT, '.cache', 'lod2');
const API = 'https://donnees.montreal.ca/api/3/action/package_show?id=';
const UA = 'mtl-lod2/1.0 (github.com/CoutoEsti/Project)';
// Newest model per borough.
const SETS = [
  { id: 'batiments-3d-2020-maquette-lod2-avec-textures', year: 2020, arr: ['VM', 'CDNNDG', 'O'] },
  { id: 'batiment-3d-2016-maquette-citygml-lod2-avec-textures2', year: 2016, arr: ['PMR', 'SO', 'V'] },
];

// The frame, as tools/extract.py.
const LAT0 = 45.5009, LON0 = -73.5733, EAST = 30.4 * Math.PI / 180;
const KX = 111320 * Math.cos(LAT0 * Math.PI / 180), KY = 110574;
const X0 = -5000, X1 = 7200, N0 = -4200, N1 = 7200;

const args = process.argv.slice(2);
const only = args.includes('--arr') ? args[args.indexOf('--arr') + 1].split(',') : null;
const force = args.includes('--force');

// ------------------------------------------------------------- projection --

// NAD83 / MTM zone 8 (EPSG:32188) to longitude, latitude: inverse transverse
// Mercator on GRS80 (Snyder, Map Projections, p. 63).
const A = 6378137, F = 1 / 298.257222101, E2 = F * (2 - F), EP2 = E2 / (1 - E2);
const K0 = 0.9999, LON_0 = -73.5 * Math.PI / 180, FE = 304800;
const E1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
function mtm8(e, nn) {
  const mu = (nn / K0) / (A * (1 - E2 / 4 - 3 * E2 * E2 / 64 - 5 * E2 ** 3 / 256));
  const p1 = mu + (1.5 * E1 - 27 * E1 ** 3 / 32) * Math.sin(2 * mu) + (21 * E1 * E1 / 16 - 55 * E1 ** 4 / 32) * Math.sin(4 * mu)
    + (151 * E1 ** 3 / 96) * Math.sin(6 * mu) + (1097 * E1 ** 4 / 512) * Math.sin(8 * mu);
  const s = Math.sin(p1), c = Math.cos(p1), t = Math.tan(p1);
  const C1 = EP2 * c * c, T1 = t * t, N1 = A / Math.sqrt(1 - E2 * s * s), R1 = A * (1 - E2) / (1 - E2 * s * s) ** 1.5;
  const D = (e - FE) / (N1 * K0);
  const lat = p1 - (N1 * t / R1) * (D * D / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * EP2) * D ** 4 / 24
    + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * EP2 - 3 * C1 * C1) * D ** 6 / 720);
  const lon = LON_0 + (D - (1 + 2 * T1 + C1) * D ** 3 / 6 + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * EP2 + 24 * T1 * T1) * D ** 5 / 120) / c;
  return [lon * 180 / Math.PI, lat * 180 / Math.PI];
}
function toGrid(e, nn) {
  const [lon, lat] = mtm8(e, nn);
  const ex = (lon - LON0) * KX, ny = (lat - LAT0) * KY;
  return [ex * Math.sin(EAST) + ny * Math.cos(EAST), -ex * Math.cos(EAST) + ny * Math.sin(EAST)];
}

// ------------------------------------------------------------------ fetch --

async function get(url, headers = {}, tries = 4) {
  for (let k = 0; ; k++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, redirect: 'manual' });
      if (r.status === 302 || r.status === 301) return r;
      if (r.ok) return r;
      throw new Error(`${r.status} ${url.slice(0, 120)}`);
    } catch (e) {
      if (k >= tries) throw e;
      await new Promise((res) => setTimeout(res, 2000 * 2 ** k));
    }
  }
}
/** The portal hands out signed storage links; resolve once, then range-read those. */
async function resolve(url) {
  const r = await get(url);
  return r.status >= 300 ? r.headers.get('location') : url;
}
async function range(url, a, b) {
  const r = await get(url, { Range: `bytes=${a}-${b}` });
  return Buffer.from(await r.arrayBuffer());
}
async function size(url) {
  const r = await get(url, { Range: 'bytes=0-0' });
  await r.arrayBuffer();
  return Number(r.headers.get('content-range').split('/')[1]);
}

// -------------------------------------------------------------------- zip --

/** Central directory of a zip, given a reader (offset, length) → Buffer. */
async function zipEntries(read, total) {
  const tailLen = Math.min(total, 65557 + 20);
  const tail = await read(total - tailLen, tailLen);
  let e = tail.length - 22;
  while (e >= 0 && tail.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error('zip : fin introuvable');
  let count = tail.readUInt16LE(e + 10), cdSize = tail.readUInt32LE(e + 12), cdOff = tail.readUInt32LE(e + 16);
  if (cdOff === 0xffffffff || count === 0xffff) {
    const loc = e - 20;
    if (tail.readUInt32LE(loc) !== 0x07064b50) throw new Error('zip64 : localisateur introuvable');
    const z64 = Number(tail.readBigUInt64LE(loc + 8));
    const rec = await read(z64, 56);
    count = Number(rec.readBigUInt64LE(32)); cdSize = Number(rec.readBigUInt64LE(40)); cdOff = Number(rec.readBigUInt64LE(48));
  }
  const cd = await read(cdOff, cdSize);
  const out = [];
  for (let o = 0, k = 0; k < count; k++) {
    const method = cd.readUInt16LE(o + 10);
    let comp = cd.readUInt32LE(o + 20), raw = cd.readUInt32LE(o + 24);
    const nl = cd.readUInt16LE(o + 28), xl = cd.readUInt16LE(o + 30), cl = cd.readUInt16LE(o + 32);
    let off = cd.readUInt32LE(o + 42);
    const name = cd.toString('utf8', o + 46, o + 46 + nl);
    // Zip64 extra field: the 0xffffffff values, in order.
    for (let x = o + 46 + nl; x < o + 46 + nl + xl;) {
      const id = cd.readUInt16LE(x), len = cd.readUInt16LE(x + 2);
      if (id === 1) {
        let p = x + 4;
        if (raw === 0xffffffff) { raw = Number(cd.readBigUInt64LE(p)); p += 8; }
        if (comp === 0xffffffff) { comp = Number(cd.readBigUInt64LE(p)); p += 8; }
        if (off === 0xffffffff) { off = Number(cd.readBigUInt64LE(p)); p += 8; }
      }
      x += 4 + len;
    }
    out.push({ name, method, comp, raw, off });
    o += 46 + nl + xl + cl;
  }
  return out;
}
async function dataStart(read, entry) {
  const h = await read(entry.off, 30);
  return entry.off + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
}

// --------------------------------------------------------------- citygml --

const KINDS = { WallSurface: 'wall', RoofSurface: 'roof', GroundSurface: 'ground' };

function* between(s, open, close, from = 0, to = s.length) {
  for (let i = s.indexOf(open, from); i >= 0 && i < to; i = s.indexOf(open, i + 1)) {
    const j = s.indexOf(close, i);
    if (j < 0 || j > to) return;
    yield [i, j + close.length];
    i = j;
  }
}
function posList(s, a, b) {
  const i = s.indexOf('>', s.indexOf('<gml:posList', a)) + 1;
  const j = s.indexOf('</gml:posList>', i);
  if (i <= 0 || j < 0 || j > b) return null;
  const v = s.slice(i, j).trim().split(/\s+/).map(Number);
  const pts = [];
  for (let k = 0; k + 2 < v.length; k += 3) {
    const [x, n] = toGrid(v[k], v[k + 1]);
    pts.push([x, n, v[k + 2]]);
  }
  const f = pts[0], l = pts[pts.length - 1];
  if (pts.length > 1 && Math.abs(f[0] - l[0]) < 1e-6 && Math.abs(f[1] - l[1]) < 1e-6 && Math.abs(f[2] - l[2]) < 1e-6) pts.pop();
  return pts.length >= 3 ? pts : null;
}

/** One cityObjectMember Building: its surfaces, as polygons with holes. */
function parseBuilding(s) {
  const surf = [];
  for (const [tag, kind] of Object.entries(KINDS)) {
    for (const [a, b] of between(s, `<bldg:${tag}`, `</bldg:${tag}>`)) {
      for (const [pa, pb] of between(s, '<gml:Polygon', '</gml:Polygon>', a, b)) {
        const ext = s.indexOf('<gml:exterior', pa);
        const outer = posList(s, ext, pb);
        if (!outer) continue;
        const holes = [];
        for (const [ia, ib] of between(s, '<gml:interior', '</gml:interior>', pa, pb)) {
          const h = posList(s, ia, ib);
          if (h) holes.push(h);
        }
        surf.push({ kind, outer, holes });
      }
    }
  }
  return surf;
}

/** Newell normal of a 3D ring. */
function normal(r) {
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < r.length; i++) {
    const a = r[i], b = r[(i + 1) % r.length];
    x += (a[1] - b[1]) * (a[2] + b[2]);
    y += (a[2] - b[2]) * (a[0] + b[0]);
    z += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return [x, y, z];
}

/** Triangles of a planar polygon, as indices into outer ++ holes (winding fixed by the caller). */
function triangles(outer, holes) {
  if (outer.length === 3 && !holes.length) return [[0, 1, 2]];
  const nrm = normal(outer);
  const ax = Math.abs(nrm[0]), ay = Math.abs(nrm[1]), az = Math.abs(nrm[2]);
  // Drop the dominant axis; keep the 2D winding the same as the 3D one seen along the normal.
  const [i, j, sgn] = az >= ax && az >= ay ? [0, 1, nrm[2]] : ax >= ay ? [1, 2, nrm[0]] : [2, 0, nrm[1]];
  const to2 = (r) => r.map((p) => new THREE.Vector2(p[i], sgn >= 0 ? p[j] : -p[j]));
  return THREE.ShapeUtils.triangulateShape(to2(outer), holes.map(to2));
}

/** A building's surfaces → rings on the ground plus indexed triangles. */
function group(surf) {
  const ground = surf.filter((p) => p.kind === 'ground');
  let zMin = Infinity, zMax = -Infinity;
  for (const p of surf) for (const q of p.outer) { zMin = Math.min(zMin, q[2]); zMax = Math.max(zMax, q[2]); }
  if (ground.length) { zMin = Infinity; for (const p of ground) for (const q of p.outer) zMin = Math.min(zMin, q[2]); }
  const rings = ground.map((p) => p.outer.map((q) => [q[0], q[1]]));
  const key = (q) => `${Math.round(q[0] * 10)},${Math.round(q[1] * 10)},${Math.round(q[2] * 10)}`;
  // Walls stand on these points: dropped a metre, so a wall reaches the
  // game's relief even where it lies a little lower than the city's survey.
  const foot = new Set();
  for (const p of ground) for (const q of p.outer) foot.add(key(q));
  const verts = [], index = new Map();
  const vid = (q) => {
    const k = key(q);
    let i = index.get(k);
    if (i === undefined) {
      i = verts.length / 3;
      verts.push(q[0], q[1], q[2] - zMin - (foot.has(k) ? 1 : 0));
      index.set(k, i);
    }
    return i;
  };
  const roof = [], wall = [];
  for (const p of surf) {
    if (p.kind === 'ground') continue;
    const all = p.outer.concat(...p.holes);
    let tris;
    try { tris = triangles(p.outer, p.holes); } catch { continue; }
    const into = p.kind === 'roof' ? roof : wall;
    const N = normal(p.outer);
    for (let [a, b, c] of tris) {
      // Each triangle faces the way its polygon does (out of the building).
      const P = all[a], Q = all[b], R = all[c];
      const ux = Q[0] - P[0], uy = Q[1] - P[1], uz = Q[2] - P[2], vx = R[0] - P[0], vy = R[1] - P[1], vz = R[2] - P[2];
      if ((uy * vz - uz * vy) * N[0] + (uz * vx - ux * vz) * N[1] + (ux * vy - uy * vx) * N[2] < 0) [b, c] = [c, b];
      const ia = vid(all[a]), ib = vid(all[b]), ic = vid(all[c]);
      if (ia !== ib && ib !== ic && ia !== ic) into.push(ia, ib, ic);
    }
  }
  return { rings, verts, roof, wall, h: zMax - zMin };
}

// ------------------------------------------------------------------ write --

function encode(groups) {
  const parts = [];
  const head = Buffer.alloc(12);
  head.write('MTL2', 0, 'ascii');
  head.writeUInt32LE(1, 4);
  head.writeUInt32LE(groups.length, 8);
  parts.push(head);
  for (const g of groups) {
    const ax = Math.round(g.rings[0][0][0] * 10), an = Math.round(g.rings[0][0][1] * 10);
    const nv = g.verts.length / 3;
    const big = nv > 65535;
    let len = 1 + 2 + 8 + 2 + 4 + nv * 6 + 8 + (g.roof.length + g.wall.length) * (big ? 4 : 2);
    for (const r of g.rings) len += 2 + r.length * 4;
    const b = Buffer.alloc(len);
    let o = 0;
    o = b.writeUInt8(big ? 1 : 0, o);
    o = b.writeUInt16LE(g.rings.length, o);
    o = b.writeInt32LE(ax, o); o = b.writeInt32LE(an, o);
    o = b.writeUInt16LE(Math.min(65535, Math.round(g.h * 10)), o);
    for (const r of g.rings) {
      o = b.writeUInt16LE(r.length, o);
      for (const [x, n] of r) { o = b.writeInt16LE(Math.round(x * 10) - ax, o); o = b.writeInt16LE(Math.round(n * 10) - an, o); }
    }
    o = b.writeUInt32LE(nv, o);
    for (let i = 0; i < g.verts.length; i += 3) {
      o = b.writeInt16LE(Math.round(g.verts[i] * 10) - ax, o);
      o = b.writeInt16LE(Math.round(g.verts[i + 1] * 10) - an, o);
      o = b.writeInt16LE(Math.round(g.verts[i + 2] * 10), o);
    }
    o = b.writeUInt32LE(g.roof.length, o);
    o = b.writeUInt32LE(g.wall.length, o);
    for (const i of g.roof.concat(g.wall)) o = big ? b.writeUInt32LE(i, o) : b.writeUInt16LE(i, o);
    parts.push(b);
  }
  return Buffer.concat(parts);
}

/** Groups far enough apart for int16 decimetres: split anything wider than 3 km (none, in practice). */
function fits(g) {
  const [x0, n0] = g.rings[0][0];
  for (let i = 0; i < g.verts.length; i += 3) if (Math.abs(g.verts[i] - x0) > 3000 || Math.abs(g.verts[i + 1] - n0) > 3000) return false;
  return true;
}

// ------------------------------------------------------------------- main --

function tileName(entry) { return path.basename(entry.name).replace(/\.zip$/i, ''); }

async function readTile(gmlBuf, name) {
  const s = gmlBuf.toString('utf8');
  const groups = [];
  let skipped = 0;
  for (const [a, b] of between(s, '<bldg:Building ', '</bldg:Building>')) {
    const surf = parseBuilding(s.slice(a, b));
    if (!surf.some((p) => p.kind === 'ground')) { skipped++; continue; }
    const g = group(surf);
    if (!g.rings.length || !(g.roof.length + g.wall.length) || !fits(g)) { skipped++; continue; }
    let cx = 0, cn = 0;
    for (const [x, n] of g.rings[0]) { cx += x; cn += n; }
    cx /= g.rings[0].length; cn /= g.rings[0].length;
    if (cx < X0 || cx > X1 || cn < N0 || cn > N1) { skipped++; continue; }
    groups.push(g);
  }
  return { groups, skipped };
}

async function inflateTo(url, entry, file) {
  const start = await dataStart((o, l) => range(url, o, o + l - 1), entry);
  const r = await get(url, { Range: `bytes=${start}-${start + entry.comp - 1}` });
  const src = Readable.fromWeb(r.body);
  if (entry.method === 8) await pipeline(src, zlib.createInflateRaw(), fs.createWriteStream(file));
  else await pipeline(src, fs.createWriteStream(file));
}

function gmlFromZipFile(file) {
  const fd = fs.openSync(file, 'r');
  const read = async (o, l) => { const b = Buffer.alloc(l); fs.readSync(fd, b, 0, l, o); return b; };
  return (async () => {
    const total = fs.fstatSync(fd).size;
    const list = await zipEntries(read, total);
    const g = list.find((e) => /\.gml$/i.test(e.name));
    if (!g) { fs.closeSync(fd); return null; }
    const start = await dataStart(read, g);
    const raw = await read(start, g.comp);
    fs.closeSync(fd);
    return g.method === 8 ? zlib.inflateRawSync(raw) : raw;
  })();
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(TMP, { recursive: true });
  const idxFile = path.join(OUT, 'index.json');
  const index = fs.existsSync(idxFile) ? JSON.parse(fs.readFileSync(idxFile, 'utf8')) : { tuiles: [] };
  const byName = new Map(index.tuiles.map((t) => [t.nom, t]));
  // The portal ships some tiles twice under two names (VM13 and VM15 in 2020): keep one.
  const hashes = new Map();
  for (const t of index.tuiles) {
    const f = path.join(OUT, t.fichier);
    if (fs.existsSync(f)) hashes.set(createHash('sha1').update(fs.readFileSync(f)).digest('hex'), t.nom);
  }
  for (const set of SETS) {
    const pkg = (await (await get(API + set.id)).json()).result;
    for (const res of pkg.resources) {
      if (res.format !== 'GML') continue;
      const arr = set.arr.find((a) => new RegExp(`^Tuiles ${a}_${set.year}_GML`, 'i').test(res.name));
      if (!arr || (only && !only.includes(arr))) continue;
      const url = await resolve(res.url);
      const total = await size(url);
      const entries = await zipEntries((o, l) => range(url, o, o + l - 1), total);
      for (const entry of entries) {
        if (!/\.zip$/i.test(entry.name) && !/\.gml$/i.test(entry.name)) continue;
        const name = tileName(entry).replace(/\.gml$/i, '');
        const outFile = path.join(OUT, `${name}.bin`);
        if (!force && byName.has(name) && fs.existsSync(outFile)) { console.log(name, 'déjà là'); continue; }
        const t0 = Date.now();
        let gml;
        if (/\.gml$/i.test(entry.name)) {
          const tmp = path.join(TMP, `${name}.gml`);
          await inflateTo(url, entry, tmp);
          gml = fs.readFileSync(tmp);
          fs.rmSync(tmp);
        } else {
          const tmp = path.join(TMP, `${name}.zip`);
          await inflateTo(url, entry, tmp);
          gml = await gmlFromZipFile(tmp);
          fs.rmSync(tmp);
        }
        if (!gml) { console.log(name, 'pas de GML'); continue; }
        const { groups, skipped } = await readTile(gml, name);
        if (!groups.length) { console.log(name, 'hors de la région'); byName.delete(name); continue; }
        const buf = encode(groups);
        const hash = createHash('sha1').update(buf).digest('hex');
        if (hashes.has(hash) && hashes.get(hash) !== name) { console.log(name, 'en double de', hashes.get(hash)); byName.delete(name); continue; }
        hashes.set(hash, name);
        fs.writeFileSync(outFile, buf);
        let x0 = Infinity, n0 = Infinity, x1 = -Infinity, n1 = -Infinity, tris = 0;
        for (const g of groups) {
          for (const r of g.rings) for (const [x, n] of r) { x0 = Math.min(x0, x); n0 = Math.min(n0, n); x1 = Math.max(x1, x); n1 = Math.max(n1, n); }
          tris += (g.roof.length + g.wall.length) / 3;
        }
        byName.set(name, {
          nom: name, fichier: `${name}.bin`, arrondissement: arr, annee: set.year,
          boite: [x0, n0, x1, n1].map((v) => Math.round(v)), batiments: groups.length, triangles: tris, octets: buf.length,
        });
        console.log(name, groups.length, 'bâtiments,', tris, 'triangles,', (buf.length / 1e6).toFixed(2), 'Mo,', skipped, 'écartés,', ((Date.now() - t0) / 1000).toFixed(0), 's');
        index.tuiles = [...byName.values()].sort((a, b) => a.nom.localeCompare(b.nom));
        index.source = 'Ville de Montréal, Bâtiments 3D (maquettes LOD2), CC BY 4.0';
        fs.writeFileSync(idxFile, JSON.stringify(index, null, 1));
      }
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
