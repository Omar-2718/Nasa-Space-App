"""Turn NISAR crops + optical into PNG layers and a small JSON for the prototype page."""
import numpy as np, json, glob, os, sys, base64, io
from PIL import Image
out = 'prototype/layers'; os.makedirs(out, exist_ok=True)
db = lambda a: 10*np.log10(np.clip(np.nan_to_num(a), 1e-6, None))
def stretch(a, m, p=(2, 98)):
    lo, hi = np.percentile(a[m], p); return (np.clip((a-lo)/(hi-lo), 0, 1)*255).astype(np.uint8)
def save(arr, name, q=None):
    im = Image.fromarray(arr); p = f'{out}/{name}'
    im.save(p, quality=82) if name.endswith('.jpg') else im.save(p, optimize=True); return p
meta = {}
# --- Part 1: X-ray the desert
C = np.load('data/safsaf/20261017.npz'); H, V = C['HH'][::2, ::2], C['HV'][::2, ::2]; m = H > 0
h, v = db(H), db(V)
save(stretch(h, m), 'radar_hh.jpg')
rgb = np.dstack([stretch(h, m), stretch(v, m), stretch(h - v, m)])   # HH, HV, HH/HV false colour
save(rgb, 'radar_rgb.jpg')
if os.path.exists('data/safsaf/optical.npy'):
    o = np.load('data/safsaf/optical.npy').transpose(1, 2, 0)
    o = o.astype(float); mk = o.sum(2) > 0
    for b in range(3):
        lo, hi = np.percentile(o[..., b][mk], [1, 99]); o[..., b] = np.clip((o[..., b] - lo) / (hi - lo), 0, 1)
    o = (o * 255).astype(np.uint8)
    save(o, 'optical.jpg')
meta['xray'] = {'size_km': round(len(C['x']) * 0.02), 'date': '2026-10-17'}
# --- Part 2: living desert time series
files = sorted(glob.glob('data/farms/*.npz'))
if files:
    stack = []; dates = []
    for f in files:
        F = np.load(f); stack.append(db(F['HV'][::2, ::2])); dates.append(os.path.basename(f)[:8])
    S = np.array(stack); mm = np.isfinite(S).all(0) & (S > -45).all(0)
    lo, hi = np.percentile(S[:, mm], [60, 99.7])     # most pixels are bare sand: anchor 'sand' at the median-ish level
    sand, crop = np.array([74, 58, 42]), np.array([120, 235, 110])
    for d, s in zip(dates, S):
        g = np.clip((s - lo) / (hi - lo), 0, 1) ** 1.3
        img = (sand[None, None] * (1 - g[..., None]) + crop[None, None] * g[..., None]).astype(np.uint8)
        save(img, f'farm_{d}.jpg')
    small = S[:, ::4, ::4]   # grid for click-to-chart
    meta['farms'] = {'dates': dates, 'grid': np.round(np.nan_to_num(small, nan=-40), 1).tolist(), 'gw': small.shape[2], 'gh': small.shape[1]}
json.dump(meta, open('prototype/layers/meta.json', 'w'))
print({k: (v if k != 'farms' else {'dates': v['dates'], 'gw': v['gw'], 'gh': v['gh']}) for k, v in meta.items()})
for f in sorted(os.listdir(out)): print(f, os.path.getsize(f'{out}/{f}')//1024, 'KB')
