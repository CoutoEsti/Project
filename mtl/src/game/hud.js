// Speed, where you are, and the map — the minimap turns with the car, the big
// map (M) shows the whole city and teleports on a click. Both draw from one
// picture of the map rendered once at load: water, blocks, streets, roads by
// level, landmarks.

const SCALE = 0.4;            // map picture: pixels per metre (2.5 m a pixel)

const COLORS = {
  water: '#0b1c2a',
  land: '#4a505c',            // what is left between blocks: streets
  block: '#1b1f27',
  park: '#17301f',
  plaza: '#2a2d34',
  mountain: '#1e3a25',
  hole: '#0c0e12',
  road: { highway: '#f2a33a', ramp: '#d88a2c', bridge: '#e8b85a', mountain: '#cbbf98', circuit: '#e04848', road: '#a3a9b3' },
  tunnel: '#7c5b2c',
};

export class Hud {
  /**
   * @param layout the compiled map
   * @param el     { root, zone, road, kmh, minimap, bigmap, bigmapCanvas }
   */
  constructor(layout, el) {
    this.layout = layout;
    this.el = el;
    this.W = layout.map.world;
    this.picture = renderMap(layout, SCALE);
    this.scale = this.picture.scale;
    this.zone = null;
    this.zoneTimer = 0;
    this.roadKey = '';
    this.kmhShown = -1;
    this.miniTimer = 0;
    this.open = false;
    this.onTeleport = null;
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const size = Math.round((el.minimap.clientWidth || 180) * dpr);
    el.minimap.width = size;
    el.minimap.height = size;
    el.bigmapCanvas.addEventListener('click', (e) => this._click(e));
  }

  show() { this.el.root.hidden = false; }
  hide() { this.el.root.hidden = true; }

  /**
   * @param dt   render delta
   * @param info { x, n, heading, kmh, zone, where: {name, ref} | null, span? }
   */
  update(dt, info) {
    const kmh = Math.round(info.kmh);
    if (kmh !== this.kmhShown) { this.el.kmh.textContent = String(kmh); this.kmhShown = kmh; }

    if (info.zone && info.zone !== this.zone) {
      this.zone = info.zone;
      this.el.zone.textContent = info.zone;
      this.el.zone.classList.add('show');
      this.zoneTimer = 2.6;
    }
    if (this.zoneTimer > 0) {
      this.zoneTimer -= dt;
      if (this.zoneTimer <= 0) this.el.zone.classList.remove('show');
    }

    const w = info.where;
    const key = w ? `${w.ref || ''}|${w.name}` : '';
    if (key !== this.roadKey) {
      this.roadKey = key;
      const r = this.el.road;
      r.textContent = '';
      if (w) {
        if (w.ref) {
          const s = document.createElement('span');
          s.className = 'shield';
          s.textContent = w.ref;
          r.appendChild(s);
        }
        r.appendChild(document.createTextNode(w.name));
      }
      r.hidden = !w;
    }

    // The minimap does not need 60 Hz; 20 is smooth enough and cheap on phones.
    this.miniTimer -= dt;
    if (this.miniTimer <= 0) {
      this.miniTimer = 0.05;
      this._minimap(info);
    }
    if (this.open) this._bigmap(info);
  }

  _minimap(info) {
    const cv = this.el.minimap, c = cv.getContext('2d');
    const S = cv.width, r = S / 2;
    const metres = info.span || 520 + Math.min(1, info.kmh / 160) * 380;   // diameter shown
    const k = S / metres;
    c.save();
    c.clearRect(0, 0, S, S);
    c.beginPath();
    c.arc(r, r, r, 0, Math.PI * 2);
    c.clip();
    c.fillStyle = COLORS.water;
    c.fillRect(0, 0, S, S);
    c.translate(r, r);
    c.rotate(-info.heading);
    c.scale(k / this.scale, k / this.scale);
    c.drawImage(this.picture, -(info.x - this.W.x0) * this.scale, -(this.W.n1 - info.n) * this.scale);
    c.restore();
    // The car, always pointing up.
    c.save();
    c.translate(r, r);
    c.fillStyle = '#37e0ff';
    c.strokeStyle = '#001018';
    c.lineWidth = Math.max(1, S / 110);
    const a = S * 0.045;
    c.beginPath();
    c.moveTo(0, -a * 1.3);
    c.lineTo(a, a);
    c.lineTo(0, a * 0.45);
    c.lineTo(-a, a);
    c.closePath();
    c.fill();
    c.stroke();
    c.restore();
  }

  toggleMap(info) {
    this.open = !this.open;
    this.el.bigmap.hidden = !this.open;
    if (this.open) this._bigmap(info, true);
    return this.open;
  }

  closeMap() {
    this.open = false;
    this.el.bigmap.hidden = true;
  }

  _bigmap(info, resize = false) {
    const cv = this.el.bigmapCanvas;
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const pw = this.picture.width, ph = this.picture.height;
    const fit = Math.min((innerWidth * 0.96) / pw, (innerHeight * 0.88) / ph);
    if (resize || !this._fit || Math.abs(this._fit - fit) > 1e-3) {
      this._fit = fit;
      cv.style.width = `${Math.round(pw * fit)}px`;
      cv.style.height = `${Math.round(ph * fit)}px`;
      cv.width = Math.round(pw * fit * dpr);
      cv.height = Math.round(ph * fit * dpr);
    }
    const c = cv.getContext('2d');
    const k = cv.width / pw;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.drawImage(this.picture, 0, 0, cv.width, cv.height);
    c.scale(k, k);
    const P = (x, n) => [(x - this.W.x0) * this.scale, (this.W.n1 - n) * this.scale];
    const L = this.layout;
    // District names, one per name.
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.font = `600 ${11 / k}px system-ui, sans-serif`;
    const said = new Set();
    for (const d of L.quartiers || []) {
      if (said.has(d.nom) || d.type === 'macrohood') continue;
      said.add(d.nom);
      const [px, py] = P(d.x, d.n);
      c.fillStyle = 'rgba(0,0,0,0.55)';
      c.fillText(d.nom.toUpperCase(), px + 1 / k, py + 1 / k);
      c.fillStyle = 'rgba(214,222,235,0.78)';
      c.fillText(d.nom.toUpperCase(), px, py);
    }
    // Spawn points: where a click lands you is the nearest road, but these
    // are the places worth knowing.
    c.font = `600 ${10 / k}px system-ui, sans-serif`;
    c.textAlign = 'left';
    for (const s of L.map.spawns) {
      const [px, py] = P(s.x, s.n);
      c.fillStyle = '#37e0ff';
      c.beginPath();
      c.arc(px, py, 3.2 / k, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = 'rgba(55,224,255,0.9)';
      c.fillText(s.name, px + 6 / k, py);
    }
    // The car.
    const [px, py] = P(info.x, info.n);
    c.save();
    c.translate(px, py);
    c.rotate(info.heading);
    c.fillStyle = '#ffffff';
    c.strokeStyle = '#000';
    c.lineWidth = 1.5 / k;
    const a = 7 / k;
    c.beginPath();
    c.moveTo(0, -a * 1.4);
    c.lineTo(a, a);
    c.lineTo(0, a * 0.4);
    c.lineTo(-a, a);
    c.closePath();
    c.fill();
    c.stroke();
    c.restore();
  }

  _click(e) {
    const cv = this.el.bigmapCanvas;
    const r = cv.getBoundingClientRect();
    const u = (e.clientX - r.left) / r.width, v = (e.clientY - r.top) / r.height;
    const x = this.W.x0 + u * (this.W.x1 - this.W.x0);
    const n = this.W.n1 - v * (this.W.n1 - this.W.n0);
    if (this.onTeleport) this.onTeleport(x, n);
  }
}

/**
 * The whole map as one picture, north up, `scale` pixels a metre. Drawn once;
 * the minimap and the big map only ever copy from it. The scale shrinks for a
 * big zone so the picture stays a few million pixels.
 */
export function renderMap(layout, scale = SCALE) {
  const W = layout.map.world;
  const maxPx = 4200;
  scale = Math.min(scale, maxPx / Math.max(W.x1 - W.x0, W.n1 - W.n0));
  const cv = document.createElement('canvas');
  cv.width = Math.ceil((W.x1 - W.x0) * scale);
  cv.height = Math.ceil((W.n1 - W.n0) * scale);
  cv.scale = scale;
  const c = cv.getContext('2d');
  const P = (x, n) => [(x - W.x0) * scale, (W.n1 - n) * scale];
  const polyPath = (poly) => {
    for (const ring of poly) {
      ring.forEach(([x, n], i) => {
        const [px, py] = P(x, n);
        if (i) c.lineTo(px, py); else c.moveTo(px, py);
      });
      c.closePath();
    }
  };
  const fillMulti = (multi, color) => {
    c.fillStyle = color;
    c.beginPath();
    for (const poly of multi) polyPath(poly);
    c.fill('evenodd');
  };

  c.fillStyle = COLORS.block;
  c.fillRect(0, 0, cv.width, cv.height);
  const green = { parc: COLORS.park, gazon: COLORS.park, terrain: COLORS.park, golf: COLORS.park, cimetiere: COLORS.park, foret: COLORS.mountain };
  for (const g of layout.greens) fillMulti(g.poly, green[g.kind] || COLORS.park);
  for (const g of layout.grounds) if (g.kind === 'place') fillMulti(g.poly, COLORS.plaza);
  fillMulti(layout.water, COLORS.water);
  if (layout.holes.length) fillMulti(layout.holes, COLORS.hole);

  // Streets, widest last so boulevards read over the grid.
  c.lineCap = 'round';
  c.lineJoin = 'round';
  const order = { alley: 0, narrow: 1, plaza: 1, street: 2, avenue: 3, boulevard: 4 };
  const streets = layout.streets.slice().sort((a, b) => (order[a.cls] ?? 2) - (order[b.cls] ?? 2));
  for (const st of streets) {
    c.strokeStyle = st.cls === 'alley' ? '#3a3f47' : COLORS.land;
    c.lineWidth = Math.max(st.cls === 'alley' ? 0.6 : 1, st.width * scale);
    c.beginPath();
    st.path.forEach(([x, n], i) => {
      const [px, py] = P(x, n);
      if (i) c.lineTo(px, py); else c.moveTo(px, py);
    });
    c.stroke();
  }

  // Roads, lowest first, so a viaduct draws over what it crosses and a
  // tunnel under the streets.
  const runs = [];
  for (const r of layout.roads) {
    let cur = null;
    for (const p of r.samples) {
      const key = p.tunnel ? 'tunnel' : 'open';
      if (!cur || cur.key !== key) {
        if (cur) cur.pts.push(p);
        cur = { road: r, key, pts: [], y: 0 };
        runs.push(cur);
      }
      cur.pts.push(p);
      cur.y += p.y - p.gs;
    }
  }
  for (const run of runs) run.y /= run.pts.length || 1;
  runs.sort((a, b) => (b.key === 'tunnel') - (a.key === 'tunnel') || a.y - b.y);
  c.lineCap = 'butt';
  for (const run of runs) {
    const r = run.road;
    const width = Math.max(1.5, r.width * scale);
    c.beginPath();
    run.pts.forEach((p, i) => {
      const [px, py] = P(p.x, p.n);
      if (i) c.lineTo(px, py); else c.moveTo(px, py);
    });
    if (run.key === 'tunnel') {
      c.setLineDash([width * 1.2, width * 0.8]);
      c.strokeStyle = COLORS.tunnel;
      c.lineWidth = width * 0.8;
      c.stroke();
      c.setLineDash([]);
      continue;
    }
    if (run.y > 2) {
      c.strokeStyle = 'rgba(0,0,0,0.65)';
      c.lineWidth = width + 3;
      c.stroke();
    }
    c.strokeStyle = COLORS.road[r.cls] || COLORS.road.road;
    c.lineWidth = width;
    c.stroke();
  }

  // Landmarks: a white dot each.
  c.fillStyle = 'rgba(255,255,255,0.85)';
  for (const l of layout.map.landmarks) {
    const [px, py] = P(l.x, l.n);
    c.beginPath();
    c.arc(px, py, 3, 0, Math.PI * 2);
    c.fill();
  }
  return cv;
}

function centroid(ring) {
  let x = 0, n = 0;
  for (const p of ring) { x += p[0]; n += p[1]; }
  return [x / ring.length, n / ring.length];
}
