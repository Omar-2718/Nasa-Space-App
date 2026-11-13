import earthaccess, h5py, sys
earthaccess.login(strategy="netrc")
res = earthaccess.search_data(short_name="NISAR_L2_GCOV_PROVISIONAL_V1", point=(30.55,25.2))
res = [r for r in res if "_079_D_076_" in r['umm']['GranuleUR']]
res.sort(key=lambda r: r['umm']['GranuleUR'].split('_')[11])
print(len(res), [r['umm']['GranuleUR'].split('_')[11][:8] for r in res])
f = earthaccess.open([res[0]])[0]
h = h5py.File(f, 'r')
def show(name, obj):
    if isinstance(obj, h5py.Dataset) and ('grids' in name or 'projection' in name.lower()) and obj.ndim<=2:
        print(name, obj.shape, obj.dtype)
h.visititems(show)
