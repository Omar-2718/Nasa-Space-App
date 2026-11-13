"""Export NISAR crops as georeferenced PNG overlays + JSON for the web app (app/data)."""
import numpy as np, json, glob, os
from PIL import Image
from pyproj import Transformer
OUT = 'app/data'
db = lambda a: 10*np.log10(np.clip(np.nan_to_num(a), 1e-6, None))
def corners(x, y, epsg, px=20):
    t = Transformer.from_crs(epsg, 4326, always_xy=True)
    l, r, top, bot = x[0]-px/2, x[-1]+px/2, y[0]+px/2, y[-1]-px/2
    return [list(t.transform(l, top)), list(t.transform(r, top)), list(t.transform(r, bot)), list(t.transform(l, bot))]  # TL TR BR BL
def gray(a, m, p=(2, 98)):
    lo, hi = np.percentile(a[m], p); return (np.clip((a-lo)/(hi-lo), 0, 1)*255).astype(np.uint8)
manifest = {}
# Sites for "X-ray": radar HH, HV and false colour
for site, npz, title in [('safsaf', 'data/safsaf/20261017.npz', 'Bir Safsaf'), ('escarpment', 'data/channel/20261017.npz', 'Toshka escarpment')]:
    if not os.path.exists(npz): continue
    C = np.load(npz); H, V = C['HH'], C['HV']; m = H > 0; h, v = db(H), db(V)
    alpha = np.where(m, 255, 0).astype(np.uint8)
    for name, rgb in [('hh', np.dstack([gray(h, m)]*3)), ('hv', np.dstack([gray(v, m)]*3)),
                      ('rgb', np.dstack([gray(h, m), gray(v, m), gray(h-v, m)]))]:
        Image.fromarray(np.dstack([rgb, alpha])[::2, ::2]).save(f'{OUT}/{site}_{name}.png', optimize=True)
    manifest[site] = {'title': title, 'date': '2026-10-17', 'corners': corners(C['x'], C['y'], int(C['epsg']))}
# Farms time series
files = sorted(glob.glob('data/farms/*.npz'))
if files:
    S = np.array([db(np.load(f)['HV']) for f in files]); dates = [os.path.basename(f)[:8] for f in files]
    F0 = np.load(files[0]); ok = np.isfinite(S).all(0) & (S > -45).all(0)
    lo, hi = np.percentile(S[:, ok], [60, 99.7])
    for d, s in zip(dates, S):
        g = np.clip((s-lo)/(hi-lo), 0, 1) ** 1.3
        a = (g * 235 + 20).astype(np.uint8)                        # transparent over sand, opaque over crops
        rgb = np.dstack([np.full_like(a, 90), np.full_like(a, 235), np.full_like(a, 100), a])
        Image.fromarray(rgb).save(f'{OUT}/farm_{d}.png', optimize=True)
    small = S[:, ::4, ::4]
    manifest['farms'] = {'dates': dates, 'corners': corners(F0['x'], F0['y'], int(F0['epsg'])),
                         'gw': small.shape[2], 'gh': small.shape[1]}
    json.dump(np.round(np.nan_to_num(small, nan=-40), 1).tolist(), open(f'{OUT}/farm_grid.json', 'w'))
json.dump(manifest, open(f'{OUT}/manifest.json', 'w'), indent=1)
print(json.dumps({k: v.get('title', len(v.get('dates', []))) for k, v in manifest.items()}))
for f in sorted(os.listdir(OUT)): print(f, os.path.getsize(f'{OUT}/{f}')//1024, 'KB')
