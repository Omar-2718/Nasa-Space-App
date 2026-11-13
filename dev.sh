#!/bin/bash
# One command for a fresh clone or a daily start: sets up what's missing, then runs
# PostGIS (docker, :5433), API (:3000), web (:5173) and the trust model loop.
# Works with no radar data: add areas from the app's Live map, or unzip the team data pack first.
set -e
cd "$(dirname "$0")"

say() { printf '\n\033[1;33m== %s\033[0m\n' "$*"; }

command -v docker >/dev/null || { echo "Docker is required (Docker Desktop is fine)."; exit 1; }
command -v node   >/dev/null || { echo "Node.js 20+ is required."; exit 1; }

[ -f api/.env ] || { say "creating api/.env"; cp api/.env.example api/.env; }
[ -d api/node_modules ] || { say "installing API packages"; (cd api && npm install); }
[ -d web/node_modules ] || { say "installing web packages"; (cd web && npm install); }
if [ ! -x .venv/bin/python ]; then
  say "creating Python environment (pipeline + trust model)"
  python3 -m venv .venv && .venv/bin/pip install -q -r pipeline/requirements.txt
fi

say "starting database"
docker compose up -d db
until docker compose exec -T db pg_isready -U sand >/dev/null 2>&1; do sleep 1; done
(cd api && npx prisma generate >/dev/null && npx prisma migrate deploy >/dev/null && npx tsx prisma/seed.ts)

# map layers: build them if this PC has radar tiles but no mosaic yet (e.g. right after unzipping the data pack)
if ls data/tiles/*/*.npz data/safsaf*/*.npz >/dev/null 2>&1 && [ ! -f web_assets/mosaic.json ]; then
  say "building map layers"; .venv/bin/python -W ignore pipeline/make_mosaic.py
fi
[ -f ~/.netrc ] || echo "note: no NASA Earthdata login in ~/.netrc, so 'Add radar for an area' won't work until you add one (see README)."

say "running: web http://localhost:5173  (phones: http://$(hostname -I 2>/dev/null | awk '{print $1}'):5173)"
trap 'kill 0' EXIT
(cd api && npx tsx watch src/index.ts) &
(cd web && npx vite --host) &
.venv/bin/python ml/trust.py --loop 30 &
wait
