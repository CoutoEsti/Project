// Procedural textures, drawn on canvases: nothing to download, no licence, and
// albedo without baked-in lighting. Browser only — under node (the export)
// there is no canvas and materials fall back to plain colours.

export function hasCanvas() {
  return typeof document !== 'undefined' || typeof OffscreenCanvas !== 'undefined';
}

function canvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** Deterministic noise for texture painting. */
function mulberry(seed) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function speckle(ctx, w, h, R, count, size, colours) {
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = colours[Math.floor(R() * colours.length)];
    const s = size * (0.5 + R());
    ctx.fillRect(R() * w, R() * h, s, s);
  }
}

/** Asphalt: aggregate, tar snakes, patches. Tiles every 8 m. */
export function asphalt(THREE) {
  const S = 512, c = canvas(S, S), g = c.getContext('2d'), R = mulberry(11);
  g.fillStyle = '#2d2d31';
  g.fillRect(0, 0, S, S);
  speckle(g, S, S, R, 26000, 1.4, ['#38383c', '#26262a', '#414145', '#1f1f22', '#333337']);
  // Slow mottling.
  for (let i = 0; i < 40; i++) {
    const x = R() * S, y = R() * S, r = 30 + R() * 90;
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    const v = R() < 0.5 ? 'rgba(255,255,255,0.025)' : 'rgba(0,0,0,0.05)';
    gr.addColorStop(0, v);
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // Tar snakes: sealed cracks, darker and a little glossy.
  g.strokeStyle = 'rgba(12,12,14,0.55)';
  for (let i = 0; i < 7; i++) {
    g.lineWidth = 1.5 + R() * 2;
    g.beginPath();
    let x = R() * S, y = R() * S;
    g.moveTo(x, y);
    for (let k = 0; k < 8; k++) { x += (R() - 0.5) * 70; y += (R() - 0.5) * 70; g.lineTo(x, y); }
    g.stroke();
  }
  return tex(THREE, c, 8);
}

export function concrete(THREE, base = '#8b8883', seed = 3) {
  const S = 256, c = canvas(S, S), g = c.getContext('2d'), R = mulberry(seed);
  g.fillStyle = base;
  g.fillRect(0, 0, S, S);
  speckle(g, S, S, R, 5000, 1.2, ['rgba(0,0,0,0.06)', 'rgba(255,255,255,0.05)', 'rgba(0,0,0,0.1)']);
  // Formwork joints.
  g.fillStyle = 'rgba(0,0,0,0.12)';
  g.fillRect(0, S / 2, S, 2);
  g.fillRect(S / 3, 0, 2, S / 2);
  g.fillRect((2 * S) / 3, S / 2, 2, S / 2);
  // Water stains running down.
  for (let i = 0; i < 12; i++) {
    const x = R() * S, w = 3 + R() * 10;
    const gr = g.createLinearGradient(0, 0, 0, S);
    gr.addColorStop(0, 'rgba(0,0,0,0.12)');
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr;
    g.fillRect(x, 0, w, S * (0.3 + R() * 0.6));
  }
  return tex(THREE, c, 4);
}

export function sidewalk(THREE) {
  const S = 256, c = canvas(S, S), g = c.getContext('2d'), R = mulberry(5);
  g.fillStyle = '#85827b';
  g.fillRect(0, 0, S, S);
  speckle(g, S, S, R, 4000, 1.1, ['rgba(0,0,0,0.07)', 'rgba(255,255,255,0.06)']);
  g.strokeStyle = 'rgba(40,38,34,0.45)';
  g.lineWidth = 2;
  for (let i = 0; i <= 2; i++) {
    g.beginPath(); g.moveTo(0, (i * S) / 2); g.lineTo(S, (i * S) / 2); g.stroke();
    g.beginPath(); g.moveTo((i * S) / 2, 0); g.lineTo((i * S) / 2, S); g.stroke();
  }
  return tex(THREE, c, 3);
}

export function grass(THREE) {
  const S = 256, c = canvas(S, S), g = c.getContext('2d'), R = mulberry(7);
  g.fillStyle = '#3f5a33';
  g.fillRect(0, 0, S, S);
  speckle(g, S, S, R, 9000, 1.5, ['#4a6a3a', '#35502b', '#56733f', '#2f4726', '#62704a']);
  return tex(THREE, c, 6);
}

export function gravel(THREE) {
  const S = 256, c = canvas(S, S), g = c.getContext('2d'), R = mulberry(9);
  g.fillStyle = '#5d5850';
  g.fillRect(0, 0, S, S);
  speckle(g, S, S, R, 12000, 1.6, ['#6d675d', '#4d4943', '#77716a', '#3f3b36']);
  return tex(THREE, c, 5);
}

export function pavers(THREE) {
  const S = 256, c = canvas(S, S), g = c.getContext('2d'), R = mulberry(13);
  g.fillStyle = '#6e6960';
  g.fillRect(0, 0, S, S);
  const n = 16, w = S / n;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const off = (j % 2) * w / 2;
      const v = 95 + Math.floor(R() * 30);
      g.fillStyle = `rgb(${v + 8},${v + 2},${v - 8})`;
      g.fillRect(i * w + off + 1, j * w + 1, w - 2, w - 2);
    }
  }
  return tex(THREE, c, 4);
}

export function tiles(THREE) {
  const S = 256, c = canvas(S, S), g = c.getContext('2d');
  g.fillStyle = '#b9b29f';
  g.fillRect(0, 0, S, S);
  g.fillStyle = '#d6cfba';
  const n = 8, w = S / n;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) g.fillRect(i * w + 1.5, j * w + 1.5, w - 3, w - 3);
  // A darker band at bumper height: every tunnel has one.
  g.fillStyle = 'rgba(40,40,40,0.35)';
  g.fillRect(0, S * 0.78, S, S * 0.22);
  return tex(THREE, c, 2);
}

export function roof(THREE) {
  const S = 256, c = canvas(S, S), g = c.getContext('2d'), R = mulberry(17);
  g.fillStyle = '#3a3836';
  g.fillRect(0, 0, S, S);
  speckle(g, S, S, R, 9000, 1.3, ['#44423f', '#302e2c', '#4d4a46', '#2a2826']);
  return tex(THREE, c, 10);
}

export function water(THREE) {
  const S = 256, c = canvas(S, S), g = c.getContext('2d'), R = mulberry(19);
  g.fillStyle = '#808080';
  g.fillRect(0, 0, S, S);
  for (let i = 0; i < 260; i++) {
    const x = R() * S, y = R() * S, w = 20 + R() * 60, h = 2 + R() * 3;
    g.fillStyle = R() < 0.5 ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.18)';
    g.beginPath();
    g.ellipse(x, y, w / 2, h / 2, 0, 0, Math.PI * 2);
    g.fill();
  }
  const t = tex(THREE, c, 30);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

/** Chain-link fence: alpha-tested diamond mesh. */
export function chainlink(THREE) {
  const S = 128, c = canvas(S, S), g = c.getContext('2d');
  g.clearRect(0, 0, S, S);
  g.strokeStyle = 'rgba(170,170,170,1)';
  g.lineWidth = 2.5;
  const n = 6, w = S / n;
  for (let i = -n; i <= n * 2; i++) {
    g.beginPath(); g.moveTo(i * w, 0); g.lineTo(i * w + S, S); g.stroke();
    g.beginPath(); g.moveTo(i * w, S); g.lineTo(i * w + S, 0); g.stroke();
  }
  return tex(THREE, c, 1);
}

/** Searchlight falloff along a cone's length (v = 0 at the lamp). */
export function beamFade(THREE) {
  const c = canvas(4, 128), g = c.getContext('2d');
  // Cone UVs run v = 1 at the apex (the lamp) to 0 at the far rim; with the
  // canvas flipped, v = 1 is the top row.
  const gr = g.createLinearGradient(0, 0, 0, 128);
  gr.addColorStop(0, '#ffffff');
  gr.addColorStop(0.3, '#8a8a8a');
  gr.addColorStop(1, '#000000');
  g.fillStyle = gr;
  g.fillRect(0, 0, 4, 128);
  return new THREE.CanvasTexture(c);
}

/** Soft radial spot for the pools of light under street lamps. */
export function lightPool(THREE) {
  const S = 128, c = canvas(S, S), g = c.getContext('2d');
  const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  gr.addColorStop(0.7, 'rgba(255,255,255,0.15)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, S, S);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * The facade atlas: one row per facade type, each row a single window bay one
 * floor high. The shader tiles it per bay and per floor and decides, window by
 * window, which ones are lit — so the pattern never repeats.
 * RGB = albedo, A = glass mask.
 */
export const FACADES = [
  'brick_red', 'brick_brown', 'brick_buff', 'brick_dark', 'brick_old', 'stone', 'stone_dark',
  'concrete', 'panel', 'panel_dark', 'glass_blue', 'glass_dark', 'glass_green', 'glass_silver',
];

const FACADE_LOOK = {
  brick_red: { wall: '#8e4634', mortar: '#a57b68', brick: true, win: [0.28, 0.2, 0.44, 0.62], frame: '#e8e1d2', glass: '#1b2530' },
  brick_brown: { wall: '#6b4432', mortar: '#8d7563', brick: true, win: [0.28, 0.2, 0.44, 0.62], frame: '#d9d2c3', glass: '#1b2530' },
  brick_buff: { wall: '#b59a74', mortar: '#cab69a', brick: true, win: [0.3, 0.2, 0.4, 0.6], frame: '#3d3a36', glass: '#1a232d' },
  brick_dark: { wall: '#523229', mortar: '#6e5a50', brick: true, win: [0.28, 0.2, 0.44, 0.62], frame: '#e6e0d0', glass: '#1b2530' },
  brick_old: { wall: '#7a4a3a', mortar: '#8f7a6a', brick: true, win: [0.18, 0.16, 0.64, 0.6], frame: '#2f2f2f', glass: '#1d262e' },
  stone: { wall: '#9d978a', mortar: '#8a8477', stone: true, win: [0.3, 0.18, 0.4, 0.6], frame: '#eee7d8', glass: '#1b242d' },
  stone_dark: { wall: '#6f6a61', mortar: '#615c54', stone: true, win: [0.3, 0.18, 0.4, 0.6], frame: '#d8d0bf', glass: '#1b242d' },
  concrete: { wall: '#8f8c86', mortar: '#8f8c86', win: [0.12, 0.2, 0.76, 0.55], frame: '#3a3a3a', glass: '#1c2631' },
  panel: { wall: '#9ea3a6', mortar: '#8d9295', panel: true, win: [0.1, 0.62, 0.8, 0.18], frame: '#555', glass: '#26313b' },
  panel_dark: { wall: '#4f5559', mortar: '#454b4f', panel: true, win: [0.1, 0.62, 0.8, 0.18], frame: '#2a2a2a', glass: '#26313b' },
  glass_blue: { wall: '#2f4a63', mortar: '#2f4a63', curtain: true, win: [0.04, 0.08, 0.92, 0.84], frame: '#a8b4bd', glass: '#27435c' },
  glass_dark: { wall: '#1e262d', mortar: '#1e262d', curtain: true, win: [0.04, 0.08, 0.92, 0.84], frame: '#5a646c', glass: '#1a2229' },
  glass_green: { wall: '#2c4a45', mortar: '#2c4a45', curtain: true, win: [0.04, 0.08, 0.92, 0.84], frame: '#8fa29c', glass: '#26403c' },
  glass_silver: { wall: '#6d7a84', mortar: '#6d7a84', curtain: true, win: [0.04, 0.08, 0.92, 0.84], frame: '#c8d0d6', glass: '#56646f' },
};

export function facadeAtlas(THREE) {
  const W = 128, H = 128, rows = FACADES.length;
  const c = canvas(W, H * rows), g = c.getContext('2d');
  const R = mulberry(23);
  FACADES.forEach((name, row) => {
    const L = FACADE_LOOK[name];
    const y0 = row * H;
    g.fillStyle = L.wall;
    g.fillRect(0, y0, W, H);
    if (L.brick) {
      g.fillStyle = L.mortar;
      const bh = 6;
      for (let j = 0; j < H / bh; j++) {
        g.fillRect(0, y0 + j * bh, W, 1);
        const off = (j % 2) * 8;
        for (let i = 0; i < W / 16 + 1; i++) g.fillRect(i * 16 + off, y0 + j * bh, 1, bh);
      }
      speckle(g, W, H, R, 500, 2, ['rgba(0,0,0,0.08)', 'rgba(255,255,255,0.05)']);
    } else if (L.stone) {
      g.fillStyle = L.mortar;
      for (let j = 0; j < 4; j++) {
        g.fillRect(0, y0 + j * 32, W, 1.5);
        for (let i = 0; i < 3; i++) g.fillRect(i * 48 + (j % 2) * 24, y0 + j * 32, 1.5, 32);
      }
    } else if (L.panel) {
      g.fillStyle = L.mortar;
      for (let i = 0; i < 8; i++) g.fillRect(i * 16, y0, 2, H);
    }
    // The window: frame, then glass. A = 1 on glass.
    const [wx, wy, ww, wh] = L.win;
    const x = wx * W, y = y0 + (1 - wy - wh) * H, w = ww * W, h = wh * H;
    g.fillStyle = L.frame;
    g.fillRect(x - 3, y - 3, w + 6, h + 6);
    g.fillStyle = L.glass;
    g.fillRect(x, y, w, h);
    if (!L.curtain) {
      g.fillStyle = L.frame;
      g.fillRect(x + w / 2 - 1.5, y, 3, h);
      g.fillRect(x, y + h * 0.38, w, 3);
      // Sill.
      g.fillStyle = 'rgba(230,225,215,0.9)';
      g.fillRect(x - 5, y + h + 3, w + 10, 4);
    } else {
      g.fillStyle = L.frame;
      g.fillRect(0, y0 + H - 4, W, 4);
      g.fillRect(0, y0, 3, H);
    }
  });
  // Glass mask into the alpha channel, from the window rectangles.
  const img = g.getImageData(0, 0, W, H * rows);
  FACADES.forEach((name, row) => {
    const [wx, wy, ww, wh] = FACADE_LOOK[name].win;
    const x0 = Math.floor(wx * W), x1 = Math.ceil((wx + ww) * W);
    const ya = Math.floor(row * H + (1 - wy - wh) * H), yb = Math.ceil(row * H + (1 - wy) * H);
    for (let y = row * H; y < (row + 1) * H; y++) {
      for (let x = 0; x < W; x++) {
        const inside = x >= x0 && x < x1 && y >= ya && y < yb;
        img.data[(y * W + x) * 4 + 3] = inside ? 255 : 0;
      }
    }
  });
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.premultiplyAlpha = false;
  return t;
}

/** Plain colour of each facade, for exports and far LODs. */
export function facadeColour(name) {
  return (FACADE_LOOK[name] || FACADE_LOOK.concrete).wall;
}

/** Text on a panel: highway signs, closures, the Five Roses sign. */
export function textPanel(THREE, lines, opts = {}) {
  const W = opts.width || 512, H = opts.height || 256;
  const c = canvas(W, H), g = c.getContext('2d');
  g.fillStyle = opts.bg || '#0f5a2b';
  g.fillRect(0, 0, W, H);
  if (opts.border !== false) {
    g.strokeStyle = opts.fg || '#ffffff';
    g.lineWidth = Math.max(4, W / 90);
    g.strokeRect(g.lineWidth, g.lineWidth, W - g.lineWidth * 2, H - g.lineWidth * 2);
  }
  g.fillStyle = opts.fg || '#ffffff';
  g.textAlign = opts.align || 'center';
  g.textBaseline = 'middle';
  const size = opts.size || Math.floor(H / (lines.length + 1.2));
  g.font = `${opts.weight || 700} ${size}px ${opts.font || 'Helvetica, Arial, sans-serif'}`;
  const top = opts.top || 0;
  lines.forEach((line, i) => {
    const y = top * H + ((1 - top) * H * (i + 1)) / (lines.length + 1);
    const x = opts.align === 'left' ? W * 0.08 : W / 2;
    g.fillText(line, x, y, W * 0.86);
  });
  if (opts.draw) opts.draw(g, W, H);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function tex(THREE, c, metres) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.userData.metres = metres;       // one repeat covers this many metres
  return t;
}
