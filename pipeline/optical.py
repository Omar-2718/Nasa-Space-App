"""Fetch Sentinel-2 true-colour onto the same grid as a NISAR crop (.npz). Reads only needed COG pixels."""
import sys, json, urllib.request, numpy as np, rasterio
from rasterio.warp import reproject, Resampling, transform_bounds
from rasterio.transform import from_origin
npz, out = sys.argv[1], sys.argv[2]
A = np.load(npz); x, y, epsg = A['x'], A['y'], int(A['epsg'])
step = 2                                   # 40 m output is plenty for a slider
xs, ys = x[::step], y[::step]
dst_t = from_origin(xs[0] - 20, ys[0] + 20, 40, 40)
bb = transform_bounds(epsg, 4326, xs[0], ys[-1], xs[-1], ys[0])
q = {"collections": ["sentinel-2-l2a"], "bbox": list(bb), "query": {"eo:cloud_cover": {"lt": 3}}, "limit": 20,
     "sortby": [{"field": "properties.datetime", "direction": "desc"}]}
req = urllib.request.Request("https://earth-search.aws.element84.com/v1/search", json.dumps(q).encode(), {"Content-Type": "application/json"})
feats = json.load(urllib.request.urlopen(req))['features']
day = feats[0]['properties']['datetime'][:10]
rgb = np.zeros((3, len(ys), len(xs)), np.uint16)
seen = set(); pick = []
for f in feats:                      # newest clear scene per MGRS tile
    t = f['id'].split('_')[1]
    if t not in seen: seen.add(t); pick.append(f)
for f in pick:
    for b, band in enumerate(['red', 'green', 'blue']):   # raw reflectance: TCI saturates over bright desert
        with rasterio.open(f['assets'][band]['href']) as src:
            tmp = np.zeros((len(ys), len(xs)), np.uint16)
            reproject(rasterio.band(src, 1), tmp, dst_transform=dst_t, dst_crs=f"EPSG:{epsg}", resampling=Resampling.average)
            rgb[b] = np.where((tmp > 0) & (rgb[b] == 0), tmp, rgb[b])
np.save(out, rgb); print('optical scenes', [f['id'] for f in pick], rgb.shape)
