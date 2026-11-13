// Map layers, candidate ranking, survey-plan exports and stats.
import { Router } from 'express';
import { readFileSync } from 'node:fs';
import { prisma, num, patchImages } from '../db.js';

export const maps = Router();

type ConsRow = { id: string; geom: string; votes: bigint; channel_share: number | null; ai_score: number | null; tracer_line: number; modern?: boolean };

maps.get('/consensus', async (_req, res) => {
  const rows = await prisma.$queryRaw<ConsRow[]>`
    SELECT p.id, ST_AsGeoJSON(p.geom) AS geom, c.votes, c.channel_share, p.ai_score, p.tracer_line, p.modern
    FROM patches p JOIN consensus c ON c.id = p.id`;
  res.json({
    type: 'FeatureCollection',
    features: rows.map(r => ({
      type: 'Feature', geometry: JSON.parse(r.geom),
      properties: { id: r.id, votes: num(r.votes), channelShare: r.channel_share, ai: r.ai_score, tracer: Math.min(1, r.tracer_line * 40), modern: !!r.modern },
    })),
  });
});

maps.get('/sites', async (_req, res) => {
  const rows = await prisma.$queryRaw<{ id: number; name: string; kind: string; age_text: string; note: string; confidence: string; source_url: string; g: string }[]>`
    SELECT id, name, kind, age_text, note, confidence, source_url, ST_AsGeoJSON(geom) AS g FROM sites`;
  res.json({ type: 'FeatureCollection', features: rows.map(({ g, ...p }) => ({ type: 'Feature', geometry: JSON.parse(g), properties: p })) });
});

// Rank patches for field survey: crowd agreement, AI score and closeness to known sites.
type Cand = { id: string; lon: number; lat: number; votes: bigint; channel_share: number | null; ai_score: number | null; tracer_line: number; site: string | null; dist_km: number | null };
async function candidates(limit: number) {
  const rows = await prisma.$queryRaw<Cand[]>`
    SELECT p.id, ST_X(p.center) AS lon, ST_Y(p.center) AS lat, c.votes, c.channel_share, p.ai_score, p.tracer_line,
           s.name AS site, s.dist_km
    FROM patches p JOIN consensus c ON c.id = p.id
    LEFT JOIN LATERAL (
      SELECT name, ST_Distance(p.center::geography, geom::geography) / 1000 AS dist_km FROM sites ORDER BY p.center <-> geom LIMIT 1
    ) s ON true
    WHERE NOT p.modern`;
  return rows.map(r => {
    const crowd = r.channel_share, ai = r.ai_score ?? Math.min(1, r.tracer_line * 40);
    const proximity = r.dist_km === null ? 0 : Math.exp(-r.dist_km / 40);
    const votes = num(r.votes) as number;
    // crowd counts more as votes accumulate; with no votes the AI carries the score
    const wCrowd = crowd === null ? 0 : Math.min(votes, 5) / 5 * 0.6;
    const score = wCrowd * (crowd ?? 0) + (0.8 - wCrowd) * ai + 0.2 * proximity;
    const why: string[] = [];
    if (crowd !== null && votes) why.push(`${Math.round(crowd * 100)}% of ${votes} taggers saw a channel`);
    why.push(`${r.ai_score === null ? 'Tracer' : 'AI'} ${Math.round(ai * 100)}%`);
    if (r.site && r.dist_km !== null) why.push(`${Math.round(r.dist_km)} km from ${r.site}`);
    return { id: r.id, lon: r.lon, lat: r.lat, score: +score.toFixed(3), votes, crowd, ai, nearestSite: r.site, distKm: r.dist_km && +r.dist_km.toFixed(1), why, images: patchImages(r.id) };
  }).sort((a, b) => b.score - a.score).slice(0, limit);
}

maps.get('/candidates', async (req, res) => res.json(await candidates(Math.min(100, Number(req.query.limit ?? 20)))));

// Survey plan exports for field teams: KML (Google Earth), GPX (handheld GPS), CSV.
maps.get('/export/:fmt', async (req, res) => {
  const ids = typeof req.query.ids === 'string' && req.query.ids ? new Set(req.query.ids.split(',')) : null;
  let list = await candidates(ids ? 500 : Math.min(100, Number(req.query.limit ?? 20)));
  if (ids) list = list.filter(c => ids.has(c.id));
  const esc = (s: string) => s.replace(/[<>&"]/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[ch]!));
  const name = (c: (typeof list)[number], i: number) => `Target ${i + 1} (score ${c.score})`;
  const fmt = req.params.fmt;
  if (fmt === 'csv') {
    res.type('text/csv').attachment('survey-plan.csv');
    return res.send(['rank,id,lat,lon,score,votes,crowd_share,ai,nearest_site,dist_km,why',
      ...list.map((c, i) => [i + 1, c.id, c.lat.toFixed(5), c.lon.toFixed(5), c.score, c.votes, c.crowd ?? '', c.ai.toFixed(2), c.nearestSite ?? '', c.distKm ?? '', `"${c.why.join('; ')}"`].join(','))].join('\n'));
  }
  if (fmt === 'gpx') {
    res.type('application/gpx+xml').attachment('survey-plan.gpx');
    return res.send(`<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Beneath the Sand" xmlns="http://www.topografix.com/GPX/1/1">
${list.map((c, i) => `  <wpt lat="${c.lat.toFixed(6)}" lon="${c.lon.toFixed(6)}"><name>${esc(name(c, i))}</name><desc>${esc(c.why.join('; '))}</desc></wpt>`).join('\n')}
</gpx>`);
  }
  if (fmt === 'kml') {
    res.type('application/vnd.google-earth.kml+xml').attachment('survey-plan.kml');
    return res.send(`<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Beneath the Sand: survey plan</name>
${list.map((c, i) => `<Placemark><name>${esc(name(c, i))}</name><description>${esc(c.why.join('\n'))}</description><Point><coordinates>${c.lon.toFixed(6)},${c.lat.toFixed(6)},0</coordinates></Point></Placemark>`).join('\n')}
</Document></kml>`);
  }
  res.status(400).json({ error: 'format must be kml, gpx or csv' });
});

// Open data: every patch with crowd labels and AI score, as GeoJSON (CC-BY 4.0).
maps.get('/dataset.geojson', async (_req, res) => {
  const rows = await prisma.$queryRaw<(ConsRow & { gold_label: string | null })[]>`
    SELECT p.id, ST_AsGeoJSON(p.geom) AS geom, c.votes, c.channel_share, p.ai_score, p.tracer_line, p.gold_label
    FROM patches p JOIN consensus c ON c.id = p.id`;
  res.attachment('beneath-the-sand-labels.geojson').json({
    type: 'FeatureCollection', license: 'CC-BY-4.0', source: 'NISAR L2 GCOV (NASA/ISRO), crowd labels from Beneath the Sand',
    features: rows.map(r => ({ type: 'Feature', geometry: JSON.parse(r.geom), properties: { id: r.id, votes: num(r.votes), channelShare: r.channel_share, ai: r.ai_score, tracer: r.tracer_line, gold: r.gold_label } })),
  });
});

maps.get('/metrics', async (_req, res) => {
  try { res.json(JSON.parse(readFileSync(new URL('../../../ml/metrics.json', import.meta.url), 'utf8'))); }
  catch { res.status(404).json({ error: 'model not trained yet' }); }
});

maps.get('/stats', async (_req, res) => {
  const [s] = await prisma.$queryRaw<Record<string, bigint>[]>`
    SELECT (SELECT count(*) FROM patches) AS patches, (SELECT count(*) FROM tags WHERE NOT is_quiz) AS tags,
           (SELECT count(*) FROM sessions) AS people, (SELECT count(DISTINCT patch_id) FROM tags WHERE NOT is_quiz) AS tagged,
           (SELECT count(*) FROM sessions WHERE flagged) AS flagged, (SELECT count(*) FROM patches WHERE gold_label IS NOT NULL) AS gold`;
  res.json(Object.fromEntries(Object.entries(s).map(([k, v]) => [k, num(v)])));
});
