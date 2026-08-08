// The ground of one tile, painted into a canvas.
//
// Every flat surface — grass, park, water, sidewalk, kerb, asphalt — is a
// stroke or a fill on a 2D canvas that becomes the tile's texture. Round line
// joins mean that four streets meeting at a corner merge into one continuous
// piece of asphalt for free: no overlapping meshes, no z-fighting, no seams
// through the middle of an intersection. Roads are drawn with their *full*
// geometry (not clipped to the tile) so the paint lines up across tile edges.

// Stylised but plausible. Kept desaturated so the car, the markings and the
// lit windows are the things that pop.
const C = {
  base: '#9c9788',
  grass: '#8ba95f',
  park: '#83a457',
  wood: '#5f8a48',
  water: '#4d7fa3',
  sand: '#c9bb92',
  industrial: '#96918a',
  cemetery: '#8ca173',
  railway: '#847d72',
  pitch: '#7fa85f',
  footprint: '#7d786f',
  sidewalk: '#b5b1a7',
  kerb: '#8d8981',
  asphalt: '#4b4b50',
  asphaltMinor: '#54545b',
  alley: '#5b574f',
  rail: '#6b655c',
};

const AREA_STYLE = {
  park: C.park, garden: C.park, pitch: C.pitch, playground: C.pitch,
  golf_course: C.park, common: C.park,
  grass: C.grass, meadow: C.grass, village_green: C.grass, recreation_ground: C.grass,
  farmland: '#a8a06a',
  forest: C.wood, wood: C.wood, scrub: '#7d9160', grassland: C.grass,
  water: C.water, sand: C.sand, bare_rock: '#a09a90',
  cemetery: C.cemetery, industrial: C.industrial, railway: C.railway,
};

// Painted last wins. Water on top of park, park on top of grass, etc.
const AREA_ORDER = {
  farmland: 0, grassland: 1, meadow: 1, grass: 2, village_green: 2,
  recreation_ground: 2, cemetery: 3, industrial: 3, railway: 3,
  scrub: 4, forest: 5, wood: 5, park: 6, garden: 6, golf_course: 6,
  pitch: 7, playground: 7, sand: 8, bare_rock: 8, water: 9,
};

/**
 * Which painted surface, if any, an OSM area represents.
 * Returns a key of AREA_STYLE, or null if we do not paint this feature.
 */
export function areaKindFromTags(tags) {
  if (!tags) return null;
  for (const key of ['natural', 'leisure', 'landuse']) {
    const v = tags[key];
    if (v && AREA_STYLE[v]) return v;
  }
  if (tags.waterway === 'river' || tags.waterway === 'canal') return 'water';
  return null;
}

let noisePattern = null;

/** A small tiling noise image, generated once and reused by every tile. */
function getNoise(doc) {
  if (noisePattern) return noisePattern;
  const n = 128;
  const cv = doc.createElement('canvas');
  cv.width = cv.height = n;
  const g = cv.getContext('2d');
  const img = g.createImageData(n, n);
  let seed = 0x1234567;
  for (let i = 0; i < n * n; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const v = 118 + ((seed >>> 24) % 26);
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v;
    img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  noisePattern = cv;
  return cv;
}

/**
 * Paint one tile.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} size        canvas edge, pixels
 * @param {{x0:number,z0:number,x1:number,z1:number}} bounds  tile rect in world metres
 * @param {Array} roads        {points:[{x,z}], spec} — full geometry, not clipped
 * @param {Array} areas        {points:[{x,z}], kind}
 * @param {Array} footprints   {points:[{x,z}]} building outlines
 * @param {Array} rails        {points:[{x,z}]}
 */
export function paintTile(ctx, size, bounds, roads, areas, footprints, rails) {
  const spanX = bounds.x1 - bounds.x0;
  const spanZ = bounds.z1 - bounds.z0;
  const sx = size / spanX;
  const sz = size / spanZ;
  // Metres -> pixels. Uniform enough that one scale works for stroke widths.
  const mToPx = (sx + sz) / 2;

  const px = (x) => (x - bounds.x0) * sx;
  const py = (z) => (z - bounds.z0) * sz;

  ctx.save();
  ctx.fillStyle = C.base;
  ctx.fillRect(0, 0, size, size);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // --- landuse / natural ----------------------------------------------------
  const sorted = areas.slice().sort((a, b) => (AREA_ORDER[a.kind] ?? 0) - (AREA_ORDER[b.kind] ?? 0));
  for (const area of sorted) {
    const fill = AREA_STYLE[area.kind];
    if (!fill || area.points.length < 3) continue;
    ctx.fillStyle = fill;
    tracePolygon(ctx, area.points, px, py);
    ctx.fill();
    // A soft rim makes flat fills read as ground rather than as decals.
    if (area.kind === 'water') {
      ctx.strokeStyle = '#3f6d8e';
      ctx.lineWidth = Math.max(1, 0.8 * mToPx);
      ctx.stroke();
    }
  }

  // --- railway ballast ------------------------------------------------------
  if (rails && rails.length) {
    ctx.strokeStyle = C.rail;
    for (const r of rails) {
      ctx.lineWidth = Math.max(1, 4.4 * mToPx);
      tracePath(ctx, r.points, px, py);
      ctx.stroke();
    }
  }

  // --- building footprints, with a contact shadow ---------------------------
  // The single cheapest thing that makes a city stop looking like flat shapes
  // sitting on a plane: a soft dark halo where each building meets the ground.
  // It is ambient occlusion, baked at paint time — no depth buffer, no extra
  // pass, and it survives at any frame rate.
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.62)';
  ctx.shadowBlur = Math.max(2, 4.5 * mToPx);
  ctx.fillStyle = C.footprint;
  for (const f of footprints) {
    if (f.points.length < 3) continue;
    tracePolygon(ctx, f.points, px, py);
    ctx.fill();
  }
  ctx.restore();

  // Second pass without the shadow, so the footprint itself stays clean rather
  // than being darkened by its own halo.
  ctx.fillStyle = C.footprint;
  for (const f of footprints) {
    if (f.points.length < 3) continue;
    tracePolygon(ctx, f.points, px, py);
    ctx.fill();
  }

  // --- the streetscape, widest band first ----------------------------------
  // Order matters: grass verge, then sidewalk, then kerb, then carriageway.
  // Each pass covers the middle of the previous one, leaving a clean band.
  const byRank = roads.slice().sort((a, b) => a.spec.rank - b.spec.rank);

  strokePass(ctx, byRank, px, py, mToPx, (spec) => {
    if (!spec.verge) return null;
    return { w: spec.width + 2 * spec.sidewalk + 2 * spec.verge, color: C.grass };
  });

  strokePass(ctx, byRank, px, py, mToPx, (spec) => {
    if (!spec.sidewalk) return null;
    return { w: spec.width + 2 * spec.sidewalk, color: C.sidewalk };
  });

  strokePass(ctx, byRank, px, py, mToPx, (spec) => (
    { w: spec.width + 0.7, color: C.kerb }
  ));

  strokePass(ctx, byRank, px, py, mToPx, (spec) => {
    let color = C.asphaltMinor;
    if (spec.kind === 'major') color = C.asphalt;
    else if (spec.kind === 'alley') color = C.alley;
    if (spec.surface === 'unpaved' || spec.surface === 'gravel') color = '#7a7266';
    return { w: spec.width, color };
  });

  // --- grain ----------------------------------------------------------------
  const noise = getNoise(ctx.canvas.ownerDocument || document);
  const pat = ctx.createPattern(noise, 'repeat');
  if (pat) {
    ctx.globalCompositeOperation = 'overlay';
    ctx.globalAlpha = 0.32;
    ctx.fillStyle = pat;
    ctx.fillRect(0, 0, size, size);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  ctx.restore();
}

/**
 * Paint the same tile as grayscale roughness: bright = matte, dark = glossy.
 * Water comes out near-black, which is what makes it mirror the sky; asphalt
 * sits in the middle so low sun raises a believable sheen off the road.
 */
export function paintRoughnessTile(ctx, size, bounds, roads, areas, footprints, rails) {
  const spanX = bounds.x1 - bounds.x0;
  const spanZ = bounds.z1 - bounds.z0;
  const sx = size / spanX;
  const sz = size / spanZ;
  const mToPx = (sx + sz) / 2;
  const px = (x) => (x - bounds.x0) * sx;
  const py = (z) => (z - bounds.z0) * sz;

  const R = {
    base: '#efefef', grass: '#f4f4f4', water: '#242424', sand: '#e8e8e8',
    asphalt: '#8a8a8a', asphaltMinor: '#949494', alley: '#a0a0a0',
    sidewalk: '#c9c9c9', kerb: '#bebebe', footprint: '#d4d4d4', rail: '#b6b6b6',
  };

  ctx.save();
  ctx.fillStyle = R.base;
  ctx.fillRect(0, 0, size, size);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const sorted = areas.slice().sort((a, b) => (AREA_ORDER[a.kind] ?? 0) - (AREA_ORDER[b.kind] ?? 0));
  for (const area of sorted) {
    if (area.points.length < 3) continue;
    ctx.fillStyle = area.kind === 'water' ? R.water
      : area.kind === 'sand' ? R.sand : R.grass;
    tracePolygon(ctx, area.points, px, py);
    ctx.fill();
  }

  if (rails && rails.length) {
    ctx.strokeStyle = R.rail;
    for (const r of rails) {
      ctx.lineWidth = Math.max(1, 4.4 * mToPx);
      tracePath(ctx, r.points, px, py);
      ctx.stroke();
    }
  }

  ctx.fillStyle = R.footprint;
  for (const f of footprints) {
    if (f.points.length < 3) continue;
    tracePolygon(ctx, f.points, px, py);
    ctx.fill();
  }

  const byRank = roads.slice().sort((a, b) => a.spec.rank - b.spec.rank);
  strokePass(ctx, byRank, px, py, mToPx, (spec) => {
    if (!spec.sidewalk) return null;
    return { w: spec.width + 2 * spec.sidewalk, color: R.sidewalk };
  });
  strokePass(ctx, byRank, px, py, mToPx, (spec) => (
    { w: spec.width + 0.7, color: R.kerb }
  ));
  strokePass(ctx, byRank, px, py, mToPx, (spec) => {
    let color = R.asphaltMinor;
    if (spec.kind === 'major') color = R.asphalt;
    else if (spec.kind === 'alley') color = R.alley;
    return { w: spec.width, color };
  });

  ctx.restore();
}

function strokePass(ctx, roads, px, py, mToPx, styleFor) {
  for (const road of roads) {
    if (road.points.length < 2) continue;
    const style = styleFor(road.spec);
    if (!style) continue;
    ctx.strokeStyle = style.color;
    ctx.lineWidth = Math.max(1, style.w * mToPx);
    tracePath(ctx, road.points, px, py);
    ctx.stroke();
  }
}

function tracePath(ctx, points, px, py) {
  ctx.beginPath();
  ctx.moveTo(px(points[0].x), py(points[0].z));
  for (let i = 1; i < points.length; i++) ctx.lineTo(px(points[i].x), py(points[i].z));
}

function tracePolygon(ctx, points, px, py) {
  ctx.beginPath();
  ctx.moveTo(px(points[0].x), py(points[0].z));
  for (let i = 1; i < points.length; i++) ctx.lineTo(px(points[i].x), py(points[i].z));
  ctx.closePath();
}

export { C as GROUND_COLORS };
