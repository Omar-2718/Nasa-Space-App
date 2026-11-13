"""Add radar coverage for specific 5.12 km grid cells: stream only the NISAR GCOV pixels they need,
cut them into patches, insert them into the database.

usage: add_area.py --epsg 32636 --cells 52:486,53:486 [--label name]
  cells are UTM grid indices (gx:gy, cell = [gx*5120, (gx+1)*5120] x [gy*5120, (gy+1)*5120] metres) chosen by
  the API from the patch grid, already excluding cells this computer has. Only the bounding box of the
  requested cells (plus a 40 m margin) is downloaded.
Prints one JSON line per step ({"step": ..., "pct": ...}) so the API can stream progress to the browser.
Needs a NASA Earthdata login in ~/.netrc.
"""
import argparse, json, os, sys
import numpy as np

ROOT = os.path.join(os.path.dirname(__file__), '..')
os.chdir(ROOT); sys.path.insert(0, 'pipeline')
DB_URL = os.environ.get('DATABASE_URL', 'postgresql://sand:sand@localhost:5433/beneath')
PREFERRED_DATE = '20261017'          # same date as the rest of the coverage, when available
SIZE, RES, MARGIN = 5120, 20, 40     # cell size, pixel size, crop margin (m)

import time
T0 = time.time()
def say(step, pct, **kw):
    print(json.dumps({'step': step, 'pct': pct, 't': round(time.time() - T0, 1), **kw}), flush=True)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--epsg', type=int, required=True); ap.add_argument('--cells', required=True); ap.add_argument('--label', default='')
    a = ap.parse_args()
    cells = sorted({tuple(map(int, c.split(':'))) for c in a.cells.split(',') if c})
    if not cells: say('done', 100, added=0, message='Nothing to download: this area is already covered.'); return
    if not os.path.exists(os.path.expanduser('~/.netrc')):
        say('error', 0, message='No NASA Earthdata login on this computer yet. Connect it on the first page of the app.'); sys.exit(1)

    from pyproj import Transformer
    to_ll = Transformer.from_crs(a.epsg, 4326, always_xy=True)
    gx0, gx1 = min(c[0] for c in cells), max(c[0] for c in cells); gy0, gy1 = min(c[1] for c in cells), max(c[1] for c in cells)
    clon, clat = to_ll.transform((gx0 + gx1 + 1) / 2 * SIZE, (gy0 + gy1 + 1) / 2 * SIZE)

    say('Searching NISAR archive', 5)
    import earthaccess, h5py
    earthaccess.login(strategy='netrc')
    res = [r for r in earthaccess.search_data(short_name='NISAR_L2_GCOV_PROVISIONAL_V1', point=(clon, clat))
           if 'DHDH' in r['umm']['GranuleUR']]                         # need both HH and HV
    if not res: say('error', 0, message='NISAR has no dual-polarisation data here yet.'); sys.exit(1)
    date = lambda r: r['umm']['GranuleUR'].split('_')[11][:8]
    pick = next((r for r in res if date(r) == PREFERRED_DATE), max(res, key=date))
    d = date(pick)

    say(f'Opening radar scene ({d})', 12)
    # small read blocks: the default 5 MB read-ahead makes every metadata lookup pull megabytes over slow links
    url = next(u for u in pick.data_links() if u.endswith('.h5'))
    fs = earthaccess.get_fsspec_https_session()
    f = fs.open(url, block_size=512 * 1024, cache_type='blockcache')
    g = h5py.File(f, 'r')['science/LSAR/GCOV/grids/frequencyA']
    # scene coordinates are cached locally, so later downloads from the same scene skip reading them
    meta = f"data/granules/{pick['umm']['GranuleUR']}.npz"
    if os.path.exists(meta):
        M = np.load(meta); epsg, x, y = int(M['epsg']), M['x'], M['y']
    else:
        epsg = int(g['projection'][()]); x = g['xCoordinates'][:]; y = g['yCoordinates'][:]
        os.makedirs('data/granules', exist_ok=True); np.savez(meta, epsg=epsg, x=x, y=y)
    if epsg != a.epsg:
        # this scene uses another UTM zone: re-derive the cells on its grid (patch ids carry the zone, so no clash)
        tf = Transformer.from_crs(a.epsg, epsg, always_xy=True)
        cells = sorted({tuple(int(v // SIZE) for v in tf.transform((cx + .5) * SIZE, (cy + .5) * SIZE)) for cx, cy in cells})
        have = {p['id'] for p in json.load(open('web_assets/patches/index.json'))} if os.path.exists('web_assets/patches/index.json') else set()
        cells = [c for c in cells if f'{epsg}_{c[0]}_{c[1]}' not in have]
        if not cells: say('done', 100, added=0, message='Nothing to download: this area is already covered.'); return
        gx0, gx1 = min(c[0] for c in cells), max(c[0] for c in cells); gy0, gy1 = min(c[1] for c in cells), max(c[1] for c in cells)

    # exact crop: bounding box of the requested cells + margin
    X0, X1, Y0, Y1 = gx0 * SIZE - MARGIN, (gx1 + 1) * SIZE + MARGIN, gy0 * SIZE - MARGIN, (gy1 + 1) * SIZE + MARGIN
    ix = np.where((x >= X0) & (x <= X1))[0]; iy = np.where((y >= Y0) & (y <= Y1))[0]
    need = (X1 - X0) / RES * 0.98
    if len(ix) < need or len(iy) < (Y1 - Y0) / RES * 0.98:
        say('error', 0, message='Part of that area is outside this radar scene (frame edge). Try cells a bit further inside.'); sys.exit(1)
    r0, r1, c0, c1 = int(iy[0]), int(iy[-1]) + 1, int(ix[0]), int(ix[-1]) + 1
    dsets = [g['HHHH'], g['HVHV']]
    # exact compressed size of the HDF5 chunks covering the crop, read from the file's chunk index
    def chunk_rows(ds):
        ch, cw = ds.chunks
        rows = []
        for cr in range(r0 // ch, (r1 - 1) // ch + 1):
            size = 0
            for cc in range(c0 // cw, (c1 - 1) // cw + 1):
                try: size += ds.id.get_chunk_info_by_coord((cr * ch, cc * cw)).size
                except Exception: size += ch * cw * ds.dtype.itemsize        # unknown: assume uncompressed
            rows.append((max(r0, cr * ch), min(r1, (cr + 1) * ch), size))
        return rows
    plan = [chunk_rows(ds) for ds in dsets]
    total = sum(sz for rows in plan for *_, sz in rows); done = 0
    mb = lambda b: round(b / 1e6, 1)
    out_arrays = []
    for name_, ds, rows in zip(('HH', 'HV'), dsets, plan):
        arr = np.empty((r1 - r0, c1 - c0), ds.dtype)
        for a0, a1, sz in rows:                                          # one chunk row at a time
            arr[a0 - r0:a1 - r0] = ds[a0:a1, c0:c1]
            done += sz
            say(f'Downloading {name_}', 15 + int(60 * done / total), mb_done=mb(done), mb_total=mb(total))
        out_arrays.append(arr)
    HH, HV = out_arrays
    name = a.label or f'c_{epsg}_{gx0}_{gy0}_{gx1 - gx0 + 1}x{gy1 - gy0 + 1}'
    out = f'data/tiles/{name}'; os.makedirs(out, exist_ok=True); path = f'{out}/{d}.npz'
    np.savez_compressed(path, HH=HH, HV=HV, x=x[ix], y=y[iy], epsg=epsg)

    say('Tracing channels and cutting patches', 75)
    from make_patches import add_tiles
    new = add_tiles([path], progress=lambda m: say(m.capitalize(), 80))
    if not new:
        say('done', 100, added=0, message="That square is at the edge of NASA's radar scene (part of it has no data), so it can't make a full patch. Try one further inside."); return

    say('Saving to database', 90)
    import psycopg
    modern = set(json.load(open('pipeline/modern_zones.json'))['patches'])
    with psycopg.connect(DB_URL) as con, con.cursor() as cur:
        for p in new:
            ring = p['corners'] + [p['corners'][0]]
            cur.execute("""INSERT INTO patches (id, tile, geom, center, tracer_line, tracer_valley, modern)
                           VALUES (%s, %s, ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326), ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326), %s, %s, %s)
                           ON CONFLICT (id) DO NOTHING""",
                        (p['id'], p['tile'], json.dumps({'type': 'Polygon', 'coordinates': [ring]}),
                         json.dumps({'type': 'Point', 'coordinates': p['center']}), p['tracer_line_frac'], p['tracer_valley_frac'], p['id'] in modern))
    say('Updating radar map layer', 95)
    from make_mosaic import build; build()
    say('done', 100, added=len(new), tile=name, date=d)

if __name__ == '__main__':
    try: main()
    except SystemExit: raise
    except Exception as e:
        txt = f'{type(e).__name__}: {e}'
        if any(k in txt for k in ('401', '403', 'Unauthorized', 'Forbidden')):
            # usually a new Earthdata account that hasn't approved NASA's radar archive (ASF) yet
            txt = ('NASA refused the download. If your Earthdata account is new, log in once at https://search.asf.alaska.edu '
                   'and accept the data terms, then try again. Otherwise reconnect your NASA login in the app.')
        say('error', 0, message=txt); sys.exit(1)
