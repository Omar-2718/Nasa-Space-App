# Beneath the Sand

NASA Space Apps 2026, challenge "Dancing with the SARs". NISAR's L-band radar sees through dry desert sand and shows river channels buried for thousands of years. People and an AI tag them together, and the output is an open map plus field survey plans for archaeologists.

Full plan: see `PLAN.md`.

## Layout
| Folder | What | Owner |
|---|---|---|
| `web/` | React + Vite + TypeScript + MapLibre | UI |
| `api/` | NestJS + Postgres/PostGIS | Backend |
| `ml/` | PyTorch model, trust model, FastAPI service | AI |
| `pipeline/` | Python: download NISAR crops, trace channels, cut patches | anyone |
| `app/` | first prototype (vanilla JS); reference only | |

## Data (not in git)
- `data/` holds raw NISAR crops (`.npz`), re-downloadable with `pipeline/crop_gcov.py` (needs a NASA Earthdata login in `~/.netrc`).
- `data/patches/*.npz`: 461 patches for ML (HH/HV in dB + tracer masks).
- `web_assets/patches/`: patch PNGs + `index.json` served to the web app.
- **Share `data/patches` and `web_assets/` as a zip or on a USB drive.** Don't push them to git.

Coverage: about 12,000 km² near the Egypt–Sudan border (around 22.5–23.1°N, 29.2–31.1°E), NISAR GCOV track 079 descending, 17 Oct 2026.

## Pre-event checklist (slow internet: do these at home)
- [ ] Everyone: `git clone`, then copy the data zip into the repo root
- [ ] `docker compose pull` (PostGIS image, about 400 MB)
- [ ] `cd web && npm install`, `cd api && npm install`
- [ ] AI person: `python -m venv .venv && .venv/bin/pip install -r ml/requirements.txt` (torch is about 2.5 GB)
- [ ] Team: hand-label about 150 patches (gold set)
- [ ] Verify archaeological site coordinates (Bir Safsaf, Wadi Arid, Bir Kiseiba, Nabta Playa, Bir Tarfawi) against the papers
- [ ] Download a Sentinel-2 fallback basemap in case venue internet is bad

## Rebuild data from scratch
```
python3 -m venv .venv && .venv/bin/pip install earthaccess h5py numpy scipy scikit-image pyproj pillow matplotlib rasterio
.venv/bin/python pipeline/crop_gcov.py <lon> <lat> 20 _079_D_077_ data/tiles/<name> 20261017
.venv/bin/python pipeline/make_patches.py
```
