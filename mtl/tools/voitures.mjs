// The three cars, measured: each one flat out on the level at the fixed 120 Hz
// step, no world, no three.js. The top speed must be reached by the physics
// (gearing, torque, drag), within ±5 % of the advertised figure.
//
//   node mtl/tools/voitures.mjs

import { Vehicle, CARS } from '../src/game/vehicle.js';

const STEP = 1 / 120;
const TOLERANCE = 0.05;
let failed = 0;

for (const car of CARS) {
  const v = new Vehicle(car.spec);
  v.reset(0, 0, 0);
  let t100 = null, top = 0, t95 = null;
  for (let i = 1; i <= 300 / STEP; i++) {
    v.step(STEP, { throttle: 1, brake: 0, steer: 0, handbrake: false });
    const kmh = v.speedKmh;
    if (t100 === null && kmh >= 100) t100 = i * STEP;
    if (t95 === null && kmh >= car.topKmh * 0.95) t95 = i * STEP;
    top = Math.max(top, kmh);
    if (t95 !== null && i * STEP > t95 + 20) break;          // plateau: enough
  }
  const err = (top - car.topKmh) / car.topKmh;
  const ok = Math.abs(err) <= TOLERANCE && t100 !== null && t95 !== null;
  if (!ok) failed++;
  console.log(`${ok ? '  ok ' : 'ÉCHEC'}  ${car.name.padEnd(11)} pointe ${top.toFixed(1)} km/h (visé ${car.topKmh}, ${(err * 100).toFixed(1)} %)` +
    ` — 0-100 en ${t100 === null ? '?' : t100.toFixed(2)} s, 95 % de la pointe en ${t95 === null ? '?' : t95.toFixed(1)} s, rapport ${v.gear}/${car.spec.gears.length}`);
}

{
  // Swapping cars at speed must not move or stop the car.
  const v = new Vehicle(CARS[2].spec);
  v.reset(10, 20, 1);
  for (let i = 0; i < 600; i++) v.step(STEP, { throttle: 1, brake: 0, steer: 0, handbrake: false });
  const before = { x: v.x, n: v.n, yaw: v.yaw, u: v.u };
  v.setSpec(CARS[0].spec);
  const same = v.x === before.x && v.n === before.n && v.yaw === before.yaw && v.u === before.u && v.gear <= CARS[0].spec.gears.length;
  for (let i = 0; i < 240; i++) v.step(STEP, { throttle: 0, brake: 0, steer: 0, handbrake: false });
  const finite = [v.x, v.n, v.yaw, v.u].every(Number.isFinite);
  const ok = same && finite;
  if (!ok) failed++;
  console.log(`${ok ? '  ok ' : 'ÉCHEC'}  changer de voiture en roulant : position et vitesse conservées, état fini`);
}

process.exit(failed ? 1 : 0);
