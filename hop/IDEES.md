# Idées

## L'ordre

Ce qu'on ferait, dans cet ordre, et pourquoi celui-là. Chaque étape rend la
suivante possible ou mesurable.

| # | Quoi | Pourquoi maintenant | Taille |
|---|---|---|---|
| 0 | **Panneau de réglage en direct + `tuning.js`** | Rien ne peut être réglé par le propriétaire du jeu aujourd'hui. C'est l'outil de toutes les étapes suivantes | Petit |
| 1 | **Courbe de pneu + sensibilité à la charge** | La signature de conduite. Tout le reste — neige, pneus, pièces — ne veut rien dire sans elle | Moyen |
| 2 | **Quart de mille + dyno** | Rend le talent et les pièces *visibles* et partageables. Le chrono, les portes et les fantômes existent déjà | Petit |
| 3 | **Garage v1 : peinture, jantes, hauteur** | Personnalisation visible immédiatement, zéro équilibrage à faire | Moyen |
| 4 | **Pièces mécaniques v1** | Moteur, boîte, pneus, suspension, freins, allègement — sur la voiture de départ. La monnaie existe déjà (le score) | Moyen |
| 5 | **Neige + pneus d'hiver + météo réelle** | Un seul bloc. L'identité montréalaise, et le premier achat qui change vraiment la conduite | Moyen |
| 6 | **Traction / propulsion / intégrale** | Nécessaire *avant* de vendre une deuxième voiture : le train moteur est l'identité d'un char | Moyen |
| 7 | **Boutique de véhicules** | En dernier, quand on saura ce que vaut un point. Bloqué par le poids des modèles | Gros |

Deux règles pour ne pas se perdre : l'étape 1 se fait avec le banc d'essai
existant (`tools/smoke.mjs`), et rien après l'étape 4 ne se construit avant que
l'économie ait des chiffres.

## Le plafond technique du navigateur

Pour savoir jusqu'où ça peut aller avant de promettre quoi que ce soit.

| | Aujourd'hui | Le plafond réaliste | Ce qui bloque |
|---|---|---|---|
| Poids total | ~50 Mo | 150-200 Mo si chargé à la demande | La patience au premier lancement |
| Triangles | ~4 M | 8-10 M | Les mobiles, pas les ordinateurs |
| Appels de rendu | ~110 | ~1500 | Le CPU par image |
| Ville | 11 × 9 km chargés d'un bloc | La planète | PMTiles + un R2 à ~2 $/mois |
| Éclairage | IBL + ombres temps réel | + SSAO, bloom, étalonnage | Rien : les addons sont déjà vendorisés |
| Voitures | 1 générée + 1 glTF | 10-15 en streaming | 2-5 Mo pièce après compression |

**Le plafond honnête, en une phrase :** on peut atteindre « très beau stylisé,
fluide sur téléphone ». On n'atteindra pas le photoréalisme AAA — pas à cause
du navigateur, mais parce que ça demande des années d'artistes. Ce n'est pas la
technique qui limite ce projet.

Une note d'avenir : WebGPU est supporté par three.js et arrive partout. Ça
donnera surtout du calcul (foules, particules, culling), pas un saut visuel.

## Comment modifier le jeu sans savoir coder

Le langage est **JavaScript**, sans étape de compilation : les fichiers de
`src/` sont exécutés tels quels par le navigateur. Concrètement, modifier le
jeu, c'est éditer un fichier texte sur GitHub — le site se redéploie tout seul.

Le problème réel n'est pas le langage, c'est que **les nombres qui comptent
sont éparpillés dans quinze fichiers**. D'où l'étape 0, qui est deux choses :

1. **`src/tuning.js`** — un seul fichier, commenté ligne par ligne, qui
   rassemble tout ce qui se règle : masse, puissance, adhérence, biais
   arrière, angle de braquage, réglages de caméra, couleurs, intensités,
   densité des piétons, prix plus tard. Éditable depuis le téléphone, dans
   l'éditeur web de GitHub, sans rien installer.
2. **`?tune=1`** — un panneau de curseurs dans le jeu, qui applique les
   changements **en direct pendant qu'on roule**, et qui recrache à la fin le
   contenu de `tuning.js` à copier-coller. On sent le changement avant de
   l'écrire.

C'est aussi, et surtout, le bon outil pour l'étape 1 : trouver le sweet spot
entre réaliste et plaisant demande de conduire en changeant un chiffre, pas de
relire du code.

Le carnet. Rien ici n'est construit — c'est ce qu'on ferait ensuite, avec
assez de détail pour qu'une prochaine session puisse attaquer sans redécouvrir
le terrain.

Le classement de `README.md` (« Ce qui reste, par ordre de rendement ») reste
la liste technique. Celle-ci est la liste des idées de jeu.

**Décision de moteur, prise le 9 août 2026 : on reste sur le web.** Unity reste
une convergence possible et acceptée — c'est plus de travail, et ce n'est pas
exclu. Ce qui suit est écrit pour que ça reste vrai : les étapes 0 à 2 sont de
la *logique* et gardent leur valeur dans n'importe quel moteur. Voir « La vraie
fourche » plus bas pour la question qui tranchera vraiment.

---

## 1. La vraie météo de Montréal

**L'idée.** Le jeu a déjà trois météos et un cycle jour/nuit. Les brancher sur
la vraie météo de Montréal veut dire qu'il pleut dans le jeu quand il pleut
dehors, et qu'à 19 h en janvier il fait nuit comme il fait nuit.

**Comment.** [Open-Meteo](https://open-meteo.com) : gratuit, sans clé, CORS
ouvert, ce qui compte parce que le jeu est un site statique sans serveur.

```
https://api.open-meteo.com/v1/forecast
  ?latitude=45.51&longitude=-73.59
  &current=temperature_2m,precipitation,snowfall,cloud_cover,weather_code
  &timezone=America/Montreal
```

Le `weather_code` est du WMO : 0-3 dégagé à couvert, 51-67 pluie, 71-77 neige,
95+ orage. Il se projette directement sur les presets de `world/weather.js`.
Le fuseau donne l'heure locale, donc `timeOfDay` sans calcul.

**Ce qu'il faut ajouter :**

- un choix `weather: 'live'` dans les réglages, à côté de `clear/overcast/rain` ;
- un cache de quinze minutes dans `store.js` — la météo ne change pas plus
  vite, et ça évite de taper l'API à chaque saut ;
- un repli silencieux sur `clear` si l'appel échoue. Une météo indisponible ne
  doit jamais empêcher de conduire ;
- la température affichée dans le HUD, à côté du nom du quartier.

**Le vrai gain est la neige.** Montréal est enneigée cinq mois par an et le jeu
ne sait pas la faire. Un preset neige demanderait :

- le sol : un mélange blanc par-dessus la texture peinte, plus fort sur le
  gazon et les toits que sur l'asphalte, qui reste noir et mouillé au centre
  des voies parce que c'est ce que font les voitures ;
- des bancs de neige le long des trottoirs — la même géométrie que les haies,
  matériau différent. Ça, c'est Montréal en hiver plus que n'importe quoi
  d'autre ;
- l'adhérence. `vehicle/physics.js` a déjà un scalaire `grip` : la neige, c'est
  `grip × 0.55` et `rearGripBias` un peu plus bas. Aucun code de physique à
  écrire, une constante à passer ;
- les particules : les traînées de pluie existent déjà dans `weather.js`, il
  suffit de les faire tomber plus lentement et de les rendre plus larges.

La température, elle, mérite d'aller au-delà du chiffre : un étalonnage plus
froid et plus bleu sous zéro, plus chaud et plus doré en juillet. Le
`toneMappingExposure` et la saturation du preset sont déjà branchés.

---

## 2. Garage, boutique et pièces moteur

**Le public visé : les gars de char.** Pas les joueurs d'arcade — mais **pas
les joueurs de *Car Mechanic Simulator* non plus**, et c'est la distinction la
plus importante de tout ce fichier.

> Le but est une **customisation poussée**, pas une **simulation poussée**.

Beaucoup de pièces, beaucoup de choix, beaucoup de combinaisons. Pas de
sous-systèmes à comprendre. Une pièce, c'est : un nom réel, un prix, un ou
deux chiffres, et un effet qu'on sent en conduisant. On l'achète, on la pose,
on repart. Personne ne devrait avoir à lire une explication pour acheter un
échappement.

**Ce qui reste non négociable**, malgré la simplicité : les chiffres doivent
être vrais. Ce public détecte le faux immédiatement, et un curseur « +15 HP »
qui ne change rien de mesurable est grillé au premier essai. Si la pièce dit
+28 HP, le modèle gagne +28 HP et le chrono le montre. C'est ça, l'honnêteté
demandée — pas la complexité.

Donc, concrètement :

| On fait | On ne fait pas |
|---|---|
| Chevaux, lb-pi, poids en livres | Barres de progression « perf ▮▮▮▯▯ » |
| Un dyno simple : la courbe avant / après | Cartographie, AFR, avance à l'allumage |
| Turbo = plus de puissance en haut, moins en bas | Inertie de turbine, wastegate, seuil de boost |
| Pneus = plus ou moins d'adhérence | Température et usure de la gomme |
| Suspension = plus ou moins de survirage | Ressorts, amortisseurs, carrossage, pincement |
| Une pièce, un ou deux chiffres | Des pièces qui en exigent d'autres |
| Rien ne casse | Fiabilité, chaleur, détonation |

**Le seul compromis à garder**, parce qu'il est simple à comprendre et qu'il
fait exister le réglage : une pièce ne doit pas être *strictement* meilleure.
Turbo — ça pousse en haut, c'est mou en bas. Finale courte — meilleur 0-100,
moins de pointe. Suspension rabaissée — ça tourne mieux, c'est nerveux.
Quatre ou cinq compromis de ce genre suffisent. S'il n'y en a aucun, la
boutique n'est plus qu'une liste de courses.

**Le quart de mille.** Presque gratuit ici : le chrono, les portes et les
fantômes existent déjà (`game/timetrial.js`). Un huitième et un quart de mille
sur une vraie ligne droite de Montréal, avec l'arbre de Noël, le temps de
réaction et le trap speed. C'est là que les chiffres du garage deviennent
visibles, et c'est ce qui se partage.

**Ce que la physique sait déjà faire**, et le seul vrai manque :

| Déjà dans `physics.js` | Sert à |
|---|---|
| Courbe de couple, `redline` | Moteur, admission, échappement, turbo |
| Rapports et finale | Boîte, différentiel |
| `grip`, `stiffnessPerN` | Pneus |
| `rearGripBias`, transfert de charge | Suspension, barres |
| `mass`, `izz` | Allègement, jantes |
| Couple de freinage | Freins |

Presque tout le garage tient donc dans des constantes que le modèle attend
déjà. **Le seul vrai chantier, c'est la transmission** : aujourd'hui la
voiture est une propulsion, point. Traction et intégrale changent complètement
le comportement, et c'est la première chose qu'un gars de char remarque —
mais c'est un choix de *véhicule*, pas un système à simuler. Un paramètre qui
répartit le couple entre les essieux couvre les trois cas.

### Les pneus d'hiver

L'idée qui relie tout : **il faut acheter des pneus d'hiver, sinon ça spin.**

C'est exactement le bon niveau. Aucune explication nécessaire, aucun
sous-système, une seule décision — et une conséquence qu'on sent dans la
première courbe. C'est aussi la loi au Québec du 1er décembre au 15 mars, donc
c'est vrai *et* c'est local, ce qu'aucun jeu de char ne fait.

Comment ça marche, en entier :

- trois jeux de pneus à l'achat : **été**, **quatre saisons**, **hiver** ;
- la météo réelle (idée 1) ou le réglage manuel décide de l'état du sol ;
- la surface multiplie `grip`, et le type de pneu multiplie ce multiplicateur.
  Été sur neige : autour de 0,35 — la voiture patine au démarrage, part au
  freinage, et on ne monte pas Camillien-Houde. Hiver sur neige : autour de
  0,75, ça roule. Hiver sur asphalte sec et chaud : un peu *moins* bon que
  l'été, parce que c'est vrai, et parce que ça évite qu'un seul choix gagne
  toute l'année ;
- deux lignes de HUD suffisent : la surface, et les pneus montés. Si les deux
  ne vont pas ensemble, on le voit.

Ça donne une raison saisonnière de revenir au garage, ça fait vendre deux
jeux de pneus au lieu d'un, et ça rend la neige (idée 1) *jouable* plutôt que
décorative. À faire en même temps que la neige, pas après.

**L'idée.** Acheter des voitures, les modifier, les régler. C'est le système
qui donne une raison de rejouer, et c'est celui qui fait rester les gens.

**Ce qui existe déjà et qu'on sous-utilise.** Presque toute la plomberie est
posée :

| Il faut | On a déjà |
|---|---|
| Une monnaie | `game/score.js` — dérives, frôlements, kilomètres propres, défis |
| Une raison de gagner de l'argent | Les défis tirés de la carte, `game/challenges.js` |
| Une mesure de progrès | Les chronos et les fantômes, `game/timetrial.js` |
| De la persistance | `core/store.js` + les liens de partage par paramètres d'URL |
| Des voitures chargeables | `vehicle/gltf.js`, qui remplace déjà la voiture générée |

Il manque le garage, la boutique, et la liste de pièces.

**Les pièces doivent toucher la vraie physique.** C'est le point important. La
simulation est un modèle bicyclette avec de vrais angles de dérive, et ses
paramètres sont déjà nommés comme des pièces :

| Pièce | Paramètre de `physics.js` |
|---|---|
| Moteur, turbo | couple, `redline` |
| Boîte | rapports, finale |
| Pneus | `grip`, `stiffnessPerN` |
| Suspension, barres | `rearGripBias`, transfert de charge |
| Freins | couple de freinage |
| Allègement | `mass`, `izz` |
| Direction | `maxSteer` |

Donc aucune statistique inventée : on achète une pièce, un nombre change dans
le modèle, et la voiture se comporte différemment pour de vraies raisons. C'est
exactement ce que font les jeux qui tiennent — et c'est ce qui rend le réglage
intéressant plutôt que décoratif.

**L'esthétique, séparément.** Peinture (teinte, plus un fini mat / métallisé /
nacré, qui n'est que `roughness`, `metalness` et `clearcoat`), jantes, hauteur
de caisse, aileron, vitres teintées, plaque. La voiture générée prend déjà une
couleur en paramètre ; le reste est du même ordre.

**Le vrai obstacle : le poids des modèles.** Une belle voiture fait 2 à 5 Mo
après Draco et WebP (`tools/prepare-model.mjs` fait déjà cette compression).
Dix voitures, c'est 30 Mo, et le jeu entier tient aujourd'hui sous les 50.
Trois façons de s'en sortir :

1. ne charger que la voiture possédée, et le garage à la demande ;
2. les pièces visibles en nœuds glTF séparés greffés sur une caisse commune,
   plutôt qu'un modèle complet par combinaison ;
3. commencer avec trois voitures bien faites plutôt que dix moyennes.

**Le vrai travail n'est pas l'interface, c'est l'équilibrage.** Une boutique
sans économie réglée devient soit un mur, soit un distributeur. Il faut décider
combien vaut un kilomètre propre, combien coûte un premier turbo, et à quel
moment le joueur cesse de progresser. Compter ça, pas la fenêtre du garage.

**L'ordre suggéré.** Garage et peinture d'abord — visible immédiatement, aucun
équilibrage. Puis les pièces mécaniques sur la voiture de départ. La boutique
de véhicules en dernier, quand on saura ce que vaut un point.

Une nuance si on vise vraiment les gars de char : la peinture est ce qui se
montre le plus vite, mais ce n'est pas ce qui les attrape. **Le dyno et le
quart de mille les attrapent**, et les deux sont presque déjà là — la courbe
de couple est dans le modèle, le chronométrage et les fantômes aussi. Ça
pourrait être fait avant même d'avoir une deuxième voiture à vendre, et ce
serait la première chose qu'ils partageraient.

Et puisque la profondeur va dans la personnalisation plutôt que dans la
simulation, c'est là qu'il faut être généreux : beaucoup de jantes, beaucoup
de teintes et de finis, hauteur de caisse, ailerons, vitres, plaques,
autocollants, numéros. Vingt jantes coûtent moins cher à faire qu'un modèle de
turbo, et c'est ce qui remplit un fil de photos — pour lequel le mode photo
existe déjà.

---

## 3. Notre propre physique

**L'idée.** Chaque jeu de char a sa signature, et on la reconnaît en dix
secondes les yeux fermés. Forza pardonne et récupère. Gran Turismo est précis
et punitif. Need for Speed part en travers au frein. GTA flotte. Ce n'est
jamais une question de « plus ou moins réaliste » — c'est une poignée de
décisions assumées. Il nous en faut une.

Et il ne s'agit pas d'ajouter du réalisme jusqu'à ce que ce soit bon. Il s'agit
de savoir *ce qu'on veut que ça fasse*, puis d'aller chercher dans la vraie
physique de quoi le faire tenir debout.

**Où est la base actuelle.** Le modèle est honnête pour ce qu'il est : modèle
bicyclette, vrais angles de dérive, transfert de charge longitudinal, ellipse
de friction par essieu, 120 Hz découplé du rendu. Ça, c'est déjà mieux que
beaucoup de jeux web. Ce qui lui manque pour avoir une *signature* :

- **une vraie courbe de pneu.** C'est le cœur du sujet. La forme de la courbe —
  où est le pic d'adhérence, et surtout à quelle vitesse ça retombe *après* le
  pic — décide à peu près tout le ressenti. Une chute douce pardonne et se
  rattrape ; une chute raide claque et punit ;
- **la sensibilité à la charge.** Dans la vraie vie l'adhérence ne monte pas
  proportionnellement à la charge : un pneu deux fois plus chargé ne tient pas
  deux fois plus. C'est *ça* qui donne un sens au transfert de masse, au
  freinage appuyé qui fait tourner, au lever de pied qui fait pivoter ;
- **quatre roues au lieu de deux**, pour que gauche et droite existent — et
  donc le roulis, l'appui en courbe, la roue intérieure qui se déleste ;
- **le différentiel**, qui décide si l'accélération en sortie de courbe
  redresse ou fait glisser.

**Ce qu'il faut aller chercher.** La recherche à faire, nommée, pour qu'on
sache quoi lire :

| Sujet | Ce que ça donne |
|---|---|
| Formule magique de Pacejka, ou le modèle « brosse » | La forme de la courbe pic + chute |
| Taux de glissement (longitudinal) vs angle de dérive | Freinage et motricité, pas juste les virages |
| Glissement combiné / ellipse de friction | Déjà là — freiner *et* tourner |
| Sensibilité à la charge | Le transfert de masse qui compte pour de vrai |
| Répartition du couple de roulis | Le sur/sous-virage réglable par les barres |
| Couple d'auto-alignement, chasse | Le volant qui revient tout seul |
| Inertie en lacet | Pourquoi une longue voiture ne pivote pas comme une courte |

**Comment trouver le sweet spot — la partie qui compte.** On ne le trouve pas
en changeant des chiffres jusqu'à ce que ça semble correct : au bout de dix
essais on ne sait plus ce qu'on a changé, et une régression passe inaperçue.

La bonne nouvelle : **le banc d'essai existe déjà**. `tools/smoke.mjs` mesure à
chaque exécution le 0-50, le 0-100, la vitesse de pointe, la distance de
freinage, la vitesse en virage tenu, le taux de lacet et le décrochage au frein
à main. C'est littéralement un dyno et une piste d'essai automatisés qui
tournent depuis le début du projet.

La méthode :

1. **Fixer les cibles avec de vrais chiffres.** Une berline sportive ordinaire :
   0-100 autour de 6 s, freinage 100-0 autour de 36 m, un peu plus d'1 g en
   virage sur du sec. On n'invente pas, on vise.
2. **Un paramètre à la fois**, et on relit les mesures. Le test dit tout de
   suite si le freinage a doublé pendant qu'on cherchait autre chose.
3. **Une liste de scénarios de ressenti**, toujours les mêmes, à conduire à la
   main : un virage qui se resserre, une ruelle à prendre au frein à main, un
   lever de pied en pleine courbe, une bosse à 80, un départ arrêté sur du
   mouillé. C'est là qu'on juge, pas dans les chiffres.
4. **Enregistrer les réglages qui valaient quelque chose**, avec leurs mesures,
   pour pouvoir y revenir. Un fichier de presets suffit.

**Là où réel et plaisant divergent — les tweaks assumés.** C'est utile de les
écrire d'avance, parce que ce sont toujours les mêmes :

- **le pic est trop étroit dans la vraie vie.** On l'élargit : il faut pouvoir
  vivre au bord de l'adhérence, pas passer dessus par accident ;
- **la chute après le pic est trop raide.** On l'adoucit, sinon toute perte
  d'adhérence est définitive ;
- **la récupération est trop lente.** Dans la réalité, rattraper un décrochage
  demande un contre-braquage précis et immédiat. Au clavier, ce geste n'existe
  pas — donc l'adhérence doit revenir plus vite qu'en vrai ;
- **le périphérique décide.** Un clavier n'a pas d'angle : la direction est
  déjà lissée à l'entrée (`core/input.js`), et c'est une décision de physique
  autant que d'interface. Une manette et un volant méritent des réglages
  différents, pas le même ;
- **la caméra fait la moitié du ressenti.** Le champ de vision qui s'ouvre avec
  la vitesse, le retard du ressort, le décalage vers l'extérieur en glisse :
  tout ça est déjà dans `_updateCamera`, et ça change plus l'impression de
  vitesse que n'importe quel paramètre de pneu. À régler *avec* la physique,
  jamais séparément.

### La signature : plancher bas, plafond haut

**Décidé.** Pas casual à la Forza. N'importe qui doit pouvoir rouler sans
tourner en toupie, et quelqu'un de bon doit pouvoir se démarquer nettement.

Ces deux choses ont l'air de se contredire. Elles ne se contredisent pas — mais
la façon évidente d'y arriver est la mauvaise, et c'est exactement celle que
Forza a prise. **Les aides ne baissent pas le plancher, elles baissent le
plafond.** Une direction assistée qui corrige ta trajectoire rend le jeu facile
*et* rend impossible d'être meilleur que l'assistance. Un bon joueur le sent au
bout de deux virages et s'en va.

La bonne formulation :

> On ne rend pas la voiture plus facile à conduire vite.
> On rend l'erreur moins coûteuse.

Un débutant roule à 70 % de la limite, ne part jamais en tête-à-queue, et
s'amuse. Un bon joueur vit à 98 %, et ces 28 % se voient au chronomètre. Le
plancher est bas parce que se tromper ne détruit pas ta sortie ; le plafond est
haut parce que rien ne conduit à ta place.

**Ce que ça impose, concrètement :**

| Décision | Pourquoi ça sert les deux |
|---|---|
| **Pic d'adhérence large** | Le débutant ne remarque jamais qu'il l'a franchi. Le bon joueur sent exactement où il est et s'assoit dessus |
| **Chute douce après le pic** | Perdre l'arrière devient une glisse rattrapable, pas une fin de course |
| **Récupération rapide mais pas gratuite** | Tu reprends le contrôle — tu as quand même perdu deux secondes |
| **Aucune main invisible** | Zéro correction automatique de trajectoire. C'est la ligne rouge |
| **Facile en bas, exigeant à la limite** | C'est ce que font les vraies voitures. À 40 dans une rue, ça se conduit tout seul |

**Le plafond doit être fait de technique, pas de tolérance.** C'est le point que
la physique doit rendre possible, sinon il n'y a rien à maîtriser :

- **freinage dégressif** — freiner encore un peu en entrée fait tourner la
  voiture. Impossible sans sensibilité à la charge : c'est pour ça qu'elle
  est en haut de la liste de recherche ;
- **transfert de masse** — lever le pied fait pivoter, remettre les gaz
  stabilise ;
- **le choix du rapport** en sortie, avec une vraie courbe de couple ;
- **la trajectoire**, qui n'existe que parce que les rues sont vraies et
  étroites.

Un modèle sans ces quatre choses n'a pas de plafond : il n'y a rien à faire de
mieux que de tourner le volant au bon moment.

**Les aides, s'il y en a : optionnelles, visibles, et plus lentes.** Antipatinage
ou contrôle de stabilité désactivés par défaut, affichés quand ils sont actifs,
et mesurablement plus lents au chrono. Ça devient une rampe qu'on monte, pas un
plafond qu'on subit.

**Et il faut que la maîtrise se voie en chiffres.** Un plafond dont on ne peut
pas prouver qu'on l'a atteint n'existe pas. C'est là que le chrono, les
fantômes, les défis et les records de quartier — tous déjà écrits — cessent
d'être des à-côtés et deviennent la raison d'être du modèle de conduite.

**Le caractère, dans ce cadre : lourde et posée, avec un arrière qui se réveille
quand on va le chercher.** Le poids donne le plancher — une voiture lourde est
stable et prévisible pour qui ne fait rien de spécial. L'arrière disponible
donne le plafond — il est là quand tu le provoques, jamais quand tu ne l'as pas
demandé. Et ça laisse la neige et les pneus d'hiver être une vraie différence,
au lieu d'un décor par-dessus une voiture qui glisse déjà tout le temps.

**Le seul vrai risque à surveiller :** la première minute. « Jouable même si tu
n'es pas bon » se joue là, pas sur la durée. Si les trente premières secondes
sont frustrantes, personne ne découvre jamais le plafond. À tester sur
quelqu'un qui n'a jamais touché au jeu, au clavier, sans explication.

---

## La vraie fourche : procédural pour toujours, ou générer puis sculpter ?

Le débat Unity contre navigateur cache une décision plus importante, et qui
doit se prendre en premier parce que c'est elle qui choisit le moteur.

Aujourd'hui la ville est **générée à l'exécution**, à partir d'OpenStreetMap.
Conséquence directe : **personne ne peut la modifier à la main.** On ne peut pas
déplacer une intersection bizarre, poser un commerce précis, ou creuser une
piste de drag quelque part. On règle le *générateur*, pas la ville.

L'alternative est de **cuire** la ville une fois — l'exporter en scène — puis de
la sculpter à la main. On gagne le contrôle total. On perd le fait de pouvoir
régénérer : le jour où on améliore les façades ou les routes, il faut choisir
entre relancer le générateur et jeter ses retouches, ou garder ses retouches et
ne jamais bénéficier des améliorations.

**C'est une porte à sens unique, et elle l'est dans n'importe quel moteur.** Ce
n'est pas Unity qui l'ouvre — Unity rend juste le côté sculpté nettement plus
agréable, parce qu'il a l'éditeur de scène que le navigateur n'aura jamais.

Donc la question à trancher avant tout le reste :

> Est-ce que Montréal doit être **exacte et régénérable**, ou **arrangée à la
> main pour bien jouer** ?

Si c'est la première : rester sur le web, le générateur est l'atout du projet.
Si c'est la seconde : Unity devient le bon outil, et il faudrait basculer tôt
plutôt que tard.

**Un pont existe entre les deux**, et il vaut la peine d'être noté : le
générateur est de la *logique*, pas du rendu. Il pourrait exporter un quartier
en glTF — un fichier que Unity, Blender ou Godot ouvrent directement. Ça
laisserait sculpter sans rien réécrire, et ça garde les deux portes ouvertes
jusqu'à ce qu'on sache laquelle on veut.

## Unity, et pourquoi non

Question légitime : le propriétaire du projet sait se servir de Unity et ne sait
pas lire du JavaScript. Un outil qu'on maîtrise vaut mieux qu'un outil élégant
qu'on ne peut pas toucher. Alors pourquoi rester ?

**La raison qui tranche : l'iPhone.** Unity WebGL est notoirement fragile sur
Safari iOS — mémoire, pauses, plantages au chargement. Le jeu est testé sur
téléphone depuis le début et le but affiché est « ça reste dans le navigateur ».
Ça, à soi seul, suffirait.

Les autres, dans l'ordre :

- **Le poids.** Unity WebGL, c'est 20 à 40 Mo de moteur *avant* le premier
  polygone. Ici, tout le jeu, ville comprise, tient dans ce budget-là.
- **Ce qu'on jetterait.** Environ 70 % du code n'est pas du rendu : c'est le
  générateur de ville OSM — classification des routes, jonctions, marquages,
  peinture du sol, extrusion des bâtiments, atlas de façades, mobilier,
  altitude. C'est la partie qui a de la valeur, et c'est celle qu'il faudrait
  réécrire en C#. Avec elle, on réécrirait aussi tous les bugs déjà trouvés et
  corrigés : la falaise d'altitude, l'horizon qui perce, la largeur des rues,
  les marquages aux intersections.
- **L'hébergement.** GitHub Pages sert le jeu gratuitement, aujourd'hui, en
  poussant un fichier.

**Et la vraie réponse au vrai problème.** « Je ne peux pas modifier le jeu »
n'est pas un problème de moteur, c'est un problème d'accès aux réglages. C'est
exactement ce que règle l'étape 0. Après elle, changer le comportement de la
voiture veut dire bouger un curseur en roulant — ce qui est *plus* direct que
dans Unity, où il faudrait ouvrir le projet, trouver le composant et
recompiler.

**Quand il faudrait reconsidérer :** si le projet vise un jour une sortie
Steam plutôt que le navigateur. Là, Unity ou Godot redeviennent la bonne
réponse — et le générateur de ville, lui, se porte : c'est de la logique, pas
du rendu.

---

## Le reste du carnet

Rangé grossièrement du meilleur rapport effet/effort au plus lourd.

### Le son du moteur qui suit les pièces

**Presque gratuit, et énorme pour le public visé.** Le moteur audio est
synthétisé, pas échantillonné : `vehicle/audio.js` calcule la fréquence de
combustion à partir du régime et du **nombre de cylindres**, qui est
aujourd'hui une constante à 4.

En faire un paramètre de la voiture, c'est un quatre cylindres qui sonne comme
un quatre cylindres et un V8 comme un V8, sans un octet de son à charger. Le
régime maxi, déjà réglable, décale tout le reste. Une pièce d'échappement peut
ouvrir le filtre, un turbo ajouter un souffle et une décharge au lever de pied.

Rapport crédibilité/effort le plus élevé du carnet. À faire en même temps que
les pièces moteur, pas après.

### Les repères de Montréal

Une poignée de bâtiments faits à la main vaut mieux que mille génériques.
OpenStreetMap donne l'empreinte au sol et la hauteur, jamais la forme — donc
l'enseigne Farine Five Roses, le Stade olympique, le pont Jacques-Cartier, la
croix du mont Royal et l'Oratoire sortent aujourd'hui en boîtes.

Cinq ou six objets modélisés, posés à leurs vraies coordonnées, feraient plus
pour « ça ressemble à Montréal » que n'importe quelle amélioration de rendu.
Le chargement de modèles à des coordonnées existe déjà (`world/models.js`).

### Les rassemblements

**La feature du public visé.** Les gars de char se rassemblent — c'est le
rituel, plus que la course. Un stationnement en ville où des voitures sont
garées, capot ouvert, avec leur fiche : proprio, pièces posées, meilleur quart
de mille.

Et ça se fait **sans serveur**, parce que la voiture d'un joueur est déjà
sérialisable : peinture, jantes, pièces, chronos — tout tient dans une chaîne
courte, comme les fantômes tiennent déjà dans une URL. On peuple le
rassemblement avec les voitures partagées par lien, plus les siennes. Une vraie
liste synchronisée demanderait un service ; le lien, non.

### Le rejeu

Un tampon des trente dernières secondes, rejouable avec la caméra libre du mode
photo — qui existe déjà. Ce sont les clips qui circulent, pas les captures
fixes. Le fantôme enregistre déjà une trajectoire : c'est la même mécanique,
avec plus de canaux (braquage, gaz, régime, glisse).

### Les livrées et les autocollants

Un éditeur simple : formes, numéros, textes, placés sur la carrosserie. Le
résultat tient dans une chaîne compacte, donc il se partage par lien comme le
reste. Beaucoup de valeur perçue pour du travail d'interface, sans toucher au
rendu — et ça alimente les rassemblements et le mode photo.

À faire avec le garage v1, une fois la peinture en place.

### Les néons et l'éclairage

Sous-caisse, intérieur, phares teintés. La nuit est déjà complète — fenêtres
allumées, halos, projecteur — donc l'infrastructure d'émission et de lumière
existe. Purement décoratif, très demandé par ce public, et ça donne une raison
de rouler la nuit.

### Une voiture qui s'abîme

Les impacts sont déjà mesurés (`lastImpact`) et coûtent la chaîne de points.
Ils pourraient coûter de la carrosserie : trois ou quatre paliers visuels, et
une facture au garage.

**À garder cosmétique.** Des dégâts mécaniques — radiateur percé, moteur qui
casse — ramèneraient exactement la complexité qu'on a décidé d'éviter.

### Le trafic

Écarté jusqu'ici pour une bonne raison : mal fait, il transforme la ville en
obstacle. Mais l'argument pour est réel — **une ville vide n'a aucun risque**,
et le frôlement, qui rapporte déjà des points, n'a rien à frôler.

La version défendable : des voitures lentes et prévisibles qui suivent le
réseau routier, jamais agressives, avec un réglage de densité. Le graphe et les
jonctions sont déjà calculés. À ne pas tenter avant que la physique ait sa
signature — sinon on réglera la conduite contre un trafic qu'on n'a pas encore
compris.

### Le multijoueur fantôme

Pas de serveur, mais un fantôme s'encode déjà dans une URL : défier quelqu'un
tient dans un lien. Étape suivante sans serveur : un tableau des temps par
quartier, alimenté par les liens reçus. Un vrai classement mondial demande un
service — c'est le premier vrai coût d'infrastructure du projet, et il est
volontairement repoussé.

### L'île complète, puis le monde

Voir `README.md` : PMTiles pour ne plus jamais charger la ville d'un bloc, et
le planet Protomaps sur R2 pour environ deux dollars par mois. Techniquement
résolu, jamais commencé. À faire quand le jeu mérite plus grand — pas avant.

---

## 4. La distance de vue, et pourquoi le brouillard est laid

Mesuré, pas estimé. Trois choses différentes limitent la vue, et une seule
coûte cher.

| Ce qui arrête l'œil | Aujourd'hui | Coût pour le repousser |
|---|---|---|
| Brouillard (`sky.js`) | **1 250 m** ← le vrai plafond | gratuit, c'est un réglage |
| Plan *far* de la caméra | 5 200 m | gratuit |
| Relief à l'horizon | 14 km ✅ | déjà fait |
| Bâtiments détaillés | ~2,1 km (anneau de tuiles) | très cher : ~200 Ko et la géométrie complète par tuile |
| Silhouettes au loin | néant | **~5 700 triangles** pour tout l'extrait |

Sur l'extrait du Plateau, seulement **473 bâtiments sur 19 732 (2,4 %)** méritent
d'être dessinés au loin — ceux de 15 m et plus, ou de plus de 1 200 m² au sol.
Un triplex fait deux pixels de haut à quatre kilomètres ; une tour du
centre-ville est la raison pour laquelle on sait dans quelle direction on
roule. `pack-data.mjs` produit déjà ce calque : `far.json`, une boîte orientée
par bâtiment, 30 Ko. **Le générateur est écrit et testé ; le rendu ne l'est
pas.**

### Le brouillard fait faux, et c'est structurel

`THREE.Fog` est linéaire : la couleur se mélange proportionnellement à la
distance, entre `near` et `far`. L'atmosphère réelle ne fait pas ça — elle
suit une exponentielle, et surtout elle **ne masque pas tout de la même
façon** : le ciel derrière reste lumineux, les objets sombres pâlissent plus
vite que les clairs. D'où l'impression de rideau gris.

Trois remplacements possibles, du moins cher au plus juste :

1. **`FogExp2`** — une ligne à changer. La densité devient exponentielle, le
   proche reste net beaucoup plus longtemps et seul le lointain se dissout. Ça
   corrige la moitié du problème pour rien.
2. **Fondu par distance sur l'alpha plutôt que sur la couleur** — les
   silhouettes s'effacent au lieu de virer au gris. C'est ce qui donne
   l'impression de « ça continue là-bas » au lieu de « ça s'arrête ici ». Il
   faut un `onBeforeCompile` sur le matériau des silhouettes, une trentaine de
   lignes.
3. **Diffusion atmosphérique** — la couleur du brouillard varie selon l'angle
   au soleil : chaude quand on regarde vers lui, bleue à l'opposé. C'est ce qui
   fait qu'une ville au loin a l'air lointaine et pas délavée. Le plus beau, le
   plus long.

L'ordre à suivre : `FogExp2`, puis les silhouettes, puis le fondu alpha. La
diffusion en dernier, si le reste tient.

### Un réglage, pas une constante

`Court / Moyen / Loin / Très loin` → 1 250 / 2 500 / 4 500 / 7 000 m, qui pilote
à la fois la densité du brouillard et le plan *far*. Les silhouettes rendent
« loin » utile ; sans elles, repousser le brouillard ne dévoile que du relief
nu, ce qui est pire que le brouillard.

---

## 5. L'asphalte : ce qui manque vraiment

### Où on en est

Tout le sol d'une tuile — herbe, parc, eau, trottoir, bordure, asphalte — est
**peint dans un seul canvas** qui devient la texture de la tuile (`ground.js`).
C'est ce qui donne des jonctions parfaites sans z-fighting ni couture : il n'y
a qu'une seule surface. L'asphalte a donc aujourd'hui une couleur (`#4b4b50`),
une carte de rugosité peinte, et un grain normal généré à `normalScale 0.22`.

Conséquence : **la route, la bordure et le trottoir sont exactement au même
niveau.** Il n'y a aucun relief nulle part. C'est ça qui fait « décalcomanie »
plutôt que « chaussée ».

### Monter l'asphalte de 1 ½ pouce ? Ce n'est pas le bon pouce

3,8 cm à cinq mètres de l'œil, à hauteur de conducteur, ça fait environ 0,4° —
sept pixels en 1080p. Visible, mais marginal.

La **bordure de trottoir fait 15 cm**, soit quatre fois plus, et c'est elle que
l'œil lit comme « la route est une dalle ». Et dans la réalité l'asphalte est
le point *bas* : c'est le trottoir qui est monté, pas la chaussée. Donc la
bonne question n'est pas « comment monter l'asphalte » mais **« comment
descendre la chaussée de 15 cm sous le trottoir »**.

### Trois façons, du bricolage au vrai

| | Méthode | Ce qu'on gagne | Ce qu'on perd | Effort |
|---|---|---|---|---|
| **A** | Marquer la bordure dans la carte normale | La lumière accroche l'arête | Aucune silhouette : à angle rasant c'est plat | ~30 min |
| **B** | Déplacer les sommets du sol | Vrai relief, aucune géométrie en plus | Une marche de 15 cm sur 20 cm demande des sommets sub-métriques le long de chaque bordure — ça se bat contre tout le design « un seul canvas » | élevé |
| **C** | **La bordure comme géométrie propre** | Vraie silhouette, vraies ombres, et la chaussée peut enfin passer 4 cm sous le trottoir | Les jonctions : il faut arrêter et arrondir les bordures aux coins | moyen |

**C est la bonne.** Les routes ont déjà une polyligne et une largeur ; on
extrude un ruban le long de chaque rive — une face verticale de 15 cm, une face
supérieure de 20 cm, soit 4 triangles par paire de segments. Sur les 941
tronçons du test, ça fait quelques milliers de triangles par tuile : rien. Et
la logique de découpe aux carrefours existe déjà, c'est celle qui coupe les
marquages à 9,5 m des jonctions.

Une fois la bordure en géométrie, le 1 ½ pouce d'asphalte devient gratuit et
cohérent : la chaussée se pose sous le dessus du trottoir au lieu d'être au
même Y.

### « De la vraie asphalte » — c'est la matière, pas un modèle 3D

Une chaussée n'est pas un modèle : c'est une surface de forme quelconque. Ce
qui la fait lire comme de l'asphalte, dans l'ordre d'importance :

1. **Les traces de roues.** Deux bandes plus sombres et plus polies là où les
   pneus passent. C'est *le* signe d'une route vraie, et c'est presque gratuit :
   deux traits dans le canvas, le long de la ligne médiane déjà calculée.
2. **Le granulat à la bonne échelle.** Des pierres de 8 à 14 mm, donc une
   normale et une rugosité qui se répètent au mètre — pas à la tuile.
3. **Les rapiéçages et les serpents de goudron.** Les tranchées rebouchées en
   rectangles plus sombres et les coulées noires sur les fissures. C'est
   exactement ce qui fait qu'une rue ressemble à Montréal et pas à une rue
   générique.
4. **Le dévers.** 2 % de pente du centre vers le caniveau. Vient gratuitement
   avec la géométrie de bordure du point C.

### Ce qui peut vraiment être un modèle 3D

Pas la chaussée — ce qui est *dessus* : plaques d'égout, grilles de caniveau,
plaques d'acier de chantier, nids-de-poule, cônes orange. Ça se pose en
instancié comme les lampadaires, aux jonctions et le long des caniveaux. Les
plaques d'égout et les cônes orange sont probablement le meilleur rapport
travail/reconnaissance de toute cette section.

### L'ordre

Traces de roues (canvas, ~1 h) → bordures en géométrie (C) → chaussée 4 cm plus
bas → rapiéçages et goudron → plaques et cônes en modèles.
