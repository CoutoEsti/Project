# Idées

Les idées de *jeu*, dans l'ordre où on les ferait. La liste technique — rendu,
données, performance — reste dans [`README.md`](README.md).

Le public visé : les gars de char. Customisation poussée, pas simulation poussée.

---

## L'ordre

**1. Une signature de conduite.** Lourde et posée, avec un arrière qui se
réveille seulement quand on va le chercher : se tromper ne doit pas détruire ta
sortie, mais rien ne conduit à ta place. Aucune correction automatique de
trajectoire, jamais — les aides baissent le plafond, pas le plancher.

**2. Le quart de mille.** Un huitième et un quart sur une vraie ligne droite de
Montréal, avec l'arbre de Noël, le temps de réaction et le trap speed. C'est là
que les chiffres du garage deviennent visibles, et c'est ce qui se partage.

**3. Le dyno.** La courbe de couple avant et après la pièce, sur un écran. Avec
le quart de mille, c'est ce qui attrape le public visé — bien plus vite que la
peinture.

**4. Garage v1 : peinture, jantes, hauteur.** Teinte plus fini mat, métallisé ou
nacré, une vingtaine de jantes, la caisse qu'on rabaisse. Visible tout de suite
et aucun équilibrage à faire.

**5. Les pièces mécaniques.** Moteur, turbo, admission, échappement, boîte,
pneus, suspension, freins, allègement : un nom réel, un prix, un ou deux
chiffres, un effet qu'on sent en conduisant. Beaucoup de choix, jamais de
sous-système à comprendre.

**6. Des chiffres vrais et des compromis.** Si la pièce annonce +28 HP, la
voiture gagne +28 HP et le chrono le montre — jamais de barre « perf ▮▮▮▯▯ ».
Et aucune pièce strictement meilleure : le turbo pousse en haut et mollit en
bas, la finale courte gagne le 0-100 et perd la pointe.

**7. La vraie météo de Montréal.** Il pleut dans le jeu quand il pleut dehors,
et à 19 h en janvier il y fait nuit. La température s'affiche dans le HUD, à
côté du nom du quartier.

**8. La neige.** Sol blanchi — plus sur le gazon et les toits que sur
l'asphalte, qui reste noir et mouillé au centre des voies — bancs de neige le
long des trottoirs, et beaucoup moins d'adhérence. Montréal est enneigée cinq
mois par an et le jeu ne sait pas la faire.

**9. Les pneus d'hiver.** Trois jeux à l'achat, été / quatre saisons / hiver :
monter de l'été sur la neige, ça spin, et l'hiver sur du sec chaud est un peu
moins bon. C'est la loi au Québec du 1er décembre au 15 mars — vrai *et* local,
ce qu'aucun jeu de char ne fait.

**10. Traction, propulsion, intégrale.** Aujourd'hui la voiture est une
propulsion, point, et le train moteur est la première chose qu'un gars de char
remarque. À faire avant de vendre une deuxième voiture.

**11. La boutique de véhicules.** Trois voitures bien faites plutôt que dix
moyennes, chargées à la demande. En dernier, quand on saura ce que vaut un
point.

Les étapes 7, 8 et 9 se font en un seul bloc : la neige sans les pneus n'est
qu'un décor.

---

## Le reste

Du meilleur rapport effet/effort au plus lourd.

**Le son du moteur suit les pièces.** Un quatre cylindres sonne comme un quatre
cylindres et un V8 comme un V8, l'échappement ouvre le son, le turbo ajoute un
souffle et une décharge au lever de pied. Tout est déjà synthétisé, donc rien à
charger.

**Les livrées et les autocollants.** Formes, numéros, textes posés sur la
carrosserie, encodés dans une chaîne courte qui se partage par lien. À faire
avec la peinture.

**Les néons.** Sous-caisse, intérieur, phares teintés. Purement décoratif, très
demandé par ce public, et ça donne une raison de rouler la nuit.

**Les aides optionnelles.** Antipatinage et contrôle de stabilité, désactivés
par défaut, affichés quand ils s'activent, et mesurablement plus lents au
chrono. Une rampe qu'on monte, pas un plafond qu'on subit.

**Les repères de Montréal.** L'enseigne Farine Five Roses, le Stade olympique,
le pont Jacques-Cartier, la croix du mont Royal, l'Oratoire — aujourd'hui des
boîtes, parce qu'OpenStreetMap donne l'empreinte et la hauteur, jamais la forme.
Cinq ou six modèles posés à leurs vraies coordonnées feraient plus pour « ça
ressemble à Montréal » que n'importe quelle amélioration de rendu.

**Les rassemblements.** Un stationnement où des voitures sont garées capot
ouvert, avec leur fiche : proprio, pièces posées, meilleur quart de mille. On le
peuple avec les voitures reçues par lien, donc sans serveur.

**Le rejeu.** Les trente dernières secondes rejouables avec la caméra libre du
mode photo. Ce sont les clips qui circulent, pas les captures fixes.

**Une voiture qui s'abîme.** Trois ou quatre paliers de tôle froissée, et une
facture au garage. Strictement cosmétique : pas de radiateur percé ni de moteur
qui casse.

**Le mobilier de rue.** Plaques d'égout, grilles de caniveau, nids-de-poule,
plaques d'acier de chantier, cônes orange. Meilleur rapport travail /
reconnaissance pour qu'une rue soit montréalaise plutôt que générique.

**Le multijoueur fantôme.** Un fantôme tient déjà dans une URL : défier
quelqu'un, c'est envoyer un lien. Ensuite un tableau des temps par quartier,
alimenté par les liens reçus.

**Le trafic.** Des voitures lentes et prévisibles qui suivent le réseau, jamais
agressives, avec un réglage de densité. Une ville vide n'a aucun risque et le
frôlement n'a rien à frôler — mais rien avant que la conduite ait sa signature.
