// Unit tests for the parts that are pure logic.
//
//   node hop/tools/units.mjs
//
// The browser test (smoke.mjs) drives the real game and takes a couple of
// minutes; this takes a fifth of a second and covers the two things where a
// quiet mistake would be invisible on screen — the wire format, and the kerb
// cross-section. Both are pure modules with no THREE and no DOM, which is
// precisely why they were written that way.

import assert from 'node:assert/strict';

import {
  encodeState, decodeState, packFlags, unpackFlags, StateBuffer,
  shortestAngle, lerpAngle, normaliseRoom, normaliseName, makeRoomCode,
  colourForName, PROTOCOL,
} from '../src/net/protocol.js';
import { KerbBuilder, buildKerbs, KERB_HEIGHT } from '../src/world/kerbs.js';
import { classifyRoad, findJunctions, offsetNormals, JUNCTION_CLEARANCE } from '../src/world/roads.js';
import { Projection } from '../src/core/geo.js';

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push(`${name} — ${err.message}`);
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
console.log('\n▶ protocole\n');

test('un état survit à l’aller-retour au centimètre près', () => {
  const s = {
    seq: 41, lat: 45.5265123, lon: -73.5795987, yaw: -1.234,
    speed: 27.55, steer: -0.201, spin: 12.34, flags: 5,
  };
  const back = decodeState(encodeState(s));
  assert.equal(back.seq, s.seq);
  // Seven decimals of latitude is about a centimetre.
  assert.ok(Math.abs(back.lat - s.lat) < 1e-6, `lat dérive de ${back.lat - s.lat}`);
  assert.ok(Math.abs(back.lon - s.lon) < 1e-6);
  assert.ok(Math.abs(back.yaw - s.yaw) < 1e-3);
  assert.equal(back.flags, s.flags);
});

test('un paquet corrompu est rejeté plutôt que cru', () => {
  assert.equal(decodeState(null), null);
  assert.equal(decodeState([1, 2, 3]), null);
  assert.equal(decodeState([1, NaN, 0, 0, 0, 0, 0, 0]), null);
  assert.equal(decodeState([1, 900, 0, 0, 0, 0, 0, 0]), null, 'latitude hors du globe acceptée');
  assert.equal(decodeState([1, 0, 400, 0, 0, 0, 0, 0]), null);
});

test('les drapeaux font l’aller-retour', () => {
  const all = { braking: true, lights: false, handbrake: true, skidding: false, reversing: true };
  assert.deepEqual(unpackFlags(packFlags(all)), all);
  assert.equal(packFlags({}), 0);
});

test('un paquet est plus court que 130 octets', () => {
  const wire = JSON.stringify({
    t: 'state',
    s: encodeState({
      seq: 999999, lat: 45.5265123, lon: -73.5795987, yaw: -3.141,
      speed: 180.55, steer: -0.551, spin: 9999.99, flags: 31,
    }),
  });
  assert.ok(wire.length < 130, `${wire.length} octets`);
});

test('les codes de salon excluent les caractères qu’on confond', () => {
  for (let i = 0; i < 200; i++) {
    assert.match(makeRoomCode(), /^[A-HJ-NP-Z2-9]{6}$/);
  }
  assert.equal(normaliseRoom(' k7m-2qp '), 'K7M2QP');
  assert.equal(normaliseRoom('ab'), '', 'un code trop court doit être refusé');
  // Anything typed folds down to the legal alphabet, so a code can never carry
  // punctuation into the peer id or the URL it ends up in.
  assert.match(normaliseRoom('<script>'), /^[A-Z0-9]*$/);
});

test('un nom garde ce qu’un vrai nom contient, et rien d’autre', () => {
  // The filter must not mangle ordinary Québécois names…
  assert.equal(normaliseName('  Jean-Guy  '), 'Jean-Guy');
  assert.equal(normaliseName('Éloïse 22'), 'Éloïse 22');
  assert.equal(normaliseName("O'Brien"), 'OBrien');
  // …while still refusing markup and control characters.
  assert.equal(normaliseName('<b>Marc</b>'), 'bMarc/b');
  assert.equal(normaliseName('a\u0000\u001fb'), 'ab');
  assert.ok(normaliseName('x'.repeat(80)).length <= 16);
});

test('deux noms différents donnent deux voitures différentes', () => {
  const palette = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  assert.equal(colourForName('Marc', palette), colourForName('Marc', palette), 'pas déterministe');
  const seen = new Set(['Marc', 'Julie', 'Alex', 'Sam', 'Pat'].map((n) => colourForName(n, palette)));
  assert.ok(seen.size >= 4, `cinq noms pour ${seen.size} couleurs`);
});

test('le protocole a un numéro', () => assert.equal(typeof PROTOCOL, 'number'));

// ---------------------------------------------------------------------------
console.log('\n▶ interpolation\n');

test('l’angle le plus court passe par le zéro', () => {
  assert.ok(Math.abs(shortestAngle(3.0, -3.0) - 0.2831) < 0.01, 'ne franchit pas ±π');
  assert.ok(Math.abs(lerpAngle(3.0, -3.0, 0.5) - 3.1415) < 0.01);
});

test('un tampon rejoue le passé et lisse entre deux paquets', () => {
  const buf = new StateBuffer(0.1);
  const at = (seq, lon) => ({ seq, lat: 45, lon, yaw: 0, speed: 0, steer: 0, spin: 0, flags: 0 });
  buf.push(at(1, 0), 1.0);
  buf.push(at(2, 1), 1.2);
  // Rendering at 1.3 − 0.1 = 1.2 lands exactly on the second sample.
  const s = buf.sample(1.3);
  assert.ok(Math.abs(s.lon - 1) < 1e-6, `lon ${s.lon}`);
  // Halfway between the two arrivals.
  const mid = buf.sample(1.2);
  assert.ok(Math.abs(mid.lon - 0.5) < 1e-6, `lon ${mid.lon}`);
  assert.equal(mid.moving, true);
});

test('un paquet en retard est jeté plutôt que de faire reculer la voiture', () => {
  const buf = new StateBuffer(0.1);
  const at = (seq, lon) => ({ seq, lat: 45, lon, yaw: 0, speed: 0, steer: 0, spin: 0, flags: 0 });
  assert.equal(buf.push(at(5, 5), 1.0), true);
  assert.equal(buf.push(at(4, 4), 1.01), false, 'un paquet plus vieux a été accepté');
  assert.equal(buf.push(at(6, 6), 1.02), true);
});

test('passé le dernier paquet la voiture tient sa pose au lieu d’extrapoler', () => {
  const buf = new StateBuffer(0.1);
  const at = (seq, lon) => ({ seq, lat: 45, lon, yaw: 0, speed: 0, steer: 0, spin: 0, flags: 0 });
  buf.push(at(1, 0), 1.0);
  buf.push(at(2, 1), 1.1);
  const held = buf.sample(9.0);
  assert.equal(held.lon, 1, 'la voiture a été extrapolée dans le décor');
  assert.equal(held.moving, false);
});

test('deux joueurs partis d’endroits différents se voient au bon endroit', () => {
  // The whole reason positions travel as latitude and longitude. Two clients
  // that hopped into different neighbourhoods have different local origins, so
  // raw x/z would put the other car kilometres away — silently, and only for
  // the player who hopped second.
  const plateau = new Projection(45.5265, -73.5795);      // where A started
  const mileEnd = new Projection(45.5230, -73.5990);      // where B started

  // A drives 300 m east and 120 m north of its own origin, and publishes.
  const sent = plateau.toLatLon(300, -120);
  const seenByB = mileEnd.toWorld(sent.lat, sent.lon);

  // B converts into its own frame. Both must agree on the ground truth, which
  // is the distance between A's car and B's own origin.
  const trueDistance = Math.hypot(
    300 - plateau.x(mileEnd.lon0),
    -120 - plateau.z(mileEnd.lat0),
  );
  const asBSeesIt = Math.hypot(seenByB.x, seenByB.z);
  assert.ok(Math.abs(trueDistance - asBSeesIt) < 1.0,
    `désaccord de ${(trueDistance - asBSeesIt).toFixed(1)} m entre les deux repères`);

  // And a round trip through one client's own projection changes nothing.
  const back = plateau.toWorld(sent.lat, sent.lon);
  assert.ok(Math.hypot(back.x - 300, back.z + 120) < 0.01);
});

test('le tampon ne grandit pas indéfiniment', () => {
  const buf = new StateBuffer();
  for (let i = 0; i < 500; i++) {
    buf.push({ seq: i, lat: 45, lon: i, yaw: 0, speed: 0, steer: 0, spin: 0, flags: 0 }, i / 15);
  }
  assert.ok(buf.samples.length <= 12, `${buf.samples.length} échantillons retenus`);
});

// ---------------------------------------------------------------------------
console.log('\n▶ bordures\n');

/** A straight street, and a side street meeting it at the middle. */
function crossroads() {
  const spec = classifyRoad({ highway: 'residential', name: 'Rue Test' });
  const main = { points: [], spec, id: 1 };
  for (let z = -100; z <= 100; z += 10) main.points.push({ x: 0, z });
  const side = {
    points: [{ x: 0, z: 0 }, { x: 60, z: 0 }],
    spec, id: 2,
  };
  return { roads: [main, side], spec };
}

test('une rue produit deux rubans de bordure', () => {
  const { roads } = crossroads();
  const out = new KerbBuilder(null);
  buildKerbs(roads, findJunctions(roads), out);
  assert.ok(out.count > 0, 'aucune bordure générée');
  assert.equal(out.count % 4, 0, 'les sections ne font pas quatre sommets');
  assert.ok(out.indices.length > 0);
});

test('la bordure fait 15 cm et jamais plus', () => {
  const { roads } = crossroads();
  const out = new KerbBuilder(null);
  buildKerbs(roads, findJunctions(roads), out);
  let highest = 0;
  for (let i = 1; i < out.positions.length; i += 3) highest = Math.max(highest, out.positions[i]);
  assert.ok(Math.abs(highest - KERB_HEIGHT) < 1e-6, `sommet le plus haut à ${highest} m`);
  assert.ok(highest < 0.2, 'une bordure de plus de 20 cm arrêterait la voiture');
});

/**
 * Kerb heights along the main street only, bucketed by how far along it they
 * are from the crossroads at the origin.
 *
 * Only the main road is built, so a vertex's distance *along its own street* is
 * simply |z| — which is the quantity the fade actually keys on. Measuring the
 * radial distance from the junction instead is the trap: the ribbons sit five
 * and a half metres to either side of the axis, so a radius small enough to
 * mean "at the crossroads" excludes every vertex and the test passes on an
 * empty set.
 */
function kerbProfile(spacing) {
  const spec = classifyRoad({ highway: 'residential' });
  const main = { points: [], spec, id: 1 };
  for (let z = -60; z <= 60.0001; z += spacing) main.points.push({ x: 0, z: Number(z.toFixed(4)) });
  const side = { points: [{ x: 0, z: 0 }, { x: 40, z: 0 }], spec, id: 2 };

  const junctions = findJunctions([main, side]);
  assert.ok(junctions.size >= 1, 'le carrefour de test n’est pas détecté');

  const out = new KerbBuilder(null);
  buildKerbs([main], junctions, out);
  assert.ok(out.count > 0, 'aucune bordure générée');

  let atJunction = 0, wellAway = 0;
  for (let i = 0; i < out.positions.length; i += 3) {
    const y = out.positions[i + 1], z = out.positions[i + 2];
    const along = Math.abs(z);
    if (along < 2) atJunction = Math.max(atJunction, y);
    if (along > JUNCTION_CLEARANCE * 1.5 && along < 40) wellAway = Math.max(wellAway, y);
  }
  return { atJunction, wellAway };
}

test('la bordure s’efface au carrefour au lieu de traverser l’asphalte', () => {
  const p = kerbProfile(10);
  assert.ok(p.atJunction < 0.05,
    `bordure de ${(p.atJunction * 100).toFixed(0)} cm en plein carrefour`);
  // …and the fade is local, not a kerb that quietly came out flat everywhere.
  assert.ok(Math.abs(p.wellAway - KERB_HEIGHT) < 1e-6,
    `bordure de ${(p.wellAway * 100).toFixed(0)} cm en pleine rue`);
});

test('un carrefour sur un tronçon très découpé est quand même détecté', () => {
  // OpenStreetMap nodes cluster, so the builder thins them to keep the triangle
  // count sane. A thinning that drops the junction vertex leaves the fade with
  // nothing to key on and the kerb runs straight through the crossroads — which
  // tidy ten-metre test geometry never reveals, because it never thins anything.
  const p = kerbProfile(0.8);
  assert.ok(p.atJunction < 0.05,
    `bordure de ${(p.atJunction * 100).toFixed(0)} cm en plein carrefour`);
  assert.ok(Math.abs(p.wellAway - KERB_HEIGHT) < 1e-6, 'la bordure a disparu partout');
});

test('la bordure borde la chaussée, jamais le milieu', () => {
  const { roads, spec } = crossroads();
  const out = new KerbBuilder(null);
  buildKerbs([roads[0]], new Map(), out);
  const half = spec.width / 2;
  let closest = Infinity;
  for (let i = 0; i < out.positions.length; i += 3) {
    closest = Math.min(closest, Math.abs(out.positions[i]));   // the street runs along z
  }
  assert.ok(Math.abs(closest - half) < 0.01, `la bordure la plus proche est à ${closest} m de l’axe (attendu ${half})`);
});

test('les ruelles et les autoroutes n’ont pas de bordure', () => {
  for (const tags of [
    { highway: 'service', service: 'alley' },
    { highway: 'motorway' },
    { highway: 'residential', bridge: 'yes' },
  ]) {
    const spec = classifyRoad(tags);
    const road = { points: [{ x: 0, z: -50 }, { x: 0, z: 50 }], spec, id: 1 };
    const out = new KerbBuilder(null);
    buildKerbs([road], new Map(), out);
    assert.equal(out.count, 0, `${tags.highway} a reçu une bordure`);
  }
});

test('la bordure suit le relief quand il y en a', () => {
  const { roads } = crossroads();
  const out = new KerbBuilder((x, z) => z * 0.1);
  buildKerbs([roads[0]], new Map(), out);
  let lo = Infinity, hi = -Infinity;
  for (let i = 1; i < out.positions.length; i += 3) {
    lo = Math.min(lo, out.positions[i]);
    hi = Math.max(hi, out.positions[i]);
  }
  assert.ok(hi - lo > 15, `la bordure est plate (${(hi - lo).toFixed(1)} m) sur une pente de 20 m`);
});

test('la bordure colle au sol même en dévers', () => {
  // The street runs along z, so this tilts the ground *across* it — the case
  // that a single height sample on the centreline gets wrong, by a third of a
  // metre on a slope like Mount Royal's.
  const { roads } = crossroads();
  const slope = (x) => x * 0.1;
  const out = new KerbBuilder((x) => slope(x));
  buildKerbs([roads[0]], new Map(), out);

  let worst = 0;
  for (let i = 0; i < out.positions.length; i += 3) {
    const x = out.positions[i], y = out.positions[i + 1];
    const above = y - slope(x);
    // Every vertex is either at grade or at kerb height above its own ground.
    worst = Math.max(worst, Math.min(Math.abs(above - KERB_HEIGHT), Math.abs(above - 0.012)));
  }
  assert.ok(worst < 0.01, `un sommet flotte à ${(worst * 100).toFixed(0)} cm du sol en dévers`);
});

test('l’offset latéral ne se rétrécit pas dans un virage', () => {
  // A right angle: the miter has to reach √2 times further than the segments.
  const points = [{ x: -10, z: 0 }, { x: 0, z: 0 }, { x: 0, z: 10 }];
  const n = offsetNormals(points);
  const len = Math.hypot(n[1].x, n[1].z);
  assert.ok(Math.abs(len - Math.SQRT2) < 0.01, `miter de ${len.toFixed(3)} au lieu de 1,414`);
});

// ---------------------------------------------------------------------------

console.log('\n──────────────────────────────────────────');
if (failures.length) {
  console.log(`✗ ${failures.length} échec(s) sur ${passed + failures.length}`);
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
console.log(`✓ tout est vert — ${passed} vérifications`);
