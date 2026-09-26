// Was copied from Ruelle (hop/src/vehicle/model.js); MTL's version has since
// grown a Civic-shaped silhouette (long low hood, fastback roofline, C-shaped
// tail lights) that hop's does not have — the two no longer share geometry,
// only the underglow idea.
//
// A car, lofted from cross-sections rather than stacked from boxes.
//
// Nine body profiles and five greenhouse profiles down the length, each an
// eight-point silhouette, skinned into two hulls: that is enough to read as a
// 10th/11th-gen Civic sedan from every angle a chase camera will ever show,
// and it still costs well under a thousand triangles. No external model, no
// download, and the paint colour is a parameter.
//
// The model faces +Z, which matches the physics convention (forward =
// (sin yaw, cos yaw)), so `mesh.rotation.y = vehicle.yaw` just works. The
// wheelbase (front z=1.30, rear z=-1.42) matches vehicle.js's physics
// wheelbase (2.70 m) and must not drift from it.

// Long low hood at the front (+z), a short trunk at the rear (-z), and a
// fastback roofline that peaks over the front seats and slopes down toward
// the trunk lid — the 10th/11th-gen Civic's silhouette, not a generic sedan.
//
// `crease` (0..1) is how much of the door character line shows at that
// section: 0 on the hood and nose (a Civic's hood is a clean, flat panel —
// the shoulder line is a door/fender feature only), ramping up through the
// cowl to full strength across the doors, and fading again into the trunk.
const BODY_SECTIONS = [
  { z: -2.14, hw: 0.62, y0: 0.42, y1: 0.62, crease: 0 }, // rear bumper: short overhang
  { z: -1.80, hw: 0.85, y0: 0.28, y1: 0.84, crease: 0.25 }, // trunk lid
  { z: -1.35, hw: 0.91, y0: 0.26, y1: 0.92, crease: 0.7 }, // rear fender / trunk
  { z: -0.60, hw: 0.94, y0: 0.25, y1: 0.97, crease: 1 }, // rear doors
  { z: 0.20, hw: 0.95, y0: 0.25, y1: 0.99, crease: 1 }, // widest point, front doors
  { z: 0.95, hw: 0.90, y0: 0.26, y1: 0.88, crease: 0.4 }, // cowl, hood begins
  { z: 1.55, hw: 0.80, y0: 0.32, y1: 0.66, crease: 0 }, // long, low, clean hood
  { z: 2.00, hw: 0.68, y0: 0.40, y1: 0.54, crease: 0 }, // front fascia taper
  { z: 2.16, hw: 0.56, y0: 0.46, y1: 0.52, crease: 0 }, // nose
];

// Low, forward-peaked fastback greenhouse: roof peak sits over the front
// seats (z ~0.3), not the middle of the cabin, and the C-pillar carries it
// down into a short deck — the long, sloping rear glass a Civic reads by.
// Height above the beltline (body's y1, ~0.97) stays close to the ~0.40 m the
// real car uses over its ~0.75 m tall body side.
const GREENHOUSE_SECTIONS = [
  { z: 1.00, hw: 0.76, y0: 0.90, y1: 0.99 }, // windshield base, at the cowl
  { z: 0.40, hw: 0.84, y0: 0.94, y1: 1.35 }, // windshield top, raked hard
  { z: -0.20, hw: 0.85, y0: 0.96, y1: 1.36 }, // roof peak, over the front seats
  { z: -0.95, hw: 0.75, y0: 0.92, y1: 1.10 }, // C-pillar, fastback slope
  { z: -1.45, hw: 0.62, y0: 0.86, y1: 0.94 }, // rear window base, at the trunk lip
];

/** Half-width of the body hull at a given z, linearly interpolated between
 * BODY_SECTIONS — used to size trim so it sits flush with the body contour
 * instead of floating past it as a flat plank. */
function bodyHalfWidthAt(z) {
  const S = BODY_SECTIONS;
  if (z <= S[0].z) return S[0].hw;
  if (z >= S[S.length - 1].z) return S[S.length - 1].hw;
  for (let i = 0; i < S.length - 1; i++) {
    if (z >= S[i].z && z <= S[i + 1].z) {
      const t = (z - S[i].z) / (S[i + 1].z - S[i].z);
      return S[i].hw + (S[i + 1].hw - S[i].hw) * t;
    }
  }
  return S[S.length - 1].hw;
}

/** Eight points around one smoothly-tapered cross-section (the greenhouse,
 * and the soft end of the body's crease blend). */
function profileSoft(section) {
  const { hw, y0, y1 } = section;
  const h = y1 - y0;
  return [
    [-hw, y0],
    [-hw, y0 + h * 0.45],
    [-hw * 0.93, y1 - h * 0.14],
    [-hw * 0.52, y1],
    [hw * 0.52, y1],
    [hw * 0.93, y1 - h * 0.14],
    [hw, y0 + h * 0.45],
    [hw, y0],
  ];
}

// Eight points around one body cross-section, with a sharp shoulder crease at
// 62% height — the character line that runs the length of a Civic's doors.
// Below the crease the panel tucks in gently to the sill; above it, it tucks
// in more to the beltline. The crease itself is a hard edge (two coincident
// heights at full width), which is what makes it read as a line rather than
// a smooth bulge once normals are computed.
function profileCreased(section) {
  const { hw, y0, y1 } = section;
  const h = y1 - y0;
  const shoulderY = y0 + h * 0.62;
  const sillHw = hw * 0.86;
  const beltHw = hw * 0.72;
  return [
    [-sillHw, y0],
    [-hw, shoulderY - 0.05],
    [-hw, shoulderY],
    [-beltHw, y1],
    [beltHw, y1],
    [hw, shoulderY],
    [hw, shoulderY - 0.05],
    [sillHw, y0],
  ];
}

/** Body profile: blend between the soft taper and the creased one by how
 * much character line this section carries (see BODY_SECTIONS' `crease`). */
function profileBody(section) {
  const soft = profileSoft(section);
  const t = section.crease ?? 0;
  if (t <= 0) return soft;
  const hard = profileCreased(section);
  return soft.map(([x, y], i) => {
    const [hx, hy] = hard[i];
    return [x + (hx - x) * t, y + (hy - y) * t];
  });
}

/** Skin a list of cross-sections into a closed hull, flat-shaded: each
 * triangle gets its own unshared vertices before normals are computed, so a
 * non-planar quad (inevitable on a tapering loft) reads as two clean facets
 * instead of an averaged, streaky gradient across it. */
function loft(THREE, sections, shape) {
  const pos = [];
  const idx = [];
  const rings = sections.map(shape);
  const n = rings[0].length;

  for (const [s, ring] of rings.entries()) {
    for (const [px, py] of ring) pos.push(px, py, sections[s].z);
  }
  for (let s = 0; s < rings.length - 1; s++) {
    for (let i = 0; i < n; i++) {
      const a = s * n + i;
      const b = s * n + ((i + 1) % n);
      const c = (s + 1) * n + ((i + 1) % n);
      const d = (s + 1) * n + i;
      idx.push(a, b, c, a, c, d);
    }
  }
  // Flat caps at both ends.
  const last = (rings.length - 1) * n;
  for (let i = 1; i < n - 1; i++) {
    idx.push(0, i + 1, i);
    idx.push(last, last + i, last + i + 1);
  }

  const indexed = new THREE.BufferGeometry();
  indexed.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  indexed.setIndex(idx);
  const flat = indexed.toNonIndexed();
  indexed.dispose();
  flat.computeVertexNormals();
  flat.computeBoundingSphere();
  return flat;
}

function box(THREE, w, h, d, x, y, z) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

/** One rectangular wheel spoke, pointing +Y before being rotated into place
 * around the wheel's spin axis (X). Five of these plus the round disc below
 * read as a cheap 5-spoke alloy — a lot cleaner than a low-segment polygon
 * standing in for a rim. */
function spoke(THREE, angle) {
  const g = new THREE.BoxGeometry(0.05, 0.17, 0.05);
  g.translate(0, 0.115, 0);
  g.rotateX(angle);
  return g;
}

/**
 * @param {object} THREE
 * @param {object} opts {color:number, ghost:boolean}
 */
export function createCar(THREE, opts = {}) {
  const paint = new THREE.Color(opts.color ?? 0x1f4e8c);
  const ghost = !!opts.ghost;

  const group = new THREE.Group();

  // Clearcoat is what reads as "car paint": a glossy varnish layer over a
  // mildly metallic base, so the sky sweeps across the body as you turn.
  // Roughness is kept high enough that the headlight, a few metres away at
  // night, doesn't collapse into a single blown-out specular pixel.
  const bodyMat = ghost
    ? new THREE.MeshBasicMaterial({ color: paint, transparent: true, opacity: 0.34, depthWrite: false })
    : new THREE.MeshPhysicalMaterial({
      color: paint, metalness: 0.15, roughness: 0.42,
      clearcoat: 1.0, clearcoatRoughness: 0.28,
    });
  const glassMat = ghost
    ? bodyMat
    : new THREE.MeshPhysicalMaterial({ color: 0x10151b, metalness: 0.15, roughness: 0.24 });
  const trimMat = ghost
    ? bodyMat
    // Black grille, bumpers, sills and mirrors all share this one dark mesh.
    : new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.6, metalness: 0.2 });

  const body = new THREE.Mesh(loft(THREE, BODY_SECTIONS, profileBody), bodyMat);
  body.castShadow = !ghost;
  group.add(body);

  const glass = new THREE.Mesh(loft(THREE, GREENHOUSE_SECTIONS, profileSoft), glassMat);
  glass.castShadow = !ghost;
  group.add(glass);

  if (!ghost) {
    // Bumpers, rocker sills, side mirrors and the front grille, merged into
    // one dark mesh — one draw call for everything that is neither painted
    // body nor glass. Each piece is sized from bodyHalfWidthAt() and kept
    // thin enough that its outer face sits flush with the body surface
    // instead of floating past it as a flat plank.
    const frontBumperZ = 2.08;
    const frontBumperHw = bodyHalfWidthAt(frontBumperZ) * 0.96;
    const rearBumperZ = -2.02;
    const rearBumperHw = bodyHalfWidthAt(rearBumperZ) * 0.98;
    const sillZ = -0.35;
    const sillHw = bodyHalfWidthAt(sillZ);
    const sillThickness = 0.05;
    const trimGeos = [
      box(THREE, frontBumperHw * 2, 0.15, 0.12, 0, 0.42, frontBumperZ), // front bumper, tucked at the nose
      box(THREE, rearBumperHw * 2, 0.18, 0.16, 0, 0.42, rearBumperZ), // rear bumper
      // Rocker sills: outer face flush with the body, not sticking out past it.
      box(THREE, sillThickness, 0.09, 2.15, sillHw - sillThickness / 2, 0.27, sillZ),
      box(THREE, sillThickness, 0.09, 2.15, -(sillHw - sillThickness / 2), 0.27, sillZ),
      box(THREE, 0.24, 0.12, 0.12, bodyHalfWidthAt(0.85) + 0.04, 1.00, 0.85), // mirror L
      box(THREE, 0.24, 0.12, 0.12, -(bodyHalfWidthAt(0.85) + 0.04), 1.00, 0.85), // mirror R
      box(THREE, 0.56, 0.13, 0.04, 0, 0.48, 2.15), // grille, flush with the nose, between the headlights
    ];
    group.add(new THREE.Mesh(mergeSimple(THREE, trimGeos), trimMat));

    // Lights: thin LED-style headlight strips, and C-shaped ("boomerang")
    // tail lights built from an inner vertical bar plus an outer horizontal
    // tip — each side merged to one mesh so both lights cost one draw call.
    const headMat = new THREE.MeshBasicMaterial({ color: 0xfff0d0 });
    const tailMat = new THREE.MeshStandardMaterial({
      color: 0x6a1410, emissive: 0x330705, emissiveIntensity: 0.1, roughness: 0.4,
    });
    const headGeos = [];
    const tailGeos = [];
    for (const sx of [-1, 1]) {
      // At fender height, on the nose (not up near the windshield): the
      // front bumper sits behind these, so they read as the leading edge.
      headGeos.push(box(THREE, 0.34, 0.09, 0.08, sx * 0.48, 0.58, 2.10));
      headGeos.push(box(THREE, 0.10, 0.09, 0.07, sx * (bodyHalfWidthAt(2.00) - 0.05), 0.55, 2.00)); // outer corner accent, wrapping the fender
      // Boomerang: a vertical bar hugging the fender, plus a short bar
      // reaching in toward the centre.
      tailGeos.push(box(THREE, 0.09, 0.28, 0.09, sx * (bodyHalfWidthAt(-1.95) - 0.045), 0.78, -1.95));
      tailGeos.push(box(THREE, 0.28, 0.10, 0.08, sx * (bodyHalfWidthAt(-2.05) - 0.16), 0.90, -2.06));
    }
    const head = new THREE.Mesh(mergeSimple(THREE, headGeos), headMat);
    group.add(head);
    const tail = new THREE.Mesh(mergeSimple(THREE, tailGeos), tailMat);
    group.add(tail);
    group.userData.headMat = headMat;
    group.userData.tailMat = tailMat;
  }

  // --- wheels ---------------------------------------------------------------
  const tyreGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.24, 16);
  tyreGeo.rotateZ(Math.PI / 2);
  // A round disc — not a low-segment polygon standing in for a rim — plus
  // five raised spokes: cheap (one merged mesh) but reads as an actual alloy
  // wheel instead of a faceted hubcap.
  const rimGeos = [];
  {
    const disc = new THREE.CylinderGeometry(0.185, 0.185, 0.05, 16);
    disc.rotateZ(Math.PI / 2);
    rimGeos.push(disc);
    for (let k = 0; k < 5; k++) rimGeos.push(spoke(THREE, (k * Math.PI * 2) / 5));
  }
  const hubGeo = new THREE.CylinderGeometry(0.045, 0.045, 0.26, 10);
  hubGeo.rotateZ(Math.PI / 2);

  const tyreMat = ghost ? bodyMat : new THREE.MeshStandardMaterial({ color: 0x0e0f11, roughness: 0.95 });
  const rimMat = ghost ? bodyMat : new THREE.MeshStandardMaterial({ color: 0xb8bec4, metalness: 0.85, roughness: 0.35 });
  const hubMat = ghost ? bodyMat : new THREE.MeshStandardMaterial({ color: 0x1c1e22, metalness: 0.4, roughness: 0.5 });
  const rimGeo = ghost ? null : mergeSimple(THREE, rimGeos);

  const wheels = [];
  const positions = [
    { x: 0.86, z: 1.30, front: true },
    { x: -0.86, z: 1.30, front: true },
    { x: 0.86, z: -1.42, front: false },
    { x: -0.86, z: -1.42, front: false },
  ];
  for (const p of positions) {
    const pivot = new THREE.Group();
    pivot.position.set(p.x, 0.34, p.z);
    const spin = new THREE.Group();
    const tyre = new THREE.Mesh(tyreGeo, tyreMat);
    tyre.castShadow = !ghost;
    spin.add(tyre);
    if (!ghost) {
      spin.add(new THREE.Mesh(rimGeo, rimMat));
      spin.add(new THREE.Mesh(hubGeo, hubMat));
    }
    pivot.add(spin);
    group.add(pivot);
    wheels.push({ pivot, spin, front: p.front });
  }

  // --- underglow ------------------------------------------------------------
  // A coloured pool on the road under the sills, additive so it lights the
  // asphalt rather than painting a decal on it. Pure decoration, and exactly
  // the kind of decoration the people this game is for actually want. It costs
  // one transparent quad and turns itself off in daylight, where a glow on lit
  // ground reads as a smudge.
  let glowMat = null;
  let glow = null;
  if (!ghost) {
    glowMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(0x22ccff),
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    // MTL: a soft radial falloff, not a flat rectangle of light.
    if (typeof document !== 'undefined') {
      const cv = document.createElement('canvas');
      cv.width = cv.height = 64;
      const c = cv.getContext('2d');
      const grad = c.createRadialGradient(32, 32, 4, 32, 32, 32);
      grad.addColorStop(0, 'rgba(255,255,255,1)');
      grad.addColorStop(0.55, 'rgba(255,255,255,0.45)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = grad;
      c.fillRect(0, 0, 64, 64);
      glowMat.map = new THREE.CanvasTexture(cv);
    }
    const glowGeo = new THREE.PlaneGeometry(4.2, 7.2);
    glowGeo.rotateX(-Math.PI / 2);
    glow = new THREE.Mesh(glowGeo, glowMat);
    // Just off the deck: any lower and it z-fights the road on a slope.
    glow.position.y = 0.06;
    glow.renderOrder = 3;
    glow.visible = false;
    group.add(glow);
  }

  return {
    group,
    wheels,
    /**
     * @param {boolean} on
     * @param {number} colour   hex
     * @param {number} night    0..1 from the sky — it fades out at dawn
     */
    setUnderglow(on, colour, night = 1) {
      if (!glow) return;
      glow.visible = !!on && night > 0.15;
      if (!glow.visible) return;
      if (colour != null) glowMat.color.setHex(colour);
      glowMat.opacity = 0.4 * Math.min(1, (night - 0.15) / 0.35);
    },
    /** @param {number} angle radians, positive = right */
    setSteer(angle) {
      for (const w of wheels) if (w.front) w.pivot.rotation.y = angle;
    },
    setSpin(radians) {
      for (const w of wheels) w.spin.rotation.x = radians;
    },
    setLights(on, braking) {
      if (ghost) return;
      // Off by day: a dark lens, not a pale patch that reads as a stray part.
      group.userData.headMat.color.setHex(on ? 0xfff3d8 : 0x33302c);
      const tailMat = group.userData.tailMat;
      tailMat.color.setHex(braking ? 0xff2a1c : (on ? 0x8c1a14 : 0x5a1210));
      // Emissive so the C-shaped tail lights read as lit, not just repainted,
      // and so the night bloom pass picks them up under braking.
      tailMat.emissive.setHex(braking ? 0xff2a1c : (on ? 0x7a140f : 0x1a0503));
      tailMat.emissiveIntensity = braking ? 1.6 : (on ? 0.55 : 0.1);
    },
    dispose() {
      group.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material && o.material.dispose) o.material.dispose();
      });
    },
  };
}

/** Merge geometries that only carry position (bumpers, sills, lights, mirrors,
 * wheel spokes). */
function mergeSimple(THREE, geos) {
  const pos = [];
  const idx = [];
  let offset = 0;
  for (const g of geos) {
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) pos.push(p.getX(i), p.getY(i), p.getZ(i));
    const index = g.getIndex();
    for (let i = 0; i < index.count; i++) idx.push(index.getX(i) + offset);
    offset += p.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setIndex(idx);
  out.computeVertexNormals();
  out.computeBoundingSphere();
  return out;
}

export const CAR_COLORS = [
  0x1f4e8c, 0xb0101c, 0xe0e2e4, 0x2c3038, 0x1f6f9a,
  0x2e7d52, 0xd9a441, 0x7a4fa3, 0xb8532f, 0x35566e,
];
