// How much traffic, where and when: mtl/trafic.json, read once at load (see
// mtl/README.md, « La circulation »). Pure logic: the host evaluates it, the
// other players never need it.
//
//   horaire   a step function of the hour: "07:00": 1.5 holds from 7:00 until
//             the next entry (and the last one wraps past midnight)
//   zones     a district by name ("quartier", the names the HUD shows) or a
//             circle in real metres (x, n, rayon), with a densite and/or its
//             own horaire
//   routes    a street or road by name ("nom", or the start of it) or route
//             number ("ref": "A15"), same
// Factors multiply: Décarie at rush hour in a busy district takes all three.

import { zoneAt } from '../game/drive.js';

export const DEFAULTS = {
  heure: 'reelle',
  vitesse_horloge: 1,
  autos_max: 90,
  horaire: { '00:00': 0.3, '06:00': 0.7, '07:00': 1.4, '09:30': 1.0, '15:30': 1.4, '18:30': 1.0, '21:00': 0.6 },
  zones: [],
  routes: [],
};

/** "07:30" → seconds since midnight; numbers are hours. */
export function parseHour(v) {
  if (typeof v === 'number') return ((v % 24) + 24) % 24 * 3600;
  const m = /^(\d{1,2})(?:[:h](\d{2}))?$/.exec(String(v).trim());
  if (!m) return null;
  return (Number(m[1]) % 24) * 3600 + Number(m[2] || 0) * 60;
}

function schedule(table) {
  if (!table || typeof table !== 'object') return null;
  const steps = Object.entries(table)
    .map(([k, v]) => [parseHour(k), Number(v)])
    .filter(([t, v]) => t !== null && Number.isFinite(v))
    .sort((a, b) => a[0] - b[0]);
  if (!steps.length) return null;
  return (sec) => {
    let v = steps[steps.length - 1][1];
    for (const [t, d] of steps) if (sec >= t) v = d;
    return v;
  };
}

function factorOf(entry) {
  const d = Number.isFinite(Number(entry.densite)) ? Number(entry.densite) : 1;
  const h = schedule(entry.horaire);
  return h ? (sec) => d * h(sec) : () => d;
}

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/**
 * @param config  trafic.json (any field may be missing)
 * @param layout  the compiled map (district names, scale)
 * @param net     buildNetwork(layout)
 * @returns { config, global(sec), at(edge, sec), local(x, n, sec), max, warnings }
 */
export function createDensity(config, layout, net) {
  const C = { ...DEFAULTS, ...(config || {}) };
  const s = layout.map.scale;
  const warnings = [];
  const global = schedule(C.horaire) || (() => 1);

  const names = new Set((layout.quartiers || []).map((q) => norm(q.nom)));
  const zones = (C.zones || []).map((z) => {
    const f = factorOf(z);
    if (z.quartier !== undefined) {
      const key = norm(z.quartier);
      if (!names.has(key)) warnings.push(`quartier inconnu : « ${z.quartier} »`);
      return { test: (x, n, district) => district === key, f, district: true };
    }
    if (Number.isFinite(z.x) && Number.isFinite(z.n) && Number.isFinite(z.rayon)) {
      const x0 = z.x * s, n0 = z.n * s, r = z.rayon * s;
      return { test: (x, n) => Math.hypot(x - x0, n - n0) <= r, f };
    }
    warnings.push(`zone sans « quartier » ni « x, n, rayon » : ${JSON.stringify(z)}`);
    return null;
  }).filter(Boolean);

  const routes = (C.routes || []).map((r) => {
    const f = factorOf(r);
    if (r.ref) { const ref = norm(r.ref); return { test: (e) => norm(roadOf(e).ref) === ref, f, label: r.ref }; }
    if (r.nom) { const nom = norm(r.nom); return { test: (e) => norm(roadOf(e).name).startsWith(nom), f, label: r.nom }; }
    warnings.push(`route sans « nom » ni « ref » : ${JSON.stringify(r)}`);
    return null;
  }).filter(Boolean);
  for (const r of routes) {
    if (!net.edges.some((e) => r.test(e))) warnings.push(`route introuvable dans cette zone : « ${r.label} »`);
  }

  // Which zones and routes each edge falls in: worked out once, on demand.
  const byDistrict = zones.some((z) => z.district);
  const district = (x, n) => norm(zoneAt(layout, x, n));
  const tags = new Map();
  const tagsOf = (e) => {
    let t = tags.get(e.id);
    if (!t) {
      const m = e.pts[e.pts.length >> 1];
      const d = byDistrict ? district(m[0], m[1]) : null;
      t = { zones: zones.filter((z) => z.test(m[0], m[1], d)), routes: routes.filter((r) => r.test(e)) };
      tags.set(e.id, t);
    }
    return t;
  };

  return {
    config: C,
    warnings,
    max: Math.max(0, Number(C.autos_max) || 0),
    clockRate: Number(C.vitesse_horloge) || 1,
    global,
    /** Factor of an edge at that time of day: zones × routes (not the hour). */
    at(e, sec) {
      const t = tagsOf(e);
      let f = 1;
      for (const z of t.zones) f *= z.f(sec);
      for (const r of t.routes) f *= r.f(sec);
      return f;
    },
    /** The zones' factor at a point: how full a player's bubble is there. */
    local(x, n, sec) {
      if (!zones.length) return 1;
      const d = byDistrict ? district(x, n) : null;
      let f = 1;
      for (const z of zones) if (z.test(x, n, d)) f *= z.f(sec);
      return f;
    },
    /** The largest factor any edge can have now, for weighting spawns. */
    peak(sec) {
      let f = 1;
      for (const z of zones) f *= Math.max(1, z.f(sec));
      for (const r of routes) f *= Math.max(1, r.f(sec));
      return f;
    },
  };
}

function roadOf(e) {
  return e.street || e.road || {};
}

/** The starting time of day, in seconds: the file, then the address. */
export function startHour(config, param) {
  const p = param !== null && param !== undefined ? parseHour(param) : null;
  if (p !== null) return p;
  const h = config && config.heure !== undefined ? config.heure : DEFAULTS.heure;
  if (h === 'reelle') {
    const d = new Date();
    return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
  }
  return parseHour(h) ?? 12 * 3600;
}
