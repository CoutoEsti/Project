# Données de carte

Ruelle sait fonctionner de trois façons, et bascule automatiquement de l'une à
l'autre :

1. **Jeu de données embarqué** (ce dossier) — instantané, hors-ligne, aucun quota.
2. **Overpass en direct** — n'importe quelle ville de la planète, mis en cache
   dans IndexedDB au fur et à mesure.
3. **Fixture générée** — une Montréal synthétique, si les deux premiers échouent.
   Le monde n'est jamais vide.

## Fournir de vraies données Montréal

```bash
curl -o hop/data/montreal.raw.json \
     https://overpass-api.de/api/interpreter \
     --data-urlencode "data@hop/data/montreal.overpassql"
```

Compter 1 à 3 minutes et 20 à 40 Mo. Pour changer de quartier, éditer la seule
ligne `[bbox:sud,ouest,nord,est]` en tête de `montreal.overpassql` — trois zones
prêtes à l'emploi y sont commentées.

Sans terminal : ouvrir [overpass-turbo.eu](https://overpass-turbo.eu), coller le
contenu de `montreal.overpassql`, lancer, puis **Exporter → données brutes
directement depuis l'API Overpass**, et enregistrer le fichier ici sous
`montreal.raw.json`.

## Compacter avant de livrer

Le JSON brut d'Overpass est verbeux. Le script de préparation supprime les
attributs inutilisés et arrondit les coordonnées à ~1 cm, ce qui divise
généralement le poids par cinq :

```bash
node hop/tools/prepare-data.mjs hop/data/montreal.raw.json hop/data/montreal.json
```

Le jeu charge `montreal.json` s'il existe. `montreal.raw.json` n'a pas besoin
d'être versionné une fois la conversion faite.

## Découper, pour aller plus grand que le quartier

Le fichier unique tient jusqu'à quelques centaines d'éléments au kilomètre
carré, puis décroche. L'extrait actuel fait **107 km² pour 10,6 Mo**, soit
0,10 Mo/km² — l'île entière donnerait une cinquantaine de mégaoctets dans un
seul fichier : un demi-million d'éléments à analyser avant même d'afficher le
menu, et un balayage linéaire de toute la liste pour chacune des trente-cinq
tuiles présentes autour de la voiture.

```bash
node hop/tools/pack-data.mjs hop/data/montreal.json hop/data/mtl
```

Le paquet contient quatre choses :

| | Contenu |
|---|---|
| `index.json` | le manifeste : zoom, bornes, et quelles tuiles existent |
| `{x}/{y}.json` | les éléments d'une tuile z15, récupérée seulement si on y roule |
| `overview.json` | les routes seules, simplifiées — ce que rasterise la carte du menu |
| `far.json` | l'horizon : une boîte orientée par bâtiment digne d'être vu de loin |

Les lignes sont classées dans les tuiles que leurs segments traversent
réellement, pas dans leur boîte englobante. Les grandes surfaces — le fleuve,
le mont Royal — sont **découpées** par tuile plutôt que recopiées entières,
sans quoi un seul anneau de plusieurs milliers de sommets pèserait plus lourd
que le reste de la ville.

`far.json` ne retient qu'un bâtiment sur quarante : 15 m de haut ou 1 200 m² au
sol. Sur le Plateau, 473 sur 19 732, soit 30 Ko et 5 700 triangles pour tout
l'horizon. **Le générateur est écrit et vérifié ; le rendu ne l'est pas
encore** — voir `IDEES.md`, section 4.

## Licence des données

Les données de carte proviennent d'OpenStreetMap, sous
[ODbL](https://www.openstreetmap.org/copyright). Toute redistribution doit
conserver l'attribution « © les contributeurs d'OpenStreetMap ».
