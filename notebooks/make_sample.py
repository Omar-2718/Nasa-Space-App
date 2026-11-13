"""Build notebooks/sample_data/: a small, shareable subset of the project data for 01_data_pipeline.ipynb.

usage (from repo root): .venv/bin/python notebooks/make_sample.py
Contents
  safsaf_crop.npz   20 x 20 km crop (1000 x 1000 px at 20 m) of data/safsaf/20261017.npz, same keys (HH, HV, x, y, epsg)
  optical_crop.npy  matching crop of data/safsaf/optical.npy (Sentinel-2 R,G,B on the 40 m radar grid)
  patches/          the patches that fall inside the crop: <id>.npz + <id>_radar/_rgb/_tracer.png
  tracer_fulltile.npz  tracer masks (40 m) computed on the FULL safsaf tile, cropped to the window
                    (valleys are defined relative to the whole 40 km tile, so a crop alone finds none)
  trace_channels.py copy of pipeline/trace_channels.py so the notebook runs without the repo
  index.json        full patch index (all 461 records; small)
  schema.prisma     copy of api/prisma/schema.prisma
"""
import json, os, shutil, sys, warnings, numpy as np
warnings.filterwarnings('ignore')
sys.path.insert(0, 'pipeline')
from trace_channels import trace_tile
R0, C0, N = 800, 200, 1000                        # crop window in the 2000 x 2000 safsaf tile (even offsets)
OUT = 'notebooks/sample_data'
os.makedirs(f'{OUT}/patches', exist_ok=True)
C = np.load('data/safsaf/20261017.npz')
x, y = C['x'][C0:C0 + N], C['y'][R0:R0 + N]
np.savez_compressed(f'{OUT}/safsaf_crop.npz', HH=C['HH'][R0:R0 + N, C0:C0 + N], HV=C['HV'][R0:R0 + N, C0:C0 + N],
                    x=x, y=y, epsg=C['epsg'])
np.save(f'{OUT}/optical_crop.npy', np.load('data/safsaf/optical.npy')[:, R0 // 2:(R0 + N) // 2, C0 // 2:(C0 + N) // 2])
index = json.load(open('web_assets/patches/index.json'))
left, right, top, bot = x[0] - 10, x[-1] + 10, y[0] + 10, y[-1] - 10
inside = []
for p in index:
    _, gx, gy = map(int, p['id'].split('_'))
    if gx * 5120 >= left and (gx + 1) * 5120 <= right and gy * 5120 >= bot and (gy + 1) * 5120 <= top:
        inside.append(p['id'])
        shutil.copy(f"data/patches/{p['id']}.npz", f'{OUT}/patches/')
        for s in ('radar', 'rgb', 'tracer'):
            shutil.copy(f"web_assets/patches/{p['id']}_{s}.png", f'{OUT}/patches/')
shutil.copy('web_assets/patches/index.json', f'{OUT}/index.json')
R = trace_tile('data/safsaf/20261017.npz'); w = (slice(R0 // 2, (R0 + N) // 2), slice(C0 // 2, (C0 + N) // 2))
np.savez_compressed(f'{OUT}/tracer_fulltile.npz', line_mask=R['line_mask'][w], valley_mask=R['valley_mask'][w])
shutil.copy('pipeline/trace_channels.py', f'{OUT}/trace_channels.py')
shutil.copy('api/prisma/schema.prisma', f'{OUT}/schema.prisma')
print('patches in crop:', inside)
