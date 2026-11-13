"""Build the map layers for whatever radar this computer has: one north-up HH mosaic + traced channels.

usage: make_mosaic.py
writes web_assets/mosaic_hh.png, web_assets/mosaic.json (corners, bounds, tour focus), web_assets/channels.geojson
Re-run after adding tiles (add_area.py does this automatically). Works with 0..N tiles:
with no tiles it removes the layers so the app shows its "add radar" state.
"""
import json, os, sys, numpy as np
from PIL import Image
from rasterio.warp import reproject, Resampling, transform_bounds
from rasterio.transform import from_origin
sys.path.insert(0, os.path.dirname(__file__))
from make_patches import all_tiles, compute_stretch, STRETCH
from trace_channels import trace_tile, tile_features

MAX_PX = 8000                                   # cap the mosaic's longest side so big coverage stays light in the browser
OUT = 'web_assets'

def cached_features(t):
    """Traced channels for one tile, cached next to it (tracing is the slow part; only new tiles get traced)."""
    cache = os.path.join(os.path.dirname(t), 'traced_features.json')
    if os.path.exists(cache) and os.path.getmtime(cache) >= os.path.getmtime(t):
        f = json.load(open(cache))
        if isinstance(f, list): return f
    f = tile_features(trace_tile(t)); json.dump(f, open(cache, 'w')); return f

def build():
    os.makedirs(OUT, exist_ok=True)
    tiles = all_tiles()
    if not tiles:
        for f in ('mosaic_hh.png', 'mosaic.json', 'channels.geojson'):
            if os.path.exists(f'{OUT}/{f}'): os.remove(f'{OUT}/{f}')
        print('no tiles: map layers removed'); return
    st = json.load(open(STRETCH)) if os.path.exists(STRETCH) else compute_stretch(tiles)
    bb = []
    for t in tiles:
        C = np.load(t); bb.append(transform_bounds(int(C['epsg']), 4326, C['x'][0], C['y'][-1], C['x'][-1], C['y'][0]))
    W, S, E, N = min(b[0] for b in bb), min(b[1] for b in bb), max(b[2] for b in bb), max(b[3] for b in bb)
    res = max(0.0004, (E - W) / MAX_PX, (N - S) / MAX_PX)        # ~40 m, coarser only for very large areas
    w, h = int((E - W) / res) + 1, int((N - S) / res) + 1
    dst_t = from_origin(W, N, res, res)
    mos = np.full((h, w), np.nan, np.float32)
    features = []
    for t in tiles:
        C = np.load(t)
        a = C['HH'].astype(np.float32); a[a <= 0] = np.nan
        tmp = np.full((h, w), np.nan, np.float32)
        reproject(a, tmp, src_transform=from_origin(C['x'][0] - 10, C['y'][0] + 10, 20, 20), src_crs=f"EPSG:{int(C['epsg'])}",
                  dst_transform=dst_t, dst_crs='EPSG:4326', resampling=Resampling.average, src_nodata=np.nan, dst_nodata=np.nan)
        mos = np.where(np.isnan(mos), tmp, mos)
        features += cached_features(t)
        print('layered', t, flush=True)
    # close hairline seams between neighbouring tiles (they don't quite touch after reprojection):
    # fill empty pixels within 3 px of data with the nearest value
    from scipy import ndimage as ndi
    empty = np.isnan(mos)
    if empty.any() and (~empty).any():
        dist, (ri, ci) = ndi.distance_transform_edt(empty, return_indices=True)
        near = empty & (dist <= 3)
        mos[near] = mos[ri[near], ci[near]]
    # show radar only inside patch squares, so the map shows exactly what can be tagged
    # (crops extend past the last complete grid cell; those edge strips have no patch)
    idx_path = 'web_assets/patches/index.json'
    if os.path.exists(idx_path):
        from rasterio.features import rasterize
        polys = [{'type': 'Polygon', 'coordinates': [p['corners'] + [p['corners'][0]]]} for p in json.load(open(idx_path))]
        if polys:
            inside = rasterize(((g_, 1) for g_ in polys), out_shape=mos.shape, transform=dst_t, fill=0, dtype='uint8', all_touched=True).astype(bool)
            mos[~inside] = np.nan
    # river layer = what the radar squares show: clip traced features to the patch squares,
    # minus modern farms (pivot circles and canals look like channels to the tracer)
    if os.path.exists(idx_path):
        from shapely.geometry import Polygon, shape, mapping
        from shapely.ops import unary_union
        modern = set(json.load(open('pipeline/modern_zones.json'))['patches'])
        idx = json.load(open(idx_path))
        keep = unary_union([Polygon(p['corners']) for p in idx if p['id'] not in modern]).buffer(0)
        clipped = []
        for f in features:
            g = shape(f['geometry']).intersection(keep)
            if g.is_empty or g.geom_type not in ('LineString', 'MultiLineString', 'Polygon', 'MultiPolygon'): continue
            if f['properties']['kind'] == 'channel':
                f['properties']['len_km'] = round(f['properties']['len_km'] * g.length / max(shape(f['geometry']).length, 1e-12), 2)
            clipped.append({**f, 'geometry': mapping(g)})
        features = clipped
    m = ~np.isnan(mos)
    g = (np.clip((10 * np.log10(np.clip(np.nan_to_num(mos), 1e-6, None)) - st['HL']) / (st['HH'] - st['HL']), 0, 1) * 255).astype(np.uint8)
    Image.fromarray(np.dstack([g, np.where(m, 255, 0).astype(np.uint8)]), 'LA').save(f'{OUT}/mosaic_hh.png', compress_level=3)   # grey + alpha: half the size of RGBA
    json.dump({'type': 'FeatureCollection', 'features': features}, open(f'{OUT}/channels.geojson', 'w'))
    # tour focus: centre of the biggest traced valley, else of the densest channels, else the mosaic centre
    focus = [(W + E) / 2, (S + N) / 2]
    vals = [f for f in features if f['properties']['kind'] == 'valley']
    if vals:
        from shapely.geometry import shape
        c = shape(max(vals, key=lambda f: f['properties']['area_px'])['geometry']).centroid; focus = [c.x, c.y]
    elif features:
        from shapely.geometry import shape
        pts = np.array([(c.x, c.y) for c in (shape(f['geometry']).centroid for f in features)]); focus = np.median(pts, 0).tolist()
    km = sum(f['properties'].get('len_km', 0) for f in features)
    json.dump({'corners': [[W, N], [E, N], [E, S], [W, S]], 'bounds': [[W, S], [E, N]], 'focus': [round(focus[0], 4), round(focus[1], 4)],
               'tiles': len(tiles), 'size_px': [w, h], 'channels_km': round(km)}, open(f'{OUT}/mosaic.json', 'w'))
    print(f'mosaic {w}x{h} px from {len(tiles)} tiles, {round(km)} km of traced channels, focus {focus}')

if __name__ == '__main__':
    os.chdir(os.path.join(os.path.dirname(__file__), '..'))
    build()
