# Beneath the Sand: 24-hour hackathon build plan

## Context
NASA Space Apps 2026 (Egypt), challenge "Dancing with the SARs". We validated on real NISAR data that L-band radar shows buried river channels at Bir Safsaf that are invisible in optical photos. That's where 1980s field teams found Acheulean hand-axes in channel sediments. There's no public, open map of these channels, and research papers name **lack of labeled data** as the bottleneck for AI mapping.

**Product:** an open platform where **NISAR + crowd tagging + an AI model** map buried rivers, and the output is a **field survey plan** (ranked GPS targets plus KML/GPX) that archaeology teams can take into the desert. That's the "do what": walk the old riverbanks, check for surface artifacts, dig test pits.

Existing prototype (keep for reference, port its logic): `app/` (vanilla MapLibre, swipe and tour), `scripts/` (data pipeline). Git repo at `/home/omar/projects/nasa`.

## Team and stack
| Person | Role | Stack |
|---|---|---|
| UI ×1 (+1 shared) | `web/` | React + Vite + TypeScript + MapLibre GL + Tailwind |
| Backend ×3 (Express/Nest) | `api/` | **NestJS** + Postgres/**PostGIS** (team knows Node; better than FastAPI for them) |
| AI ×1 | `ml/` | Python, PyTorch, `segmentation_models_pytorch`, small **FastAPI** inference service |
| Anyone | `pipeline/` | existing Python scripts |

Everything runs under `docker-compose.yml`: `db` (postgis/postgis), `api`, `ml`, `web`.

## Repo layout (monorepo, reuse current repo)
```
web/        React app (port tour + swipe from app/app.js)
api/        NestJS: patches, tags, consensus, candidates, exports, live updates (SSE)
ml/         train.py, predict.py, service.py (FastAPI /predict, /scan)
pipeline/   move scripts/ here + new make_patches.py, seed_db.py
data/       downloaded crops (gitignored), patches/ (served statically)
app/        old prototype (frozen)
```

## Data model (PostGIS)
- `patches(id, geom bbox, center, region, radar_png, optical_png, ai_mask_png, ai_score, tracer_score)`
- `tags(id, patch_id, session_id, label ENUM(channel, site_feature, nothing, unsure), line geometry NULL, created_at)`
- `sites(id, name, kind, age_text, geom, source_url)`: known archaeological sites (Bir Safsaf, Wadi Arid, Bir Kiseiba, Nabta Playa, Bir Tarfawi). **Coordinates verified from sources before seeding.**
- `candidates` view: per patch `priority = consensus_channel × ai_score × proximity_to_known_site`.

## Features, in build priority order
1. **Landing + guided tour**: port the existing tour, swipe, pulse and sweep (`app/app.js`: `goStep`, `setHighlight`, `sweep`, two synced maps) into React.
2. **Tag mode ("Desert Detectives")**: show a radar patch and its photo, with the AI suggestion toggleable. Buttons 1–4 (channel / site-like feature / nothing / unsure), optional "draw the channel" line tool, progress and streak counter. `POST /tags`.
3. **Community map**: live layers for consensus (heat by vote share), AI predictions, traced channels and known sites. Updates via SSE when anyone tags, so judges see their own tags appear.
4. **Field planner**: select top candidates. Each gets a survey card (coordinates, priority, nearest known site and distance, why it ranked) plus export to **KML / GPX / CSV** (`GET /export/*`).
5. **AI loop**: the model pre-tags every patch. A retrain script runs on crowd votes during the event, and a metrics panel shows precision/recall against held-out human labels. **Demo moment:** the model finds channels in a region nobody tagged.
6. **Open data page**: download patches, labels and predictions (CC-BY), framed as the training set the research field lacks.
7. **Trust model (filters false positives and trolls)**: gold patches (about 1 in 10, from the team's hand labels) give each person an accuracy weight. Behavior flags: under 1 s per answer, always the same button, constant disagreement. Dawid–Skene EM estimates tagger reliability without gold. Output: per-tag `p_correct`; low-trust users are down-weighted, never deleted. Lives in `ml/trust.py`, run on a timer, writes `tags.p_correct` and `sessions.trust`.
8. **AI hint after answering**: the AI guess is hidden until the person tags ("You said river. AI said 74%"), so taggers don't copy it. Uncertain patches are served first (active learning).
9. **60-second guide + practice quiz**: the goal ("your tags show archaeologists where to walk and dig"), how radar sees under sand, river vs not-river examples (rock cracks: straight and angular; dunes: evenly spaced parallel; tracks: perfectly straight; speckle: random), then a 5-gold-patch quiz that sets the starting trust score.

## AI approach (realistic for 24 h)
- **Labels:** pseudo-labels from the existing tracer (`scripts/trace_channels.py`: `ridge_mask`, `valleys`), plus about 150 patches hand-labeled by the team before the event (validation set), plus crowd votes during the event.
- **Model:** U-Net with a pretrained ResNet18 encoder. Input is 3 channels (HH, HV, HH−HV) at 256×256 pixels and 20 m resolution (5 km patches). Output is a per-pixel channel mask and a per-patch score.
- **Train before the event** on pseudo-labels (CPU is OK at this size, or use a free Kaggle/Colab GPU). Fine-tune during the event with crowd-weighted labels.
- **Scan:** run on extra pre-downloaded tiles outside the tagged area to produce "new candidates".
- **Honesty line in the pitch:** these are candidates for experts, not discoveries.

## Pre-event prep (data prep is allowed; internet is slow)
1. **Download:** widen coverage from 80×80 km to roughly 200×200 km (Bir Safsaf → Wadi Arid → Bir Kiseiba → Nabta Playa) with `scripts/crop_gcov.py` (about 23 MB per 40 km tile at full resolution). Use NISAR's coarse frequency B layer (80 m, 16× smaller) for any wider scan.
2. **Optical patches:** pre-fetch Sentinel-2 patches with `scripts/optical.py`, so the demo works offline if the Esri basemap is slow.
3. **Patches:** `pipeline/make_patches.py` cuts the mosaic into 5 km patches (radar PNG, photo PNG, tracer mask, bbox JSON). Reuse the mosaic code in `scripts/export_app_data.py`.
4. **Labels and model:** the team hand-labels about 150 patches, and the baseline model is trained.
5. **Sites:** research and verify known site coordinates and sources.
6. **Scaffolding:** a repo skeleton with docker-compose (empty services) is ready to `git clone`.

## 24-hour timeline
| Hours | UI | Backend | AI |
|---|---|---|---|
| 0–2 | Vite scaffold, map, routing | Nest + PostGIS schema, seed patches and sites | Load baseline model, `/predict` service |
| 2–8 | Port tour, tag-mode UI | `/patches/next`, `/tags`, consensus SQL | Batch-predict all patches, write `ai_score` |
| 8–14 | Community map layers, live updates | SSE, `/candidates`, exports (KML/GPX/CSV) | Retrain script on votes, metrics |
| 14–18 | Field planner, open-data page | Docker polish, deploy | Scan new region, "new candidates" layer |
| 18–22 | Polish, mobile layout | Bug fixes, load test | Final retrain, numbers for the pitch |
| 22–24 | Demo rehearsal, video, slides (everyone) | | |

## Pitch demo flow (3 min)
1. **Tour:** empty sand, then the radar reveal, then the rivers (the existing wow moment).
2. **Context:** "In 1982, teams dug here and found hand-axes hundreds of thousands of years old. The Sahara is 9M km², and nobody can walk it."
3. **Hand a judge a phone:** they tag 3 patches live, and their tags pop up on the big screen.
4. **AI:** it learned from tags and found channels in an untouched region.
5. **Field planner:** export a survey plan, open it in Google Earth.
6. **Close:** open dataset, NISAR repeats every 12 days, and it scales to the whole Sahara.

## Risks and mitigations
- **Slow internet at the venue:** all data is pre-downloaded; serve patches locally; keep a Sentinel-2 fallback basemap.
- **The model is weak:** show the tracer baseline against the model honestly; the loop matters more than accuracy.
- **Overclaiming:** say "candidates" everywhere; cite the 1981–82 fieldwork.
- **Integration failures late in the event:** freeze API contracts (OpenAPI) in hour 2; the web app works on mock JSON until the API is ready.

## Verification
- `docker compose up` brings up db, api, ml and web; `pipeline/seed_db.py` loads the patches and sites.
- Tag flow end to end in Chrome: tag patches, see rows in `tags`, consensus map updates in a **second browser** within a couple of seconds via SSE.
- `GET /export/kml` opens correctly in Google Earth with candidates placed on the right coordinates (spot-check against the radar mosaic).
- ML: `train.py` reports validation IoU/precision on the hand-labeled set; `/predict` returns a mask for a sample patch; scan output renders as a layer.
- Full pitch run-through with a timer, on venue-like slow or no internet.
