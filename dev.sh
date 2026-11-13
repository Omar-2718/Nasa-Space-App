#!/bin/bash
# Start everything for local development: database, API (:3000), web (:5173), trust model loop.
set -e
cd "$(dirname "$0")"
docker compose up -d db
until docker compose exec -T db pg_isready -U sand >/dev/null 2>&1; do sleep 1; done
(cd api && npx prisma migrate deploy >/dev/null && npx tsx prisma/seed.ts)
trap 'kill 0' EXIT
(cd api && npx tsx watch src/index.ts) &
(cd web && npx vite --host) &
.venv/bin/python ml/trust.py --loop 30 &
wait
