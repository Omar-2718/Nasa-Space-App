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
// Coordinates: Wikipedia geodata (checked 2026-11-13) unless noted. Oasis/mountain points are centres, not exact sites.
const SITES = [
  { name: 'Nabta Playa', kind: 'Neolithic ceremonial site', age: 'c. 7,000–4,500 BCE',
    note: 'Seasonal lake basin with one of the oldest known stone circles.', confidence: 'published',
    url: 'https://en.wikipedia.org/wiki/Nabta_Playa', lon: 30.7256, lat: 22.508 },
  { name: 'Gebel Ramlah', kind: 'Neolithic cemeteries by an ancient lake', age: 'c. 4,600–4,000 BCE',
    note: 'Graves on the shore of a dried playa, about 20 km west of Nabta.', confidence: 'published',
    url: 'https://en.wikipedia.org/wiki/Gebel_Ramlah', lon: 30.5047, lat: 22.7103 },
  { name: 'Bir Kiseiba', kind: 'Paleolithic and Neolithic sites', age: 'Middle Pleistocene to Holocene',
    note: 'Sources disagree on longitude (29.92°E vs 30.12°E).', confidence: 'approximate',
    url: 'https://en.wikipedia.org/wiki/Bir_Kiseiba', lon: 29.9167, lat: 22.6833 },
  { name: 'Bir Tarfawi', kind: 'Middle Paleolithic lake sites', age: 'c. 230,000–60,000 years ago',
    note: 'Location from the IntChron database.', confidence: 'approximate',
    url: 'https://intchron.org/record/Egypt', lon: 28.8811, lat: 22.9489 },
  { name: 'Selima Oasis', kind: 'Oasis with prehistoric lake deposits', age: 'Pleistocene to Holocene',
    note: 'Sudan. Ancient lake sediments and stone-tool sites.', confidence: 'published',
    url: 'https://en.wikipedia.org/wiki/Selima_Oasis', lon: 29.3167, lat: 21.3667 },
  { name: 'Wadi Howar', kind: "Dried river (the 'Yellow Nile')", age: 'Active until c. 2,000 BCE',
    note: 'Sudan. Once a Nile tributary; a known buried-river check for the radar.', confidence: 'published',
    url: 'https://en.wikipedia.org/wiki/Wadi_Howar', lon: 30.7406, lat: 18.1989 },
  { name: 'Gebel Uweinat', kind: 'Mountain with prehistoric rock art', age: 'Holocene',
    note: 'Egypt–Libya–Sudan corner.', confidence: 'published',
    url: 'https://en.wikipedia.org/wiki/Jebel_Uweinat', lon: 25.0167, lat: 21.9167 },
  { name: 'Gilf Kebir', kind: 'Plateau with wadis and rock art', age: 'Holocene',
    note: "Remote plateau in Egypt's far southwest.", confidence: 'published',
    url: 'https://en.wikipedia.org/wiki/Gilf_Kebir', lon: 25.8397, lat: 23.4414 },
  { name: 'Cave of Swimmers', kind: 'Rock-art shelter (Wadi Sura)', age: 'c. 8,000 years ago',
    note: 'Paintings of people swimming, from a wetter Sahara.', confidence: 'published',
    url: 'https://en.wikipedia.org/wiki/Cave_of_Swimmers', lon: 25.2335, lat: 23.5947 },
  { name: 'Cave of Beasts', kind: 'Rock-art shelter (Wadi Sura)', age: 'c. 8,000 years ago',
    note: 'Thousands of painted figures.', confidence: 'published',
    url: 'https://en.wikipedia.org/wiki/Cave_of_Beasts', lon: 25.1597, lat: 23.6533 },
  { name: 'Toshka Lakes', kind: 'Modern lakes from Nile overflow (reference)', age: '1998 onward',
    note: 'Not archaeological: a check that radar shows water and farms correctly.', confidence: 'published',
    url: 'https://en.wikipedia.org/wiki/Toshka_Lakes', lon: 30.9, lat: 23.1 },
  { name: 'Abu Simbel', kind: 'Temples on the Nile (reference)', age: 'c. 1,260 BCE',
    note: 'Not a buried-river site: a well-known landmark to orient yourself.', confidence: 'published',
    url: 'https://en.wikipedia.org/wiki/Abu_Simbel', lon: 31.6256, lat: 22.3369 },
  { name: 'Kharga Oasis', kind: 'Oasis with Paleolithic spring sites', age: 'Pleistocene to present',
    note: 'Fossil spring mounds and stone tools.', confidence: 'published',
    url: 'https://en.wikipedia.org/wiki/Kharga_Oasis', lon: 30.5583, lat: 25.4383 },
  { name: 'Dakhla Oasis', kind: 'Oasis with prehistoric lake beds', age: 'Pleistocene to present',
    note: 'Ancient lake sediments and Neolithic sites.', confidence: 'published',
    url: 'https://en.wikipedia.org/wiki/Dakhla_Oasis', lon: 28.9792, lat: 25.5 },
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
