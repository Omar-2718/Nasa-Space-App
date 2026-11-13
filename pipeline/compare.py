import numpy as np, matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt, sys
from scipy.signal import fftconvolve
d, a, b, out = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
A = np.load(f"{d}/{a}.npz"); B = np.load(f"{d}/{b}.npz")
db = lambda v: 10*np.log10(np.clip(np.nan_to_num(v), 1e-5, None))
ha, hb = db(A['HH']), db(B['HH'])
lo, hi = np.nanpercentile(ha, [2, 98])
fig, ax = plt.subplots(1, 3, figsize=(18, 6.4))
ax[0].imshow(ha, cmap='gray', vmin=lo, vmax=hi); ax[0].set_title(f'HH {a}')
ax[1].imshow(hb, cmap='gray', vmin=lo, vmax=hi); ax[1].set_title(f'HH {b}')
diff = hb - ha
ax[2].imshow(diff, cmap='RdBu_r', vmin=-6, vmax=6); ax[2].set_title(f'change dB ({b} - {a}); red=brighter')
for x in ax: x.axis('off')
plt.tight_layout(); plt.savefig(out, dpi=80)
# global shift check via phase correlation on a centre patch (should be ~0 for stable ground)
def shift(p, q):
    F = np.fft.fft2(p - p.mean()) * np.conj(np.fft.fft2(q - q.mean())); r = np.fft.ifft2(F / (abs(F) + 1e-9)).real
    i = np.unravel_index(r.argmax(), r.shape); return [(v if v < s/2 else v - s) for v, s in zip(i, r.shape)]
print('global shift px', shift(ha, hb), '| mean |diff| dB', np.nanmean(abs(diff)).round(2), '| HH range', lo.round(1), hi.round(1))
