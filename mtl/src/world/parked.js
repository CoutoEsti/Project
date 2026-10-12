// Parked cars, instanced. Any model will do — the generated Civic now, a
// downloaded glTF later: bakeModel() flattens it into one geometry per
// material, and each part becomes one InstancedMesh per tile.

/**
 * Flatten an Object3D into [{ geometry, material }], one per material, in the
 * model's own frame. Attributes kept: position, normal, and uv when every
 * mesh of that material has one.
 */
export function bakeModel(THREE, object) {
  object.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(object.matrixWorld).invert();
  const byMat = new Map();
  object.traverse((o) => {
    if (!o.isMesh || !o.geometry || Array.isArray(o.material)) return;
    let g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
    g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld));
    if (!g.attributes.normal) g.computeVertexNormals();
    let list = byMat.get(o.material);
    if (!list) { list = []; byMat.set(o.material, list); }
    list.push(g);
  });
  const parts = [];
  for (const [material, geos] of byMat) {
    const withUv = geos.every((g) => g.attributes.uv);
    let count = 0;
    for (const g of geos) count += g.attributes.position.count;
    const pos = new Float32Array(count * 3), nor = new Float32Array(count * 3);
    const uv = withUv ? new Float32Array(count * 2) : null;
    let k = 0;
    for (const g of geos) {
      pos.set(g.attributes.position.array, k * 3);
      nor.set(g.attributes.normal.array, k * 3);
      if (uv) uv.set(g.attributes.uv.array, k * 2);
      k += g.attributes.position.count;
      g.dispose();
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    if (uv) geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    parts.push({ geometry, material });
  }
  return parts;
}

/**
 * Two draw calls per car instead of one per material: every untextured part
 * but the paint is folded into one mesh, its colour moved into the vertices.
 * Textured parts (a glTF colour atlas) stay as they are.
 */
export function foldParts(THREE, parts, paint) {
  const fold = parts.filter((p) => p !== paint && !p.material.map && p.material.color);
  if (fold.length < 2) return parts;
  let count = 0;
  for (const p of fold) count += p.geometry.attributes.position.count;
  const pos = new Float32Array(count * 3), nor = new Float32Array(count * 3), col = new Float32Array(count * 3);
  let k = 0;
  for (const p of fold) {
    const g = p.geometry, n = g.attributes.position.count, c = p.material.color;
    pos.set(g.attributes.position.array, k * 3);
    nor.set(g.attributes.normal.array, k * 3);
    for (let i = 0; i < n; i++) { col[(k + i) * 3] = c.r; col[(k + i) * 3 + 1] = c.g; col[(k + i) * 3 + 2] = c.b; }
    k += n;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.3, name: 'Voiture_details' });
  return [...parts.filter((p) => !fold.includes(p)), { geometry, material }];
}

// Montréal's parked cars: mostly greys, whites, blacks, some colour.
const PAINTS = [0x1c1d20, 0x2b2d31, 0x8d9096, 0xb9bcc0, 0xe6e6e2, 0xd9d9d4, 0x5c6168,
  0x7a1d1a, 0x1d3557, 0x2f4f3a, 0x9a8a6a, 0x3b3f8f, 0xa33a2a];

/**
 * @param parts   bakeModel() output
 * @param paint   the part whose instances get a paint colour each (or null)
 * @param cars    placeParkedCars() output for one tile
 */
export function buildParked(THREE, parts, paint, cars, tile = null) {
  const out = [];
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(0, 0, 0, 'YXZ');
  const p = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1), c = new THREE.Color();
  for (const part of parts) {
    const mesh = new THREE.InstancedMesh(part.geometry, part.material, cars.length);
    cars.forEach((car, i) => {
      p.set(car.x, car.y, -car.n);
      q.setFromEuler(e.set(-car.pitch, car.yaw, 0));
      m.compose(p, q, one);
      mesh.setMatrixAt(i, m);
      if (part === paint) mesh.setColorAt(i, c.set(PAINTS[Math.floor(car.hue * PAINTS.length) % PAINTS.length]));
    });
    mesh.name = 'Voitures_stationnees';
    mesh.userData.zone = 'mobilier';
    mesh.userData.tile = tile;
    mesh.userData.layer = 'mobilier';
    mesh.userData.detail = true;
    mesh.userData.reach = 240;      // metres from the camera; see main.js
    mesh.computeBoundingSphere();
    out.push(mesh);
  }
  return out;
}
