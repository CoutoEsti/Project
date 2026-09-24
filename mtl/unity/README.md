# Importer MTL dans Unity

1. Installer **glTFast** (`com.unity.cloud.gltfast`) depuis le Package Manager.
2. Générer l'export : `node mtl/tools/export.mjs` (options `--zone`,
   `--echelle`, `--tuiles`), ou la touche **E** dans le navigateur, qui
   télécharge un `.zip` et garde les textures générées. La zone et l'échelle
   exportées sont celles de la carte construite.
3. Glisser les `.glb` de `mtl/export/` dans `Assets/`. Un fichier par couche :
   `sol`, `eau`, `rues`, `trottoirs`, `routes`, `ouvrages` (murs, glissières,
   piliers, tunnels), `marquage`, `reperes`, `arbres`, `mobilier`,
   `alentours` ; et les bâtiments par tuile de 1 km (`batiments_<i>_<j>`),
   pour pouvoir les charger ou les décharger par morceaux. `--tuiles` découpe
   aussi toutes les autres couches.

Les `.glb` passent le validateur officiel de Khronos (`gltf-validator`) sans
erreur ni avertissement. Extensions utilisées, toutes lues par glTFast :
`EXT_mesh_gpu_instancing` (arbres, lampadaires et autres objets répétés),
`KHR_materials_unlit` (panneaux et autres surfaces sans éclairage) et `KHR_materials_emissive_strength`
(lampes et enseignes plus brillantes que le blanc, pour le bloom).

## Ce qui passe dans Unity, et ce qui ne passe pas

- **Passe** : toute la géométrie (routes, tranchées, tunnel, ponts, bâtiments,
  montagne, repères, mobilier), les matériaux de base et `map.json`.
- **Ne passe pas** : la conduite, la caméra, le HUD et le son sont en
  JavaScript. Dans Unity, il faut les refaire en C#, ou partir d'un
  contrôleur de voiture existant (Asset Store, ou le `WheelCollider` de base). `map.json` donne ce qu'il faut pour rebrancher les
  courses, les zones et les points de départ.
- **À refaire à la main** : les matériaux URP/HDRP (voir plus bas), la
  lumière et le ciel.

## Repère

- 1 unité = 1 mètre.
- Unity +X = est de Montréal (vers le Stade), +Z = nord de Montréal (vers
  Laval), +Y = haut. C'est le repère « rue » de Montréal, tourné d'environ 57°
  par rapport au nord géographique.
- `map.json` utilise le même repère : points `[x, y, z]`, caps en degrés dans le
  sens horaire depuis le nord de Montréal.

## Matériaux

Sans canvas, l'export en ligne de commande n'a pas de textures. Les matériaux
portent des noms stables (`Asphalt`, `Concrete`, `Glass`, `Lamp_Sodium`…) :
les remplacer par nom avec des matériaux URP/HDRP. Les façades utilisent un
shader maison dans le navigateur ; dans Unity, prévoir un matériau à atlas de
fenêtres, avec les attributs de sommet `_FACADE` et `_SEED` s'ils sont présents.

## Collisions

Ajouter un `MeshCollider` sur `sol`, `rues`, `routes` et `ouvrages` (le sol
porte le relief réel : les rues sont drapées dessus). Pour les bâtiments, un
`MeshCollider` convexe par bâtiment coûte cher : un `MeshCollider` non convexe
par tuile suffit.

## Taille

À 100 %, la zone `anneau` fait ~12 × 11 km, soit ±6 km autour de l'origine
(Peel et Sainte-Catherine) : la précision des flottants de Unity tient. Le
poids total dépasse 300 Mo (surtout les bâtiments) ; `centre` en fait ~140.

## Ce que `map.json` contient

Zone et échelle, axes des routes avec leur hauteur (et leurs tronçons en
tunnel), rues avec la hauteur du sol, quartiers (points nommés), repères tels
que placés, points de départ résolus sur la route, courses. Tout en repère
Unity : `[x, y, z]`, x = est, z = nord.
