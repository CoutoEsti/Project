// The two settings a person changes: which part of Montréal, and at what scale.
// Defaults live in mtl/carte.json; the menu (and the URL) override them.
//
// Zones are rectangles in Montréal's street-grid frame, real metres, origin at
// Peel and Sainte-Catherine: [x0, n0, x1, n1] (x towards "east", n "north").

export const ZONES = {
  centre: {
    nom: 'Centre',
    description: 'Centre-ville, Vieux-Montréal, Vieux-Port, Plateau, mont Royal, la Ville-Marie et les îles',
    box: [-2900, -3800, 3800, 3400],
  },
  anneau: {
    nom: 'Anneau',
    description: 'Le centre, plus Décarie, la 40, Turcot et le Stade olympique',
    box: [-4700, -3800, 6900, 6900],
  },
};

export const ECHELLES = [100, 85, 70];

export const DEFAUTS = { zone: 'anneau', echelle: 100 };

/** Settings from carte.json, then the URL (?zone=…&echelle=…) on top. */
export function resolveSettings(file = {}, params = null) {
  const s = { ...DEFAUTS, ...pick(file) };
  if (params) {
    if (params.get('zone')) s.zone = params.get('zone');
    if (params.get('echelle')) s.echelle = Number(params.get('echelle'));
  }
  if (!ZONES[s.zone]) s.zone = DEFAUTS.zone;
  if (!(s.echelle >= 50 && s.echelle <= 100)) s.echelle = DEFAUTS.echelle;
  return s;
}

function pick(o) {
  const out = {};
  if (o && typeof o.zone === 'string') out.zone = o.zone;
  if (o && Number.isFinite(Number(o.echelle))) out.echelle = Number(o.echelle);
  return out;
}
