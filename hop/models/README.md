# Modèles 3D

Dépose ici un fichier nommé **`car.glb`** et le jeu l'utilisera à la place de
la voiture procédurale, automatiquement. Rien d'autre à configurer : si le
fichier est absent ou illisible, la voiture générée reste en place.

## Ce que le jeu fait tout seul

Tu n'as pas à préparer l'orientation ni l'échelle. Au chargement, le jeu
mesure la boîte englobante, normalise la longueur à 4,30 m, tourne le modèle
pour qu'il pointe vers l'avant, et le pose sur ses roues.

Il cherche ensuite les pièces animables **par leur nom**. Ça marche mieux si
les nœuds de ton modèle contiennent l'un de ces mots :

| Pièce | Mots reconnus |
|---|---|
| Roues | `wheel`, `tyre`, `tire`, `rim`, `roue`, `pneu`, `jante` |
| Roues avant | en plus : `front`, `avant`, `_fl`, `_fr` |
| Vitres | `glass`, `window`, `windshield`, `vitre`, `pare-brise` |
| Feux | `headlight`, `taillight`, `phare`, `feu` |

Sans ces noms le modèle s'affiche quand même — les roues ne tourneront
simplement pas.

## Compresser avant de livrer

Un modèle de vitrine fait couramment 50 à 150 Mo. Le téléchargement est
pénible, mais ce qui tue vraiment l'onglet c'est la mémoire vidéo : une seule
texture 4096×4096 non compressée occupe 67 Mo en VRAM, 89 Mo une fois
mipmappée. Un jeu PBR complet pour une voiture, c'est donc ~450 Mo, et Safari
iOS ferme la page bien avant.

```bash
node hop/tools/prepare-model.mjs ~/Downloads/voiture.glb hop/models/car.glb
```

Le script redimensionne les textures, les ré-encode en WebP, quantifie les
sommets puis compresse la géométrie en Draco. Compter une division par vingt
à cinquante. Si le résultat dépasse encore 8 Mo, relance avec `--max 1024`.

Les dépendances du script ne sont pas dans le dépôt :

```bash
npm install @gltf-transform/core @gltf-transform/functions \
            @gltf-transform/extensions draco3dgltf sharp
```

## Cibles

| | Budget |
|---|---|
| Fichier | 2 à 5 Mo |
| Triangles | 50 à 150 k |
| Textures | 1024 ou 2048, jamais 4096 |

## Licence

Le dépôt est public : n'y dépose que des modèles en CC0, CC-BY ou dont tu
détiens les droits, et note l'attribution ici.
