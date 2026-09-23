// The whole map, as data. Everything else — the 3D world, the plan, the glTF
// export, the Unity import — is derived from this file.
//
// Frame: metres, aligned on Montréal's street grid rather than on true north.
//   x = "Montréal east"  (towards the Olympic Stadium; true bearing ~33°)
//   n = "Montréal north" (towards Laval;              true bearing ~303°)
//   y = up, 0 = street level.
// The grid is rotated ~57° from true north; aligning on it makes the streets
// axis-aligned, which is how Montrealers read the city and how a level designer
// wants to snap it.
//
// This is a compressed, arranged Montréal: every district keeps street-level
// proportions (lane widths, block depths, building heights), but the distances
// *between* districts are cut by roughly three, the way open-world games do it.
// Relative positions come from real coordinates projected on the grid.

// ---------------------------------------------------------------- helpers --

/** A straight north–south street. */
function ns(name, x, n0, n1, width, cls = 'street', extra = {}) {
  return { name, cls, width, path: [[x, n0], [x, n1]], ...extra };
}

/** A straight east–west street. */
function ew(name, n, x0, x1, width, cls = 'street', extra = {}) {
  return { name, cls, width, path: [[x0, n], [x1, n]], ...extra };
}

/**
 * Points on a circular arc, angles in degrees (0 = +x, counter-clockwise),
 * heights interpolated linearly along the arc.
 */
function arc(cx, cn, r, a0, a1, heights, steps = 6) {
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = ((a0 + (a1 - a0) * t) * Math.PI) / 180;
    const y = Array.isArray(heights) ? heights[Math.min(heights.length - 1, i)] : heights;
    out.push([round(cx + r * Math.cos(a)), round(cn + r * Math.sin(a)), y]);
  }
  return out;
}

function round(v) { return Math.round(v * 10) / 10; }

/** Axis-aligned rectangle as a closed-by-convention ring. */
function rect(x0, n0, x1, n1) {
  return [[x0, n0], [x1, n0], [x1, n1], [x0, n1]];
}

// The Métropolitaine is a straight line with a slight tilt on the grid.
const A40 = { x0: -1550, n0: 1690, x1: 1850, n1: 1865 };
function a40n(x) {
  return A40.n0 + ((x - A40.x0) * (A40.n1 - A40.n0)) / (A40.x1 - A40.x0);
}
/** Point along the A-40 at abscissa x, offset t metres to the north. */
function a40(x, t = 0, y) {
  const p = [round(x), round(a40n(x) + t)];
  if (y !== undefined) p.push(y);
  return p;
}

// --------------------------------------------------------------- the world --

export const WORLD = { x0: -2150, x1: 2900, n0: -2000, n1: 2050 };

export const LEVELS = {
  ground: 0,
  water: -4.5,       // river and canal surface; the quays stand 4.5 m above it
  kerb: 0.15,        // sidewalks and lots sit this much above the asphalt
  clearance: 5.0,    // minimum headroom under a structure
  deck: 1.2,         // structural depth of a deck or a cover
};

// Land is everything that is not the St. Lawrence. The canal is cut out of it.
export const LAND = {
  island: [
    [-2150, 2050], [2900, 2050], [2900, -655], [2400, -665], [1800, -685],
    [1400, -700], [1150, -712], [920, -745], [860, -790],
    // Old Port piers, east to west: de l'Horloge, Jacques-Cartier,
    // King-Edward, Alexandra.
    [860, -960], [760, -960], [760, -790],
    [540, -790], [540, -905], [480, -905], [480, -790],
    [260, -790], [260, -905], [200, -905], [200, -790],
    [-40, -790], [-40, -905], [-100, -905], [-100, -790],
    [-120, -790],
    // Pointe-du-Moulin and the Cité du Havre breakwater, out to the Concorde.
    [-120, -845], [-40, -905], [150, -1010], [330, -1120], [380, -1165],
    [360, -1205], [300, -1200], [120, -1090], [-100, -965], [-250, -905],
    // Pointe-Saint-Charles and Verdun shore.
    [-500, -925], [-900, -1000], [-1400, -1080], [-2150, -1115],
  ],
  // Lachine Canal: mouth next to the Old Port, then due west to the edge.
  canal: [[-120, -845], [-80, -845], [-80, -660], [-2200, -660], [-2200, -700], [-120, -700]],
  islands: [
    {
      id: 'ile-sainte-helene', name: 'Île Sainte-Hélène',
      ring: [[560, -1180], [620, -1080], [760, -1030], [950, -1010], [1150, -1000],
        [1330, -1030], [1480, -1090], [1520, -1170], [1460, -1280], [1300, -1380],
        [1100, -1440], [850, -1460], [680, -1430], [590, -1350], [555, -1260]],
    },
    {
      id: 'ile-notre-dame', name: 'Île Notre-Dame',
      ring: [[190, -1560], [330, -1545], [600, -1540], [900, -1545], [1070, -1560],
        [1140, -1610], [1150, -1690], [1080, -1760], [1010, -1860], [880, -1915],
        [620, -1925], [380, -1905], [230, -1860], [170, -1760], [165, -1640]],
    },
  ],
};

// ------------------------------------------------------------- districts --
// Styles drive the procedural buildings; see world/buildings.js.

export const DISTRICTS = [
  { id: 'centre-ville', name: 'Centre-ville', style: 'downtown', ring: [[-700, -450], [690, -450], [690, 300], [80, 300], [80, 420], [-700, 420]] },
  { id: 'vieux-montreal', name: 'Vieux-Montréal', style: 'oldstone', ring: rect(-30, -700, 690, -450) },
  { id: 'vieux-port', name: 'Vieux-Port', style: 'port', ring: rect(-100, -960, 900, -700) },
  { id: 'griffintown', name: 'Griffintown', style: 'lofts', ring: rect(-700, -660, -30, -450) },
  { id: 'saint-henri', name: 'Saint-Henri', style: 'lofts', ring: rect(-1450, -660, -700, -450) },
  { id: 'westmount', name: 'Westmount', style: 'westmount', ring: [[-1760, -100], [-1450, -100], [-1450, -450], [-700, -450], [-700, 360], [-1760, 360]] },
  { id: 'plateau', name: 'Plateau-Mont-Royal', style: 'plex', ring: rect(80, 300, 1330, 1245) },
  { id: 'centre-sud', name: 'Centre-Sud', style: 'brick', ring: rect(690, -540, 1330, 300) },
  { id: 'port-est', name: 'Port de Montréal', style: 'yard', ring: rect(690, -720, 2900, -540) },
  { id: 'hochelaga', name: 'Hochelaga-Maisonneuve', style: 'brick', ring: [[1330, -540], [2900, -540], [2900, 350], [2100, 350], [2100, 700], [1930, 700], [1330, 300]] },
  { id: 'parc-olympique', name: 'Parc olympique', style: 'plaza', ring: rect(2100, 350, 2900, 700) },
  { id: 'jardin-botanique', name: 'Jardin botanique', style: 'park', ring: rect(2100, 700, 2900, 1140) },
  { id: 'rosemont', name: 'Rosemont', style: 'plex', ring: [[1330, 300], [1930, 700], [2100, 700], [2100, 1140], [2900, 1140], [2900, 1245], [1330, 1245]] },
  { id: 'outremont', name: 'Outremont', style: 'villas', ring: [[-1150, 1150], [80, 1150], [80, 1245], [-700, 1245], [-700, 1350], [-1150, 1350]] },
  { id: 'mile-ex', name: 'Mile-Ex', style: 'industrial', ring: [[-700, 1245], [80, 1245], a40(80), a40(-700)] },
  { id: 'petite-italie', name: 'Petite-Italie', style: 'plex', ring: [[80, 1245], [1190, 1245], a40(1190), a40(80)] },
  { id: 'villeray', name: 'Villeray', style: 'walkups', ring: [[1190, 1245], [2900, 1245], a40(2900), a40(1190)] },
  { id: 'cote-des-neiges', name: 'Côte-des-Neiges', style: 'walkups', ring: rect(-1760, 360, -1150, 1350) },
  { id: 'ndg', name: 'Notre-Dame-de-Grâce', style: 'walkups', ring: rect(-2150, -100, -1840, 1100) },
  { id: 'parc-extension', name: 'Parc-Extension', style: 'walkups', ring: [[-1760, 1350], [-700, 1350], a40(-700), a40(-1760)] },
  { id: 'ville-mont-royal', name: 'Ville Mont-Royal', style: 'industrial', ring: [[-2150, 1100], [-1760, 1100], [-1760, 2050], [-2150, 2050]] },
  { id: 'marche-central', name: 'Marché Central', style: 'bigbox', ring: [a40(-1760), a40(-150), [-150, 2050], [-1760, 2050]] },
  { id: 'chabanel', name: 'Chabanel', style: 'factory', ring: [a40(-150), a40(1100), [1100, 2050], [-150, 2050]] },
  { id: 'saint-michel', name: 'Saint-Michel', style: 'industrial', ring: [a40(1100), a40(2900), [2900, 2050], [1100, 2050]] },
  { id: 'turcot', name: 'Échangeur Turcot', style: 'yard', ring: rect(-2150, -660, -1450, -100) },
  { id: 'pointe-saint-charles', name: 'Pointe-Saint-Charles', style: 'brick', ring: rect(-2150, -1130, -250, -700) },
  { id: 'cite-du-havre', name: 'Cité du Havre', style: 'park', ring: [[-250, -700], [-120, -700], [-120, -845], [-40, -905], [150, -1010], [330, -1120], [380, -1165], [360, -1205], [300, -1200], [120, -1090], [-100, -965], [-250, -905]] },
  { id: 'ile-sainte-helene', name: 'Île Sainte-Hélène', style: 'park', ring: null },
  { id: 'ile-notre-dame', name: 'Île Notre-Dame', style: 'park', ring: null },
];

// Parks and squares inside districts: they override the district's style.
export const PARKS = [
  { name: 'Parc La Fontaine', style: 'park', ring: rect(690, 300, 900, 510) },
  { name: 'Parc Jeanne-Mance', style: 'park', ring: rect(80, 510, 200, 720) },
  { name: "Place d'Armes", style: 'plaza', ring: rect(80, -540, 200, -450) },
  { name: 'Square Dorchester', style: 'park', ring: rect(-420, -160, -280, 0) },
  { name: 'Place des Festivals', style: 'plaza', ring: rect(200, 0, 340, 145) },
  { name: 'Parc Jarry', style: 'park', ring: rect(-300, 1350, 80, 1560) },
  { name: 'Parc Maisonneuve', style: 'park', ring: rect(2100, -540, 2400, -250) },
];

// ------------------------------------------------------------ the mountain --

export const MOUNTAIN = {
  id: 'mont-royal',
  name: 'Mont-Royal',
  // Footprint: the terrain replaces the flat land inside it and fades to 0 at
  // the edge. Parc on the east, des Pins on the south, Côte-des-Neiges west.
  ring: [[-60, 355], [55, 470], [60, 700], [55, 920], [10, 1080], [-150, 1150],
    [-420, 1165], [-700, 1130], [-930, 1010], [-1080, 850], [-1130, 700],
    [-1110, 520], [-1010, 400], [-850, 355], [-600, 350], [-330, 352]],
  fade: 150,         // metres over which the relief ramps down to street level
  // Heights are compressed with the rest: the cross stands ~75 m over the
  // Plateau, the lake plateau ~50 m, so every road climbs at 10 % at most.
  summits: [
    { name: 'Colline de la Croix', x: -330, n: 860, h: 72, r: 250 },
    { name: "Colline d'Outremont", x: -660, n: 1030, h: 56, r: 210 },
    { name: 'Sommet de Westmount', x: -880, n: 600, h: 50, r: 200 },
    { name: 'Plateau du lac aux Castors', x: -560, n: 820, h: 50, r: 280 },
  ],
  lake: { name: 'Lac aux Castors', x: -690, n: 720, rx: 55, rn: 38 },
};

// ---------------------------------------------------------------- streets --
// At-grade streets are the gaps between blocks: the land is asphalt, blocks sit
// on top. So a street here has no mesh of its own, only a corridor that blocks
// are cut from, and markings. Endpoints sit on the centreline of the street
// they end on, so corridors always overlap cleanly at T-junctions.
//
// cls: 'boulevard' (median, 2-3 lanes each way), 'avenue', 'street', 'narrow'
// (old town, cobbles), 'alley' (ruelle), 'service' (highway service road),
// 'apron' (paved corridor under a structure, no markings), 'plaza'.

export const STREETS = [
  // --- Centre-ville, west to east ---
  ns('Rue Guy', -700, -660, 300, 16, 'avenue'),
  ns('Rue Crescent', -560, -310, 300, 12, 'street'),
  ns('Rue Peel', -420, -660, 300, 16, 'avenue'),
  ns('Avenue McGill College', -280, -160, 300, 26, 'boulevard'),
  ns('Boulevard Robert-Bourassa', -140, -660, 300, 20, 'avenue'),
  ns('Rue McGill', -30, -700, -160, 16, 'avenue'),
  ns('Rue Saint-François-Xavier', 80, -700, -450, 10, 'narrow'),
  ns('Rue de Bleury', 80, -450, 300, 14, 'street'),
  ns('Rue Saint-Sulpice', 200, -700, -540, 10, 'narrow'),
  ns('Rue Jeanne-Mance', 200, -310, 1140, 12, 'street'),
  ns('Boulevard Saint-Laurent', 340, -700, 2050, 16, 'avenue'),
  ns('Place Jacques-Cartier', 470, -700, -540, 22, 'plaza'),
  ns('Rue Saint-Denis', 520, -310, 2050, 16, 'avenue'),
  ns('Rue Bonsecours', 590, -700, -450, 10, 'narrow'),
  ns('Rue Saint-Hubert', 605, 0, 1650, 12, 'street'),
  ns('Rue Berri', 690, -700, 300, 16, 'avenue'),

  ew('Rue de la Commune', -700, -80, 690, 18, 'avenue'),
  ew('Rue Saint-Paul', -615, -30, 690, 9, 'narrow'),
  ew('Rue Notre-Dame Ouest', -540, -1500, -30, 16, 'avenue'),
  ew('Rue Notre-Dame', -540, -30, 690, 12, 'narrow'),
  ew('Rue Notre-Dame Est', -540, 690, 2900, 24, 'boulevard'),
  ew('Rue Saint-Jacques', -450, -1000, 690, 12, 'street'),
  ew('Rue Saint-Antoine', -310, -1450, 690, 16, 'avenue'),
  ew('Boulevard René-Lévesque', -160, -1000, 1330, 28, 'boulevard'),
  ew('Rue Sainte-Catherine', 0, -1000, 2760, 14, 'street', { oneway: true }),
  ew('Boulevard De Maisonneuve', 145, -1000, 690, 16, 'avenue'),
  ew('Rue Ontario', 145, 690, 2760, 14, 'street'),
  {
    name: 'Rue Sherbrooke', cls: 'boulevard', width: 22,
    path: [[-2150, 150], [-1450, 150], [-1100, 225], [-700, 300], [1330, 300], [1930, 700], [2900, 700]],
  },

  // --- Plateau-Mont-Royal ---
  ns('Avenue du Parc', 80, 300, 2050, 20, 'boulevard'),
  ns('Rue De Bullion', 430, 300, 1140, 10, 'street'),
  ns('Rue Christophe-Colomb', 690, 300, 2050, 12, 'street'),
  ns('Rue De Brébeuf', 790, 510, 1140, 10, 'street'),
  ns('Avenue Papineau', 900, -540, 2050, 18, 'avenue'),
  ns('Rue Fabre', 1020, 300, 1140, 10, 'street'),
  ns('Avenue De Lorimier', 1150, 300, 1245, 16, 'avenue'),
  ew('Rue Rachel', 510, 80, 1330, 14, 'street'),
  ew('Avenue du Mont-Royal', 720, 80, 1480, 16, 'avenue'),
  ew('Avenue Laurier', 930, 80, 1150, 14, 'street'),
  ew('Boulevard Saint-Joseph', 1140, 80, 2100, 24, 'boulevard'),

  // Ruelles: a lane down the middle of every long Plateau block.
  ns('Ruelle', 140, 720, 1140, 6, 'alley'),
  ...[270, 385, 475, 562, 648, 960, 1085].map((x) => ns('Ruelle', x, 300, 1140, 6, 'alley')),
  ...[740, 845].map((x) => ns('Ruelle', x, 510, 1140, 6, 'alley')),
  ...[1405, 1555, 1705, 1855, 2015].map((x) => ns('Ruelle', x, 900, 1140, 6, 'alley')),

  // --- Centre-Sud, Hochelaga-Maisonneuve, Olympic Park ---
  ns('Rue Amherst', 800, -160, 300, 12, 'street'),
  ns('Rue Frontenac', 1330, -540, 1245, 14, 'street'),
  ns("Rue D'Iberville", 1480, -540, 2050, 14, 'street'),
  ns('Rue Préfontaine', 1630, -540, 560, 12, 'street'),
  ns('Boulevard Saint-Michel', 1630, 560, 2050, 22, 'boulevard'),
  ns('Rue Joliette', 1780, -540, 1245, 12, 'street'),
  ns('Rue Aylwin', 1930, -540, 1245, 12, 'street'),
  ns('Boulevard Pie-IX', 2100, -540, 2050, 32, 'boulevard'),
  ns('Rue Letourneux', 2250, -540, 350, 12, 'street'),
  ns('Rue Desjardins', 2400, -540, 350, 12, 'street'),
  ns('Rue Bennett', 2580, -540, 350, 12, 'street'),
  ns('Rue Viau', 2760, -540, 2050, 18, 'avenue'),
  ew('Rue Hochelaga', 250, 1480, 2760, 14, 'street'),
  ew('Avenue Pierre-De Coubertin', 350, 2100, 2760, 16, 'avenue'),
  ew('Rue Masson', 900, 1330, 2100, 14, 'street'),
  ew('Boulevard Rosemont', 1245, -700, 2900, 22, 'boulevard'),

  // --- Petite-Italie, Villeray, Parc-Extension ---
  ew('Rue Jean-Talon', 1350, -1620, 2900, 20, 'boulevard'),
  ns("Boulevard de l'Acadie", -700, 1350, 2050, 24, 'boulevard'),
  ns('Avenue Querbes', -300, 1245, 1740, 12, 'street'),
  ns('Avenue Des Érables', 1190, 1245, 1800, 12, 'street'),

  // --- A-40 corridor: service roads under the Métropolitaine ---
  { name: 'Boulevard Crémazie', cls: 'service', width: 11, path: [a40(-1450, -31), a40(1630, -31)] },
  { name: 'Boulevard Métropolitain', cls: 'service', width: 11, path: [a40(-1450, 31), a40(1630, 31)] },
  { name: 'Autoroute Métropolitaine', cls: 'apron', width: 73, path: [a40(-1450), a40(1630)] },
  ns('Avenue Mountain Sights', -1450, 1350, 2050, 14, 'street'),
  ew('Rue Chabanel', 1950, -1450, 1100, 16, 'avenue'),

  // --- Décarie: service roads on both sides of the trench ---
  ns('Boulevard Décarie', -1830, 0, 1050, 11, 'service'),
  ns('Boulevard Décarie', -1770, 0, 1050, 11, 'service'),
  ns('Autoroute Décarie', -1800, 0, 1050, 50, 'apron'),
  ew('Chemin Upper-Lachine', 0, -2150, -1830, 14, 'street'),
  ew('Rue Saint-Jacques', 0, -1770, -1450, 14, 'street'),
  ew('Chemin Queen-Mary', 450, -2150, -1100, 18, 'avenue'),
  ew('Chemin de la Côte-Sainte-Catherine', 750, -2150, -1160, 16, 'avenue'),
  ew('Avenue Van Horne', 1050, -2150, -1210, 14, 'street'),
  ns('Avenue Girouard', -2000, -100, 1100, 12, 'street'),
  ns('Avenue Victoria', -1620, -100, 1350, 12, 'street'),
  ns('Avenue Westbury', -1470, 450, 1350, 12, 'street'),
  ns('Avenue Atwater', -1000, -1000, 244, 16, 'avenue'),
  ns('Avenue Greene', -850, -450, 272, 12, 'street'),
  {
    name: 'Chemin de la Côte-Sainte-Catherine', cls: 'avenue', width: 16,
    path: [[-1160, 750], [-1060, 880], [-960, 1010], [-800, 1120], [-600, 1175], [-300, 1195], [80, 1195]],
  },

  // --- Griffintown, Pointe-Saint-Charles, Cité du Havre ---
  ew('Rue Wellington', -800, -1400, -140, 14, 'street'),
  ns('Rue Charlevoix', -1250, -1080, -700, 12, 'street'),
  ns('Rue du Séminaire', -700, -1000, -660, 12, 'street'),
  {
    name: 'Avenue Pierre-Dupuy', cls: 'avenue', width: 14,
    path: [[-140, -660], [-140, -760], [-60, -880], [150, -995], [330, -1140], [360, -1170]],
  },
];

// ------------------------------------------------------------------ roads --
// Roads carry their own geometry: anything that leaves street level (trench,
// tunnel, viaduct, bridge, ramp) or follows the mountain. Control points are
// [x, n, y]; y is interpolated along the path, then smoothed into vertical
// curves (see map/profile.js). follow: 'terrain' samples the mountain instead.
//
// A dual carriageway is one ribbon: `lanes` per direction, a median barrier in
// the middle. Barriers, retaining walls, fascias, pillars and covers are not
// authored — the builder infers them from what lies on each side.

const RING = [
  // Pie-IX, climbing onto the Métropolitaine.
  [2100, 1565, 0], [2100, 1615, 0],
  ...arc(1850, 1615, 250, 0, 90, [0, 0, 0, 0, 1.5, 3.5, 5.5, 7.5, 9, 9.8, 10, 10, 10], 12).slice(1),
  // A-40, westbound, over the service roads.
  a40(1500, 0, 10), a40(1000, 0, 10), a40(500, 0, 10), a40(0, 0, 10),
  a40(-500, 0, 10), a40(-1000, 0, 10), a40(-1300, 0, 10),
  // Échangeur Décarie: the A-40 turns into the A-15 southbound.
  ...arc(-1550, 1440, 250, 90, 180, 10),
  // Down into the Décarie trench, 8 m below the street.
  [-1800, 1300, 2.6], [-1800, 1100, -8], [-1800, 800, -8],
  [-1800, 500, -8], [-1800, 250, -8], [-1800, 110, -8],
  // Out of the trench and up onto Turcot.
  [-1800, -40, 1], [-1800, -200, 10],
  ...arc(-1550, -200, 250, 180, 270, 10).slice(1),
  // A-720 Ville-Marie: down past Atwater, then the tunnel under downtown.
  [-1400, -448, 6], [-1250, -436, 1.5], [-1150, -422, -2], [-1060, -402, -6],
  [-990, -390, -8], [-880, -382, -8], [-600, -380, -8], [-300, -380, -8],
  [0, -380, -8], [300, -380, -8], [600, -380, -8], [880, -382, -8],
  // Back up, and onto Notre-Dame Est.
  [960, -398, -7], [1040, -440, -4.5], [1110, -500, -1.5], [1190, -535, 0],
  [1260, -540, 0], [1320, -540, 0],
];

export const ROADS = [
  {
    id: 'ring', name: 'La boucle', cls: 'highway', lanes: 3, width: 30, median: true,
    path: RING,
    // Names by stretch, for the HUD and the signs: each stretch starts at the
    // path point closest to `from` and runs to the next one.
    stretches: [
      { from: [2100, 1565], name: 'Boulevard Pie-IX', ref: null },
      { from: [1900, 1860], name: 'Autoroute Métropolitaine', ref: '40' },
      { from: [-1550, 1690], name: 'Échangeur Décarie', ref: '15' },
      { from: [-1800, 1380], name: 'Autoroute Décarie', ref: '15' },
      { from: [-1800, -100], name: 'Échangeur Turcot', ref: '15' },
      { from: [-1550, -450], name: 'Autoroute Ville-Marie', ref: '720' },
      { from: [-880, -382], name: 'Tunnel Ville-Marie', ref: '720' },
      { from: [880, -382], name: 'Autoroute Ville-Marie', ref: '720' },
      { from: [1190, -535], name: 'Rue Notre-Dame Est', ref: null },
    ],
    tunnel: { from: [-880, -382], to: [880, -382], name: 'Tunnel Ville-Marie' },
  },

  // --- Closed continuations: they carry the interchanges' silhouette and say
  // where the rest of the island would be. Each ends on a closure. ---
  {
    id: 'a40-ouest', name: 'Autoroute 40 Ouest', cls: 'highway', lanes: 3, width: 30, median: true,
    path: [a40(-1300, 0, 10), a40(-1550, 0, 10), [-1750, 1680, 10], [-1950, 1670, 10], [-2130, 1661, 10]],
    // Same as the A-40 Est: no median until the ring has turned into Décarie.
    medianFrom: 360,
    closed: 'end', closure: 'Vers l’Ouest-de-l’Île — fermé',
  },
  {
    id: 'a40-est', name: 'Autoroute 40 Est', cls: 'highway', lanes: 3, width: 30, median: true,
    path: [a40(1500, 0, 10), a40(1800, 0, 10), [1950, 1885, 10], [2300, 1905, 10], [2880, 1925, 10]],
    // Shares the ring's deck until the ring turns down to Pie-IX: the median
    // only starts once the two have parted, or it would cut the ring's lanes.
    medianFrom: 470,
    closed: 'end', closure: 'Vers l’A-25 — fermé',
  },
  {
    id: 'a20-ouest', name: 'Autoroute 20 Ouest', cls: 'highway', lanes: 3, width: 30, median: true,
    path: [[-1797, -240, 10], [-1815, -290, 10], [-1860, -340, 10], [-1950, -378, 11], [-2130, -398, 12]],
    medianFrom: 130,   // clear of the ring's lanes first
    closed: 'end', closure: 'Vers l’aéroport — fermé',
  },
  {
    id: 'a15-sud', name: 'Autoroute 15 Sud', cls: 'highway', lanes: 3, width: 30, median: true,
    path: [[-1700, -405, 10], [-1650, -470, 10], [-1590, -560, 12], [-1540, -700, 14], [-1480, -880, 12], [-1450, -1110, 10]],
    medianFrom: 130,   // clear of the ring's lanes first
    closed: 'end', closure: 'Vers le pont Samuel-De Champlain — fermé',
  },

  // --- Décarie trench ramps, 8 per direction pair. Offsets from the trench
  // centreline x = -1800: main lanes to ±15, ramp strip ±14.5..±20.5, service
  // road inner lane ±26.5. ---
  ...decarieRamps(),

  // --- Métropolitaine diamonds at L'Acadie and Saint-Laurent ---
  ...a40Ramps(-700, 'Boulevard de l’Acadie'),
  ...a40Ramps(340, 'Boulevard Saint-Laurent'),

  // --- Pont Jacques-Cartier: off De Lorimier, over the port and the river,
  // across Île Sainte-Hélène; closed beyond towards Longueuil. ---
  {
    id: 'pont-jacques-cartier', name: 'Pont Jacques-Cartier', cls: 'bridge', lanes: 2, width: 20, median: false,
    structure: 'jacques-cartier',
    path: [[1150, 300, 0], [1150, 270, 0], [1150, 150, 6.9], [1150, 0, 14], [1150, -300, 26.5], [1150, -540, 36],
      [1150, -720, 43], [1150, -860, 46], [1150, -1000, 44], [1160, -1150, 36],
      [1170, -1280, 29], [1176, -1360, 25], [1180, -1420, 22], [1186, -1520, 22], [1195, -1700, 22], [1200, -1950, 22]],
    closed: 'end', closure: 'Vers Longueuil — fermé',
  },
  {
    id: 'bretelle-sainte-helene', name: 'Accès Île Sainte-Hélène', cls: 'ramp', lanes: 1, width: 10, median: false,
    path: [[1183, -1465, 22], [1168, -1478, 22], [1140, -1485, 21.2], [1020, -1470, 14], [900, -1440, 6.5], [805, -1409, 0.3], [745, -1400, 0]],
  },

  // --- Islands ---
  {
    id: 'pont-concorde', name: 'Pont de la Concorde', cls: 'bridge', lanes: 2, width: 16, median: false,
    path: [[360, -1170, 0], [382, -1173, 0], [425, -1181, 2.5], [515, -1195, 2.5], [558, -1202, 0], [578, -1205, 0]],
  },
  {
    id: 'tour-de-l-isle', name: "Chemin du Tour-de-l'Isle", cls: 'road', lanes: 1, width: 12, median: false,
    path: [[575, -1205, 0], [640, -1120, 0], [780, -1065, 0], [960, -1045, 0], [1150, -1040, 0],
      [1320, -1070, 0], [1440, -1130, 0], [1440, -1230, 0], [1320, -1330, 0], [1120, -1395, 0],
      [900, -1345, 0], [740, -1400, 0], [650, -1340, 0], [600, -1260, 0], [575, -1205, 0]],
    loop: true,
  },
  {
    id: 'pont-des-iles', name: 'Pont des Îles', cls: 'bridge', lanes: 1, width: 12, median: false,
    path: [[740, -1400, 0], [739, -1420, 0], [735, -1455, 2.5], [726, -1512, 2.5], [721, -1560, 0], [720, -1582, 0]],
  },
  {
    id: 'circuit', name: 'Circuit Gilles-Villeneuve', cls: 'circuit', lanes: 2, width: 14, median: false,
    loop: true,
    path: [[300, -1830, 0], [480, -1832, 0], [650, -1832, 0], [705, -1838, 0], [745, -1862, 0],
      [790, -1875, 0], [840, -1862, 0], [900, -1832, 0], [950, -1795, 0], [965, -1745, 0],
      [985, -1700, 0], [1030, -1680, 0], [1075, -1672, 0], [1100, -1650, 0], [1098, -1620, 0],
      [1072, -1603, 0], [1000, -1596, 0], [720, -1586, 0], [500, -1582, 0], [330, -1582, 0],
      [290, -1592, 0], [268, -1612, 0], [248, -1635, 0], [236, -1690, 0], [238, -1760, 0],
      [262, -1812, 0]],
  },

  // --- Mont-Royal ---
  {
    id: 'camillien-houde', name: 'Voie Camillien-Houde', cls: 'mountain', lanes: 1, width: 13, median: false,
    follow: 'terrain', maxGrade: 0.1,
    path: [[80, 720], [30, 790], [5, 870], [-20, 950], [-60, 1030], [-150, 1085], [-280, 1095], [-420, 1040]],
  },
  {
    id: 'remembrance', name: 'Chemin Remembrance', cls: 'mountain', lanes: 1, width: 13, median: false,
    follow: 'terrain', maxGrade: 0.1,
    path: [[-420, 1040], [-520, 995], [-640, 930], [-770, 880], [-900, 820], [-1010, 760], [-1100, 700], [-1172, 640]],
  },
  {
    id: 'chemin-du-chalet', name: 'Chemin du Chalet', cls: 'mountain', lanes: 1, width: 9, median: false,
    follow: 'terrain', maxGrade: 0.1,
    path: [[-420, 1040], [-405, 955], [-392, 875], [-405, 800], [-430, 755], [-470, 735]],
  },
  {
    id: 'avenue-des-pins', name: 'Avenue des Pins', cls: 'mountain', lanes: 1, width: 14, median: false,
    follow: 'terrain', maxGrade: 0.08,
    path: [[80, 380], [-60, 395], [-200, 410], [-360, 418], [-520, 412], [-680, 395], [-790, 380]],
  },
  {
    id: 'cote-des-neiges', name: 'Chemin de la Côte-des-Neiges', cls: 'mountain', lanes: 2, width: 16, median: false,
    follow: 'terrain', maxGrade: 0.08,
    path: [[-700, 300], [-790, 380], [-900, 420], [-1010, 440], [-1100, 450], [-1165, 520], [-1172, 640],
      [-1165, 750], [-1180, 900], [-1210, 1050], [-1260, 1350]],
  },
];

function decarieRamps() {
  const X = -1800;
  // [id, name, side (+1 east / -1 west), n at the trench floor end, n at the street end]
  const specs = [
    ['decarie-n-sortie-qm', 'Sortie Queen-Mary', 1, 180, 432],
    ['decarie-n-entree-qm', 'Entrée Queen-Mary', 1, 720, 468],
    ['decarie-n-sortie-vh', 'Sortie Van Horne', 1, 780, 1032],
    ['decarie-s-entree-vh', 'Entrée Van Horne', -1, 780, 1032],
    ['decarie-s-sortie-qm', 'Sortie Queen-Mary', -1, 720, 468],
    ['decarie-s-entree-qm', 'Entrée Queen-Mary', -1, 180, 432],
  ];
  return specs.map(([id, name, side, nLow, nHigh]) => {
    const dir = Math.sign(nHigh - nLow);   // +1: the ramp climbs going north
    const at = (d) => nLow + dir * d;       // distance from the floor end
    const len = Math.abs(nHigh - nLow);
    // Peel off the outer lane at floor level, run up the side strip, and
    // swing onto the service road once at street level.
    const path = [
      [X + side * 11.5, at(0), -8],
      [X + side * 14, at(30), -8],
      [X + side * 17.5, at(60), -8],
      [X + side * 17.5, at(len - 40), 0],
      [X + side * 23, at(len - 15), 0],
      [X + side * 26.5, at(len), 0],
    ];
    // Stored in driving order: exits leave the trench, entries enter it.
    const exit = name.startsWith('Sortie');
    return {
      id, name: `${name} (Décarie)`, cls: 'ramp', lanes: 1, width: 6, median: false,
      path: exit ? path : path.slice().reverse(),
    };
  });
}

function a40Ramps(xCross, crossName) {
  // Diamond: off-ramp before the cross street, on-ramp after, both sides.
  // Eastbound runs on the south side (t < 0), westbound on the north (t > 0).
  const ramps = [];
  const mk = (id, name, pts) => ({
    id, name: `${name} ${crossName}`, cls: 'ramp', lanes: 1, width: 6.5, median: false,
    path: pts,
  });
  const c = xCross;
  // Eastbound off: leaves the deck 300 m before, lands on Crémazie.
  ramps.push(mk(`a40-e-sortie-${c}`, 'Sortie', [
    a40(c - 300, -11.5, 10), a40(c - 250, -19, 10), a40(c - 230, -19, 10),
    a40(c - 60, -19, 0), a40(c - 30, -26, 0), a40(c - 12, -28, 0)]));
  ramps.push(mk(`a40-e-entree-${c}`, 'Entrée', [
    a40(c + 12, -28, 0), a40(c + 30, -26, 0), a40(c + 60, -19, 0),
    a40(c + 230, -19, 10), a40(c + 250, -19, 10), a40(c + 300, -11.5, 10)]));
  ramps.push(mk(`a40-o-sortie-${c}`, 'Sortie', [
    a40(c + 300, 11.5, 10), a40(c + 250, 19, 10), a40(c + 230, 19, 10),
    a40(c + 60, 19, 0), a40(c + 30, 26, 0), a40(c + 12, 28, 0)]));
  ramps.push(mk(`a40-o-entree-${c}`, 'Entrée', [
    a40(c - 12, 28, 0), a40(c - 30, 26, 0), a40(c - 60, 19, 0),
    a40(c - 230, 19, 10), a40(c - 250, 19, 10), a40(c - 300, 11.5, 10)]));
  return ramps;
}

// -------------------------------------------------------------- landmarks --
// Placed by hand; each `type` has a parametric model in world/landmarks.js.
// heading: the way the front faces, in degrees clockwise from Montréal north
// (0 = north, 90 = east) — a compass on the street grid. Spawns use the same.

export const LANDMARKS = [
  { id: 'place-ville-marie', name: 'Place Ville Marie', type: 'pvm', x: -210, n: -80, heading: 0 },
  { id: '1000-gauchetiere', name: '1000 De La Gauchetière', type: 'gauchetiere', x: -210, n: -240, heading: 0 },
  { id: 'centre-bell', name: 'Centre Bell', type: 'arena', x: -490, n: -235, heading: 0 },
  { id: 'basilique', name: 'Basilique Notre-Dame', type: 'basilica', x: 140, n: -578, heading: 0 },
  { id: 'hotel-de-ville', name: 'Hôtel de ville', type: 'cityhall', x: 530, n: -495, heading: 180 },
  { id: 'marche-bonsecours', name: 'Marché Bonsecours', type: 'bonsecours', x: 533, n: -658, heading: 180 },
  { id: 'tour-horloge', name: "Tour de l'Horloge", type: 'clocktower', x: 810, n: -935, heading: 180 },
  { id: 'grande-roue', name: 'Grande roue', type: 'wheel', x: 800, n: -845, heading: 90 },
  { id: 'silo-5', name: 'Silo n° 5', type: 'silo', x: -200, n: -751, heading: 0 },
  { id: 'five-roses', name: 'Farine Five Roses', type: 'fiveroses', x: -300, n: -735, heading: 0 },
  { id: 'habitat-67', name: 'Habitat 67', type: 'habitat', x: 60, n: -1005, heading: 30 },
  { id: 'biosphere', name: 'Biosphère', type: 'biosphere', x: 800, n: -1240, heading: 0 },
  { id: 'la-ronde', name: 'La Ronde', type: 'coaster', x: 1340, n: -1190, heading: 0 },
  { id: 'casino', name: 'Casino de Montréal', type: 'casino', x: 560, n: -1640, heading: 0 },
  { id: 'mur-des-champions', name: 'Mur des champions', type: 'championswall', x: 254, n: -1819, heading: 48 },
  { id: 'stade-olympique', name: 'Stade olympique', type: 'stadium', x: 2450, n: 520, heading: 0 },
  { id: 'biodome', name: 'Biodôme', type: 'biodome', x: 2200, n: 430, heading: 0 },
  { id: 'croix', name: 'Croix du mont Royal', type: 'cross', x: -300, n: 880, heading: 90 },
  { id: 'chalet', name: 'Chalet du Mont-Royal', type: 'chalet', x: -470, n: 700, heading: 180 },
  { id: 'oratoire', name: 'Oratoire Saint-Joseph', type: 'oratory', x: -1045, n: 560, heading: 225 },
  { id: 'marche-jean-talon', name: 'Marché Jean-Talon', type: 'market', x: 430, n: 1440, heading: 180 },
  { id: 'marche-atwater', name: 'Marché Atwater', type: 'atwater', x: -1068, n: -610, heading: 0 },
];

// ------------------------------------------------------------------ signs --
// Overhead gantries in the Québec style: green panels, white text, route
// shields. `at` is a point on the host road; the gantry spans it.

export const SIGNS = [
  { road: 'ring', at: [-1800, 1380], facing: 'south', panels: [
    { ref: '15', dir: 'SUD', text: 'Décarie\nCentre-ville' },
  ] },
  { road: 'ring', at: [-1800, 60], facing: 'south', panels: [
    { ref: '20', dir: 'OUEST', text: 'Aéroport\nToronto', closed: true },
    { ref: '720', dir: 'EST', text: 'Ville-Marie\nCentre-ville' },
  ] },
  { road: 'ring', at: [-1800, 1150], facing: 'north', panels: [
    { ref: '40', dir: 'EST', text: 'Métropolitaine\nQuébec' },
  ] },
  { road: 'ring', at: [-1000, -390], facing: 'east', panels: [
    { ref: '720', dir: 'EST', text: 'Tunnel Ville-Marie\nVieux-Montréal' },
  ] },
  { road: 'ring', at: a40(0), facing: 'east', panels: [
    { ref: '40', dir: 'EST', text: 'Boul. Pie-IX\nStade olympique' },
  ] },
  { road: 'ring', at: a40(900), facing: 'west', panels: [
    { ref: '40', dir: 'OUEST', text: 'Décarie\nBoul. Saint-Laurent' },
  ] },
  { road: 'ring', at: [300, -380], facing: 'west', panels: [
    { ref: '720', dir: 'OUEST', text: 'Turcot\nDécarie' },
  ] },
];

// ----------------------------------------------------------------- spawns --

export const SPAWNS = [
  { id: 'sainte-catherine', name: 'Sainte-Catherine', x: -350, n: -3, heading: 90 },
  { id: 'decarie', name: 'Tranchée Décarie', x: -1793, n: 300, heading: 0, y: -8 },
  { id: 'metropolitaine', name: 'Sur la Métropolitaine', x: 200, n: round(a40n(200) - 7), heading: 90, y: 10 },
  { id: 'vieux-port', name: 'Vieux-Port', x: 300, n: -704, heading: 90 },
  { id: 'plateau', name: 'Avenue du Mont-Royal', x: 500, n: 716, heading: 90 },
  { id: 'camillien-houde', name: 'Pied de Camillien-Houde', x: 68, n: 736, heading: 325 },
  { id: 'stade', name: 'Stade olympique', x: 2108, n: 300, heading: 0 },
  { id: 'circuit', name: 'Circuit Gilles-Villeneuve', x: 400, n: -1830, heading: 90 },
  { id: 'tunnel', name: 'Tunnel Ville-Marie', x: -300, n: -387, heading: 90, y: -8 },
];

// ----------------------------------------------------------------- races --
// Waypoint lists for the first events. Checkpoints are street positions; the
// game draws gates at each one. Kept here because they are level design.

export const RACES = [
  {
    id: 'tour-de-la-boucle', name: 'Le tour de la boucle', kind: 'circuit', laps: 1,
    points: [[2100, 1300], a40(1000), a40(-1000), [-1800, 800], [-1700, -420],
      [0, -380], [1200, -538], [2100, 0]],
  },
  {
    id: 'tranchee', name: 'La tranchée', kind: 'sprint',
    points: [[-1793, 1300], [-1793, 900], [-1793, 500], [-1793, 150]],
  },
  {
    id: 'camillien-houde', name: 'Camillien-Houde', kind: 'sprint',
    points: [[80, 720], [-100, 830], [-80, 995], [-300, 1045], [-640, 930], [-1172, 640]],
  },
  {
    id: 'gilles-villeneuve', name: 'Circuit Gilles-Villeneuve', kind: 'circuit', laps: 3,
    points: [[480, -1832], [900, -1832], [1098, -1620], [720, -1586], [248, -1635]],
  },
  {
    id: 'quart-de-mille-notre-dame', name: 'Quart de mille — Notre-Dame Est', kind: 'drag',
    points: [[1400, -546], [1802, -546]],
  },
];

export const MAP = {
  meta: {
    name: 'MTL',
    version: 1,
    units: 'metres',
    frame: 'x = Montréal east, n = Montréal north (grid rotated ~57° from true north), y = up',
  },
  world: WORLD,
  levels: LEVELS,
  land: LAND,
  districts: DISTRICTS,
  parks: PARKS,
  mountain: MOUNTAIN,
  streets: STREETS,
  roads: ROADS,
  landmarks: LANDMARKS,
  signs: SIGNS,
  spawns: SPAWNS,
  races: RACES,
};

export default MAP;
