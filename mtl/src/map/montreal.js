// What the data cannot say, placed by hand on top of the real city: the
// landmark models, where you start, the district styles, and the few bridges
// whose silhouette OpenStreetMap does not describe.
//
// Coordinates are real metres in Montréal's street-grid frame (see
// map/zones.js), before any scaling. Headings are degrees clockwise from
// Montréal north (0 = north, 90 = east) — a compass on the street grid.

// Roads built whole as a structure of their own rather than as streets.
export const BRIDGES = {
  // The main span clears the seaway by some 49 m.
  'Pont Jacques-Cartier': { cls: 'bridge', peak: 30, structure: 'jacques-cartier' },
  // The Formula 1 track: barriers and floodlights instead of sidewalks.
  'Circuit Gilles-Villeneuve': { cls: 'circuit' },
};

// Districts: the name shown when you enter, and the style its buildings take
// (see map/buildings.js STYLES). The data's own neighbourhood names are used
// too; each takes the style of the nearest entry here.
export const QUARTIERS = [
  { nom: 'Centre-ville', x: 0, n: 0, style: 'downtown' },
  { nom: 'Centre-ville', x: 700, n: -500, style: 'downtown' },
  { nom: 'Quartier des spectacles', x: 993, n: -140, style: 'downtown' },
  { nom: 'Quartier chinois', x: 1189, n: -488, style: 'downtown' },
  { nom: 'Vieux-Montréal', x: 861, n: -929, style: 'oldstone' },
  { nom: 'Vieux-Montréal', x: 1500, n: -950, style: 'oldstone' },
  { nom: 'Vieux-Port', x: 1500, n: -1350, style: 'oldstone' },
  { nom: 'Griffintown', x: -350, n: -1150, style: 'lofts' },
  { nom: 'Cité du Havre', x: 509, n: -2438, style: 'lofts' },
  { nom: 'Le Village', x: 2486, n: -192, style: 'brick' },
  { nom: 'Centre-Sud', x: 3200, n: 250, style: 'brick' },
  { nom: 'Plateau-Mont-Royal', x: 2100, n: 1500, style: 'plex' },
  { nom: 'Plateau-Mont-Royal', x: 1500, n: 2400, style: 'plex' },
  { nom: 'Mile-End', x: 1244, n: 3164, style: 'plex' },
  { nom: 'Outremont', x: 364, n: 3252, style: 'villas' },
  { nom: 'Petite-Italie', x: 1900, n: 4500, style: 'plex' },
  { nom: 'La Petite-Patrie', x: 2623, n: 4058, style: 'plex' },
  { nom: 'Villeray', x: 1889, n: 5657, style: 'walkups' },
  { nom: 'Parc-Extension', x: 462, n: 4994, style: 'walkups' },
  { nom: 'Rosemont', x: 4800, n: 3300, style: 'plex' },
  { nom: 'Hochelaga', x: 4946, n: 580, style: 'brick' },
  { nom: 'Parc olympique', x: 6300, n: 1750, style: 'suburb' },
  { nom: 'Mont Royal', x: -400, n: 1500, style: 'villas' },
  { nom: 'Côte-des-Neiges', x: -2196, n: 3295, style: 'walkups' },
  { nom: 'Westmount', x: -2369, n: 714, style: 'westmount' },
  { nom: 'Saint-Henri', x: -2625, n: -460, style: 'brick' },
  { nom: 'Petite-Bourgogne', x: -1450, n: -650, style: 'brick' },
  { nom: 'Pointe-Saint-Charles', x: -1647, n: -1828, style: 'brick' },
  { nom: 'Verdun', x: -3982, n: -2348, style: 'plex' },
  { nom: 'Échangeur Turcot', x: -4300, n: -650, style: 'industrial' },
  { nom: 'Échangeur Décarie', x: -3650, n: 6150, style: 'industrial' },
  { nom: 'Ville de Mont-Royal', x: -1524, n: 5516, style: 'villas' },
  { nom: 'Le Triangle', x: -3524, n: 5221, style: 'walkups' },
  { nom: 'Marché Central', x: -2300, n: 6700, style: 'industrial' },
  { nom: 'Chabanel', x: 700, n: 6450, style: 'industrial' },
  { nom: 'Saint-Michel', x: 4564, n: 7037, style: 'walkups' },
  { nom: 'Île Sainte-Hélène', x: 3000, n: -1800, style: 'suburb' },
  { nom: 'Île Notre-Dame', x: 2300, n: -3000, style: 'suburb' },
  { nom: 'Longueuil', x: 5500, n: -3200, style: 'suburb' },
  { nom: 'Saint-Lambert', x: 2556, n: -4200, style: 'suburb' },
];

// Landmark models (world/landmarks.js), where OpenStreetMap's footprint and
// height alone would not be recognisable. The data's own buildings under a
// model are removed. Positions from the real footprints where the data has
// them.
export const LANDMARKS = [
  { id: 'stade-olympique', name: 'Stade olympique', type: 'stadium', x: 6275, n: 1720, heading: 147 },
  { id: 'biodome', name: 'Biodôme', type: 'biodome', x: 6545, n: 1680, heading: 57 },
  { id: 'biosphere', name: 'Biosphère', type: 'biosphere', x: 2909, n: -2078, heading: 0 },
  { id: 'croix', name: 'Croix du mont Royal', type: 'cross', x: 192, n: 1360, heading: 90 },
  { id: 'chalet', name: 'Chalet du Mont-Royal', type: 'chalet', x: -270, n: 1129, heading: 180 },
  { id: 'oratoire', name: 'Oratoire Saint-Joseph', type: 'oratory', x: -2571, n: 2525, heading: 225 },
  { id: 'place-ville-marie', name: 'Place Ville Marie', type: 'pvm', x: 216, n: -214, heading: 0 },
  { id: 'centre-bell', name: 'Centre Bell', type: 'arena', x: -286, n: -554, heading: 0 },
  { id: 'basilique', name: 'Basilique Notre-Dame', type: 'basilica', x: 1017, n: -947, heading: 0 },
  { id: 'hotel-de-ville', name: 'Hôtel de ville', type: 'cityhall', x: 1521, n: -852, heading: 0 },
  { id: 'marche-bonsecours', name: 'Marché Bonsecours', type: 'bonsecours', x: 1622, n: -1050, heading: 180 },
  { id: 'tour-horloge', name: "Tour de l'Horloge", type: 'clocktower', x: 2167, n: -1214, heading: 180 },
  { id: 'grande-roue', name: 'Grande roue', type: 'wheel', x: 1611, n: -1281, heading: 90 },
  { id: 'silo-5', name: 'Silo n° 5', type: 'silo', x: 661, n: -1707, heading: 0 },
  { id: 'five-roses', name: 'Farine Five Roses', type: 'fiveroses', x: 168, n: -1383, heading: 0 },
  { id: 'habitat-67', name: 'Habitat 67', type: 'habitat', x: 1073, n: -2052, heading: 30 },
  { id: 'casino', name: 'Casino de Montréal', type: 'casino', x: 2319, n: -2934, heading: 0 },
  { id: 'la-ronde', name: 'La Ronde', type: 'coaster', x: 3558, n: -1429, heading: 0 },
  { id: 'marche-atwater', name: 'Marché Atwater', type: 'atwater', x: -2202, n: -947, heading: 0 },
  { id: 'marche-jean-talon', name: 'Marché Jean-Talon', type: 'market', x: 1767, n: 4757, heading: 180 },
];

// Where you start: on a named road, near a point, facing roughly `heading`.
// Resolved on the compiled map (the nearest sample of that road going that
// way), so they survive any zone and any scale.
export const SPAWNS = [
  { id: 'decarie', name: 'Tranchée Décarie', road: 'Autoroute Décarie', x: -3780, n: 2600, heading: 180 },
  { id: 'metropolitaine', name: 'Sur la Métropolitaine', road: 'Autoroute Métropolitaine', x: 1200, n: 5900, heading: 90 },
  { id: 'ville-marie', name: 'Tunnel Ville-Marie', road: 'Autoroute Ville-Marie', x: 300, n: -550, heading: 90 },
  { id: 'centre-ville', name: 'Rue Sainte-Catherine', road: 'Rue Sainte-Catherine Ouest', x: 0, n: 0, heading: 90 },
  { id: 'vieux-port', name: 'Rue de la Commune', road: 'Rue de la Commune Ouest', x: 900, n: -1400, heading: 90 },
  { id: 'plateau', name: 'Avenue du Mont-Royal', road: 'Avenue du Mont-Royal Est', x: 2000, n: 1950, heading: 90 },
  { id: 'camillien-houde', name: 'Voie Camillien-Houde', road: 'Voie Camillien-Houde', x: 620, n: 1960, heading: 270 },
  { id: 'jacques-cartier', name: 'Pont Jacques-Cartier', road: 'Pont Jacques-Cartier', x: 3200, n: -100, heading: 180 },
  { id: 'stade', name: 'Boulevard Pie-IX', road: 'Boulevard Pie-IX', x: 5950, n: 1300, heading: 0 },
  { id: 'circuit', name: 'Circuit Gilles-Villeneuve', road: 'Circuit Gilles-Villeneuve', x: 2300, n: -3200, heading: 180 },
];

export const SIGNS = [];

export const RACES = [];

export default { bridges: BRIDGES, landmarks: LANDMARKS, spawns: SPAWNS, signs: SIGNS, races: RACES, quartiers: QUARTIERS };
