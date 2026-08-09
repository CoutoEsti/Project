# Fixtures de test

Neuf tuiles d'altitude au format terrarium, couvrant l'île de Montréal au
zoom 12. Elles rendent le test de relief hermétique : `smoke.mjs` intercepte
les requêtes vers AWS et sert ces fichiers, si bien que le test vérifie le
mont Royal sans dépendre du réseau.

Source : [Terrain Tiles sur AWS Open Data](https://registry.opendata.aws/terrain-tiles/),
dérivées de SRTM et d'autres relevés du domaine public. Voir l'inventaire des
sources et attributions du jeu de données pour le détail.
