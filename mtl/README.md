# MTL — la vraie Montréal pour un jeu de course

Carte de monde ouvert pour un jeu de course de rue façon *Need for Speed
Underground*, construite sur les **vraies données** de Montréal :
OpenStreetMap (via Overture Maps) pour les rues, autoroutes, bâtiments, eau,
parcs et arbres, et le relief réel (tuiles Terrarium). Rien n'est tracé à la
main sauf quelques repères, les points de départ et les styles de quartier.

![Plan](docs/plan.png)

## Lancer

```bash
cd mtl && python3 -m http.server 8080     # puis http://localhost:8080
```

Pas de build ni de `npm install` : three.js est dans `vendor/`, les données
dans `data/` (≈ 13 Mo).

## Zone et échelle

Deux réglages, dans le bouton **Carte…** en haut (la page se reconstruit) :

| Zone | Contenu |
|---|---|
| `centre` | centre-ville, Vieux-Montréal, Vieux-Port, Plateau, mont Royal, Ville-Marie, les îles (~7 × 7 km) |
| `anneau` | le centre, plus Décarie, la Métropolitaine (A-40), Turcot, le Stade (~12 × 11 km) |

**Échelle** : 100 % (la vraie ville), 85 % ou 70 %. En dessous de 100 %,
tout rapetisse d'autant — rues, bâtiments, relief — sauf la voiture et les
dégagements sous les ponts et dans les tunnels, qui restent en vrais mètres.

La valeur de départ est dans `carte.json` ; l'adresse la remplace :
`?zone=centre&echelle=85` (ou `#centre-85`).

## Contrôles

| Touche | Action |
|---|---|
| WASD / flèches | conduire (manette et tactile aussi) |
| Espace | frein à main |
| R | replacer sur la route |
| C | caméra (poursuite, lointaine, capot) |
| M | grande carte ; un clic y téléporte |
| N | nuit / jour |
| F | vol libre (ou le bouton **Vol libre** en haut) |
| E | exporter pour Unity (un `.zip` : `.glb` + `map.json`) |

### Vol libre

La voiture reste où elle est ; la vitesse suit l'altitude.

| Touche | Action |
|---|---|
| glisser (souris ou doigt) | regarder |
| WASD / flèches | avancer, reculer, glisser de côté |
| Espace / Maj | monter / descendre |
| molette | plonger vers ce qu'on regarde |
| O | vue d'ensemble de la zone |
| M | grande carte ; un clic y amène la caméra |
| G | poser la voiture sur la rue au centre de la vue et reprendre le volant |
| F | revenir à la voiture |

Autres paramètres d'URL : `?spawn=decarie|metropolitaine|ville-marie|centre-ville|vieux-port|plateau|camillien-houde|jacques-cartier|stade|circuit`,
`?day=1`, `?low=1` (réglages téléphone), `?fly=1` ou `#vol` (démarrer en vol
libre), `?cam=x,n,h,tx,tn,th` (vol libre à un point précis).

## La nuit

Le jeu se passe de nuit (N bascule le jour, pour lire la carte). Low poly,
mais détaillé, et une couleur qui donne le ton sans faire futuriste : la
Montréal humide d'un soir d'été, où les enseignes gagnent sur le sodium.

- **Ciel et brume** : indigo au zénith, brume violette, lueur de la ville à
  l'horizon qui passe du magenta au sarcelle.
- **Façades** (un seul shader pour toute la ville) : fenêtres allumées une par
  une, surtout chaudes, quelques pièces en couleur, des stores ; bureaux
  éclairés par étage en blanc froid ; rez-de-chaussée commerciaux plus
  souvent allumés, en couleur ; le bas des murs éclairé par la rue ; bandes
  LED cyan ou magenta sur les coins de certaines tours.
- **Néons** (`map/neon.js`, `world/neon.js`) : sur les artères (boulevards et
  avenues), bandeaux au-dessus des vitrines, enseignes drapeau façon
  Saint-Laurent, auvents, noms lumineux en haut des tours. Couleurs selon le
  quartier (cyan et magenta au centre-ville, rose et ambre sur le Plateau,
  ambre et rouge dans le Vieux). Quelques-uns grésillent.
- **Chaussée mouillée, simulée** : chaque flaque de lumière (lampadaire,
  enseigne) s'étire vers la caméra comme un reflet sur l'asphalte mouillé,
  dans le vertex shader. Pas de vrais reflets (trop cher sur téléphone).
- **Éclairage** : LED blanc froid sur les artères et les autoroutes, sodium
  orange dans les rues résidentielles, lanternes dans le Vieux.
- **Détails** : corniches sur les toits plats, blocs techniques, couronnes
  lumineuses et feux d'avion clignotants sur les tours.

## Comment c'est fait

```
tools/extract.py  →  data/*  →  map/source.js  →  map/real.js  →  map/layout.js  →  map/structures.js  →  world/*
(une fois, Python)   (fichiers)   (décodage)       (zone, échelle,   (routes échantillonnées,  (murs, glissières,     (maillages
                                                    profils)          jonctions, relief)        piliers, plafonds)      three.js)
```

- **Rues** : tout ce qui roule au niveau du sol est drapé sur le relief ; la
  voiture roule sur le relief.
- **Routes** : ce qui quitte le sol — autoroutes et bretelles entières, et les
  ponts, tunnels et passages supérieurs des rues ordinaires avec leurs rampes.
  OpenStreetMap donne un *ordre* de couches, pas des hauteurs : les hauteurs
  sont déduites (couche 1 ≈ 7,6 m, tunnel ≈ −8 m), puis limitées en pente,
  raccordées aux routes qu'elles rejoignent, et écartées d'un gabarit complet
  (ou ramenées au même niveau) là où deux routes se croisent de trop près.
  Deux règles corrigent la lecture littérale des couches :
  - **La rue reste au niveau, l'autoroute passe dessous.** OSM met la rue en
    pont (couche 1) au-dessus d'une autoroute restée en couche 0. Lu tel quel,
    chaque rue du quadrillage montait de 7,6 m au-dessus de Décarie. Le pont
    de la rue redescend donc au sol (avec les autres morceaux du même pont),
    et l'autoroute descend de 7,4 m sous elle.
  - **Pas de montagnes russes.** Entre deux ponts (ou deux passages
    inférieurs) trop proches pour redescendre et rester au sol un moment
    (≈ 400 m de palier pour une autoroute), la route garde sa hauteur :
    remblai ou viaduc continu, tranchée continue. C'est ce qui donne la
    tranchée Décarie et le viaduc de la Métropolitaine.
- **Ouvrages** : murs de tranchée, tunnels, glissières, piliers, clôtures sont
  *déduits* de ce qu'il y a de chaque côté de chaque route. Rien n'est posé à
  la main ; ce qu'on voit et ce qu'on percute sont les mêmes données.
- **Bâtiments** : les 130 000 empreintes réelles, hauteur d'OSM quand elle
  existe, sinon estimée (étages, type, quartier). Façades selon le style du
  quartier (`map/montreal.js`).
- **Repères** : 20 modèles (Stade, croix, PVM, Habitat 67…). S'ils tombent
  sur une rue ou une route, ils glissent automatiquement vers la place libre
  la plus proche.

| Dossier | Rôle |
|---|---|
| `data/` | la ville extraite (générée par `tools/extract.py`) |
| `src/map/` | logique pure, sans three.js : décodage, zones, profils, structures, surfaces, collisions |
| `src/world/` | maillages three.js (reçoivent `THREE` en paramètre) |
| `src/game/` | conduite (physique de Ruelle à 120 Hz), caméras, entrées, HUD, son |
| `src/export/` | export glTF, `map.json`, `.zip` |
| `tools/` | contrôles, captures, plan, export, extraction |

Rafraîchir les données (réseau requis, ~5 min) :
`python3 -m pip install pyarrow shapely numpy scipy pillow && python3 mtl/tools/extract.py`.

## Contrôles avant de commiter

```bash
node mtl/tools/check.mjs                         # ~40 s : profils, repères, conduite
node mtl/tools/check.mjs --zone centre --echelle 85
node mtl/tools/check.mjs --browser               # + la vraie page dans Chromium headless
node mtl/tools/shots.mjs --day                   # captures → mtl/.shots/
node mtl/tools/plan.mjs --png                    # régénère docs/plan.png
node mtl/tools/export.mjs                        # export Unity → mtl/export/
```

`check.mjs` fait rouler un pilote automatique, voie de droite, sur Décarie
dans les deux sens, la Métropolitaine dans les deux sens, le tunnel
Ville-Marie dans les deux sens, le pont Jacques-Cartier, Camillien-Houde et le
circuit Gilles-Villeneuve, et pose la voiture sur une centaine de rues prises
au hasard. Il compte chaque choc, chaque saut et chaque écart vertical, mesure
le 0-100 et le freinage, et vérifie qu'aucun repère n'est sur une rue. Passe
aux zones `anneau` 100 % et 70 %, et `centre` 100 % et 85 %.

## La voiture

Une Honda Civic générée (`src/game/car.js`) roule par défaut : un hull
low-poly texturé par sa seule couleur, avec les proportions d'une 10e/11e
génération — long capot bas, pavillon fastback, ligne de caractère marquée,
phares fins, feux arrière en C, calandre noire, jantes à 5 branches.

Pour rouler avec un vrai modèle : déposer un fichier `mtl/models/civic.glb`
(glTF **binaire**, sans Draco — `mtl/vendor` n'a pas le décodeur, seul
`hop/vendor` l'a — idéalement sous 5 Mo, par exemple exporté depuis Blender en
`.glb` sans cocher la compression Draco). Au chargement, `game/gltf-car.js`
sonde ce chemin ; s'il est absent, la voiture générée reste en place, sans
message dans la console. `?car=<url>` pointe vers un autre fichier.

`hop/tools/prepare-model.mjs` (réduction de texture + Draco) n'est **pas**
directement utilisable ici : il compresse toujours la géométrie en Draco, que
`mtl/vendor` ne sait pas décoder. Pour un modèle déjà lourd, réduire les
textures à la main (2048 px ou moins, WebP ou JPEG) et exporter sans Draco est
la voie la plus sûre tant que `mtl/vendor` n'a pas son propre décodeur.

Le modèle est mis à l'échelle sur la longueur de la voiture générée (4,30 m),
recentré, posé au sol, et ses roues sont retrouvées par leur nom
(`wheel`/`tire`/`roue`/`pneu`…, avant/arrière par `front`/`avant` ou
`rear`/`arrière`) pour le braquage et la rotation. Sans nœud reconnu comme
roue, le modèle reste statique plutôt que de planter.

## Unity

Voir [`unity/README.md`](unity/README.md).

## Limites connues (honnêtement)

- **Les hauteurs sont déduites, pas mesurées.** Les autoroutes testées se
  conduisent sans choc, mais `check.mjs` liste encore quelques centaines de
  croisements « à revoir » : un pont bas au-dessus d'une rue (3,5 à 6 m), une
  rue qui passe sous un tablier sans vrai tunnel, souvent à 5-6 m au lieu de
  6,2. Ça ne bloque pas la voiture ; les pires (routes en escalier, rues qui
  plongeaient dans la tranchée) sont corrigés.
- Les bretelles de l'île Sainte-Hélène qui montent au pont Jacques-Cartier
  sont trop courtes dans les données pour atteindre le tablier : elles
  finissent sur une barrière « Fermé ».
- À 70 %, les voies sont étroites (la voiture ne rapetisse pas).
- Premier chargement lourd : ~25 s pour `anneau` sur un bon ordinateur. Au
  volant, 400 à 750 appels de rendu et 3 à 5 M triangles au centre-ville ;
  la vue d'ensemble de l'anneau, ~1 400 appels et 6,7 M. Sur téléphone,
  utiliser la zone `centre` (non mesuré sur un vrai téléphone).
- Les voitures, piétons et le trafic manquent : les rues sont vides.
- Pas encore de trafic, de piétons, ni de course jouable.
