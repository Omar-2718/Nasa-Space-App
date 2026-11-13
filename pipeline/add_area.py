"""Add radar coverage for a 40 x 40 km area: stream a NISAR GCOV crop, cut patches, insert them into the database.

usage: add_area.py <lon> <lat> [--half-km 20]
Prints one JSON line per step ({"step": ..., "pct": ...}) so the API can stream progress to the browser.
Needs a NASA Earthdata login in ~/.netrc. Downloads about 25 MB (only the crop, never the 1.6 GB file).
"""
import argparse, json, os, sys, time
import numpy as np

ROOT = os.path.join(os.path.dirname(__file__), '..')
os.chdir(ROOT); sys.path.insert(0, 'pipeline')
DB_URL = os.environ.get('DATABASE_URL', 'postgresql://sand:sand@localhost:5433/beneath')
PREFERRED_DATE = '20261017'          # same date as the rest of the coverage, when available

def say(step, pct, **kw):
    print(json.dumps({'step': step, 'pct': pct, **kw}), flush=True)

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('lon', type=float); ap.add_argument('lat', type=float)
    ap.add_argument('--half-km', type=float, default=20); a = ap.parse_args()
    name = f't_{a.lon:.2f}_{a.lat:.2f}' + ('' if a.half_km == 20 else f'_{int(a.half_km * 2)}km'); out = f'data/tiles/{name}'
    os.makedirs(out, exist_ok=True)

    if not os.path.exists(os.path.expanduser('~/.netrc')):
        say('error', 0, message='No NASA Earthdata login on this computer. Add it to ~/.netrc (see README).'); sys.exit(1)

    say('Searching NISAR archive', 5)
    import earthaccess, h5py
    from pyproj import Transformer
    earthaccess.login(strategy='netrc')
    res = [r for r in earthaccess.search_data(short_name='NISAR_L2_GCOV_PROVISIONAL_V1', point=(a.lon, a.lat))
           if 'DHDH' in r['umm']['GranuleUR']]                         # need both HH and HV
    if not res: say('error', 0, message='NISAR has no dual-polarisation data here yet.'); sys.exit(1)
    date = lambda r: r['umm']['GranuleUR'].split('_')[11][:8]
    pick = next((r for r in res if date(r) == PREFERRED_DATE), max(res, key=date))
    d = date(pick); path = f'{out}/{d}.npz'

    if not os.path.exists(path):
        say(f'Downloading radar crop ({d})', 15)
        f = earthaccess.open([pick])[0]
        g = h5py.File(f, 'r')['science/LSAR/GCOV/grids/frequencyA']
        epsg = int(g['projection'][()]); x = g['xCoordinates'][:]; y = g['yCoordinates'][:]
        X, Y = Transformer.from_crs(4326, epsg, always_xy=True).transform(a.lon, a.lat)
        h = a.half_km * 1000
        ix = np.where((x > X - h) & (x < X + h))[0]; iy = np.where((y > Y - h) & (y < Y + h))[0]
        if len(ix) < min(300, a.half_km * 75) or len(iy) < min(300, a.half_km * 75): say('error', 0, message='That spot is at the edge of the radar frame. Try a bit further inside.'); sys.exit(1)
        sl = (slice(iy[0], iy[-1] + 1), slice(ix[0], ix[-1] + 1))
        say('Downloading radar crop: HH', 30)
        HH = g['HHHH'][sl]
        say('Downloading radar crop: HV', 55)
        HV = g['HVHV'][sl]
        np.savez_compressed(path, HH=HH, HV=HV, x=x[ix], y=y[iy], epsg=epsg)

    say('Tracing channels and cutting patches', 75)
    from make_patches import add_tiles
    new = add_tiles([path], progress=lambda m: say(m.capitalize(), 80))
    if not new: say('done', 100, added=0, message='This area is already covered.'); return

    say('Saving to database', 92)
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
    say('Updating radar map layer', 97)
    from make_mosaic import build; build()
    say('done', 100, added=len(new), tile=name, date=d)

if __name__ == '__main__':
    try: main()
    except SystemExit: raise
    except Exception as e:
        say('error', 0, message=f'{type(e).__name__}: {e}'); sys.exit(1)
