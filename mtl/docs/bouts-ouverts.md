# Bouts de route ouverts — zone anneau, 100 %

Mesuré le 2 octobre 2026 avec `node mtl/tools/bouts.mjs --all`.

## La mesure

À chaque bout de route (hors boucles et circuit), des sondes tous les mètres
en travers de la chaussée, un mètre au-delà du bout. Une sonde est
**raccordée** si elle trouve, à 60 cm près de la hauteur du bout (une marche
que la voiture monte), une route telle que dessinée (bouts rognés, biseaux et
coins compris), une rue ou son trottoir. Sinon elle trouve **le gazon** (le
sol, à la même hauteur : pas de chute, mais plus de route) ou **le vide**
(chute ou mur). Un bout est **ouvert** dès qu'une sonde tombe dans le vide.

Pour chaque bout, le script dit aussi ce qu'OpenStreetMap raccorde à son
nœud. C'est ce qui sépare une vraie fin de route (cul-de-sac dans les
données, bord de la zone) d'un raccord que les profils de hauteur ont raté.

Le chiffre de 65 noté dans `REPRISE.md` venait d'un script jamais commité,
perdu avec la session qui l'avait écrit, et sa définition n'est pas connue.
Celui-ci le remplace : sur la même base (`746f233`), il compte **95 bouts**
(62 ouverts sur le vide, 33 sur le gazon).

## Avant, après

| | base `746f233` | après |
|---|---|---|
| bouts ouverts sur le vide | 62 | 57 |
| bouts qui finissent sur le gazon | 33 | 30 |
| **total** | **95** | **87** |
| dont fermés d'une barrière | 30 | 30 |

Huit bouts raccordés, deux améliorés sans l'être tout à fait, deux coins
voisins un peu plus ouverts (tableau plus bas). Tous sont des bretelles qui
finissent au milieu d'un tronçon de rue surélevé : la bretelle était profilée
avant la rue (une rue passe après une bretelle), donc elle ne pouvait pas s'y
poser. Elle restait au sol sous le tablier, ou en
l'air à côté. `map/real.js` (`meetLiftedStreets`) la reprofile une fois la
rue connue, et ne garde le nouveau profil que s'il atteint la rue sans
fermeture et sans dépasser 10 % de pente.

| bout | où | avant | après |
|---|---|---|---|
| r37 début | Transcanadienne, échangeur 40/Côte-de-Liesse | en l'air, 6 m au-dessus de la rue | raccordé (pente 8,8 %) |
| r131 fin | Décarie | 2 m sous la rue | raccordé |
| r894 fin | **Turcot**, sur Saint-Jacques | au sol, 11 m sous la rue | raccordé |
| r5216 début | Lucien-L'Allier | au sol, 6 m au-dessus de la rue en passage inférieur | raccordé |
| r5511 fin | Saint-Antoine Est | 2 m sous la rue | raccordé |
| r6023 début | **Jacques-Cartier rive sud**, Saint-Charles | au sol sous le pont de Saint-Charles | raccordé |
| r6095 fin | **Jacques-Cartier rive sud**, Taschereau | au sol, 3 m sous la rue | raccordé |
| r6112 début | **Jacques-Cartier rive sud** | 13 m sous la bretelle qu'il rejoint | raccordé |
| r132 début | Transcanadienne | 1,8 m sous le sol | au sol, sur le gazon (pente 10 %) |
| r6024 début | **Jacques-Cartier rive sud**, Saint-Charles | au sol, 6,8 m sous la rue | raccordé sauf un coin (17 %) |
| r5215 début | Saint-Antoine Ouest | 33 % ouvert | 50 % ouvert : sa voisine r5216 est montée et ne couvre plus son coin |
| r6113 début | Taschereau | 33 % ouvert | 50 % ouvert : même cause, avec r6112 |

`check.mjs --browser` : 23/23 avant comme après. Les avertissements de
profils restent au même niveau (12 pentes, 136 croisements au lieu de 139,
43 dégagements au lieu de 41, 11 chevauchements au lieu de 10). Les écarts de
6 m aux raccords corrigés sont devenus des écarts de 0,5 à 0,8 m, que le
contrôle de dégagement compte encore comme des croisements trop serrés.

## Les 87 bouts qui restent

### Fins légitimes (35)

**Bord de la zone, fermés d'une barrière (28).** Autoroutes et rues coupées
au contour (x = −4700 ou 6900, n = −3800 ou 7150) : r0, r14, r494, r508,
r967 début, r973, r995, r1548, r3823, r3824, r3840, r3842, r5428 (deux
bouts), r5429 (deux bouts), r493, r503, r1584, r3835, r3836, r3837, r3841,
s6020-0, s6340-1, s5391-0 (pont Victoria), s501-0, s502-0.

**Cul-de-sac dans OpenStreetMap (7).** Aucune autre voie au nœud : passerelle
du Campus MIL (s1391-0), passerelle des Nénuphars (s5421-0), passerelle du
Chenal-Le Moyne (s5447-0, deux bouts), s4076-0, s5019-0, s5163-0. Ce sont
surtout des passerelles piétonnes que les données classent comme routes.

### Coins sur le gazon, sans chute (4)

Le tronçon surélevé est un peu plus large que la rue où il se pose et un coin
dépasse sur le sol, à la même hauteur : s5321-0 (Wellington, 5 %), s5644-0
(Notre-Dame Est, 11 %), s6042-0 (La Ronde, 11 %), r132 (voir plus haut).

### Défauts de raccord restants (48)

**Tête du pont Jacques-Cartier, île Sainte-Hélène (4).** s6043-0 fin,
s6044-0 début, s6047-0 fin, s6048-0 début. Les bretelles de l'île sont à
8 m du sol ; le pont passe 30 m plus haut. Cause : `map/real.js` dessine
*une seule* parabole de la première travée sur l'eau à la dernière, donc le
sommet du pont tombe sur l'île au lieu du fleuve. Essayé : une parabole par
plan d'eau. Le pont redescend à 8 m sur l'île et les quatre bouts se
raccordent, mais une bretelle qui passe sous le tablier le croise alors au
même niveau. Sa glissière coupe la chaussée du pont et le contrôle
« pont Jacques-Cartier » percute à (3370, −1419). Retiré. Pour le refaire, il
faut décider de la hauteur du pont sur l'île : assez haut pour qu'une
bretelle passe dessous (≈ 15 m), et des bretelles qui montent jusque-là.

**Pont Jacques-Cartier, rive sud (5).** s6105-0 début (6 m sous la fin du
pont r6088), r6113 fin et s6132-0 fin (les deux bretelles se rejoignent
7,4 m au-dessus de la rue qui les prolonge), r6113 début et r6024 début
(un coin chacun). Même famille que les bouts corrigés, mais dans l'autre
sens : c'est la rue ou le pont qu'il faudrait bouger.

**Turcot (11).**
- r511 début : finit 23 m sous Saint-Jacques (s506-1), qu'il rejoint dans
  OSM. Le reprofil est refusé : trop raide.
- s506-1 (deux bouts), s517-0 début : Saint-Jacques est surélevée sur 630 m
  et finit à (−4266, 317) 17,7 m au-dessus de la rue qui la prolonge au sol.
  Le relief de la falaise est probablement trop grossier à cet endroit ; à
  vérifier avant de toucher aux profils.
- s526-0 (deux bouts), s527-0 fin : chemin Upper Lachine, finit 1,3 à 3,9 m
  au-dessus ou au-dessous de sa propre rue. Les croisements avec la 15
  (r96, r81) et les bretelles r511, r518, r557 sont déjà trop serrés d'après
  `validate.js` : la rue n'a pas la place de redescendre.
- r504 fin, r505 début, r895 début : bretelles de Tanneries. r895 finit 3 m
  sous r504, qu'il rejoint ; r505 finit 1,5 m au-dessus de Tanneries.
- r549 fin : 5 m au-dessus de la rue Addington.

**Bretelles laissées en l'air parce qu'une autoroute les croise juste avant
(9).** La règle de `map/real.js` : une bretelle ne descend pas sur sa rue si
une autoroute coupe ses 250 derniers mètres, faute de dégagement. Déjà notée
au point 6 de `REPRISE.md` : r270 (−6,4 m), r1162 (−6,2 m), r1607 (+7,6 m),
r1046 (+2,9 m), r1051 et s1053-0 (+5,7 m, Marcel-Laurin), r5381 (+9 m),
r5510 (+4,8 m), r3992 (−14,4 m, sortie de tunnel sur Saint-Antoine).

**Bretelles de Ville-Marie à René-Lévesque (3).** r3973 et r3974 finissent
6,9 m sous r3953, qu'elles rejoignent dans OSM. Le profil les a jugées
impossibles à raccorder et les a fermées d'une barrière (« Fermé ») ; r3953
reste donc ouvert.

**Échangeur 15/40 (1).** r967 fin : la 15 finit au sol au nœud de la 40,
7,7 m plus haut.

**Ponts de l'île Notre-Dame (4).** Pont de la Concorde (s5411-0 fin,
s5419-0 début) et chemin des Floralies (s5437-0, deux bouts) finissent à 6 m
au-dessus du circuit Gilles-Villeneuve, qu'ils rejoignent dans OSM. Le
circuit est profilé à part (`cls: 'circuit'`) et ne s'abaisse ni ne monte
pour eux.

**Tronçons de rue surélevés qui finissent à côté de leur rue (10).**
Lucien-L'Allier (s5184-0, 7,2 m sous la rue : sortie de passage inférieur),
Rockland (s1370-0, deux bouts, 0,8 à 0,9 m), La Gauchetière (s5162-0
+1,4 m, s5167-0 au sol), Hochelaga (s5721-0, +0,7 m), de la Montagne
(s5178-0, +0,7 m, un coin), Sherbrooke Est (s4634-0, un coin), Bridge
(s5391-1, +1 m), et le coin de la bretelle r5215 sur Saint-Antoine Ouest.

**Bretelle sans suite dans les données (1).** r5388 début : cul-de-sac dans
OSM, mais 3,4 m au-dessus du sol près de Bonaventure. Probablement une
bretelle en chantier ; à fermer d'une barrière plutôt qu'à raccorder.
