# Beneath the Sand

NASA Space Apps 2026, challenge "Dancing with the SARs". NISAR's L-band radar sees through dry desert sand and shows river channels buried for thousands of years. The app traces them from the radar, highlights them on a live map next to known archaeological sites, and turns them into field survey plans for archaeologists.

Full plan: see `PLAN.md`.

## Install and run (for teammates testing it)

### 1. What you need
| Tool | Version | Check | Get it |
|---|---|---|---|
| Git | any | `git --version` | https://git-scm.com |
| Docker | Docker Desktop or Docker Engine, with Compose | `docker compose version` | https://docs.docker.com/get-docker/ |
| Node.js | 20 or newer | `node -v` | https://nodejs.org (LTS) |
| Python | 3.10 or newer, with `venv` | `python3 -m venv --help` | Ubuntu: `sudo apt install python3-venv` |

**Windows:** use WSL2 (Ubuntu) and run everything inside it, because `dev.sh` is a bash script. Docker Desktop has a WSL2 option.
**Linux with Docker Desktop:** if `docker` says it can't connect, start it with `systemctl --user start docker-desktop`.

### 2. Get the code and start
```bash
git clone https://github.com/Omar-2718/Nasa-Space-App.git
cd Nasa-Space-App
./dev.sh
```
The first run takes a few minutes. It installs the npm packages, creates a Python environment in `.venv` (light, no PyTorch), pulls the PostGIS image (about 400 MB), creates the database and seeds it. Later runs start in seconds.

When it prints `running`, open **http://localhost:5173**. Phones on the same Wi-Fi can use the address it prints. Stop everything with Ctrl+C.

### 3. Connect your NASA account (once) and download radar
Radar comes straight from NASA on each computer, so you don't need anyone's data files.
1. Make a free NASA Earthdata account: https://urs.earthdata.nasa.gov/users/new
2. **New accounts only:** log in once at https://search.asf.alaska.edu with that account and accept the data terms. NISAR radar is served by ASF, and it may refuse downloads until you do.
3. Open the app on the computer running it (http://localhost:5173). The first page asks for your Earthdata username and password. The app checks them with NASA and saves them only on that computer, in `~/.netrc`. Phones on the Wi-Fi can't see or change them.
4. **Live map → Add radar for an area:** pick a size and click squares. One 5 km square takes about 30 s on a slow connection. Squares you already have are skipped.

Offline option: `pipeline/pack_data.sh` zips this computer's radar (`beneath-data.zip`). Unzip it in another copy's project folder and run `./dev.sh` again.

### 4. Check it works
- **Tour:** the radar reveal plays.
- **Live map:** the example squares at the top show what a buried river looks like and what doesn't count. **Go to site** jumps to known places (★ = published buried rivers, like the Bir Safsaf radar rivers inside our area).
- **Live map:** blue lines are traced buried channels and blue areas are buried valleys (lines on modern farms are hidden).

### Troubleshooting
| Problem | Fix |
|---|---|
| Port 5433, 3000 or 5173 busy | stop the other program, or change the port in `docker-compose.yml` / `api/.env` (`DATABASE_URL`) |
| `prisma` errors about the database | `docker compose up -d db` and wait a few seconds, then `./dev.sh` again |
| "No NASA Earthdata login" in the app | connect it on the first page (step 3) |
| "NASA refused the download" | new account: do step 3.2, then try again |
| "NISAR has no dual-polarisation data here yet" | NASA hasn't released that area yet; try squares next to existing radar |
| Start from an empty database | `docker compose down -v` (deletes the database), then `./dev.sh` |

### Optional: the AI model (AI person only)
```bash
.venv/bin/pip install -r ml/requirements.txt   # PyTorch, about 2.5 GB: download at home
.venv/bin/python ml/train.py                   # about 1.5 min on an RTX 3050
```

## Layout
| Folder | What | Owner |
|---|---|---|
| `web/` | React + Vite + TypeScript + MapLibre | UI |
| `api/` | Express + Prisma + PostGIS | Backend |
| `ml/` | `train.py` (U-Net), `trust.py` (tagger reliability) | AI |
| `notebooks/` | data pipeline explained (`01_data_pipeline.ipynb`) | everyone |
| `pipeline/` | Python: download NISAR crops, trace channels, cut patches | anyone |
| `app/` | first prototype (vanilla JS); reference only | |

## Known sites
17 places on the map: 4 published buried rivers in gold (Bir Safsaf radar rivers, Wadi Howar, Kufrah radar river, Ahramat Nile Branch) and 13 sites (`api/prisma/seed.ts`), coordinates from Wikipedia's geodata unless marked approximate. Toshka Lakes and Abu Simbel are reference points for checking the radar, not buried-river sites. Oasis and mountain points are centres, not exact dig sites.

## Data (not in git)
- `data/` holds raw NISAR crops (`.npz`), re-downloadable with `pipeline/crop_gcov.py` (needs a NASA Earthdata login in `~/.netrc`).
- `data/patches/*.npz`: 461 patches for ML (HH/HV in dB + tracer masks).
- `web_assets/patches/`: patch PNGs + `index.json` served to the web app.
- **Datasets never go in git.** Make a data pack with `pipeline/pack_data.sh` (creates `beneath-data.zip`) and share it by USB or Drive; teammates unzip it in the project root.
- No data pack? Use **Live map → Add radar for an area** (see install step 3B).

Coverage: about 12,000 km² near the Egypt–Sudan border (around 22.5–23.1°N, 29.2–31.1°E), NISAR GCOV track 079 descending, 17 Oct 2026.

## Pre-event checklist (slow internet: do these at home)
- [ ] Everyone: `git clone`, make an Earthdata account, accept the ASF terms (step 3)
- [ ] `docker compose pull` (PostGIS image, about 400 MB)
- [ ] `cd web && npm install`, `cd api && npm install`
- [ ] AI person: `python -m venv .venv && .venv/bin/pip install -r ml/requirements.txt` (torch is about 2.5 GB)
- [ ] Team: hand-label about 150 patches (gold set)
- [ ] Find published coordinates for Wadi Arid (not on the map) and exact ones for Bir Kiseiba and the Bir Safsaf channels (map points are approximate)
- [ ] Download a Sentinel-2 fallback basemap in case venue internet is bad

## Rebuild data from scratch
```
python3 -m venv .venv && .venv/bin/pip install earthaccess h5py numpy scipy scikit-image pyproj pillow matplotlib rasterio
.venv/bin/python pipeline/crop_gcov.py <lon> <lat> 20 _079_D_077_ data/tiles/<name> 20261017
.venv/bin/python pipeline/make_patches.py
```
