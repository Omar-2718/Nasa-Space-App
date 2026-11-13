"""Build one north-up radar mosaic (HH, ~80 m) of every downloaded tile, for the live map's radar layer.

usage: make_mosaic.py        writes web_assets/mosaic_hh.png + web_assets/mosaic.json (corners)
Re-run after adding tiles (add_area.py does this automatically). Uses the shared stretch from make_patches.
"""
import glob, json, os, sys, numpy as np
from PIL import Image
from rasterio.warp import reproject, Resampling, transform_bounds
from rasterio.transform import from_origin
sys.path.insert(0, os.path.dirname(__file__))
from make_patches import all_tiles, compute_stretch, STRETCH

RES = 0.0008                                    # degrees, about 80 m: whole coverage stays a few MB

def build():
    tiles = all_tiles()
    if not tiles: print('no tiles'); return
    st = json.load(open(STRETCH)) if os.path.exists(STRETCH) else compute_stretch(tiles)
    meta = [(t, np.load(t)) for t in tiles]
    bb = [transform_bounds(int(C['epsg']), 4326, C['x'][0], C['y'][-1], C['x'][-1], C['y'][0]) for _, C in meta]
    W, S, E, N = min(b[0] for b in bb), min(b[1] for b in bb), max(b[2] for b in bb), max(b[3] for b in bb)
    w, h = int((E - W) / RES) + 1, int((N - S) / RES) + 1
    dst_t = from_origin(W, N, RES, RES)
    mos = np.full((h, w), np.nan, np.float32)
    for t, C in meta:
        a = C['HH'].astype(np.float32); a[a <= 0] = np.nan
        tmp = np.full((h, w), np.nan, np.float32)
        reproject(a, tmp, src_transform=from_origin(C['x'][0] - 10, C['y'][0] + 10, 20, 20), src_crs=f"EPSG:{int(C['epsg'])}",
                  dst_transform=dst_t, dst_crs='EPSG:4326', resampling=Resampling.average, src_nodata=np.nan, dst_nodata=np.nan)
        mos = np.where(np.isnan(mos), tmp, mos)
    m = ~np.isnan(mos)
    g = (np.clip((10 * np.log10(np.clip(np.nan_to_num(mos), 1e-6, None)) - st['HL']) / (st['HH'] - st['HL']), 0, 1) * 255).astype(np.uint8)
    Image.fromarray(np.dstack([g, g, g, np.where(m, 255, 0).astype(np.uint8)])).save('web_assets/mosaic_hh.png', optimize=True)
    json.dump({'corners': [[W, N], [E, N], [E, S], [W, S]], 'tiles': len(tiles), 'size_px': [w, h]}, open('web_assets/mosaic.json', 'w'))
    print(f'mosaic {w}x{h} px from {len(tiles)} tiles')

if __name__ == '__main__':
    os.chdir(os.path.join(os.path.dirname(__file__), '..'))
    build()
