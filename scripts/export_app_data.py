"""Export NISAR radar tiles as georeferenced PNG overlays + traced channels for the web app (app/data).

Tiles: every data/safsaf*/20261017.npz. Channels: traced across all tiles by trace_channels.py.
"""
import numpy as np, json, glob, os, subprocess, sys
from PIL import Image
from pyproj import Transformer
OUT = 'app/data'; os.makedirs(OUT, exist_ok=True)
for f in glob.glob(f'{OUT}/*'): os.remove(f)
db = lambda a: 10*np.log10(np.clip(np.nan_to_num(a), 1e-6, None))

def corners(x, y, epsg, px=20):
    t = Transformer.from_crs(epsg, 4326, always_xy=True)
    l, r, top, bot = x[0]-px/2, x[-1]+px/2, y[0]+px/2, y[-1]-px/2
    return [list(t.transform(l, top)), list(t.transform(r, top)), list(t.transform(r, bot)), list(t.transform(l, bot))]

tiles = sorted(glob.glob('data/safsaf*/20261017.npz'))
# one shared contrast stretch across tiles so the mosaic has no seams in brightness
H_all = np.concatenate([db(np.load(t)['HH'][::4, ::4]).ravel() for t in tiles]); H_all = H_all[H_all > -50]
V_all = np.concatenate([db(np.load(t)['HV'][::4, ::4]).ravel() for t in tiles]); V_all = V_all[V_all > -50]
hl, hh_ = np.percentile(H_all, [2, 98]); vl, vh = np.percentile(V_all, [2, 98])
st = lambda a, lo, hi: (np.clip((a-lo)/(hi-lo), 0, 1)*255).astype(np.uint8)

manifest = {'tiles': []}
for t in tiles:
    name = os.path.basename(os.path.dirname(t))
    C = np.load(t); H, V = db(C['HH'][::2, ::2]), db(C['HV'][::2, ::2]); m = C['HH'][::2, ::2] > 0
    a = np.where(m, 255, 0).astype(np.uint8)
    hh = st(H, hl, hh_); hv = st(V, vl, vh); ratio = st(H - V, np.percentile(H - V, 2), np.percentile(H - V, 98))
    Image.fromarray(np.dstack([hh, hh, hh, a])).save(f'{OUT}/{name}_hh.png', optimize=True)
    Image.fromarray(np.dstack([hh, hv, ratio, a])).save(f'{OUT}/{name}_rgb.png', optimize=True)
    manifest['tiles'].append({'id': name, 'corners': corners(C['x'], C['y'], int(C['epsg']))})

subprocess.run([sys.executable, '-W', 'ignore', 'scripts/trace_channels.py', f'{OUT}/channels.geojson', 'data/trace_all.png', *tiles], check=True)
g = json.load(open(f'{OUT}/channels.geojson'))
manifest['channels_km'] = round(sum(f['properties'].get('len_km', 0) for f in g['features']))
manifest['date'] = '2026-10-17'
json.dump(manifest, open(f'{OUT}/manifest.json', 'w'), indent=1)
print('tiles', [t['id'] for t in manifest['tiles']], 'channels_km', manifest['channels_km'])
print(sum(os.path.getsize(f'{OUT}/{f}') for f in os.listdir(OUT)) // 1024, 'KB total')
