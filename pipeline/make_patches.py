"""Cut NISAR tiles into 5.12 km patches (256 x 256 px at 20 m) for tagging and ML.

usage: make_patches.py            (reads data/safsaf*/20261017.npz and data/tiles/*/20261017.npz)

Writes
  data/patches/<id>.npz           float16 HH/HV dB + tracer masks (ML training input, gitignored)
  web_assets/patches/<id>_radar.png, <id>_rgb.png, <id>_tracer.png   (served to the web app)
  web_assets/patches/index.json   one record per patch: corners (lon/lat), center, tracer scores
Patches sit on a fixed UTM grid, so overlapping tiles never produce duplicates.
"""
import glob, json, os, sys, numpy as np
from PIL import Image
from pyproj import Transformer
from scipy import ndimage as ndi
sys.path.insert(0, os.path.dirname(__file__))
from trace_channels import trace_tile

PX, RES = 256, 20                    # pixels per side, metres per pixel
SIZE = PX * RES                      # 5120 m
NPZ_DIR, WEB_DIR = 'data/patches', 'web_assets/patches'
os.makedirs(NPZ_DIR, exist_ok=True); os.makedirs(WEB_DIR, exist_ok=True)

tiles = sorted(glob.glob('data/safsaf*/20261017.npz') + glob.glob('data/tiles/*/20261017.npz'))
db = lambda a: 10 * np.log10(np.clip(np.nan_to_num(a), 1e-6, None))

# one global contrast stretch so every patch looks consistent
H_all = np.concatenate([db(np.load(t)['HH'][::8, ::8]).ravel() for t in tiles]); H_all = H_all[H_all > -50]
V_all = np.concatenate([db(np.load(t)['HV'][::8, ::8]).ravel() for t in tiles]); V_all = V_all[V_all > -50]
HL, HH_ = np.percentile(H_all, [2, 98]); VL, VH = np.percentile(V_all, [2, 98])
RL, RH = np.percentile(H_all[:len(V_all)] - V_all[:len(H_all)], [2, 98])
u8 = lambda a, lo, hi: (np.clip((a - lo) / (hi - lo), 0, 1) * 255).astype(np.uint8)

index, done = [], set()
for t in tiles:
    C = np.load(t); x, y, epsg = C['x'], C['y'], int(C['epsg'])
    H, V = db(C['HH']), db(C['HV']); valid = C['HH'] > 0
    T = trace_tile(t)                                  # masks on a 40 m grid
    up = lambda m: np.kron(m, np.ones((2, 2), bool))   # back to 20 m
    line = ndi.binary_dilation(up(T['line_mask']), iterations=1); valley = up(T['valley_mask'])
    line = np.pad(line, ((0, max(0, H.shape[0] - line.shape[0])), (0, max(0, H.shape[1] - line.shape[1]))))[:H.shape[0], :H.shape[1]]
    valley = np.pad(valley, ((0, max(0, H.shape[0] - valley.shape[0])), (0, max(0, H.shape[1] - valley.shape[1]))))[:H.shape[0], :H.shape[1]]
    tf = Transformer.from_crs(epsg, 4326, always_xy=True)
    # grid cells fully inside this tile (pixel centres x[i], y[j]; y descends)
    left, right, top, bot = x[0] - RES / 2, x[-1] + RES / 2, y[0] + RES / 2, y[-1] - RES / 2
    for gx in range(int(np.ceil(left / SIZE)), int(np.floor(right / SIZE))):
        for gy in range(int(np.ceil(bot / SIZE)), int(np.floor(top / SIZE))):
            pid = f'{epsg}_{gx}_{gy}'
            if pid in done: continue
            c0 = int(round((gx * SIZE - left) / RES)); r0 = int(round((top - (gy + 1) * SIZE) / RES))
            sl = (slice(r0, r0 + PX), slice(c0, c0 + PX))
            if valid[sl].shape != (PX, PX) or valid[sl].mean() < 0.98: continue
            done.add(pid)
            h, v, lm, vm = H[sl], V[sl], line[sl], valley[sl]
            np.savez_compressed(f'{NPZ_DIR}/{pid}.npz', hh=h.astype(np.float16), hv=v.astype(np.float16),
                                line=lm.astype(np.uint8), valley=vm.astype(np.uint8))
            g = u8(h, HL, HH_)
            Image.fromarray(g).save(f'{WEB_DIR}/{pid}_radar.png', optimize=True)
            Image.fromarray(np.dstack([g, u8(v, VL, VH), u8(h - v, RL, RH)])).save(f'{WEB_DIR}/{pid}_rgb.png', optimize=True)
            ov = np.zeros((PX, PX, 4), np.uint8)
            ov[vm] = (47, 211, 255, 70); ov[lm] = (191, 243, 255, 255)
            Image.fromarray(ov).save(f'{WEB_DIR}/{pid}_tracer.png', optimize=True)
            X0, X1, Y0, Y1 = gx * SIZE, (gx + 1) * SIZE, gy * SIZE, (gy + 1) * SIZE
            corners = [list(map(lambda v_: round(v_, 6), tf.transform(a, b))) for a, b in [(X0, Y1), (X1, Y1), (X1, Y0), (X0, Y0)]]
            center = [round(v_, 6) for v_ in tf.transform((X0 + X1) / 2, (Y0 + Y1) / 2)]
            index.append({'id': pid, 'tile': os.path.basename(os.path.dirname(t)), 'corners': corners, 'center': center,
                          'tracer_line_frac': round(float(lm.mean()), 4), 'tracer_valley_frac': round(float(vm.mean()), 4)})
    print(t, 'patches so far', len(index), flush=True)

json.dump(index, open(f'{WEB_DIR}/index.json', 'w'))
lf = np.array([p['tracer_line_frac'] for p in index])
print(f'{len(index)} patches | with traced channels: {(lf > 0.002).sum()} | area {len(index) * 5.12**2:.0f} km2')
