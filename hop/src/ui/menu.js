// Start screen, place search and settings.
//
// Search goes through Nominatim, which asks for at most one request a second
// and a genuine identifying Referer — a browser supplies the latter on its
// own, and the debounce below supplies the former.

const PRESETS = [
  { name: 'Plateau-Mont-Royal', sub: 'Montréal', lat: 45.5265, lon: -73.5795 },
  { name: 'Vieux-Montréal', sub: 'Montréal', lat: 45.5065, lon: -73.5540 },
  { name: 'Mile End', sub: 'Montréal', lat: 45.5230, lon: -73.5990 },
  { name: 'Saint-Léonard', sub: 'Montréal', lat: 45.5880, lon: -73.5940 },
  { name: 'Centre-ville', sub: 'Montréal', lat: 45.5015, lon: -73.5700 },
  { name: 'Québec', sub: 'Vieux-Québec', lat: 46.8130, lon: -71.2080 },
  { name: 'Paris', sub: 'Le Marais', lat: 48.8590, lon: 2.3600 },
  { name: 'Manhattan', sub: 'New York', lat: 40.7420, lon: -73.9890 },
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

    this.el = root.querySelector('#menu');
    this.input = root.querySelector('#search-input');
    this.results = root.querySelector('#search-results');
    this.presetsEl = root.querySelector('#presets');
    this.hint = root.querySelector('#menu-hint');
    this.panel = root.querySelector('#settings');
    this.visible = true;

    this._searchTimer = 0;
    this._searchAbort = null;
    this._lastQuery = '';

    this._buildPresets();
    this._bindSearch();
    this._bindSettings();

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
    this.input.addEventListener('input', () => {
      const q = this.input.value.trim();
      clearTimeout(this._searchTimer);
      if (q.length < 3) {
        this.results.innerHTML = '';
        this.results.classList.remove('visible');
        return;
      }
      this._searchTimer = setTimeout(() => this._search(q), 420);
    });

    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const first = this.results.querySelector('button');
        if (first) first.click();
        else this._search(this.input.value.trim(), true);
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
