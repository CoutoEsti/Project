# Modèles 3D

Tout ici est **optionnel**. Chaque élément a une version générée par le code ;
déposer un fichier au bon nom la remplace, sans rien configurer. Un fichier
absent ou illisible n'est pas une erreur — le procédural reprend la main.

| Fichier | Remplace | Hauteur cible |
|---|---|---|
| `car.glb` | la voiture du joueur | 4,30 m de long |
| `tree.glb` | tous les arbres | 8,5 m |
| `lamp.glb` | tous les lampadaires | 6,2 m |
| `bench.glb` | les bancs | 0,9 m |

## Ce que le jeu fait tout seul

Tu n'as ni à orienter, ni à mettre à l'échelle, ni à poser le modèle au sol.
Au chargement, le jeu mesure la boîte englobante, ramène le modèle à la
hauteur cible, le recentre horizontalement et pose sa base à y = 0.

Pour la voiture, il cherche en plus les pièces animables **par leur nom** :

| Pièce | Mots reconnus, français ou anglais |
|---|---|
| Roues | `wheel`, `tyre`, `tire`, `rim`, `roue`, `pneu`, `jante` |
| Roues avant | en plus : `front`, `avant`, `_fl`, `_fr` |
| Vitres | `glass`, `window`, `windshield`, `vitre`, `pare-brise` |
| Feux | `headlight`, `taillight`, `phare`, `feu` |

Sans ces noms, le modèle s'affiche quand même : les roues ne tourneront
simplement pas.

Les props sont **instanciés** : un `tree.glb` sert des milliers d'arbres pour
une poignée d'appels de rendu. Chaque matériau du modèle devient un
InstancedMesh, donc un arbre tronc + feuillage coûte deux appels, pas deux
mille.

## Budget — et pourquoi

Un modèle de vitrine fait couramment 50 à 150 Mo. Le téléchargement est
pénible, mais ce qui tue vraiment l'onglet, c'est la **mémoire vidéo** : une
texture 4096×4096 non compressée occupe 67 Mo en VRAM, 89 Mo une fois
mipmappée. Un jeu PBR complet pour une seule voiture, c'est ~450 Mo, et Safari
iOS ferme la page bien avant.

| | Voiture | Arbre |
|---|---|---|
| Fichier | 2 à 5 Mo | 0,3 à 1,5 Mo |
| Triangles | 50 à 150 k | 1,5 à 8 k |
| Textures | 2048 max | 1024 max |

L'arbre est instancié des milliers de fois : ses triangles comptent bien plus
que ceux de la voiture, qui n'existe qu'en un exemplaire.

## Compresser

```bash
npm install @gltf-transform/core @gltf-transform/functions \
            @gltf-transform/extensions draco3dgltf sharp

node hop/tools/prepare-model.mjs ~/Downloads/voiture.glb hop/models/car.glb
node hop/tools/prepare-model.mjs ~/Downloads/arbre.glb hop/models/tree.glb --max 1024
```

Redimensionnement des textures, ré-encodage WebP, quantification des sommets,
puis compression Draco. Compter une division par vingt à cinquante.

## Où trouver des modèles

Le dépôt est public : **CC0 de préférence**, sinon CC-BY avec l'attribution
notée ci-dessous.

- **[Poly Haven](https://polyhaven.com/models)** — CC0, scannés, excellente
  qualité. Peu de modèles mais tous bons.
- **[Poly Pizza](https://poly.pizza)** — CC0, low-poly, énorme catalogue.
  Idéal pour les arbres, qui doivent rester légers.
- **[Sketchfab](https://sketchfab.com)** — filtrer sur « Downloadable » puis
  licence CC0 ou CC-BY.
- **[Kenney](https://kenney.nl/assets)** — CC0, style cohérent.

## Attributions

<!-- Ajouter ici : nom du modèle, auteur, licence, lien. -->

_Aucun modèle livré pour l'instant._
