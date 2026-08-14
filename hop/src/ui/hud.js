// The heads-up display: dial, minimap, stopwatch, notifications.
//
// The two canvases are redrawn on a budget — the dial every frame because the
// needle has to be smooth, the minimap twelve times a second because nobody
// can tell and it saves a couple of milliseconds on a dense tile.

import { formatTime } from '../game/timetrial.js';

const MINIMAP_RANGE = 260;      // metres from edge to edge

export class Hud {
  constructor(root) {
    this.root = root;
    this.dial = root.querySelector('#dial');
    this.dialCtx = this.dial.getContext('2d');
    this.minimap = root.querySelector('#minimap');
    this.minimapCtx = this.minimap.getContext('2d');

    this.speedValue = root.querySelector('#speed-value');
    this.speedUnit = root.querySelector('#speed-unit');
    this.gearEl = root.querySelector('#gear');
    this.timerEl = root.querySelector('#timer');
    this.timerLabel = root.querySelector('#timer-label');
    this.bestEl = root.querySelector('#best');
    this.placeEl = root.querySelector('#place');
    this.toastEl = root.querySelector('#toast');
    this.statusEl = root.querySelector('#status');
    this.fpsEl = root.querySelector('#fps');
    this.scoreEl = root.querySelector('#score');
    this.scoreTotal = root.querySelector('#score-total');
    this.scoreChain = root.querySelector('#score-chain');
    this.scoreMult = root.querySelector('#score-mult');
    this.scoreLabel = root.querySelector('#score-label');
    this.playersEl = root.querySelector('#players');

    this._playerSig = '';
    this._toastTimer = 0;
    this._minimapTimer = 0;
    this._dpr = Math.min(2, window.devicePixelRatio || 1);
    this._needle = 0;
    this._resize();
    window.addEventListener('resize', () => this._resize());
  }

  _resize() {
    for (const canvas of [this.dial, this.minimap]) {
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(80, rect.width || canvas.clientWidth || 170);
      const h = Math.max(80, rect.height || canvas.clientHeight || 170);
      canvas.width = Math.round(w * this._dpr);
      canvas.height = Math.round(h * this._dpr);
    }
  }

  toast(message, ms = 2600) {
    this.toastEl.textContent = message;
    this.toastEl.classList.add('visible');
    this._toastTimer = ms / 1000;
  }

  setStatus(message, tone = '') {
    this.statusEl.textContent = message || '';
    this.statusEl.classList.toggle('visible', !!message);
    this.statusEl.classList.toggle('urgent', tone === 'urgent');
  }

  setPlace(name) {
    this.placeEl.textContent = name || '';
  }

  /**
   * Who else is in the room, top left, under the place name.
   *
   * Rebuilt only when something actually changed. Speeds are rounded to five
   * km/h first, because the point of this list is "who is here and are they
   * moving", and a needle twitching sixty times a second in the corner of the
   * eye is a distraction with no information in it.
   *
   * @param {Array} rows from Multiplayer.roster(), or empty when offline
   */
  setPlayers(rows) {
    if (!this.playersEl) return;
    const list = rows && rows.length > 1 ? rows : [];
    const sig = list.map((r) => `${r.name}|${r.colour}|${Math.round(r.speedKmh / 5)}`).join(';');
    if (sig === this._playerSig) return;
    this._playerSig = sig;

    this.playersEl.textContent = '';
    for (const r of list) {
      const row = document.createElement('div');
      row.className = `player-row${r.self ? ' self' : ''}`;

      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.style.background = `#${(r.colour >>> 0).toString(16).padStart(6, '0')}`;

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = r.name;

      const kmh = document.createElement('span');
      kmh.className = 'kmh';
      kmh.textContent = `${Math.round(r.speedKmh)}`;

      row.append(chip, name, kmh);
      this.playersEl.appendChild(row);
    }
  }

  /**
   * @param {object} s {speedKmh, rpm, gear, redline, reversing, units, fps, showFps}
   * @param {number} dt
   */
  update(s, dt) {
    if (this._toastTimer > 0) {
      this._toastTimer -= dt;
      if (this._toastTimer <= 0) this.toastEl.classList.remove('visible');
    }

    const mph = s.units === 'mph';
    const shown = mph ? s.speedKmh * 0.621371 : s.speedKmh;
    this.speedValue.textContent = String(Math.round(Math.abs(shown)));
    this.speedUnit.textContent = mph ? 'mph' : 'km/h';
    this.gearEl.textContent = s.reversing ? 'R' : (Math.abs(s.speedKmh) < 1 ? 'N' : String(s.gear));

    // Ease the needle so a gearshift does not make it snap.
    const target = Math.min(1, s.rpm / (s.redline || 7000));
    this._needle += (target - this._needle) * Math.min(1, dt * 14);
    this._drawDial(this._needle, Math.abs(shown), s.redline);

    if (this.fpsEl) {
      this.fpsEl.style.display = s.showFps ? 'block' : 'none';
      if (s.showFps) this.fpsEl.textContent = `${Math.round(s.fps)} fps`;
    }
  }

  /** @param {object} s from Score.snapshot() */
  setScore(s) {
    if (!this.scoreEl) return;
    this.scoreTotal.textContent = s.total.toLocaleString('fr-CA');
    const active = s.chain > 0;
    this.scoreEl.classList.toggle('chaining', active);
    this.scoreChain.textContent = active ? `+${s.chain.toLocaleString('fr-CA')}` : '';
    this.scoreMult.textContent = s.multiplier > 1 ? `×${s.multiplier}` : '';
    if (s.label) {
      this.scoreLabel.textContent = s.label.points
        ? `${s.label.label} +${s.label.points}`
        : s.label.label;
      this.scoreLabel.style.opacity = String(Math.min(1, s.flash * 1.6));
    } else {
      this.scoreLabel.style.opacity = '0';
    }
  }

  _drawDial(t, speed, redline) {
    const ctx = this.dialCtx;
    const w = this.dial.width, h = this.dial.height;
    const cx = w / 2, cy = h / 2;
    const r = Math.min(w, h) / 2 - 4 * this._dpr;
    ctx.clearRect(0, 0, w, h);

    const START = Math.PI * 0.75;
    const SWEEP = Math.PI * 1.5;

    // Track
    ctx.lineWidth = 7 * this._dpr;
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(255,255,255,0.13)';
    ctx.beginPath();
    ctx.arc(cx, cy, r, START, START + SWEEP);
    ctx.stroke();

    // Redline zone
    ctx.strokeStyle = 'rgba(232,80,58,0.55)';
    ctx.beginPath();
    ctx.arc(cx, cy, r, START + SWEEP * 0.86, START + SWEEP);
    ctx.stroke();

    // Rev fill
    const grad = ctx.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, '#6fd3ff');
    grad.addColorStop(0.6, '#8ee6a0');
    grad.addColorStop(1, '#ffcf5c');
    ctx.strokeStyle = t > 0.86 ? '#ff6a4d' : grad;
    ctx.beginPath();
    ctx.arc(cx, cy, r, START, START + SWEEP * Math.max(0.001, t));
    ctx.stroke();

    // Ticks
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1.5 * this._dpr;
    const steps = Math.max(4, Math.round((redline || 7000) / 1000));
    for (let i = 0; i <= steps; i++) {
      const a = START + (SWEEP * i) / steps;
      const inner = r - 11 * this._dpr;
      const outer = r - 5 * this._dpr;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
      ctx.lineTo(cx + Math.cos(a) * outer, cy + Math.sin(a) * outer);
      ctx.stroke();
    }
    void speed;
  }

  /**
   * @param {Array} roads   {points:[{x,z}], spec}
   * @param {object} car    {x, z, yaw}
   * @param {object} trial  optional {start, finish}
   */
  drawMinimap(roads, car, trial, dt, waypoint = null, others = null) {
    this._minimapTimer -= dt;
    if (this._minimapTimer > 0) return;
    this._minimapTimer = 1 / 12;

    const ctx = this.minimapCtx;
    const w = this.minimap.width, h = this.minimap.height;
    const scale = Math.min(w, h) / MINIMAP_RANGE;

    ctx.clearRect(0, 0, w, h);
    ctx.save();

    // Round clip so the map sits in its bezel.
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, Math.min(w, h) / 2 - 1, 0, Math.PI * 2);
    ctx.clip();

    ctx.fillStyle = 'rgba(18,22,28,0.82)';
    ctx.fillRect(0, 0, w, h);

    // Car-up: translate to the car, rotate so its heading points up-screen.
    //
    // World forward is (sin ψ, cos ψ), and canvas y grows downward, so after
    // ctx.rotate(θ) that vector lands at (sin(ψ−θ), cos(ψ−θ)). Screen-up is
    // (0, −1), which needs ψ−θ = π. Rotating by ψ alone — the obvious guess —
    // puts the map exactly upside down.
    ctx.translate(w / 2, h / 2);
    ctx.rotate(car.yaw - Math.PI);
    ctx.scale(scale, scale);
    ctx.translate(-car.x, -car.z);

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const range = MINIMAP_RANGE * 0.75;

    for (const road of roads) {
      const pts = road.points;
      if (pts.length < 2) continue;
      // Cheap reject: skip anything clearly outside the disc.
      if (Math.abs(pts[0].x - car.x) > range && Math.abs(pts[0].z - car.z) > range
          && Math.abs(pts[pts.length - 1].x - car.x) > range
          && Math.abs(pts[pts.length - 1].z - car.z) > range) continue;

      const spec = road.spec;
      ctx.strokeStyle = spec.kind === 'major' ? '#e8d9a8'
        : spec.kind === 'alley' ? 'rgba(200,200,200,0.28)' : 'rgba(226,230,236,0.7)';
      ctx.lineWidth = Math.max(1.2 / scale, spec.width * 0.5);
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].z);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].z);
      ctx.stroke();
    }

    if (trial && trial.start) {
      drawPin(ctx, trial.start.x, trial.start.z, '#35c46a', 5 / scale);
    }
    if (trial && trial.finish) {
      drawPin(ctx, trial.finish.x, trial.finish.z, '#e8503a', 5 / scale);
    }

    // The other players, in their own colours, still inside the map transform
    // so they sit on the right street. Drawn as arrowheads rather than dots
    // because which way somebody is pointing is half of what you want to know.
    if (others) {
      for (const o of others) {
        if (Math.abs(o.x - car.x) > range || Math.abs(o.z - car.z) > range) continue;
        ctx.save();
        ctx.translate(o.x, o.z);
        // Inside the map transform these are world coordinates, and the shape
        // is drawn pointing at local −y. Sending that to world (sin θ, cos θ)
        // needs π − θ; rotating by −θ, the obvious guess, mirrors it.
        ctx.rotate(Math.PI - o.yaw);
        ctx.fillStyle = `#${(o.colour >>> 0).toString(16).padStart(6, '0')}`;
        const r = 6 / scale;
        ctx.beginPath();
        ctx.moveTo(0, -r);
        ctx.lineTo(r * 0.72, r * 0.85);
        ctx.lineTo(0, r * 0.42);
        ctx.lineTo(-r * 0.72, r * 0.85);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = 'rgba(12,16,20,0.8)';
        ctx.lineWidth = 1.4 / scale;
        ctx.stroke();
        ctx.restore();
      }
    }

    ctx.restore();

    // The active checkpoint. Clamped to the rim when it is off the minimap,
    // because "which way is it" matters more than "exactly where is it".
    if (waypoint) {
      const dx = waypoint.x - car.x, dz = waypoint.z - car.z;
      const a = car.yaw - Math.PI;
      // Same rotation the map got, applied by hand to a single point.
      let sx = (dx * Math.cos(a) - dz * Math.sin(a)) * scale;
      let sy = (dx * Math.sin(a) + dz * Math.cos(a)) * scale;
      const rim = Math.min(w, h) / 2 - 9 * this._dpr;
      const d = Math.hypot(sx, sy);
      const clamped = d > rim;
      if (clamped && d > 0) { sx = (sx / d) * rim; sy = (sy / d) * rim; }
      ctx.save();
      ctx.translate(w / 2 + sx, h / 2 + sy);
      ctx.fillStyle = '#ffc857';
      ctx.beginPath();
      ctx.arc(0, 0, (clamped ? 4 : 5) * this._dpr, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(12,16,20,0.85)';
      ctx.lineWidth = 1.5 * this._dpr;
      ctx.stroke();
      ctx.restore();
    }

    // The car marker stays put in the middle, pointing up.
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(0, -7 * this._dpr);
    ctx.lineTo(5 * this._dpr, 6 * this._dpr);
    ctx.lineTo(0, 3 * this._dpr);
    ctx.lineTo(-5 * this._dpr, 6 * this._dpr);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Bezel
    ctx.strokeStyle = 'rgba(255,255,255,0.20)';
    ctx.lineWidth = 2 * this._dpr;
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, Math.min(w, h) / 2 - 1, 0, Math.PI * 2);
    ctx.stroke();
  }

  /** @param {object} t {state, elapsed, best, lastTime, sharedTarget} */
  setTrial(t) {
    if (!t || t.state === 'idle') {
      this.timerEl.textContent = '';
      this.timerLabel.textContent = '';
      this.bestEl.textContent = '';
      this.root.querySelector('#trial').classList.remove('visible');
      return;
    }
    this.root.querySelector('#trial').classList.add('visible');

    if (t.state === 'placing') {
      this.timerLabel.textContent = 'Départ posé';
      this.timerEl.textContent = 'Pose l’arrivée';
      this.bestEl.textContent = '';
      return;
    }
    if (t.state === 'armed') {
      this.timerLabel.textContent = 'Prêt';
      this.timerEl.textContent = 'Franchis le départ';
      this.bestEl.textContent = t.best != null ? `Record ${formatTime(t.best)}` : '';
      return;
    }
    if (t.state === 'running') {
      this.timerLabel.textContent = 'En course';
      this.timerEl.textContent = formatTime(t.elapsed);
      this.bestEl.textContent = t.best != null ? `Record ${formatTime(t.best)}` : '';
      return;
    }
    this.timerLabel.textContent = t.improved ? 'Nouveau record' : 'Terminé';
    this.timerEl.textContent = formatTime(t.lastTime);
    this.bestEl.textContent = t.best != null ? `Record ${formatTime(t.best)}` : '';
  }
}

function drawPin(ctx, x, z, colour, r) {
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.arc(x, z, r, 0, Math.PI * 2);
  ctx.fill();
}
