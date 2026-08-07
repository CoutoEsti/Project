// The map, drawn once and reused.
//
// The whole road network of the bundled extract is rasterised into a single
// offscreen canvas the first time it is needed. Both the menu picker and the
// full-screen map then just blit that image and paint markers on top, so
// opening the map costs nothing no matter how many streets are loaded.

const CLASS_STYLE = {
  major: { colour: '#e9dcb0', width: 2.4 },
  minor: { colour: 'rgba(226,230,236,0.72)', width: 1.2 },
  alley: { colour: 'rgba(160,170,180,0.30)', width: 0.7 },
};

const MAJOR = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary',
  'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link']);

function roadClass(tags) {
  const hw = tags.highway;
  if (!hw) return null;
  if (hw === 'service') return (tags.service === 'alley' || tags.service === 'driveway') ? 'alley' : 'minor';
  if (MAJOR.has(hw)) return 'major';
  if (hw === 'pedestrian' || hw === 'track') return 'alley';
  return 'minor';
}

/**
 * Rasterise a dataset's roads.
 * @returns {{canvas, bounds:{south,west,north,east}, aspect:number}}
 */
export function buildMapImage(elements, longEdge = 2048) {
  let south = 90, north = -90, west = 180, east = -180;
  const roads = [];

  for (const el of elements) {
    if (el.type !== 'way' || !el.tags) continue;
    const cls = roadClass(el.tags);
    if (!cls || !el.geometry || el.geometry.length < 2) continue;
    roads.push({ cls, geom: el.geometry });
    for (const p of el.geometry) {
      if (p.lat < south) south = p.lat;
      if (p.lat > north) north = p.lat;
      if (p.lon < west) west = p.lon;
      if (p.lon > east) east = p.lon;
    }
  }

  if (!roads.length) return null;

  // Metres-per-degree differ by latitude; without this correction the city
  // comes out stretched east-west.
  const midLat = (north + south) * 0.5;
  const lonScale = Math.cos(midLat * Math.PI / 180);
  const spanX = (east - west) * lonScale;
  const spanY = north - south;
  const aspect = spanX / spanY;

  const w = aspect >= 1 ? longEdge : Math.round(longEdge * aspect);
  const h = aspect >= 1 ? Math.round(longEdge / aspect) : longEdge;

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(2, w);
  canvas.height = Math.max(2, h);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#11161c';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const px = (lon) => ((lon - west) * lonScale / spanX) * canvas.width;
  const py = (lat) => ((north - lat) / spanY) * canvas.height;

  // Alleys first, arterials last, so the structure of the city reads.
  for (const cls of ['alley', 'minor', 'major']) {
    const style = CLASS_STYLE[cls];
    ctx.strokeStyle = style.colour;
    ctx.lineWidth = style.width * (longEdge / 2048) * 1.6;
    ctx.beginPath();
    for (const road of roads) {
      if (road.cls !== cls) continue;
      const g = road.geom;
      ctx.moveTo(px(g[0].lon), py(g[0].lat));
      for (let i = 1; i < g.length; i++) ctx.lineTo(px(g[i].lon), py(g[i].lat));
    }
    ctx.stroke();
  }

  return { canvas, bounds: { south, west, north, east }, aspect, lonScale };
}

/**
 * Fit an image of the given aspect into a box, returning the placement and the
 * conversion helpers both directions.
 */
export function fitView(image, boxW, boxH) {
  const scale = Math.min(boxW / image.canvas.width, boxH / image.canvas.height);
  const w = image.canvas.width * scale;
  const h = image.canvas.height * scale;
  const x = (boxW - w) / 2;
  const y = (boxH - h) / 2;
  const b = image.bounds;
  const spanX = (b.east - b.west) * image.lonScale;
  const spanY = b.north - b.south;

  return {
    x, y, w, h, scale,
    toPixel(lat, lon) {
      return {
        px: x + ((lon - b.west) * image.lonScale / spanX) * w,
        py: y + ((b.north - lat) / spanY) * h,
      };
    },
    toGeo(px, py) {
      return {
        lon: b.west + (((px - x) / w) * spanX) / image.lonScale,
        lat: b.north - ((py - y) / h) * spanY,
      };
    },
    contains(px, py) {
      return px >= x && px <= x + w && py >= y && py <= y + h;
    },
  };
}

/** Blit the map into a canvas and return the fitted view for marker painting. */
export function paintMap(canvas, image, dpr = 1) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.fillStyle = '#0b0f13';
  ctx.fillRect(0, 0, w, h);
  const view = fitView(image, w, h);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(image.canvas, view.x, view.y, view.w, view.h);
  void dpr;
  return view;
}

/** A labelled dot. */
export function marker(ctx, px, py, colour, label, size = 5) {
  ctx.beginPath();
  ctx.arc(px, py, size + 2.5, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(px, py, size, 0, Math.PI * 2);
  ctx.fillStyle = colour;
  ctx.fill();
  if (label) {
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.strokeText(label, px, py - size - 4);
    ctx.fillStyle = '#eef2f6';
    ctx.fillText(label, px, py - size - 4);
  }
}

/** The car, as an arrow pointing along its heading. */
export function carMarker(ctx, px, py, yaw) {
  ctx.save();
  ctx.translate(px, py);
  // World forward is (sin ψ, cos ψ) with −Z north, so screen-up is −cos ψ.
  ctx.rotate(Math.atan2(Math.sin(yaw), -Math.cos(yaw)));
  ctx.beginPath();
  ctx.moveTo(0, -9);
  ctx.lineTo(6.5, 8);
  ctx.lineTo(0, 4.5);
  ctx.lineTo(-6.5, 8);
  ctx.closePath();
  ctx.fillStyle = '#5fd0a8';
  ctx.strokeStyle = 'rgba(0,0,0,0.7)';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fill();
  ctx.restore();
}
