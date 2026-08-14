# Ruelle

Jeu de conduite dans le navigateur, sur les vraies rues de Montréal (OpenStreetMap).
Le jeu est dans `hop/`. Carte des fichiers et détails d'architecture : `hop/README.md`.

## Commandes

```bash
cd hop && python3 -m http.server 8080   # servir (modules ES : file:// est bloqué)
node hop/tools/smoke.mjs                # 26 contrôles headless — avant chaque commit
node hop/tools/smoke.mjs --headed       # les voir tourner
node hop/tools/shots.mjs --out .shots/live   # captures sur les vraies données
```

Pas de build, pas de bundler, pas de `npm install` : les fichiers de `src/` sont
exécutés tels quels. three.js et ses addons sont vendorisés dans `hop/vendor/`.
`smoke.mjs` lance son propre serveur et joue sur la fixture (`?offline=1`) pour
rester hermétique ; `--live` teste le chemin réseau.

## Ce qui ne se négocie pas

- **Site statique.** Aucun serveur, aucun compte, aucune clé d'API. Ce qui persiste
  passe par `core/store.js` ou par les paramètres d'URL. Refuser toute idée qui
  demande un backend, ou la ramener à une version sans serveur.
- **Rien à télécharger en plus.** Moteur audio et musique sont synthétisés, les
  textures générées. Ne pas ajouter de fichier son, ni de dépendance npm.
- **Le sol d'une tuile est un seul canvas peint** (`world/ground.js`) : routes,
  trottoirs, gazon, eau. Ne jamais poser un maillage par-dessus la chaussée —
  z-fighting immédiat au milieu des intersections.
- **Les marquages sont de la géométrie**, coupée à 9,5 m des jonctions. Toute
  nouvelle peinture au sol suit cette règle, sinon deux marquages se recouvrent.
- **La physique tourne à 120 Hz, découplée du rendu.** Jamais de logique de
  conduite indexée sur le framerate ni sur `delta` du rendu.
- **Pas d'imagerie satellite** : le libre est à 10 m/pixel, illisible à hauteur de
  pare-chocs. Le rendu reste stylisé.
- **Ça doit rester fluide sur téléphone**, Safari iOS compris. C'est ce critère qui
  a écarté Unity WebGL ; il écarte aussi tout ce qui alourdit le premier chargement.

## Budgets

| | Aujourd'hui | Plafond |
|---|---|---|
| Poids total | ~50 Mo | 150 Mo si chargé à la demande |
| Appels de rendu | ~110 | ~1500 |
| Triangles | ~4 M | 8-10 M |
| Construction | 1 pas par image, 8 ms | ne pas dépasser : le streaming se verrait |

Une voiture glTF pèse 2 à 5 Mo après `tools/prepare-model.mjs`. En ajouter dix
double le poids du jeu — charger à la demande, pas au lancement.

## Conventions

- **JavaScript pur**, modules ES. 2 espaces, guillemets simples, points-virgules.
- **Commentaires et noms de code en anglais ; documentation en français.**
- Les modules de `src/world/` **reçoivent `THREE` en paramètre**, ils ne
  l'importent pas — c'est ce qui les garde testables sans importmap. Garder ce
  contrat pour tout nouveau module de monde.
- Les données viennent d'une chaîne de quatre sources (embarqué → cache → Overpass
  → fixture générée) : le monde ne doit jamais finir vide. Tout nouvel appel
  réseau a un repli silencieux.
- Les nouvelles mesures de conduite se prouvent dans `tools/smoke.mjs`, qui mesure
  déjà 0-100, freinage, virage tenu et frein à main. Un chiffre annoncé se vérifie.

## Les deux listes

- `hop/README.md` → **liste technique** (rendu, données, performance).
- `hop/IDEES.md` → **liste des idées de jeu**, dans l'ordre. Y ajouter une idée de
  gameplay en deux phrases maximum ; ne jamais y mettre de plan technique.

## Git

**On travaille sur `main`.** Pas de branche de fonctionnalité, pas de pull
request : on commite et on pousse directement sur `main`, qui est ce que le site
déploie. Commits en français, à l'impératif, une ligne. `smoke.mjs` doit passer
avant de pousser.
