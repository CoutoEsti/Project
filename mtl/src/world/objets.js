// Custom objects (see map/objets.js): each placed model, set where the map
// put it. The models come from `load(modele)`, which main.js supplies (the
// published .glb files, or the editor's local copies); without it — under
// node — nothing is drawn, but the ground, the cleared buildings and the
// collisions are already there, from the map.

/**
 * @param map   buildMap() output (map.objets)
 * @param load  async (modele) → a THREE.Object3D to clone, or null
 */
export async function buildObjets(THREE, map, load) {
  const out = [];
  if (!load) return out;
  for (const o of map.objets || []) {
    let model = null;
    try { model = await load(o.modele); } catch (e) { model = null; }
    if (!model) continue;
    const inner = model.clone(true);
    inner.position.set(-o.origine[0], -o.origine[1], -o.origine[2]);
    const g = new THREE.Group();
    g.add(inner);
    g.position.set(o.x, o.y, -o.n);
    g.rotation.y = (-o.cap * Math.PI) / 180;
    g.scale.setScalar(o.k);
    g.name = o.nom;
    g.userData.objet = o.id;
    g.userData.layer = 'objets';
    g.updateMatrixWorld(true);
    g.traverse((m) => { m.matrixAutoUpdate = false; });
    out.push(g);
  }
  return out;
}
