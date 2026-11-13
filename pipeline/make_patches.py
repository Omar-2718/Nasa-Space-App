"""Cut NISAR tiles into 5.12 km patches (256 x 256 px at 20 m) for tagging and ML.

usage:
  make_patches.py                    rebuild everything from data/safsaf*/*.npz and data/tiles/*/*.npz
  make_patches.py data/tiles/X/D.npz add one or more tiles to the existing set (used by add_area.py)

Writes
  data/patches/<id>.npz           float16 HH/HV dB + tracer masks (ML training input, gitignored)
  web_assets/patches/<id>_radar.png, <id>_rgb.png, <id>_tracer.png   (served to the web app)
  web_assets/patches/index.json   one record per patch: corners (lon/lat), center, tracer scores
  web_assets/stretch.json         contrast stretch shared by all patches, so added tiles look the same
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
INDEX, STRETCH = f'{WEB_DIR}/index.json', 'web_assets/stretch.json'
db = lambda a: 10 * np.log10(np.clip(np.nan_to_num(a), 1e-6, None))
u8 = lambda a, lo, hi: (np.clip((a - lo) / (hi - lo), 0, 1) * 255).astype(np.uint8)

def all_tiles():
    return sorted(glob.glob('data/safsaf*/*.npz') + glob.glob('data/tiles/*/*.npz'))

def compute_stretch(tiles):
    H = np.concatenate([db(np.load(t)['HH'][::8, ::8]).ravel() for t in tiles]); H = H[H > -50]
    V = np.concatenate([db(np.load(t)['HV'][::8, ::8]).ravel() for t in tiles]); V = V[V > -50]
    n = min(len(H), len(V))
    s = dict(zip(['HL', 'HH', 'VL', 'VH', 'RL', 'RH'], map(float, [*np.percentile(H, [2, 98]), *np.percentile(V, [2, 98]), *np.percentile(H[:n] - V[:n], [2, 98])])))
    json.dump(s, open(STRETCH, 'w')); return s

def process_tile(t, st, done, progress=lambda msg: None):
    """Cut one tile into patches. Skips grid cells already in `done`. Returns new index records."""
    C = np.load(t); x, y, epsg = C['x'], C['y'], int(C['epsg'])
    H, V = db(C['HH']), db(C['HV']); valid = C['HH'] > 0
    progress('tracing channels')
    T = trace_tile(t)                                  # masks on a 40 m grid
    up = lambda m: np.kron(m, np.ones((2, 2), bool))   # back to 20 m
    fit = lambda m: np.pad(m, ((0, max(0, H.shape[0] - m.shape[0])), (0, max(0, H.shape[1] - m.shape[1]))))[:H.shape[0], :H.shape[1]]
    line = fit(ndi.binary_dilation(up(T['line_mask']), iterations=1)); valley = fit(up(T['valley_mask']))
    tf = Transformer.from_crs(epsg, 4326, always_xy=True)
    left, right, top, bot = x[0] - RES / 2, x[-1] + RES / 2, y[0] + RES / 2, y[-1] - RES / 2
    out = []
    progress('cutting patches')
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
            g = u8(h, st['HL'], st['HH'])
            Image.fromarray(g).save(f'{WEB_DIR}/{pid}_radar.png', optimize=True)
            Image.fromarray(np.dstack([g, u8(v, st['VL'], st['VH']), u8(h - v, st['RL'], st['RH'])])).save(f'{WEB_DIR}/{pid}_rgb.png', optimize=True)
            ov = np.zeros((PX, PX, 4), np.uint8); ov[vm] = (47, 211, 255, 70); ov[lm] = (191, 243, 255, 255)
            Image.fromarray(ov).save(f'{WEB_DIR}/{pid}_tracer.png', optimize=True)
            X0, X1, Y0, Y1 = gx * SIZE, (gx + 1) * SIZE, gy * SIZE, (gy + 1) * SIZE
            corners = [[round(v_, 6) for v_ in tf.transform(a, b)] for a, b in [(X0, Y1), (X1, Y1), (X1, Y0), (X0, Y0)]]
            center = [round(v_, 6) for v_ in tf.transform((X0 + X1) / 2, (Y0 + Y1) / 2)]
            out.append({'id': pid, 'tile': os.path.basename(os.path.dirname(t)), 'corners': corners, 'center': center,
                        'tracer_line_frac': round(float(lm.mean()), 4), 'tracer_valley_frac': round(float(vm.mean()), 4)})
    return out

def add_tiles(tiles, progress=lambda msg: None):
    """Add tiles to the existing patch set; returns the new records."""
    os.makedirs(NPZ_DIR, exist_ok=True); os.makedirs(WEB_DIR, exist_ok=True)
    index = json.load(open(INDEX)) if os.path.exists(INDEX) else []
    st = json.load(open(STRETCH)) if os.path.exists(STRETCH) else compute_stretch(tiles)
    done = {p['id'] for p in index}; new = []
    for t in tiles: new += process_tile(t, st, done, progress)
    json.dump(index + new, open(INDEX, 'w'))
    return new

if __name__ == '__main__':
    if len(sys.argv) > 1:
        new = add_tiles(sys.argv[1:], print); print(f'added {len(new)} patches')
    else:
        tiles = all_tiles()
        if not tiles: sys.exit('no radar tiles in data/: download some with pipeline/add_area.py <lon> <lat> or the app')
        os.makedirs(NPZ_DIR, exist_ok=True); os.makedirs(WEB_DIR, exist_ok=True)
        st = compute_stretch(tiles); done, index = set(), []
        for t in tiles:
            index += process_tile(t, st, done); print(t, 'patches so far', len(index), flush=True)
        json.dump(index, open(INDEX, 'w'))
        lf = np.array([p['tracer_line_frac'] for p in index])
        print(f'{len(index)} patches | with traced channels: {(lf > 0.002).sum()} | area {len(index) * 5.12**2:.0f} km2')
