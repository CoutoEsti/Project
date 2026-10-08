# Sons moteur enregistrés

Un dossier par voiture : `voiture-1/` (Plateau), `voiture-2/` (Rosemont),
`voiture-3/` (Ville-Marie). S'il manque, la voiture garde le moteur synthétisé,
sans message. `?sons=<url>` pointe vers une autre table pour essayer.

Les pneus, le vent, le turbo et les chocs restent synthétisés : seul le
moteur est remplacé.

## Ce qu'il faut dans le dossier

Des boucles courtes (1 à 3 s) enregistrées à **régime stable**, et un
`moteur.json` qui dit à quel régime chacune a été prise :

```json
{
  "loops": [
    { "file": "ralenti.wav",  "rpm": 900,  "load": "off" },
    { "file": "2000-off.wav", "rpm": 2000, "load": "off" },
    { "file": "4000-off.wav", "rpm": 4000, "load": "off" },
    { "file": "2000-on.wav",  "rpm": 2000, "load": "on" },
    { "file": "4000-on.wav",  "rpm": 4000, "load": "on" },
    { "file": "6000-on.wav",  "rpm": 6000, "load": "on" }
  ]
}
```

- `load` : `on` = en charge (on accélère), `off` = pied levé ou au neutre,
  `both` (par défaut) = sert aux deux. Une table avec un seul genre marche
  quand même.
- `gain` (facultatif, 1 par défaut) : pour égaliser une boucle plus forte que
  les autres.
- **WAV 16 bits mono, 44,1 kHz.** Il passe partout, Safari iOS compris, et
  s'importe tel quel dans Unity et Unreal. Le MP3 ajoute un silence au début
  et à la fin : la boucle claque. Environ 170 ko par seconde, donc 1 à 2 Mo par
  voiture, chargés seulement quand on la choisit.
- Un écart de 1500 à 2000 tr/min entre deux boucles suffit. Plus serré, c'est
  plus fidèle.

`node mtl/tools/sons.mjs` vérifie chaque dossier : table lisible, fichiers
présents, et pas de clic au raccord de la boucle.

## Enregistrer un vrai char

Un téléphone suffit. Micro près de l'échappement (pas dedans), à l'abri du
vent, voiture à l'arrêt pour les boucles `off` : tenir le régime stable 5 s au
compte-tours. Pour les boucles `on`, il faut de la charge : un dynamomètre, ou
une montée en rapport long à régime tenu, sur un terrain privé. Couper ensuite
1 à 3 s au milieu de la prise, sur un passage par zéro (Audacity :
*Sélection → Aux passages par zéro*), puis exporter en WAV 16 bits mono.

Les boucles gratuites sur internet sont rarement à régime stable, et vérifier
la licence avant d'en mettre une ici : le site sert les fichiers à tout le
monde, il faut donc une licence qui permet de les redistribuer (CC0 ou CC-BY
avec crédit).

## Le mixage (à refaire tel quel dans Unity ou Unreal)

Toute la logique est dans `mixWeights()` de `src/game/engine-loops.js` :

1. Séparer les boucles `on` et `off` (`both` va dans les deux).
2. Dans chaque groupe, prendre les deux boucles qui encadrent le régime
   actuel. Avec `t` = position entre les deux (0 à 1), gains
   `cos(t·π/2)` et `sin(t·π/2)` : puissance constante, pas de creux au milieu.
   Sous la plus basse ou au-dessus de la plus haute, elle seule joue.
3. Vitesse de lecture de chaque boucle = régime / régime enregistré, bornée
   entre 0,5 et 2.
4. Accélérateur `x` (0 à 1) : groupe `on` × `sin(x·π/2)`, groupe `off` ×
   `cos(x·π/2)`.

Toutes les boucles tournent en continu, muettes hors de leur tour : démarrer
et arrêter des sources, c'est là que ça craque. Dans Unity, c'est un
`AudioSource` en boucle par fichier, `volume` et `pitch` mis à jour à chaque
image avec ces formules.
