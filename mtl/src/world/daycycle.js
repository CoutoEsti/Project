// Time of day and weather, from the wall clock alone. Every player who reads
// the same clock sees the same sky and the same rain, with no server and no
// message: multiplayer for free (clocks a few seconds apart don't show).
//
// A cycle is mostly night — this is a street-racing city — with a short day
// to read the map: day, dusk, night, dawn.

export const CYCLE = {
  day: 210,        // 3 min 30
  dusk: 45,
  night: 15 * 60,  // 15 min between the two transitions
  dawn: 45,
};
export const CYCLE_LENGTH = CYCLE.day + CYCLE.dusk + CYCLE.night + CYCLE.dawn;

// Rain falls on some nights only, the same ones for everyone.
const RAIN_SHARE = 0.35;      // share of nights with rain
const RAIN_RAMP = 40;         // seconds to set in and to clear

/** Seconds on the shared clock. */
export function sharedClock() {
  return Date.now() / 1000;
}

const smooth = (t) => t * t * (3 - 2 * t);
const clamp01 = (t) => Math.min(1, Math.max(0, t));
function hash01(i) {
  let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * The sky at `seconds` on the shared clock.
 * daylight: 1 by day, 0 by night. twilight: 1 halfway through dusk or dawn,
 * 0 otherwise. rain: 0..1. phase and the seconds into the cycle, for the HUD.
 */
export function skyAt(seconds) {
  const t = ((seconds % CYCLE_LENGTH) + CYCLE_LENGTH) % CYCLE_LENGTH;
  const index = Math.floor(seconds / CYCLE_LENGTH);
  const duskEnd = CYCLE.day + CYCLE.dusk;
  const nightEnd = duskEnd + CYCLE.night;
  let daylight, phase;
  if (t < CYCLE.day) { daylight = 1; phase = 'jour'; }
  else if (t < duskEnd) { daylight = 1 - smooth((t - CYCLE.day) / CYCLE.dusk); phase = 'crépuscule'; }
  else if (t < nightEnd) { daylight = 0; phase = 'nuit'; }
  else { daylight = smooth((t - nightEnd) / CYCLE.dawn); phase = 'aube'; }
  const twilight = 1 - Math.abs(daylight * 2 - 1);

  // Rain: on a rainy night, from a few minutes in until a few before dawn,
  // where both are drawn from the cycle's number.
  let rain = 0;
  if (hash01(index) < RAIN_SHARE) {
    const from = duskEnd + 60 + hash01(index * 7 + 1) * 240;
    const to = nightEnd - 60 - hash01(index * 7 + 2) * 240;
    rain = clamp01((t - from) / RAIN_RAMP) * clamp01((to - t) / RAIN_RAMP);
    rain = smooth(rain) * (0.6 + 0.4 * hash01(index * 7 + 3));
  }
  return { daylight, twilight, rain, phase, t };
}
