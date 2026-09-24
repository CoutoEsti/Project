#!/usr/bin/env python3
"""Extract real Montréal into mtl/data/, in the street-grid frame.

Sources, all open and keyless:
  - Overture Maps (roads, buildings, water, parks, trees, neighbourhoods) —
    OpenStreetMap-derived, ODbL. Read straight from its public S3 bucket.
  - Terrarium elevation tiles (AWS Open Data, Mapzen/Tilezen) for the relief.

Only needed to refresh the data; the game reads mtl/data/ and nothing else.

    python3 -m pip install pyarrow shapely numpy scipy pillow
    python3 mtl/tools/extract.py            # ~5 min the first time, cached after

Downloads are cached in mtl/.cache/ (ignored by git).

The frame is Montréal's own: x runs along the streets towards "Montréal east"
(true bearing 30.4°), n towards "Montréal north" (300.4°), origin at Peel and
Sainte-Catherine, metres. Everything the game does happens in this frame.
"""

import json
import math
import os
import struct
import sys
import time
import urllib.request
from collections import defaultdict
from urllib.parse import urlparse

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, '.cache')
OUT = os.path.join(ROOT, 'data')

RELEASE = '2026-09-23.0'
# The frame.
LAT0, LON0 = 45.5009, -73.5733
EAST = math.radians(30.4)
KX = 111320 * math.cos(math.radians(LAT0))
KY = 110574
# The region extracted, in the frame: the largest zone plus a margin. Zones
# (see src/map/zones.js) are cut from it at load time.
X0, X1, N0, N1 = -5000.0, 7200.0, -4200.0, 7200.0
RELIEF_STEP = 10.0


def to_grid(lon, lat):
    e = (lon - LON0) * KX
    nn = (lat - LAT0) * KY
    return e * math.sin(EAST) + nn * math.cos(EAST), -e * math.cos(EAST) + nn * math.sin(EAST)


def to_lonlat(x, n):
    e = x * math.sin(EAST) - n * math.cos(EAST)
    nn = x * math.cos(EAST) + n * math.sin(EAST)
    return LON0 + e / KX, LAT0 + nn / KY


def region_lonlat():
    pts = [to_lonlat(x, n) for x in (X0, X1) for n in (N0, N1)]
    return (min(p[0] for p in pts), min(p[1] for p in pts), max(p[0] for p in pts), max(p[1] for p in pts))


def inside(x, n, pad=0.0):
    return X0 - pad <= x <= X1 + pad and N0 - pad <= n <= N1 + pad


def log(*a):
    print(*a, flush=True)


# ------------------------------------------------------------------ fetch --

THEMES = {'segment': 'transportation', 'building': 'buildings', 'building_part': 'buildings',
          'water': 'base', 'land': 'base', 'land_use': 'base', 'land_cover': 'base',
          'infrastructure': 'base', 'division': 'divisions'}


def overture(kind):
    """One Overture type over the region, cached as GeoParquet."""
    import pyarrow as pa
    import pyarrow.compute as pc
    import pyarrow.dataset as ds
    import pyarrow.fs as fs
    import pyarrow.parquet as pq
    path = os.path.join(CACHE, 'overture', f'{kind}.parquet')
    if os.path.exists(path):
        return pq.read_table(path)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    xmin, ymin, xmax, ymax = region_lonlat()
    kw = {'anonymous': True, 'region': 'us-west-2', 'request_timeout': 120, 'connect_timeout': 30}
    proxy = os.environ.get('HTTPS_PROXY') or os.environ.get('https_proxy')
    if proxy:
        p = urlparse(proxy)
        kw['proxy_options'] = {'scheme': p.scheme, 'host': p.hostname, 'port': p.port}
    if os.environ.get('AWS_CA_BUNDLE'):
        kw['tls_ca_file_path'] = os.environ['AWS_CA_BUNDLE']
    s3 = fs.S3FileSystem(**kw)
    t0 = time.time()
    d = ds.dataset(f'overturemaps-us-west-2/release/{RELEASE}/theme={THEMES[kind]}/type={kind}/',
                   filesystem=s3, format='parquet')
    f = ((pc.field('bbox', 'xmin') < xmax) & (pc.field('bbox', 'xmax') > xmin) &
         (pc.field('bbox', 'ymin') < ymax) & (pc.field('bbox', 'ymax') > ymin))
    cols = [c for c in d.schema.names if c != 'sources']
    parts = []
    for frag in d.get_fragments():
        for rg in frag.split_by_row_group(filter=f):
            t = rg.to_table(filter=f, columns=cols)
            if t.num_rows:
                parts.append(t)
    table = pa.concat_tables(parts)
    pq.write_table(table, path, compression='zstd')
    log(f'  overture {kind}: {table.num_rows} objets, {time.time() - t0:.0f} s')
    return table


def rows(kind, columns):
    t = overture(kind)
    return t.select([c for c in columns if c in t.schema.names]).to_pylist()


# ---------------------------------------------------------------- geometry --

def geom(wkb_bytes):
    from shapely import wkb
    return wkb.loads(wkb_bytes)


def ring_to_grid(coords):
    return [to_grid(lon, lat) for lon, lat in coords]


def polygons_of(g):
    from shapely.geometry import MultiPolygon, Polygon
    if isinstance(g, Polygon):
        return [g]
    if isinstance(g, MultiPolygon):
        return list(g.geoms)
    if hasattr(g, 'geoms'):
        return [p for p in g.geoms if isinstance(p, Polygon)]
    return []


def grid_polygon(p):
    """A shapely polygon in lon/lat → a shapely polygon in the frame."""
    from shapely.geometry import Polygon
    return Polygon(ring_to_grid(p.exterior.coords), [ring_to_grid(r.coords) for r in p.interiors])


def region_box():
    from shapely.geometry import box
    return box(X0, N0, X1, N1)


def flat_ring(coords, digits=1):
    out = []
    for x, n in list(coords)[:-1] if list(coords)[0] == list(coords)[-1] else coords:
        out += [round(x, digits), round(n, digits)]
    return out


def poly_json(p, simplify=0.5):
    """[[outer flat], [hole flat], ...], rings open (last point != first)."""
    p = p.simplify(simplify, preserve_topology=True)
    if p.is_empty:
        return None
    out = []
    for poly in polygons_of(p):
        rings = [flat_ring(poly.exterior.coords)] + [flat_ring(r.coords) for r in poly.interiors if len(r.coords) >= 4]
        out.append(rings)
    return out


# ------------------------------------------------------------------ relief --

def relief():
    """Elevation on a 10 m grid over the region, smoothed, in metres."""
    from PIL import Image
    from scipy.ndimage import gaussian_filter, map_coordinates
    Z = 14
    w, s, e, n = region_lonlat()

    def tx(lon):
        return (lon + 180) / 360 * 2 ** Z

    def ty(lat):
        p = math.radians(lat)
        return (1 - math.log(math.tan(p) + 1 / math.cos(p)) / math.pi) / 2 * 2 ** Z
    x0, x1, y0, y1 = int(tx(w)), int(tx(e)), int(ty(n)), int(ty(s))
    cache = os.path.join(CACHE, 'terrarium')
    os.makedirs(cache, exist_ok=True)
    mosaic = np.zeros(((y1 - y0 + 1) * 256, (x1 - x0 + 1) * 256), dtype=np.float32)
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            path = os.path.join(cache, f'{Z}_{x}_{y}.png')
            if not os.path.exists(path):
                url = f'https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{Z}/{x}/{y}.png'
                with urllib.request.urlopen(url, timeout=60) as r:
                    open(path, 'wb').write(r.read())
            a = np.asarray(Image.open(path).convert('RGB')).astype(np.float32)
            mosaic[(y - y0) * 256:(y - y0 + 1) * 256, (x - x0) * 256:(x - x0 + 1) * 256] = \
                a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256 - 32768
    xs = np.arange(X0, X1 + RELIEF_STEP / 2, RELIEF_STEP)
    ns = np.arange(N0, N1 + RELIEF_STEP / 2, RELIEF_STEP)
    GX, GN = np.meshgrid(xs, ns)
    ee = GX * math.sin(EAST) - GN * math.cos(EAST)
    nn = GX * math.cos(EAST) + GN * math.sin(EAST)
    lon = LON0 + ee / KX
    lat = LAT0 + nn / KY
    px = ((lon + 180) / 360 * 2 ** Z - x0) * 256
    lr = np.radians(lat)
    py = ((1 - np.log(np.tan(lr) + 1 / np.cos(lr)) / math.pi) / 2 * 2 ** Z - y0) * 256
    H = map_coordinates(mosaic, [py - 0.5, px - 0.5], order=1, mode='nearest')
    # The source is ~30 m data quantised to the metre: terraces a car would
    # feel. A 20 m blur turns them into slopes.
    return gaussian_filter(H, 2.0).astype(np.float32), xs, ns


def sample(H, x, n):
    i = (n - N0) / RELIEF_STEP
    j = (x - X0) / RELIEF_STEP
    i0 = min(max(int(math.floor(i)), 0), H.shape[0] - 2)
    j0 = min(max(int(math.floor(j)), 0), H.shape[1] - 2)
    u, v = min(max(j - j0, 0), 1), min(max(i - i0, 0), 1)
    return (H[i0, j0] * (1 - u) * (1 - v) + H[i0, j0 + 1] * u * (1 - v) +
            H[i0 + 1, j0] * (1 - u) * v + H[i0 + 1, j0 + 1] * u * v)


# ------------------------------------------------------------------- roads --

ROAD_CLASSES = {'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential',
                'unclassified', 'living_street', 'service', 'pedestrian'}
FLAG_BITS = {'is_bridge': 1, 'is_tunnel': 2, 'is_covered': 2}


def ranges(rules, key):
    """[(a, b, value)] over [0, 1] from Overture's `between` rules."""
    out = []
    for r in rules or []:
        b = r.get('between') or [0.0, 1.0]
        out.append((b[0], b[1], r.get(key)))
    return out


def oneway_of(restrictions):
    """+1: one way along the geometry, -1: against it, 0: both ways."""
    for a in restrictions or []:
        w = a.get('when') or {}
        if a.get('access_type') != 'denied' or a.get('between'):
            continue
        if w.get('using') or w.get('during') or w.get('vehicle'):
            continue
        mode = w.get('mode')
        if mode and 'motor_vehicle' not in mode and 'car' not in mode:
            continue
        if w.get('heading') == 'backward':
            return 1
        if w.get('heading') == 'forward':
            return -1
    return 0


def no_cars(restrictions):
    for a in restrictions or []:
        w = a.get('when') or {}
        if a.get('access_type') == 'denied' and not a.get('between') and not w.get('heading') \
                and not w.get('using') and not w.get('during') and not w.get('vehicle'):
            mode = w.get('mode')
            if not mode or 'motor_vehicle' in mode:
                return True
    return False


def route_ref(routes):
    for r in routes or []:
        net, ref = r.get('network') or '', r.get('ref')
        if ref and net.startswith('CA:QC:A'):
            return 'A' + ref
    for r in routes or []:
        net, ref = r.get('network') or '', r.get('ref')
        if ref and net.startswith('CA:QC:R'):
            return 'R' + ref
    return None


def roads():
    segs = rows('segment', ['id', 'names', 'subtype', 'class', 'subclass', 'connectors', 'road_flags',
                            'level_rules', 'access_restrictions', 'routes', 'geometry', 'width_rules'])
    pieces = []
    for s in segs:
        if s['subtype'] != 'road' or s['class'] not in ROAD_CLASSES:
            continue
        sub = s['subclass']
        if s['class'] == 'service' and sub != 'alley':
            continue
        if sub in ('sidewalk', 'crosswalk', 'driveway', 'parking_aisle', 'cycle_crossing'):
            continue
        flags_all = {v for f in (s['road_flags'] or []) for v in f['values']}
        if flags_all & {'is_under_construction', 'is_abandoned', 'is_indoor'}:
            continue
        name = (s['names'] or {}).get('primary') or ''
        if s['class'] == 'pedestrian' and not name:
            continue
        if s['class'] not in ('motorway', 'trunk', 'pedestrian') and no_cars(s['access_restrictions']):
            continue
        line = geom(s['geometry'])
        coords = list(line.coords)
        pts = ring_to_grid(coords)
        if not any(inside(x, n, 300) for x, n in pts):
            continue
        # Cumulative length, to place Overture's fractional ranges.
        cum = [0.0]
        for (ax, an), (bx, bn) in zip(pts, pts[1:]):
            cum.append(cum[-1] + math.hypot(bx - ax, bn - an))
        L = cum[-1] or 1.0
        levels = ranges(s['level_rules'], 'value')
        flags = []
        for f in s['road_flags'] or []:
            b = f.get('between') or [0.0, 1.0]
            bits = 0
            for v in f['values']:
                bits |= FLAG_BITS.get(v, 0)
            if bits:
                flags.append((b[0], b[1], bits))
        # Split the line at every range boundary so each edge carries one
        # level and one set of flags.
        cuts = sorted({c for a, b, _ in levels + flags for c in (a, b) if 0 < c < 1})
        P, D = list(pts), list(cum)
        for c in cuts:
            d = c * L
            k = next((i for i in range(1, len(D)) if D[i] > d), None)
            if k is None or abs(D[k] - d) < 0.05 or abs(D[k - 1] - d) < 0.05:
                continue
            t = (d - D[k - 1]) / (D[k] - D[k - 1])
            ax, an = P[k - 1]
            bx, bn = P[k]
            P.insert(k, (ax + (bx - ax) * t, an + (bn - an) * t))
            D.insert(k, d)
        lv, fl = [], []
        for i in range(len(P) - 1):
            mid = (D[i] + D[i + 1]) / 2 / L
            lv.append(next((v for a, b, v in levels if a <= mid <= b), 0) or 0)
            bits = 0
            for a, b, v in flags:
                if a <= mid <= b:
                    bits |= v
            fl.append(bits)
        ends = {}
        for c in s['connectors'] or []:
            if c['at'] <= 1e-6:
                ends[0] = c['connector_id']
            elif c['at'] >= 1 - 1e-6:
                ends[1] = c['connector_id']
        ow = oneway_of(s['access_restrictions'])
        if ow < 0:
            P.reverse(); lv.reverse(); fl.reverse()
            ends = {0: ends.get(1), 1: ends.get(0)}
        cls = s['class']
        pieces.append({
            'cls': cls, 'link': sub == 'link', 'alley': sub == 'alley', 'name': name,
            'ref': route_ref(s['routes']), 'ow': 1 if ow else 0, 'pts': P, 'lv': lv, 'fl': fl,
            'a': ends.get(0), 'b': ends.get(1),
        })
    log(f'  {len(pieces)} tronçons carrossables')
    return chain(pieces)


def chain(pieces):
    """Join pieces end to end while the continuation is unambiguous: same
    class, same name, same direction rule. A carriageway runs on past its
    ramps; a street runs on through its crossings."""
    at = defaultdict(list)
    for i, p in enumerate(pieces):
        if p['a']:
            at[p['a']].append((i, 0))
        if p['b']:
            at[p['b']].append((i, 1))

    def key(p):
        return (p['cls'], p['link'], p['alley'], p['name'], p['ow'], p['ref'])

    def heading(p, end):
        # Direction leaving the connector at `end`, into the piece.
        P = p['pts']
        if end == 0:
            a, b = P[0], P[min(len(P) - 1, 1)]
        else:
            a, b = P[-1], P[max(0, len(P) - 2)]
        return math.atan2(b[0] - a[0], b[1] - a[1])

    def partner(i, end):
        """The piece continuing piece i past its `end`, and which of its ends touches."""
        p = pieces[i]
        cid = p['b'] if end == 1 else p['a']
        if not cid:
            return None
        cands = []
        for j, e in at[cid]:
            if j == i:
                continue
            q = pieces[j]
            if key(q) != key(p):
                continue
            if p['ow'] and e != (0 if end == 1 else 1):
                continue           # one-way: the next piece must start here
            cands.append((j, e))
        if len(cands) != 1:
            return None
        j, e = cands[0]
        # And the partner must see us as its only continuation too.
        back = [(k, f) for k, f in at[cid] if k != j and key(pieces[k]) == key(p)
                and (not p['ow'] or f == (1 if e == 0 else 0))]
        if len(back) != 1:
            return None
        # No hairpins: the road goes on, it does not fold back.
        h_out = heading(p, end) + math.pi
        h_in = heading(pieces[j], e)
        d = abs((h_in - h_out + math.pi) % (2 * math.pi) - math.pi)
        if d > math.radians(75):
            return None
        return j, e

    used = [False] * len(pieces)
    chains = []
    for i in range(len(pieces)):
        if used[i]:
            continue
        # Walk back to the start of the chain.
        start, start_end = i, 0
        seen = {i}
        while True:
            nx = partner(start, start_end)
            if not nx or nx[0] in seen or used[nx[0]]:
                break
            j, e = nx
            seen.add(j)
            start, start_end = j, 1 - e
        # Then forward, collecting.
        seq = []
        cur, entry = start, start_end
        while True:
            used[cur] = True
            seq.append((cur, entry))
            nx = partner(cur, 1 - entry)
            if not nx or used[nx[0]]:
                break
            cur, entry = nx
        pts, lv, fl = [], [], []
        for idx, entry in seq:
            p = pieces[idx]
            P, V, F = p['pts'], p['lv'], p['fl']
            if entry == 1:
                P, V, F = P[::-1], V[::-1], F[::-1]
            if pts:
                P = P[1:]
            pts += P
            lv += V
            fl += F
        first, last = pieces[seq[0][0]], pieces[seq[-1][0]]
        a = first['a'] if seq[0][1] == 0 else first['b']
        b = last['b'] if seq[-1][1] == 0 else last['a']
        chains.append({**{k: first[k] for k in ('cls', 'link', 'alley', 'name', 'ref', 'ow')},
                       'pts': pts, 'lv': lv, 'fl': fl, 'a': a, 'b': b})
    log(f'  {len(chains)} voies après jonction')
    return chains


def write_roads(chains):
    names, name_ix = [], {}

    def nid(s):
        if s not in name_ix:
            name_ix[s] = len(names)
            names.append(s)
        return name_ix[s]
    conn, conn_ix = [], {}

    def cid(c):
        if not c:
            return -1
        if c not in conn_ix:
            conn_ix[c] = len(conn)
            conn.append(c)
        return conn_ix[c]
    out = []
    for c in chains:
        pts = c['pts']
        if not any(inside(x, n) for x, n in pts):
            continue
        # Drop points closer than 0.5 m to the previous one (keep edges' data).
        P, V, F = [pts[0]], [], []
        for k in range(1, len(pts)):
            if math.hypot(pts[k][0] - P[-1][0], pts[k][1] - P[-1][1]) < 0.5 and k < len(pts) - 1:
                continue
            P.append(pts[k])
            V.append(c['lv'][k - 1])
            F.append(c['fl'][k - 1])
        if len(P) < 2:
            continue
        rec = {'c': c['cls'], 'n': nid(c['name']), 'p': [v for x, n in P for v in (round(x * 10), round(n * 10))],
               'a': cid(c['a']), 'b': cid(c['b'])}
        if c['link']:
            rec['k'] = 'link'
        if c['alley']:
            rec['k'] = 'alley'
        if c['ref']:
            rec['r'] = c['ref']
        if c['ow']:
            rec['o'] = 1
        if any(V):
            rec['l'] = V
        if any(F):
            rec['f'] = F
        out.append(rec)
    doc = {'names': names, 'roads': out}
    path = os.path.join(OUT, 'rues.json')
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(doc, f, ensure_ascii=False, separators=(',', ':'))
    log(f'  rues.json : {len(out)} voies, {os.path.getsize(path) / 1e6:.1f} Mo')


# --------------------------------------------------------------- buildings --

KINDS = ['', 'residential', 'commercial', 'industrial', 'religious', 'education', 'civic', 'medical',
         'transportation', 'entertainment', 'outbuilding', 'agricultural', 'military', 'service']
ROOFS = ['', 'gabled', 'hipped', 'dome', 'skillion', 'gambrel', 'mansard', 'saltbox', 'pyramidal', 'onion', 'round']


def buildings():
    from shapely.geometry import Polygon
    blds = rows('building', ['id', 'names', 'height', 'min_height', 'num_floors', 'is_underground', 'subtype',
                             'class', 'roof_shape', 'has_parts', 'geometry', 'bbox'])
    parts = rows('building_part', ['building_id', 'names', 'height', 'min_height', 'num_floors', 'roof_shape',
                                   'geometry', 'is_underground', 'min_floor'])
    with_parts = {p['building_id'] for p in parts}
    recs = []

    def add(g, height, min_h, floors, kind, roof, name, part):
        for p in polygons_of(g):
            q = Polygon(ring_to_grid(p.exterior.coords))
            if not q.is_valid:
                q = q.buffer(0)
            for q in polygons_of(q):
                if q.area < 12:
                    continue
                q = q.simplify(0.25, preserve_topology=True)
                ring = list(q.exterior.coords)[:-1]
                if len(ring) < 3:
                    continue
                cx, cn = q.centroid.x, q.centroid.y
                if not inside(cx, cn):
                    continue
                recs.append((ring, height, min_h, floors, kind, roof, name, part))

    for b in blds:
        if b['is_underground'] or b['id'] in with_parts:
            continue
        h = b['height'] or 0.0
        floors = b['num_floors'] or 0
        kind = b['subtype'] or ''
        if b['class'] in ('shed', 'garage', 'garages', 'carport', 'hut', 'kiosk', 'roof'):
            kind = 'outbuilding'
        roof = b['roof_shape'] or ''
        add(geom(b['geometry']), h, b['min_height'] or 0.0, floors, kind, roof,
            (b['names'] or {}).get('primary') or '', 0)
    for p in parts:
        if p['is_underground']:
            continue
        h = p['height'] or ((p['num_floors'] or 0) * 3.2)
        min_h = p['min_height'] or ((p['min_floor'] or 0) * 3.2)
        add(geom(p['geometry']), h, min_h, p['num_floors'] or 0, '', p['roof_shape'] or '',
            (p['names'] or {}).get('primary') or '', 1)

    # Binary, little-endian:
    #   'MTLB' u32 version u32 count
    #   per building: u16 points, i32 x, i32 n (dm), then (points - 1) × i16 dx, dn (dm),
    #                 u16 height dm, u16 min_height dm, u8 floors, u8 kind, u8 roof, u8 flags
    # Names go to batiments-noms.json: { index: name }.
    names = {}
    buf = bytearray(b'MTLB' + struct.pack('<II', 1, 0))
    count = 0
    for ring, h, min_h, floors, kind, roof, name, part in recs:
        q = [(round(x * 10), round(n * 10)) for x, n in ring]
        ok = all(abs(q[i][0] - q[i - 1][0]) < 32000 and abs(q[i][1] - q[i - 1][1]) < 32000 for i in range(1, len(q)))
        if not ok or len(q) > 65000:
            continue
        buf += struct.pack('<Hii', len(q), q[0][0], q[0][1])
        for i in range(1, len(q)):
            buf += struct.pack('<hh', q[i][0] - q[i - 1][0], q[i][1] - q[i - 1][1])
        flags = (1 if part else 0)
        buf += struct.pack('<HHBBBB', min(65535, round(h * 10)), min(65535, round(min_h * 10)),
                           min(255, int(floors)), KINDS.index(kind) if kind in KINDS else 0,
                           ROOFS.index(roof) if roof in ROOFS else 0, flags)
        if name:
            names[count] = name
        count += 1
    struct.pack_into('<I', buf, 8, count)
    path = os.path.join(OUT, 'batiments.bin')
    open(path, 'wb').write(buf)
    with open(os.path.join(OUT, 'batiments-noms.json'), 'w', encoding='utf-8') as f:
        json.dump(names, f, ensure_ascii=False, separators=(',', ':'))
    log(f'  batiments.bin : {count} bâtiments ({len(names)} nommés), {len(buf) / 1e6:.1f} Mo')


# ---------------------------------------------------------------- surfaces --

def surfaces(H):
    from shapely.geometry import Polygon
    from shapely.ops import unary_union
    box = region_box()
    out = {'eau': [], 'verdure': [], 'sol': []}

    # Water: the river, the canal, the lakes and ponds. Each body keeps its
    # own level, read from the relief along its shore.
    water = rows('water', ['subtype', 'class', 'names', 'geometry'])
    bodies = []
    for w in water:
        if w['subtype'] in ('human_made', 'physical', 'spring') or w['class'] in ('swimming_pool', 'fountain'):
            continue
        g = geom(w['geometry'])
        for p in polygons_of(g):
            q = grid_polygon(p).intersection(box)
            if q.is_empty or q.area < 200:
                continue
            bodies.append(((w['names'] or {}).get('primary') or '', w['class'], q))
    for name, cls, q in bodies:
        shore = []
        for poly in polygons_of(q):
            for x, n in list(poly.exterior.coords)[::4]:
                if inside(x, n, -5):
                    shore.append(sample(H, x, n))
        level = float(np.percentile(shore, 10)) if shore else 6.0
        pj = poly_json(q, 1.0)
        if pj:
            out['eau'].append({'nom': name, 'type': cls, 'niveau': round(level, 1), 'poly': pj})

    # Green: parks, cemeteries, golf, lawns, pitches, the mountain's woods.
    green_use = {('park', 'park'): 'parc', ('park', 'dog_park'): 'parc', ('cemetery', 'cemetery'): 'cimetiere',
                 ('golf', 'golf_course'): 'golf', ('golf', 'fairway'): 'golf', ('golf', 'green'): 'golf',
                 ('managed', 'grass'): 'gazon', ('recreation', 'pitch'): 'terrain',
                 ('recreation', 'recreation_ground'): 'parc', ('protected', 'nature_reserve'): 'foret',
                 ('agriculture', 'meadow'): 'gazon', ('horticulture', 'garden'): 'parc'}
    other_use = {('transportation', 'railway'): 'voies', ('developed', 'industrial'): 'industriel',
                 ('pedestrian', 'plaza'): 'place', ('pedestrian', 'pedestrian'): 'place',
                 ('recreation', 'stadium'): 'place', ('developed', 'works'): 'industriel'}
    for r in rows('land_use', ['subtype', 'class', 'names', 'geometry']):
        k = (r['subtype'], r['class'])
        kind = green_use.get(k) or other_use.get(k)
        if not kind:
            continue
        for p in polygons_of(geom(r['geometry'])):
            q = grid_polygon(p).intersection(box)
            if q.is_empty or q.area < 150:
                continue
            pj = poly_json(q, 0.8)
            if pj:
                (out['verdure'] if k in green_use else out['sol']).append(
                    {'type': kind, 'nom': (r['names'] or {}).get('primary') or '', 'poly': pj})
    for r in rows('land', ['subtype', 'class', 'geometry']):
        if r['subtype'] not in ('forest', 'shrub', 'grass'):
            continue
        for p in polygons_of(geom(r['geometry'])):
            q = grid_polygon(p).intersection(box)
            if q.is_empty or q.area < 300:
                continue
            pj = poly_json(q, 1.0)
            if pj:
                out['verdure'].append({'type': 'foret' if r['subtype'] == 'forest' else 'gazon', 'nom': '', 'poly': pj})
    # Parking lots (infrastructure theme).
    for r in rows('infrastructure', ['subtype', 'class', 'geometry']):
        if (r['subtype'], r['class']) != ('transit', 'parking'):
            continue
        g = geom(r['geometry'])
        for p in polygons_of(g):
            q = grid_polygon(p).intersection(box)
            if q.is_empty or q.area < 150:
                continue
            pj = poly_json(q, 0.5)
            if pj:
                out['sol'].append({'type': 'stationnement', 'nom': '', 'poly': pj})
    path = os.path.join(OUT, 'surfaces.json')
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
    log(f"  surfaces.json : {len(out['eau'])} plans d'eau, {len(out['verdure'])} espaces verts, "
        f"{len(out['sol'])} autres, {os.path.getsize(path) / 1e6:.1f} Mo")
    return [(b['niveau'], b['poly']) for b in out['eau']]


def write_relief(H, bodies):
    """Int16 decimetres on the 10 m grid. Water bodies are flattened to their
    level, so a shore is a shore and not a slope into the river."""
    from matplotlib.path import Path
    H = H.copy()
    rows_, cols = H.shape
    xs = X0 + np.arange(cols) * RELIEF_STEP
    ns = N0 + np.arange(rows_) * RELIEF_STEP
    GX, GN = np.meshgrid(xs, ns)
    pts = np.column_stack([GX.ravel(), GN.ravel()])
    for level, poly in bodies:
        for rings in poly:
            outer = np.array(rings[0], dtype=np.float64).reshape(-1, 2)
            if len(outer) < 3:
                continue
            m = Path(outer).contains_points(pts).reshape(H.shape)
            for hole in rings[1:]:
                hh = np.array(hole, dtype=np.float64).reshape(-1, 2)
                if len(hh) >= 3:
                    m &= ~Path(hh).contains_points(pts).reshape(H.shape)
            H[m] = np.minimum(H[m], level - 1.5)
    head = struct.pack('<4sIffffII', b'MTLR', 1, X0, N0, RELIEF_STEP, RELIEF_STEP, cols, rows_)
    data = np.clip(np.round(H * 10), -32768, 32767).astype('<i2').tobytes()
    path = os.path.join(OUT, 'relief.bin')
    open(path, 'wb').write(head + data)
    log(f'  relief.bin : {cols} × {rows_} à {RELIEF_STEP:.0f} m, {os.path.getsize(path) / 1e6:.1f} Mo, '
        f'{H.min():.0f} à {H.max():.0f} m')


# -------------------------------------------------------------- the rest --

def trees():
    pts = []
    for r in rows('land', ['subtype', 'class', 'geometry']):
        if r['class'] != 'tree':
            continue
        g = geom(r['geometry'])
        x, n = to_grid(g.x, g.y)
        if inside(x, n):
            pts.append((round(x * 10), round(n * 10)))
    buf = bytearray(b'MTLA' + struct.pack('<II', 1, len(pts)))
    for x, n in pts:
        buf += struct.pack('<ii', x, n)
    path = os.path.join(OUT, 'arbres.bin')
    open(path, 'wb').write(buf)
    log(f'  arbres.bin : {len(pts)} arbres, {len(buf) / 1e6:.1f} Mo')


def signals():
    pts = []
    for r in rows('infrastructure', ['subtype', 'class', 'geometry']):
        if r['class'] not in ('traffic_signals', 'street_lamp'):
            continue
        g = geom(r['geometry'])
        if g.geom_type != 'Point':
            continue
        x, n = to_grid(g.x, g.y)
        if inside(x, n):
            pts.append([1 if r['class'] == 'traffic_signals' else 2, round(x, 1), round(n, 1)])
    with open(os.path.join(OUT, 'mobilier.json'), 'w') as f:
        json.dump(pts, f, separators=(',', ':'))
    log(f'  mobilier.json : {len(pts)} feux et lampadaires')


def neighbourhoods():
    out = []
    for r in rows('division', ['subtype', 'names', 'geometry']):
        if r['subtype'] not in ('neighborhood', 'macrohood', 'locality'):
            continue
        name = (r['names'] or {}).get('primary')
        g = geom(r['geometry'])
        x, n = to_grid(g.x, g.y)
        if name and inside(x, n, 500):
            out.append({'nom': name, 'type': r['subtype'], 'x': round(x), 'n': round(n)})
    with open(os.path.join(OUT, 'quartiers.json'), 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=0)
    log(f'  quartiers.json : {len(out)} noms')


def main():
    os.makedirs(OUT, exist_ok=True)
    t0 = time.time()
    log('Relief…')
    H, xs, ns = relief()
    log('Rues…')
    write_roads(roads())
    log('Bâtiments…')
    buildings()
    log('Surfaces…')
    bodies = surfaces(H)
    write_relief(H, bodies)
    log('Arbres, feux, quartiers…')
    trees()
    signals()
    neighbourhoods()
    meta = {
        'nom': 'Montréal', 'source': 'Overture Maps ' + RELEASE + ' (OpenStreetMap) et tuiles terrarium (AWS Open Data)',
        'licence': 'ODbL — © les contributeurs d’OpenStreetMap ; relief : Mapzen/Tilezen, données publiques',
        'genere': time.strftime('%Y-%m-%d'),
        'repere': {'lat': LAT0, 'lon': LON0, 'est': math.degrees(EAST), 'kx': KX, 'ky': KY},
        'region': {'x0': X0, 'x1': X1, 'n0': N0, 'n1': N1},
    }
    with open(os.path.join(OUT, 'meta.json'), 'w', encoding='utf-8') as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)
    log(f'Terminé en {time.time() - t0:.0f} s → {OUT}')


if __name__ == '__main__':
    sys.exit(main())
