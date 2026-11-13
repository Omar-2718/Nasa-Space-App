"""Stream a lat/lon crop of HH/HV from NISAR GCOV granules (one track/frame) and save as .npz."""
import earthaccess, h5py, numpy as np, sys, os
from pyproj import Transformer
lon, lat, half_km = float(sys.argv[1]), float(sys.argv[2]), float(sys.argv[3])
tag, out = sys.argv[4], sys.argv[5]          # tag e.g. _079_D_076_
dates = sys.argv[6].split(',') if len(sys.argv) > 6 else None
earthaccess.login(strategy="netrc")
res = earthaccess.search_data(short_name="NISAR_L2_GCOV_PROVISIONAL_V1", point=(lon, lat))
if tag == 'auto':   # pick the track/frame with the most dates
    import collections
    key = lambda r: '_' + '_'.join(r['umm']['GranuleUR'].split('_')[5:8]) + '_'
    tag = collections.Counter(map(key, res)).most_common(1)[0][0]; print('track', tag)
res = [r for r in res if tag in r['umm']['GranuleUR']]
res.sort(key=lambda r: r['umm']['GranuleUR'].split('_')[11])
if dates == ['ends']:
    dp = [r for r in res if 'DHDH' in r['umm']['GranuleUR']] or res
    res = [dp[0], dp[-1]]
elif dates: res = [r for r in res if r['umm']['GranuleUR'].split('_')[11][:8] in dates]
os.makedirs(out, exist_ok=True)
for r, f in zip(res, earthaccess.open(res)):
    d = r['umm']['GranuleUR'].split('_')[11][:8]
    if os.path.exists(f"{out}/{d}.npz"): print(d, 'cached'); continue
    g = h5py.File(f, 'r')['science/LSAR/GCOV/grids/frequencyA']
    if 'HVHV' not in g: print(d, 'skipped: no HV (single-pol)'); continue
    epsg = int(g['projection'][()]); x = g['xCoordinates'][:]; y = g['yCoordinates'][:]
    X, Y = Transformer.from_crs(4326, epsg, always_xy=True).transform(lon, lat)
    h = half_km * 1000
    ix = np.where((x > X - h) & (x < X + h))[0]; iy = np.where((y > Y - h) & (y < Y + h))[0]
    sl = (slice(iy[0], iy[-1] + 1), slice(ix[0], ix[-1] + 1))
    np.savez_compressed(f"{out}/{d}.npz", HH=g['HHHH'][sl], HV=g['HVHV'][sl], x=x[ix], y=y[iy], epsg=epsg)
    print(d, 'epsg', epsg, 'spacing', g['xCoordinateSpacing'][()], 'crop', g['HHHH'][sl].shape, flush=True)
