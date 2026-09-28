# Reprise — état de MTL au 28 septembre 2026

Pour reprendre sans contexte. Lire d'abord `CLAUDE.md` (racine), puis
`mtl/README.md` (architecture, contrôles, limites) et `mtl/unity/README.md`.

## Le projet

`mtl/` : jeu de course dans la **vraie** Montréal (OpenStreetMap via Overture,
relief Terrarium), three.js, sans build ni npm. **Il sera porté sur Unity** :
tout ce qu'on crée doit rester exportable — logique de carte pure dans
`src/map/` (portable en C#), maillages glTF par zone, noms de matériaux
stables, `map.json` pour la logique de jeu.

```bash
cd mtl && python3 -m http.server 8080     # jouer
node mtl/tools/check.mjs                  # 18 contrôles, ~4 min — doit passer avant de commiter
node mtl/tools/shots.mjs --day            # captures (SwiftShader, lent)
node mtl/tools/export.mjs                 # export Unity
```

## Ce que l'utilisateur a demandé (session du 28 septembre)

1. La 40 surélevée (piliers et murs en béton, muret central en blocs de béton)
   ne doit plus « creuser » les routes qu'elle croise.
2. Un agent en parallèle pour les textures.
3. Penser Unity en permanence.
4. Une ville vibrante, façon *Marvel's Spider-Man*, fidèle aux vraies rues et
   quartiers de Montréal.

## Ce qui a été fait

**Attention à l'historique.** Les commits du 24 au 26 septembre (`d2c3854` →
`d2c2316`) avaient déjà réglé l'essentiel du point 1 — hauteurs déduites des
croisements, tranchée Décarie, viaduc continu de la Métropolitaine, sol qui ne
s'effondre plus sous les routes (`terrain.frozen()`), repères hors des rues,
contrôles et export à jour. La session du 28 est partie d'un clone qui ne les
avait pas, a refait une bonne part du même travail en parallèle, puis a
constaté que la version existante était meilleure (15/15 contrôles, 10
chevauchements contre 50) et l'a gardée. N'en a été porté que ce qui manquait :

- **Muret central et tablier unique de la 40** (`map/structures.js` :
  `twinOf`, genres `twin` / `twin-gap` ; `world/roads.js` : dalles
  `medians`). Avant, là où les deux chaussées se chevauchaient, il n'y avait
  aucun muret : on pouvait passer en sens inverse. Aujourd'hui : 6,9 km de
  muret New Jersey central sur la 40, 1 km de dalle entre chaussées écartées.
- **Portiques de sortie verts générés** (`map/exits.js`, `world/signs.js`
  accepte un vecteur `dir`) : 23 dans la zone anneau (« Sortie — Boul.
  Pie-IX »…), textures réduites à 512 × 200 pour le téléphone.
- **Contrôle « les rues passent sous la 40 »** dans `tools/check.mjs` : chaque
  rue nommée qui croise le viaduc est parcourue 60 m de chaque côté ; aucun
  choc, au moins 6,8 m sous le tablier. **16/16 contrôles passent.**

## L'agent textures — travail NON fusionné

Son commit est sauvegardé en patch : `mtl/docs/reprise/textures-agent.patch`
(fait sur l'ancienne base `729046e`). Entre-temps, `d2c2316` a refait de son
côté asphalte, trottoirs, fenêtres et corrigé les façades noires (masque de
vitres inversé dans l'alpha). Appliquer le patch donne 12 conflits dans
`textures.js`, `materials.js` et `README.md` : deux réécritures du même
shader de façades. Ce que le patch apporte et qui manque :

- matériaux béton de la 40 : `Concrete_Barrier` (4 × 1 m, crasse en bas),
  `Concrete_Pier` (4 × 8 m, coulures sous le chevêtre), `Concrete_Deck`
  (dessous du tablier, efflorescence) ;
- `tools/textures.mjs` : génère chaque texture dans Chromium et écrit des PNG +
  `materials.json` dans `mtl/export/textures/` — **indispensable pour Unity**,
  qui ne reçoit aujourd'hui aucune texture de l'export en ligne de commande ;
- atlas de façades 5 × 5 avec rez-de-chaussée (vitrines, portes de plex,
  auvents), types `limestone` et `condo`, boiseries colorées au Plateau,
  varyings `flat` contre un scintillement ; flaques d'asphalte la nuit.

Méthode conseillée : ne pas appliquer le patch en bloc. Partir du code actuel
et y reporter une à une les fonctions utiles (`git apply --3way` pour voir,
puis à la main), en premier `textures.mjs` et les trois bétons.

## À faire, dans l'ordre

1. **Reporter l'agent textures** (voir ci-dessus), puis brancher les bétons
   dans `world/roads.js` : glissières `jersey`/`median` → `Concrete_Barrier`,
   piliers → `Concrete_Pier`, `Dessous_tabliers` et rives → `Concrete_Deck`.
   Vérifier par captures de jour et de nuit sous la 40.
2. **Ville vivante** (demande Spider-Man, rien de fait encore côté contenu) :
   trafic et voitures garées (instanciés, chargés à la demande), piétons,
   escaliers extérieurs des plex et corniches en géométrie, enseignes. Budget
   `CLAUDE.md` : ~1500 appels de rendu, 8-10 M triangles, fluide sur iPhone.
3. **Voies ferrées** absentes des données : les ajouter à
   `tools/extract.py` (Overture `rail`) ; les ponts routiers au-dessus
   redeviendraient de vrais ponts.
4. **Poids de l'export Unity** : ~385 Mo en tout (bâtiments par quartier
   surtout) ; budget 150 Mo chargé à la demande. Simplifier / instancier.
5. `check.mjs` signale encore, sans échouer : 41 croisements juste sous le
   gabarit, 10 chevauchements, 133 routes ni au niveau ni au-dessus d'une rue
   (surtout Turcot et l'échangeur Décarie). À faire baisser. Le pont Victoria
   « perd » la voiture vers (1267, −3740) : défaut existant, à regarder.
6. 10 bouts de route arrivent encore sur une rue avec plus de 3 m d'écart
   (contrôle « les routes se posent sur les rues », 54 au départ) : des
   bretelles d'échangeur (l'Acadie, Décarie, Turcot) laissées en l'air parce
   qu'une autoroute les croise juste avant. Il faudrait les faire descendre
   sous l'autoroute avec assez de hauteur, ou les raccorder à une autre route.
7. **Bretelles qui arrivent sur un boulevard** (au sol, ex. voies de service de
   Décarie) : leur ruban chevauche encore la rue en biais. Appliquer le même
   principe que `map/junctions.js` (une seule surface, bretelle découpée contre
   le bord de la rue), mais contre les rues (`layout.streets`) plutôt que
   contre les routes. Ne pas poser de maillage par-dessus la chaussée d'une rue.
8. **Nombre de voies réel** : Overture n'a pas la balise OSM `lanes`, le jeu
   le devine d'après la largeur (`real.js`, `lanes:`). L'utilisateur va fournir
   un export Overpass (`lanes`, `width`, `turn:lanes` des `motorway`, `trunk`,
   `primary` et bretelles de la zone). À faire : un fichier `data/voies.json`
   (id de voie OSM → voies), le lire dans `tools/extract.py` ou `map/real.js`,
   largeur = voies × 3,7 m + accotements, et le marquage suit.
9. Fourche r1147 (échangeur Décarie/40) : pente de 8,9 % juste après le nez
   (limite 7,9 %), le seul avertissement ajouté par le raccord des fourches.

## Git

`CLAUDE.md` dit de travailler sur `main` ; ces sessions poussent sur la branche
`claude/funny-keller-cvo4kz`. À fusionner dans `main` (c'est `main` que le
site déploie). **Faire `git fetch` avant de commencer** : c'est faute de l'avoir
fait que la session du 28 a refait du travail existant.
