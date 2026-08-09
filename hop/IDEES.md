# Idées

Le carnet. Rien ici n'est construit — c'est ce qu'on ferait ensuite, avec
assez de détail pour qu'une prochaine session puisse attaquer sans redécouvrir
le terrain.

Le classement de `README.md` (« Ce qui reste, par ordre de rendement ») reste
la liste technique. Celle-ci est la liste des idées de jeu.

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

**Notre signature, à décider.** La question à trancher avant de toucher au
code, parce que tout le reste en découle : on veut une voiture **lourde et
posée qui récompense la conduite propre**, ou **vive et joueuse qui part en
travers dès qu'on le demande** ? Les deux sont défendables. Ce qui ne l'est
pas, c'est de ne pas choisir — c'est comme ça qu'on obtient un jeu dont
personne ne se rappelle la conduite.

Vu le reste du projet — une vraie ville, des rues étroites, du relief, de la
neige — je pencherais pour **lourd et posé, avec un arrière qui se réveille
quand on va le chercher**. Ça laisse la neige et les pneus d'hiver être une
vraie différence, au lieu d'un décor par-dessus une voiture qui glisse déjà
tout le temps.

---

## Autres, en vrac

- **Une voiture qui s'abîme.** Les impacts sont déjà mesurés (`lastImpact`) et
  coûtent la chaîne de points ; ils pourraient aussi coûter de la carrosserie.
- **Le trafic**, un jour. Écarté pour l'instant, et pour une bonne raison :
  mal fait, il transforme la ville en obstacle. Le réseau routier et les
  jonctions sont pourtant déjà là.
- **Le multijoueur fantôme.** Pas de serveur, mais un fantôme s'encode déjà
  dans une URL — donc défier quelqu'un tient dans un lien.
- **L'île complète, puis le monde.** Voir `README.md` : PMTiles, et le planet
  Protomaps sur R2 pour environ deux dollars par mois.
