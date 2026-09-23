# Importer MTL dans Unity

1. Installer **glTFast** (`com.unity.cloud.gltfast`) depuis le Package Manager.
2. Générer l'export : `node mtl/tools/export.mjs`, ou la touche **E** dans le
   navigateur (celle-ci garde les textures générées).
3. Glisser les `.glb` de `mtl/export/` dans `Assets/`. Il y a un fichier par
   zone : `routes`, `mont-royal`, `reperes`, `arbres`, `mobilier`, puis un par
   quartier pour les bâtiments.

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

Ajouter un `MeshCollider` sur `routes` et `mont-royal`. Pour les bâtiments,
des `BoxCollider` suffisent. Les glissières, murs et piliers font partie de
`routes`.

## Ce que `map.json` contient

Axes des routes avec leur hauteur (pour l'IA et les courses), rues, quartiers
(polygones, pour les bannières de zone), repères, points de départ et
courses.
