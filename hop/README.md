# Ruelle

Un jeu de conduite dans le navigateur, sur les vraies rues d'OpenStreetMap.
Aucune installation, aucun compte, aucun serveur.

```bash
cd hop && python3 -m http.server 8080   # ou n'importe quel serveur statique
# puis ouvrir http://localhost:8080
```

Un serveur est nécessaire : le jeu est en modules ES et `file://` les bloque.

---

## État actuel — 9 août 2026

Vérifié par `node hop/tools/smoke.mjs`, 26 contrôles automatisés à chaque commit.

**Monde.** Streamé depuis les vraies données Montréal — 19 618 bâtiments,
7 672 tronçons, 28 150 arbres, 1 219 feux, 549 lampadaires, sur 11 × 9 km.
Anneau de 5 × 5 tuiles, soit 4,3 km de portée, avec deux niveaux de détail :
les tuiles lointaines gardent sol et bâtiments, perdent le mobilier urbain et
un quart de leur texture. Recyclage vérifié après 3,6 km de route.

**Rendu.** Éclairage par image : le ciel est cuit en carte d'environnement
préfiltrée, re-cuite quand l'heure bouge, et c'est lui que reflètent vitres,
eau et carrosserie. Matériaux PBR partout, cartes de rugosité et de normales
générées. Quatre familles de façades dans un atlas — brique du Plateau, pierre
grise, commerce, bloc d'après-guerre — choisies d'après les tags OSM, en un
seul appel de rendu. Occlusion entre bâtiments approchée par comptage de
voisinage. Grain d'asphalte tuilé. Feuillage en panneaux croisés alpha testés.
Nuit complète : fenêtres allumées, halos, phares en projecteur.

**Conduite.** 0-50 en 2,3 s, 0-100 en 6,7 s, pointe 184 km/h, freinage à 1 g,
virage tenu à 62 km/h pour 0,76 rad/s, frein à main qui décroche l'arrière à
1,48 rad. Joystick flottant analogique sur mobile, manette, et onze commandes
remappables.

**Relief.** Le mont Royal est une montagne : altitudes tirées des tuiles
terrarium (AWS Open Data), lissées avant usage parce que 30 m d'échantillonnage
donne des terrasses sur lesquelles une voiture tressaute. Le sol, les
bâtiments, le mobilier et la caméra suivent tous la pente ; la gravité te coûte
de la vitesse en montée et te la rend en descente.

**Météo et heure.** Dégagé, couvert, pluie — la pluie mouille l'asphalte, qui
devient réfléchissant. Cycle jour/nuit, automatique ou au curseur.

**Vie.** Des piétons marchent les trottoirs (torse, tête et deux jambes qui
alternent, tout en instancié, jamais solides). Des oiseaux tournent au-dessus
de la ville et rentrent à la tombée du jour. Les haies `barrier=hedge` et les
buissons des parcs sont générés.

**Jeu.** Portes départ/arrivée posées n'importe où, chronométrage, fantôme
translucide du meilleur tour, lien de partage. Carte plein écran cliquable pour
se téléporter. Chaînes de talent façon Forza — dérive, frôlement, vitesse
tenue, kilomètre propre — qui se banquent ou se perdent au premier choc. Défis
tirés de la carte (touche `B`) : trois à cinq points de passage posés sur de
vraies rues autour de toi, budget de temps calculé sur la longueur réelle du
trajet, meilleur temps gardé par quartier.

**Mode photo** (touche `P`) : caméra libre en orbite, focale réglable de 18 à
90 mm, interface qui s'efface, et un PNG à la fin. La lecture des pixels se
fait dans la même image que le rendu, ce qui évite `preserveDrawingBuffer` et
sa bande passante sur *toutes* les autres images.

**Musique.** Générée dans le même graphe Web Audio que le moteur : nappe
d'accords, mélodie pentatonique en marche aléatoire, filtre qui s'ouvre avec la
vitesse. Aucun fichier à charger — donc aucune licence, et zéro octet.

**Assets.** Déposer `models/car.glb`, `tree.glb` ou `lamp.glb` remplace la
version générée, sans configuration. `tools/prepare-model.mjs` compresse un
modèle de vitrine par vingt à cinquante.

**Essences d'arbres.** `tree.glb` à `tree6.glb` : une essence par fichier,
réparties par un champ de quartier plutôt qu'au hasard — 80 % des arbres
voisins partagent leur essence, 17 % à 900 m, soit le pur hasard. Une rue est
plantée d'une essence, le quartier d'à côté d'une autre. Voir
`models/README.md`.

---

## Ce qui reste, par ordre de rendement

**1. De vraies textures.** C'est le plafond actuel, et il est net : tout ce que
tu vois est *dessiné*, pas photographié. Quatre familles de façades générées
valent mieux qu'une, mais une photo de brique montréalaise vaudra mieux que
mes quatre. Même chose pour l'asphalte. Voir `models/README.md` et la section
splat mapping ci-dessous.

**2. Splat mapping du sol.** Le sol est un composite peint — routes, trottoirs,
gazon dans un seul canvas par tuile — donc on ne peut pas y échanger une
photo. La vraie solution garde ce canvas comme *masque* et laisse un shader
mélanger trois ou quatre jeux PBR tuilés par-dessus, chacun à son échelle.
Textures attendues sous `assets/surfaces/{asphalt,sidewalk,grass}/`.

**3. Occlusion.** Depuis une rue, neuf bâtiments sur dix sont cachés derrière
ceux de devant, et on les dessine quand même. C'est le budget qui paiera les
assets haute qualité.

**4. Post-traitement.** SSAO, bloom, étalonnage. Les addons three.js sont déjà
vendorisés sous `vendor/jsm/`.

**5. L'île complète.** Voir `data/README.md` : la bbox est prête, il ne manque
que l'export. Au-delà, PMTiles pour ne plus jamais charger la ville d'un bloc.

**6. Suspension quatre roues.** Le relief est là, donc elle se verrait
maintenant : quatre points de contact au lieu d'un plan incliné, et les
débattements qui vont avec.

Volontairement écartés : trafic, imagerie satellite.

Les idées de *jeu* — météo réelle de Montréal, neige, garage et pièces moteur —
sont dans [`IDEES.md`](IDEES.md). Cette liste-ci reste la liste technique.

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
| `src/world/props.js` | lampadaires, arbres, feux, haies, buissons |
| `src/world/terrain.js` | altitudes terrarium, échantillonnage lissé |
| `src/world/birds.js` | le vol au-dessus de la ville |
| `src/world/pedestrians.js` | les piétons des trottoirs |
| `src/vehicle/` | physique, modèle, audio, collisions |
| `src/game/timetrial.js` | portes, chrono, fantômes, partage |
| `src/game/score.js` | chaînes de talent, multiplicateur, banque |
| `src/game/challenges.js` | parcours tirés du réseau routier |
| `src/game/photo.js` | caméra libre, focale, capture PNG |
| `src/game/music.js` | la bande son générative |
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
