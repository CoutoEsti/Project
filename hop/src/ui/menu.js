// Start screen, place search, key bindings and the city map picker.
//
// Search goes through Nominatim, which asks for at most one request a second
// and a genuine identifying Referer — a browser supplies the latter on its
// own, and the debounce below supplies the former.

import { paintMap, marker } from './map.js';
import { BINDABLE, keyLabel } from '../core/input.js';

// Only places the bundled Montréal extract actually covers. Anywhere else
// would depend on a live Overpass round-trip, which is not something to put
// behind a one-click button that looks like it will just work.
const PRESETS = [
  { name: 'Plateau-Mont-Royal', sub: 'Parc La Fontaine', lat: 45.5265, lon: -73.5795 },
  { name: 'Mile End', sub: 'Saint-Viateur', lat: 45.5230, lon: -73.5990 },
  { name: 'Vieux-Montréal', sub: 'Place Jacques-Cartier', lat: 45.5065, lon: -73.5540 },
  { name: 'Centre-ville', sub: 'Sainte-Catherine', lat: 45.5015, lon: -73.5700 },
  { name: 'Rosemont', sub: 'Beaubien', lat: 45.5400, lon: -73.5830 },
  { name: 'Saint-Léonard', sub: 'Grandes-Prairies', lat: 45.5880, lon: -73.5940 },
];

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';

export class Menu {
  /**
   * @param {HTMLElement} root
   * @param {object} opts {settings, onHop(lat,lon,label), onSettings(settings)}
   */
  constructor(root, opts) {
    this.root = root;
    this.settings = opts.settings;
    this.onHop = opts.onHop;
    this.onSettings = opts.onSettings || (() => {});
    this.input = opts.input;
    this.mapImage = null;

    this.el = root.querySelector('#menu');
    this.searchEl = root.querySelector('#search-input');
    this.results = root.querySelector('#search-results');
    this.presetsEl = root.querySelector('#presets');
    this.hint = root.querySelector('#menu-hint');
    this.panel = root.querySelector('#settings');
    this.visible = true;

    this._searchTimer = 0;
    this._searchAbort = null;
    this._lastQuery = '';

    this.mapCanvas = root.querySelector('#menu-map');
    this.mapWrap = root.querySelector('#menu-map-wrap');
    this.mapWrap.style.display = 'none';

    this._buildPresets();
    this._bindSearch();
    this._bindSettings();
    this._buildKeybinds();
    this._bindMap();
    window.addEventListener('resize', () => this.drawMap());

    root.querySelector('#open-settings').addEventListener('click', () => {
      this.panel.classList.toggle('visible');
    });
    root.querySelector('#close-settings').addEventListener('click', () => {
      this.panel.classList.remove('visible');
    });
  }

  _buildPresets() {
    this.presetsEl.innerHTML = '';
    for (const p of PRESETS) {
      const btn = document.createElement('button');
      btn.className = 'preset';
      btn.innerHTML = `<strong>${escapeHtml(p.name)}</strong><span>${escapeHtml(p.sub)}</span>`;
      btn.addEventListener('click', () => this.onHop(p.lat, p.lon, `${p.name}, ${p.sub}`));
      this.presetsEl.appendChild(btn);
    }
  }

  _bindSearch() {
    this.searchEl.addEventListener('input', () => {
      const q = this.searchEl.value.trim();
      clearTimeout(this._searchTimer);
      if (q.length < 3) {
        this.results.innerHTML = '';
        this.results.classList.remove('visible');
        return;
      }
      this._searchTimer = setTimeout(() => this._search(q), 420);
    });

    this.searchEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const first = this.results.querySelector('button');
        if (first) first.click();
        else this._search(this.searchEl.value.trim(), true);
      }
    });
  }

  async _search(query, hopFirst = false) {
    if (!query || query === this._lastQuery) return;
    this._lastQuery = query;
    this.results.innerHTML = '<div class="searching">Recherche…</div>';
    this.results.classList.add('visible');

    if (this._searchAbort) this._searchAbort.abort();
    this._searchAbort = new AbortController();

    try {
      const url = `${NOMINATIM}?q=${encodeURIComponent(query)}&format=jsonv2&limit=6&addressdetails=1`;
      const res = await fetch(url, {
        signal: this._searchAbort.signal,
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(String(res.status));
      const list = await res.json();
      this._renderResults(list, hopFirst);
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      this.results.innerHTML =
        '<div class="searching">Recherche indisponible. Utilise un raccourci ci-dessous.</div>';
    }
  }

  _renderResults(list, hopFirst) {
    this.results.innerHTML = '';
    if (!list.length) {
      this.results.innerHTML = '<div class="searching">Aucun résultat.</div>';
      return;
    }
    for (const item of list) {
      const lat = parseFloat(item.lat);
      const lon = parseFloat(item.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const btn = document.createElement('button');
      btn.className = 'result';
      const label = item.display_name || item.name || 'Lieu';
      const head = label.split(',')[0];
      btn.innerHTML = `<strong>${escapeHtml(head)}</strong><span>${escapeHtml(label)}</span>`;
      btn.addEventListener('click', () => this.onHop(lat, lon, head));
      this.results.appendChild(btn);
    }
    if (hopFirst) {
      const first = this.results.querySelector('button');
      if (first) first.click();
    }
  }

  _bindSettings() {
    const bind = (id, key, transform = (v) => v, event = 'change') => {
      const el = this.root.querySelector(id);
      if (!el) return;
      if (el.type === 'checkbox') el.checked = !!this.settings[key];
      else el.value = String(this.settings[key]);
      el.addEventListener(event, () => {
        this.settings[key] = el.type === 'checkbox' ? el.checked : transform(el.value);
        this.onSettings(this.settings, key);
      });
    };

    bind('#set-quality', 'quality');
    bind('#set-shadows', 'shadows');
    bind('#set-audio', 'audio');
    bind('#set-volume', 'volume', Number, 'input');
    bind('#set-units', 'units');
    bind('#set-time', 'timeOfDay', Number, 'input');
    bind('#set-autotime', 'autoTime');
    bind('#set-fps', 'showFps');
  }

  /** Attach the rasterised city map, once the dataset has loaded. */
  setMapImage(image) {
    this.mapImage = image;
    this.mapWrap.style.display = image ? 'flex' : 'none';
    this.drawMap();
  }

  drawMap() {
    if (!this.mapImage || !this.mapCanvas || this.mapWrap.style.display === 'none') return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const rect = this.mapCanvas.getBoundingClientRect();
    if (!rect.width) return;
    this.mapCanvas.width = Math.round(rect.width * dpr);
    this.mapCanvas.height = Math.round(rect.height * dpr);
    this._view = paintMap(this.mapCanvas, this.mapImage);

    const ctx = this.mapCanvas.getContext('2d');
    for (const p of PRESETS) {
      const { px, py } = this._view.toPixel(p.lat, p.lon);
      if (!this._view.contains(px, py)) continue;
      marker(ctx, px, py, '#ffc857', p.name, 4);
    }
  }

  _bindMap() {
    this.mapCanvas.addEventListener('click', (e) => {
      if (!this._view) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const rect = this.mapCanvas.getBoundingClientRect();
      const px = (e.clientX - rect.left) * dpr;
      const py = (e.clientY - rect.top) * dpr;
      if (!this._view.contains(px, py)) return;
      const { lat, lon } = this._view.toGeo(px, py);
      this.onHop(lat, lon, 'Montréal');
    });
  }

  _buildKeybinds() {
    const host = this.root.querySelector('#keybinds');
    if (!host || !this.input) return;

    const render = () => {
      host.innerHTML = '';
      for (const [action, label] of BINDABLE) {
        const row = document.createElement('div');
        row.className = 'keybind';
        const name = document.createElement('span');
        name.textContent = label;
        const btn = document.createElement('button');
        btn.textContent = this.input.codesFor(action).map(keyLabel).join(' / ');
        btn.addEventListener('click', () => {
          btn.classList.add('capturing');
          btn.textContent = 'appuie…';
          this.input.beginCapture(action, () => render());
        });
        row.append(name, btn);
        host.appendChild(row);
      }
    };

    render();
    const reset = this.root.querySelector('#reset-keys');
    if (reset) {
      reset.addEventListener('click', () => { this.input.resetBindings(); render(); });
    }
  }

  setHint(text) {
    this.hint.textContent = text || '';
  }

  show() {
    this.visible = true;
    this.el.classList.remove('hidden');
  }

  hide() {
    this.visible = false;
    this.el.classList.add('hidden');
    this.panel.classList.remove('visible');
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export { PRESETS };
