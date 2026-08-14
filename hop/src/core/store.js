// Thin, never-throwing wrapper over localStorage.
// Private-browsing modes and disabled storage must not take the game down.

const PREFIX = 'ruelle:';

export function load(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw == null) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function save(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function remove(key) {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    /* ignore */
  }
}

/** Keys under our prefix, with the prefix stripped. */
export function keys() {
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX)) out.push(k.slice(PREFIX.length));
    }
  } catch {
    /* ignore */
  }
  return out;
}

const DEFAULT_SETTINGS = {
  quality: 'high',      // 'low' | 'medium' | 'high'
  shadows: true,
  audio: true,
  volume: 0.7,
  music: true,
  musicVolume: 0.4,
  camera: 'chase',      // 'chase' | 'hood' | 'orbit'
  touch: 'auto',        // 'auto' | 'on' | 'off'
  weather: 'clear',     // 'clear' | 'overcast' | 'rain'
  terrain: true,        // ground elevation from the AWS terrain tiles
  timeOfDay: 10.5,      // hours, 0-24
  autoTime: false,
  underglow: false,
  underglowColor: 'cyan',
  units: 'kmh',         // 'kmh' | 'mph'
  showFps: false,
  playerName: '',       // multiplayer; blank until one is picked or generated
};

export function loadSettings() {
  const s = load('settings', {});
  return { ...DEFAULT_SETTINGS, ...(s && typeof s === 'object' ? s : {}) };
}

export function saveSettings(s) {
  save('settings', s);
}

export { DEFAULT_SETTINGS };
