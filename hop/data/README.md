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

## Licence des données

Les données de carte proviennent d'OpenStreetMap, sous
[ODbL](https://www.openstreetmap.org/copyright). Toute redistribution doit
conserver l'attribution « © les contributeurs d'OpenStreetMap ».
