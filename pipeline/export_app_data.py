"""Export NISAR radar tiles as georeferenced PNG overlays + traced channels for the web app (app/data).

Tiles: every data/safsaf*/20261017.npz. Channels: traced across all tiles by trace_channels.py.
"""
import numpy as np, json, glob, os, subprocess, sys
from PIL import Image
from pyproj import Transformer
OUT = 'web/public/tour'; os.makedirs(OUT, exist_ok=True)   # tour layers for the React app (gitignored)
for f in glob.glob(f'{OUT}/*'): os.remove(f)
# note: trace output goes to data/trace_all.png
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

# Mosaic all tiles onto one north-up lon/lat grid (no rotation, no seams)
import rasterio
from rasterio.warp import reproject, Resampling, transform_bounds
from rasterio.transform import from_origin
RES = 0.0004                                   # degrees, ~40 m
bb = [transform_bounds(int(np.load(t)['epsg']), 4326, np.load(t)['x'][0], np.load(t)['y'][-1], np.load(t)['x'][-1], np.load(t)['y'][0]) for t in tiles]
W_, S_, E_, N_ = min(b[0] for b in bb), min(b[1] for b in bb), max(b[2] for b in bb), max(b[3] for b in bb)
w, h = int((E_ - W_) / RES), int((N_ - S_) / RES); dst_t = from_origin(W_, N_, RES, RES)
mos = {k: np.full((h, w), np.nan, np.float32) for k in ('HH', 'HV')}
for t in tiles:
    C = np.load(t); src_t = from_origin(C['x'][0] - 10, C['y'][0] + 10, 20, 20)
    for k in mos:
        a = C[k].astype(np.float32); a[a <= 0] = np.nan
        tmp = np.full((h, w), np.nan, np.float32)
        reproject(a, tmp, src_transform=src_t, src_crs=f"EPSG:{int(C['epsg'])}", dst_transform=dst_t, dst_crs='EPSG:4326',
                  resampling=Resampling.average, src_nodata=np.nan, dst_nodata=np.nan)
        mos[k] = np.where(np.isnan(mos[k]), tmp, mos[k])
m = ~np.isnan(mos['HH']); H, V = db(mos['HH']), db(mos['HV'])
a = np.where(m, 255, 0).astype(np.uint8)
hh = st(H, hl, hh_); hv = st(V, vl, vh); r = H - V; ratio = st(r, np.nanpercentile(r[m], 2), np.nanpercentile(r[m], 98))
Image.fromarray(np.dstack([hh, hh, hh, a])).save(f'{OUT}/radar_hh.png', optimize=True)
Image.fromarray(np.dstack([hh, hv, ratio, a])).save(f'{OUT}/radar_rgb.png', optimize=True)
manifest = {'radar': {'corners': [[W_, N_], [E_, N_], [E_, S_], [W_, S_]], 'size_px': [w, h]}}
subprocess.run([sys.executable, '-W', 'ignore', 'pipeline/trace_channels.py', f'{OUT}/channels.geojson', 'data/trace_all.png', *tiles], check=True)
g = json.load(open(f'{OUT}/channels.geojson'))
manifest['channels_km'] = round(sum(f['properties'].get('len_km', 0) for f in g['features']))
manifest['date'] = '2026-10-17'
json.dump(manifest, open(f'{OUT}/manifest.json', 'w'), indent=1)
print('mosaic', manifest['radar']['size_px'], 'channels_km', manifest['channels_km'])
print(sum(os.path.getsize(f'{OUT}/{f}') for f in os.listdir(OUT)) // 1024, 'KB total')
