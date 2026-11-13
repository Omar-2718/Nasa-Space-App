// Seed patches (from web_assets/patches/index.json) and known archaeological sites.
// Run: npx tsx prisma/seed.ts   (safe to re-run: upserts patches, replaces sites)
import { PrismaClient } from '@prisma/client';
import { readFileSync, existsSync } from 'node:fs';

const prisma = new PrismaClient();
const ROOT = new URL('../../', import.meta.url).pathname;
const ASSETS = process.env.ASSETS_DIR ?? ROOT + 'web_assets';

type IndexRec = { id: string; tile: string; corners: number[][]; center: number[]; tracer_line_frac: number; tracer_valley_frac: number };

// Only sites with a citable location. 'approximate' = sources disagree or the location is from a database, not a survey.
// Bir Safsaf and Wadi Arid are left out until their coordinates are verified from the 1980s field papers.
const SITES = [
  { name: 'Nabta Playa', kind: 'Neolithic ceremonial site', age: 'c. 7,000–4,500 BCE',
    note: 'Seasonal lake basin with one of the oldest known stone circles.', confidence: 'published',
    url: 'https://en.wikipedia.org/wiki/Nabta_Playa', lon: 30.7256, lat: 22.5080 },
  { name: 'Bir Kiseiba', kind: 'Paleolithic and Neolithic sites', age: 'Middle Pleistocene to Holocene',
    note: 'Sources disagree on longitude (29.92°E vs 30.12°E).', confidence: 'approximate',
    url: 'https://en.wikipedia.org/wiki/Bir_Kiseiba', lon: 29.9167, lat: 22.6833 },
  { name: 'Bir Tarfawi', kind: 'Middle Paleolithic lake sites', age: 'c. 230,000–60,000 years ago',
    note: 'Location from the IntChron database.', confidence: 'approximate',
    url: 'https://intchron.org/record/Egypt', lon: 28.8811, lat: 22.9489 },
];

async function main() {
  const idxPath = ASSETS + '/patches/index.json';
  // A fresh computer has no patch files yet: seed the sites, then add coverage from the app ("Add radar for an area").
  const idx: IndexRec[] = existsSync(idxPath) ? JSON.parse(readFileSync(idxPath, 'utf8')) : [];
  if (!idx.length) console.log('no patch files on this computer yet: use "Add radar for an area" in the app, or unzip the team data pack');
  const aiPath = ASSETS + '/ai_scores.json';
  const ai: Record<string, number> = existsSync(aiPath) ? JSON.parse(readFileSync(aiPath, 'utf8')) : {};
  for (const p of idx) {
    const ring = [...p.corners, p.corners[0]];
    const poly = JSON.stringify({ type: 'Polygon', coordinates: [ring] });
    const pt = JSON.stringify({ type: 'Point', coordinates: p.center });
    await prisma.$executeRaw`
      INSERT INTO patches (id, tile, geom, center, tracer_line, tracer_valley, ai_score)
      VALUES (${p.id}, ${p.tile}, ST_SetSRID(ST_GeomFromGeoJSON(${poly}), 4326), ST_SetSRID(ST_GeomFromGeoJSON(${pt}), 4326),
              ${p.tracer_line_frac}, ${p.tracer_valley_frac}, ${ai[p.id] ?? null})
      ON CONFLICT (id) DO UPDATE SET tracer_line = EXCLUDED.tracer_line, tracer_valley = EXCLUDED.tracer_valley,
                                     ai_score = coalesce(EXCLUDED.ai_score, patches.ai_score)`;
  }
  const modern: string[] = JSON.parse(readFileSync(ROOT + 'pipeline/modern_zones.json', 'utf8')).patches;
  await prisma.patch.updateMany({ data: { modern: false } });
  await prisma.patch.updateMany({ where: { id: { in: modern } }, data: { modern: true } });
  await prisma.$executeRaw`DELETE FROM sites`;
  for (const s of SITES) {
    await prisma.$executeRaw`
      INSERT INTO sites (name, kind, age_text, note, confidence, source_url, geom)
      VALUES (${s.name}, ${s.kind}, ${s.age}, ${s.note}, ${s.confidence}, ${s.url}, ST_SetSRID(ST_MakePoint(${s.lon}, ${s.lat}), 4326))`;
  }
  const [{ n }] = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM patches`;
  console.log(`patches: ${n}, modern: ${modern.length}, sites: ${SITES.length}, ai scores: ${Object.keys(ai).length}`);
}
main().finally(() => prisma.$disconnect());
