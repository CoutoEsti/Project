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

**Le public visé : les gars de char.** Pas les joueurs d'arcade. Des gens qui
ont déjà ouvert un capot, qui savent ce qu'est un downpipe, et qui savent
qu'un gros turbo ne fait pas que « plus de chevaux ».

Ça change tout, parce que ce public **détecte le faux immédiatement**. Un
curseur « +15 HP » qui ne change rien de mesurable est grillé au premier essai,
et une fois grillé le jeu est mort pour eux. Ce qui les garde, à l'inverse, est
exactement ce qui est le plus dur à truquer : des chiffres qui tiennent, et des
compromis qui se sentent au volant.

Ce qui achète la crédibilité, dans l'ordre :

1. **Des unités réelles, pas des barres.** Chevaux et lb-pi, poids en livres,
   boost en PSI, 0-100 et le quart de mille avec temps *et* vitesse de sortie.
   Pas de « performance : ▮▮▮▮▯ ».
2. **Un dyno.** La courbe de couple et de puissance en fonction du régime,
   affichée, comparable avant/après. C'est l'artefact que ce monde-là partage
   entre eux. `physics.js` a déjà une courbe de couple — elle est *dans* le
   modèle, il ne manque que le graphe.
3. **Des compromis vrais, pas des améliorations pures.** Un plus gros turbo
   monte plus haut et répond plus tard. Une finale courte gagne au 0-100 et
   perd en pointe. Une barre arrière plus raide fait sortir l'arrière. Si
   chaque pièce est strictement meilleure, il n'y a pas de réglage, juste une
   liste de courses.
4. **Des mods qui en demandent d'autres.** Le boost sans injecteurs ni
   intercooler, ça cogne et ça coupe. C'est ce qui transforme une boutique en
   projet.
5. **Le quart de mille.** Presque gratuit ici : le chrono, les portes et les
   fantômes existent déjà (`game/timetrial.js`). Un huitième et un quart de
   mille sur une vraie ligne droite de Montréal, avec l'arbre de Noël, le
   temps de réaction et le trap speed.

**Ce que la physique sait déjà faire**, et ce qu'il faudrait lui ajouter pour
que le garage soit honnête :

| Déjà dans `physics.js` | À écrire |
|---|---|
| Courbe de couple, `redline` | Modèle de turbo : inertie, seuil, lag, wastegate |
| Rapports et finale | Différentiel : ouvert / autobloquant / soudé |
| `grip`, `stiffnessPerN` | Composé de gomme et température |
| `rearGripBias`, transfert de charge | Traction : propulsion / traction / intégrale |
| `mass`, `izz` | Fiabilité : chaleur, détonation, casse |

La transmission est le plus gros morceau : aujourd'hui le modèle est une
propulsion. Une traction et une intégrale changent complètement le
comportement, et un public de gars de char verra tout de suite la différence
entre les trois. C'est probablement le premier gros chantier après le garage.

**Le côté Montréal joue aussi.** Pneus d'hiver contre pneus d'été, ça n'est pas
un détail folklorique ici — c'est la loi, et c'est une vraie différence
d'adhérence. Combiné à l'idée de neige plus haut, ça donne quelque chose
qu'aucun jeu de char ne fait sérieusement.

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
