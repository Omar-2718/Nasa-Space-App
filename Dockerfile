FROM node:22-bookworm-slim AS build

RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY web/package*.json ./web/
RUN cd web && npm ci
COPY web ./web
RUN cd web && npm run build

COPY api/package*.json ./api/
RUN cd api && npm ci
COPY api ./api
RUN cd api && npx prisma generate && npm run build

FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/api/package.json ./api/package.json
COPY --from=build /app/api/node_modules ./api/node_modules
COPY --from=build /app/api/dist ./api/dist
COPY --from=build /app/api/prisma ./api/prisma
COPY --from=build /app/web/dist ./web/dist
COPY web_assets ./web_assets
COPY pipeline/modern_zones.json ./pipeline/modern_zones.json

WORKDIR /app/api
EXPOSE 3000
CMD ["sh", "-c", "./node_modules/.bin/prisma migrate deploy && ./node_modules/.bin/tsx prisma/seed.ts && node dist/index.js"]
