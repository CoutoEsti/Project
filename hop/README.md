# Ruelle

Un jeu de conduite dans le navigateur, sur les vraies rues d'OpenStreetMap.
Aucune installation, aucun compte, aucun serveur.

```bash
cd hop && python3 -m http.server 8080   # ou n'importe quel serveur statique
# puis ouvrir http://localhost:8080
```

Un serveur est nécessaire : le jeu est en modules ES et `file://` les bloque.

---

## État actuel — 7 août 2026

**Ce qui fonctionne, vérifié par le test automatisé** (`node hop/tools/smoke.mjs`) :

- Monde streamé depuis les vraies données Montréal (19 618 bâtiments,
  7 672 tronçons, 28 150 arbres, 1 219 feux, 549 lampadaires, 11 × 9 km).
- Physique : 0-50 en 2,6 s, 0-100 en 7,0 s, pointe 183 km/h, freinage à 1 g,
  frein à main qui décroche l'arrière à 1,47 rad de dérive.
- 9 tuiles construites, 1 700 tronçons visibles, 117 draw calls, 3,7 M
  triangles par image.
- Nuit : fenêtres allumées, halos de lampadaires, phares.
- Chrono : portes départ/arrivée, parcours armé, lien de partage.
- Recyclage des tuiles après 3,6 km de route (pas de fuite mémoire).
- Zéro erreur console, zéro erreur de page.

**Ce qui reste à faire**, par ordre d'importance :

1. Les vitres des bâtiments sont noires opaques — il leur faut un reflet de
   ciel pour ne pas ressembler à des trous.
2. La caméra de poursuite traverse les murs dans les ruelles étroites ; il
   faut un raycast entre la voiture et la caméra.
3. Les arbres sont des icosaèdres à 20 faces : très anguleux de près. Un
   niveau de détail selon la distance réglerait le compromis.
4. Le relief est ignoré (Montréal est plate ; ailleurs il faudra draper les
   routes sur un MNT).
5. Pas de trafic ni de piétons — écarté volontairement pour cette étape.
6. Le fantôme n'est pas encore partagé par le lien, seulement le parcours.

---

## Comment c'est construit

Trois décisions portent l'essentiel du résultat.

**Le sol est peint, pas modélisé.** Chaque tuile devient une texture dessinée
au canvas : gazon, parc, eau, trottoir, bordure, asphalte. Les jointures
arrondies fusionnent quatre rues qui se croisent en une seule nappe d'asphalte
continue. Aucun maillage superposé, donc aucun z-fighting au milieu d'une
intersection — le défaut le plus visible de ce genre de jeu.

**Les marquages sont de la géométrie, rognée aux jonctions.** Ligne axiale
jaune (convention québécoise), lignes de voie blanches, lignes de rive,
lignes d'arrêt, passages piétons. Chaque marquage s'interrompt à 9,5 m d'une
jonction — exactement ce que fait la vraie peinture au sol — ce qui garantit
que deux marquages ne se recouvrent jamais.

**La simulation tourne à 120 Hz, découplée du rendu.** Modèle bicyclette avec
angles de dérive réels, transfert de charge longitudinal et ellipse de
friction par essieu. La voiture sous-vire quand on entre trop vite, pivote au
lever de pied, et décroche proprement au frein à main — à 30 comme à 144 fps.

Trois autres choix comptent :

- **Le moteur audio est synthétisé**, pas échantillonné : cinq oscillateurs
  pilotés par le régime, à travers un filtre mobile. Rien à charger, donc rien
  qui puisse craquer sur une limite de tampon.
- **Un pas de construction par image**, budget de 8 ms : analyse, peinture,
  structures, mobilier. Le streaming ne se voit jamais comme un à-coup.
- **Pas d'imagerie satellite.** À hauteur de pare-chocs, le seul satellite
  vraiment libre est à 10 m/pixel — une bouillie. Le rendu stylisé est à la
  fois plus beau de près et sans contrainte de licence.

## Où sont les choses

| Chemin | Rôle |
|---|---|
| `src/core/` | projection, tuiles slippy, boucle à pas fixe, entrées |
| `src/world/source.js` | chaîne embarqué → cache → Overpass → fixture |
| `src/world/fixture.js` | Montréal synthétique, au format exact d'Overpass |
| `src/world/ground.js` | la texture de sol par tuile |
| `src/world/roads.js` | classification, jonctions, marquages |
| `src/world/buildings.js` | extrusion, fenêtres, escaliers extérieurs |
| `src/world/props.js` | lampadaires, arbres, feux, voitures garées |
| `src/vehicle/` | physique, modèle, audio, collisions |
| `src/game/timetrial.js` | portes, chrono, fantômes, partage |
| `tools/prepare-data.mjs` | compacte un export Overpass brut |
| `tools/smoke.mjs` | test navigateur headless |

Les modules de `world/` reçoivent `THREE` en paramètre plutôt que de
l'importer : ils restent testables sans importmap.

## Données

Le jeu essaie quatre sources dans l'ordre, pour que le monde ne soit jamais
vide : jeu embarqué (`data/montreal.json`), cache IndexedDB, Overpass en
direct, puis une Montréal générée. Voir `data/README.md` pour renouveler
l'extrait.

Données cartographiques © les contributeurs d'OpenStreetMap, sous
[ODbL](https://www.openstreetmap.org/copyright).

Made with Claude.
