// A car, lofted from cross-sections rather than stacked from boxes.
//
// Eight profiles down the length, each an eight-point silhouette, skinned into
// one hull: that is enough to read as a car from every angle a chase camera
// will ever show, and it costs about 400 triangles. No external model, no
// download, and the paint colour is a parameter.
//
// The model faces +Z, which matches the physics convention (forward =
// (sin yaw, cos yaw)), so `mesh.rotation.y = vehicle.yaw` just works.

const BODY_SECTIONS = [
  { z: -2.14, hw: 0.70, y0: 0.44, y1: 0.94 },
  { z: -1.78, hw: 0.87, y0: 0.30, y1: 1.04 },
  { z: -1.05, hw: 0.92, y0: 0.27, y1: 1.11 },
  { z: -0.20, hw: 0.94, y0: 0.26, y1: 1.14 },
  { z: 0.66, hw: 0.93, y0: 0.26, y1: 1.11 },
  { z: 1.42, hw: 0.88, y0: 0.29, y1: 1.00 },
  { z: 1.92, hw: 0.79, y0: 0.35, y1: 0.88 },
  { z: 2.16, hw: 0.66, y0: 0.46, y1: 0.79 },
];

const GREENHOUSE_SECTIONS = [
  { z: -1.42, hw: 0.78, y0: 1.00, y1: 1.16 },
  { z: -1.05, hw: 0.82, y0: 1.02, y1: 1.46 },
  { z: -0.15, hw: 0.84, y0: 1.04, y1: 1.51 },
  { z: 0.72, hw: 0.81, y0: 1.02, y1: 1.44 },
  { z: 1.28, hw: 0.70, y0: 0.99, y1: 1.10 },
];

/** Eight points around one cross-section, counter-clockwise seen from +Z. */
function profile(section) {
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

/** Skin a list of cross-sections into a closed hull. */
function loft(THREE, sections, colour) {
  const pos = [];
  const idx = [];
  const rings = sections.map(profile);
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

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  void colour;
  return geo;
}

function box(THREE, w, h, d, x, y, z) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

/**
 * @param {object} THREE
 * @param {object} opts {color:number, ghost:boolean}
 */
export function createCar(THREE, opts = {}) {
  const paint = new THREE.Color(opts.color ?? 0xc0392b);
  const ghost = !!opts.ghost;

  const group = new THREE.Group();

  // Clearcoat is what reads as "car paint": a glossy varnish layer over a
  // mildly metallic base, so the sky sweeps across the body as you turn.
  const bodyMat = ghost
    ? new THREE.MeshBasicMaterial({ color: paint, transparent: true, opacity: 0.34, depthWrite: false })
    : new THREE.MeshPhysicalMaterial({
      color: paint, metalness: 0.15, roughness: 0.38,
      clearcoat: 1.0, clearcoatRoughness: 0.06,
    });
  const glassMat = ghost
    ? bodyMat
    : new THREE.MeshPhysicalMaterial({ color: 0x10151b, metalness: 0.25, roughness: 0.05 });
  const trimMat = ghost
    ? bodyMat
    : new THREE.MeshStandardMaterial({ color: 0x22262b, roughness: 0.55, metalness: 0.2 });

  const body = new THREE.Mesh(loft(THREE, BODY_SECTIONS), bodyMat);
  body.castShadow = !ghost;
  group.add(body);

  const glass = new THREE.Mesh(loft(THREE, GREENHOUSE_SECTIONS), glassMat);
  glass.castShadow = !ghost;
  group.add(glass);

  if (!ghost) {
    // Bumpers, sills and mirrors, merged into one dark mesh.
    const trimGeos = [
      box(THREE, 1.86, 0.20, 0.28, 0, 0.42, 2.16),
      box(THREE, 1.86, 0.22, 0.30, 0, 0.44, -2.14),
      box(THREE, 0.10, 0.16, 2.4, 0.92, 0.36, 0),
      box(THREE, 0.10, 0.16, 2.4, -0.92, 0.36, 0),
      box(THREE, 0.30, 0.12, 0.12, 1.02, 1.12, 0.55),
      box(THREE, 0.30, 0.12, 0.12, -1.02, 1.12, 0.55),
    ];
    group.add(new THREE.Mesh(mergeSimple(THREE, trimGeos), trimMat));

    // Lights.
    const headMat = new THREE.MeshBasicMaterial({ color: 0xfff0d0 });
    const tailMat = new THREE.MeshBasicMaterial({ color: 0x6a1410 });
    for (const sx of [-1, 1]) {
      const h = new THREE.Mesh(box(THREE, 0.34, 0.16, 0.10, sx * 0.55, 0.86, 2.19), headMat);
      group.add(h);
      const t = new THREE.Mesh(box(THREE, 0.34, 0.14, 0.10, sx * 0.55, 0.90, -2.19), tailMat);
      group.add(t);
    }
    group.userData.headMat = headMat;
    group.userData.tailMat = tailMat;
  }

  // --- wheels ---------------------------------------------------------------
  const tyreGeo = new THREE.CylinderGeometry(0.33, 0.33, 0.235, 16);
  tyreGeo.rotateZ(Math.PI / 2);
  const rimGeo = new THREE.CylinderGeometry(0.20, 0.20, 0.25, 10);
  rimGeo.rotateZ(Math.PI / 2);

  const tyreMat = ghost ? bodyMat : new THREE.MeshStandardMaterial({ color: 0x0e0f11, roughness: 0.95 });
  const rimMat = ghost ? bodyMat : new THREE.MeshStandardMaterial({ color: 0xb8bec4, metalness: 0.85, roughness: 0.3 });

  const wheels = [];
  const positions = [
    { x: 0.86, z: 1.30, front: true },
    { x: -0.86, z: 1.30, front: true },
    { x: 0.86, z: -1.42, front: false },
    { x: -0.86, z: -1.42, front: false },
  ];
  for (const p of positions) {
    const pivot = new THREE.Group();
    pivot.position.set(p.x, 0.33, p.z);
    const spin = new THREE.Group();
    const tyre = new THREE.Mesh(tyreGeo, tyreMat);
    tyre.castShadow = !ghost;
    spin.add(tyre);
    spin.add(new THREE.Mesh(rimGeo, rimMat));
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
    const glowGeo = new THREE.PlaneGeometry(3.4, 6.2);
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
      glowMat.opacity = 0.55 * Math.min(1, (night - 0.15) / 0.35);
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
      group.userData.headMat.color.setHex(on ? 0xfff3d8 : 0x6b6659);
      group.userData.tailMat.color.setHex(braking ? 0xff2a1c : (on ? 0x8c1a14 : 0x5a1210));
    },
    dispose() {
      group.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material && o.material.dispose) o.material.dispose();
      });
    },
  };
}

/** Merge geometries that only carry position (bumpers, sills, mirrors). */
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
  0xc0392b, 0x1f6f9a, 0xe0e2e4, 0x2c3038, 0x2e7d52,
  0xd9a441, 0x7a4fa3, 0xb8532f, 0x35566e,
];
