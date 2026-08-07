// Extraction OpenStreetMap pour Ruelle — Montréal.
//
// La zone est définie UNE seule fois, sur la ligne [bbox:...] ci-dessous,
// dans l'ordre sud, ouest, nord, est.
//
//   Plateau + Parc La Fontaine + Mile End (défaut, ~12 km²)
//     [bbox:45.510,-73.595,45.545,-73.555]
//   Centre-ville + Vieux-Montréal
//     [bbox:45.494,-73.578,45.520,-73.545]
//   Saint-Léonard
//     [bbox:45.575,-73.612,45.605,-73.575]
//
// Lancer :
//   curl -o hop/data/montreal.raw.json \
//        https://overpass-api.de/api/interpreter \
//        --data-urlencode "data@hop/data/montreal.overpassql"
//
// Compter ~1 à 3 minutes et 20 à 40 Mo. Si le serveur répond 429 ou 504,
// il est saturé : réessayer plus tard, ou remplacer overpass-api.de par
// overpass.kumi.systems ou overpass.private.coffee.

[out:json][timeout:300][bbox:45.510,-73.595,45.545,-73.555];
(
  way["highway"]["highway"!~"^(footway|path|steps|cycleway|bridleway|corridor|proposed|construction|platform|elevator|raceway|bus_guideway)$"]["area"!="yes"];
  way["building"];
  way["building:part"];
  way["leisure"~"^(park|garden|pitch|playground|golf_course|common)$"];
  way["landuse"~"^(grass|forest|meadow|cemetery|recreation_ground|village_green|farmland|industrial|railway)$"];
  way["natural"~"^(water|wood|scrub|grassland|sand|bare_rock)$"];
  way["waterway"~"^(river|canal)$"];
  way["railway"~"^(rail|light_rail|subway|tram)$"];
  way["barrier"~"^(wall|fence|hedge)$"];
  relation["leisure"~"^(park|garden)$"];
  relation["natural"="water"];
  relation["building"];
  node["highway"~"^(street_lamp|traffic_signals|stop|give_way|crossing|turning_circle)$"];
  node["natural"="tree"];
  node["amenity"~"^(bench|fountain|waste_basket|bicycle_parking)$"];
);
out geom qt;
