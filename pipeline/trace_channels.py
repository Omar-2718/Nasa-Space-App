"""Trace candidate buried channels (long, dark, winding lines) in NISAR HH crops.

usage: trace_channels.py out.geojson debug.png tile1.npz [tile2.npz ...]
Each tile is processed on its own grid; lines are converted to lon/lat and merged.
"""
import sys, json, numpy as np
from scipy import ndimage as ndi
from skimage.filters import sato
from skimage.morphology import remove_small_objects, skeletonize, binary_closing, disk
from skimage.measure import approximate_polygon
from pyproj import Transformer
import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt

STEP = 2                 # 20 m -> 40 m working resolution
MIN_LEN_PX = 100         # keep traced networks >= 4 km
RIDGE_PCT = 90           # how much of the ridge response counts as "channel"

def load(npz):
    C = np.load(npz); H = C['HH'].astype(np.float64)
    h, w = (H.shape[0] // STEP) * STEP, (H.shape[1] // STEP) * STEP
    H = H[:h, :w].reshape(h // STEP, STEP, w // STEP, STEP).mean((1, 3))   # average intensity, then dB
    valid = H > 0
    db = 10 * np.log10(np.clip(H, 1e-6, None))
    return db, valid, C['x'][:w:STEP] + 10 * (STEP - 1), C['y'][:h:STEP] - 10 * (STEP - 1), int(C['epsg'])

def ridge_mask(db, valid):
    fill = np.where(valid, db, np.median(db[valid]))
    sm = ndi.median_filter(fill, 5)                                       # kill speckle
    flat = sm - ndi.gaussian_filter(sm, 30)                              # remove km-scale brightness trends
    r = sato(flat, sigmas=[3, 5, 8], black_ridges=True)                 # dark, line-like features
    r[~ndi.binary_erosion(valid, iterations=8)] = 0
    # ignore rough rocky outcrops: their dark gaps between bright blocks look like lines too
    mean = ndi.uniform_filter(sm, 25); sd = np.sqrt(np.clip(ndi.uniform_filter(sm**2, 25) - mean**2, 0, None))
    rough = (sd > np.percentile(sd[valid], 75)) | (mean > np.percentile(mean[valid], 80))
    r[ndi.binary_dilation(rough, iterations=3)] = 0
    m = r > np.percentile(r[valid], RIDGE_PCT)
    m = binary_closing(m, disk(2))
    m = remove_small_objects(m, 400)
    return m, sm

NB = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]
def trace(skel):
    """Split a skeleton into polylines between endpoints/junctions."""
    pts = set(zip(*np.nonzero(skel)))
    nbrs = lambda p: [(p[0] + a, p[1] + b) for a, b in NB if (p[0] + a, p[1] + b) in pts]
    deg = {p: len(nbrs(p)) for p in pts}
    nodes = {p for p, d in deg.items() if d != 2}
    seen_edges, lines = set(), []
    for n in nodes:
        for nb in nbrs(n):
            if (n, nb) in seen_edges: continue
            path, prev, cur = [n], n, nb
            while True:
                path.append(cur); seen_edges.add((prev, cur)); seen_edges.add((cur, prev))
                if cur in nodes: break
                nxt = [q for q in nbrs(cur) if q != prev and (cur, q) not in seen_edges]
                if not nxt: break
                prev, cur = cur, nxt[0]
            lines.append(np.array(path))
    return lines

def valleys(sm, valid):
    """Wide buried valleys: large, elongated, dark regions at km scale. Returns list of contours (row, col)."""
    from skimage.measure import label, regionprops, find_contours
    from skimage.morphology import binary_opening
    big = ndi.gaussian_filter(sm, 6)
    dark = (big < np.percentile(big[valid], 22)) & ndi.binary_erosion(valid, iterations=10)
    dark = binary_opening(dark, disk(4))
    lab = label(dark); keep = np.zeros_like(dark)
    for r in regionprops(lab):
        if r.area >= 3000 and r.minor_axis_length > 0 and r.major_axis_length / r.minor_axis_length >= 2.5:   # >= ~5 km2, elongated
            keep[lab == r.label] = True
    keep = ndi.binary_fill_holes(keep)
    return [c for c in find_contours(np.pad(keep, 1).astype(float), 0.5) if len(c) > 40]

def narrow_channels(sm, valid, wide):
    """Narrower buried channels (a few hundred metres wide, km long): dark winding bands at ~1 km scale that are
    too thin for valleys() and too wide or rough-edged for the line tracer. Returns contours like valleys()."""
    from skimage.measure import label, regionprops, find_contours
    from skimage.morphology import binary_opening
    flat = ndi.gaussian_filter(sm, 2) - ndi.gaussian_filter(sm, 25)          # local darkness
    ok = ndi.binary_erosion(valid, iterations=10) & ~ndi.binary_dilation(wide, iterations=3)
    dark = binary_opening((flat < np.percentile(flat[ok], 10)) & ok, disk(2))
    lab = label(dark); keep = np.zeros_like(dark)
    for r in regionprops(lab):
        if r.area >= 250 and r.minor_axis_length > 0 and r.major_axis_length / r.minor_axis_length >= 3 and r.major_axis_length >= 60:   # >= 2.4 km long, thin
            keep[lab == r.label] = True
    return [c for c in find_contours(np.pad(keep, 1).astype(float), 0.5) if len(c) > 30]

def chain_length(lines):
    return sum(np.hypot(*np.diff(l, axis=0).T).sum() for l in lines)

def trace_tile(npz):
    """Run the tracer on one tile. Returns dict with 40 m grid arrays, pixel lines, valley contours and masks."""
    db, valid, x, y, epsg = load(npz)
    m, sm = ridge_mask(db, valid)
    skel = skeletonize(m)
    lab, n = ndi.label(skel, structure=np.ones((3, 3)))
    keep = np.zeros_like(skel)
    for i, sl in enumerate(ndi.find_objects(lab), 1):          # keep only long connected networks
        comp = lab[sl] == i
        if comp.sum() >= MIN_LEN_PX: keep[sl] |= comp
    lines = [l for l in trace(keep) if len(l) >= 20]
    vs = valleys(sm, valid)
    from skimage.draw import polygon as fillpoly
    wide = np.zeros(sm.shape, bool)
    for c in vs:
        rr, cc = fillpoly(c[:, 0] - 1, c[:, 1] - 1, wide.shape); wide[rr, cc] = True
    vs = vs + narrow_channels(sm, valid, wide)
    line_mask = np.zeros_like(keep)
    for l in lines: line_mask[l[:, 0], l[:, 1]] = True
    from skimage.draw import polygon as fillpoly
    valley_mask = np.zeros_like(keep)
    for c in vs:
        rr, cc = fillpoly(c[:, 0] - 1, c[:, 1] - 1, valley_mask.shape); valley_mask[rr, cc] = True
    return dict(db=db, sm=sm, valid=valid, x=x, y=y, epsg=epsg, lines=lines, valleys=vs,
                line_mask=line_mask, valley_mask=valley_mask)

def tile_features(T):
    """GeoJSON features (lon/lat) for one traced tile: channel lines + valley polygons."""
    x, y, lines, vs = T['x'], T['y'], T['lines'], T['valleys']
    tf = Transformer.from_crs(T['epsg'], 4326, always_xy=True); out = []
    for l in lines:
        s_ = approximate_polygon(l.astype(float), tolerance=2.0)
        lon, lat = tf.transform(x[s_[:, 1].astype(int)], y[s_[:, 0].astype(int)])
        out.append({'type': 'Feature', 'properties': {'kind': 'channel', 'len_km': round(float(np.hypot(*np.diff(l, axis=0).T).sum()) * 0.04, 2)},
                    'geometry': {'type': 'LineString', 'coordinates': [[round(a, 5), round(b, 5)] for a, b in zip(lon, lat)]}})
    for c in vs:
        c = approximate_polygon(c - 1, tolerance=2.0); c = np.clip(c, 0, [len(y) - 1, len(x) - 1])
        lon, lat = tf.transform(x[c[:, 1].astype(int)], y[c[:, 0].astype(int)])
        out.append({'type': 'Feature', 'properties': {'kind': 'valley', 'area_px': int(len(c))}, 'geometry': {'type': 'Polygon', 'coordinates': [[[round(a, 5), round(b, 5)] for a, b in zip(lon, lat)]]}})
    return out

def main():
    features, dbg = [], []
    out, debug = sys.argv[1], sys.argv[2]
    for npz in sys.argv[3:]:
        T = trace_tile(npz); sm, valid, x, y, epsg, lines, vs = T['sm'], T['valid'], T['x'], T['y'], T['epsg'], T['lines'], T['valleys']
        features += tile_features(T)
        dbg.append((npz, sm, valid, lines, vs))
        print(npz, 'lines', len(lines), 'total km', round(chain_length(lines) * 0.04, 1))
    json.dump({'type': 'FeatureCollection', 'features': features}, open(out, 'w'))
    fig, ax = plt.subplots(1, len(dbg), figsize=(9 * len(dbg), 9), squeeze=False)
    for a, (name, sm, valid, lines, vs) in zip(ax[0], dbg):
        for c in vs: a.fill(c[:, 1] - 1, c[:, 0] - 1, color='#2fd3ff', alpha=.25)
        lo, hi = np.percentile(sm[valid], [2, 98]); a.imshow(sm, cmap='gray', vmin=lo, vmax=hi)
        for l in lines: a.plot(l[:, 1], l[:, 0], color='#2fd3ff', lw=1.2)
        a.set_title(name); a.axis('off')
    plt.tight_layout(); plt.savefig(debug, dpi=55)

if __name__ == '__main__':
    main()
