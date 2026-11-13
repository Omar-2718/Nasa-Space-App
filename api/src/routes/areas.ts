// On-demand coverage: download NISAR radar for a clicked area and cut it into patches (pipeline/add_area.py).
// One job at a time; progress goes to every browser over SSE ('area' events) and to GET /api/areas/job.
import { Router } from 'express';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { prisma, ASSETS } from '../db.js';
import { broadcast } from '../live.js';

export const areas = Router();
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const PY = process.env.PYTHON ?? ROOT + '.venv/bin/python';

type Job = { lon: number; lat: number; n?: number; cells?: string[]; mbDone?: number; mbTotal?: number; step: string; pct: number; state: 'running' | 'done' | 'error'; message?: string; added?: number; started: number };
let job: Job | null = null;

// What this computer has: patch images on disk, patches in the DB, a NASA login, the Python env.
areas.get('/setup', async (_req, res) => {
  const patchesInDb = await prisma.patch.count();
  res.json({
    patchesInDb,
    patchFilesOnDisk: existsSync(ASSETS + '/patches/index.json'),
    earthdataLogin: existsSync(homedir() + '/.netrc'),
    python: existsSync(PY),
    job,
  });
});

areas.get('/areas/job', (_req, res) => res.json(job));

type Cell = { gx: number; gy: number; id: string; exists: boolean; geometry: { type: string; coordinates: number[][][] } };

// Grid cells (5.12 km, same UTM grid as the patches) for an n x n block around a clicked point.
// The UTM zone follows the patches already nearby (NISAR frames here use zone 36), else the point's own zone.
async function previewCells(lon: number, lat: number, n: number): Promise<{ epsg: number; cells: Cell[] }> {
  const [z] = await prisma.$queryRaw<{ epsg: number | null }[]>`
    SELECT split_part(id, '_', 1)::int AS epsg FROM patches
    WHERE ST_DWithin(center::geography, ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326)::geography, 200000)
    GROUP BY 1 ORDER BY count(*) DESC LIMIT 1`;
  const epsg = z?.epsg ?? (lat >= 0 ? 32600 : 32700) + Math.floor((lon + 180) / 6) + 1;
  const lo = Math.floor((n - 1) / 2), hi = Math.floor(n / 2);
  const rows = await prisma.$queryRaw<{ gx: number; gy: number; exists: boolean; g: string }[]>`
    WITH p AS (SELECT ST_Transform(ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326), ${epsg}::int) AS g),
         c AS (SELECT floor(ST_X(g) / 5120)::int AS cx, floor(ST_Y(g) / 5120)::int AS cy FROM p)
    SELECT gx, gy,
           EXISTS (SELECT 1 FROM patches WHERE id = ${epsg}::text || '_' || gx || '_' || gy) AS exists,
           ST_AsGeoJSON(ST_Transform(ST_MakeEnvelope(gx * 5120, gy * 5120, (gx + 1) * 5120, (gy + 1) * 5120, ${epsg}::int), 4326), 6) AS g
    FROM c, generate_series(c.cx - ${lo}::int, c.cx + ${hi}::int) gx, generate_series(c.cy - ${lo}::int, c.cy + ${hi}::int) gy`;
  return { epsg, cells: rows.map(r => ({ gx: r.gx, gy: r.gy, id: `${epsg}_${r.gx}_${r.gy}`, exists: r.exists, geometry: JSON.parse(r.g) })) };
}

const sizeParam = (v: unknown) => Math.min(10, Math.max(1, Math.round(Number(v ?? 3)) || 3));

areas.get('/areas/preview', async (req, res) => {
  const lon = Number(req.query.lon), lat = Number(req.query.lat);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return res.status(400).json({ error: 'lon and lat are required' });
  const p = await previewCells(lon, lat, sizeParam(req.query.n));
  res.json({ ...p, missing: p.cells.filter(c => !c.exists).length });
});

areas.post('/areas', async (req, res) => {
  const lon = Number(req.body?.lon), lat = Number(req.body?.lat), n = sizeParam(req.body?.n);
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 85) return res.status(400).json({ error: 'lon and lat are required' });
  if (job?.state === 'running') return res.status(409).json({ error: 'Another area is downloading. Wait for it to finish.', job });
  if (!existsSync(PY)) return res.status(500).json({ error: 'Python environment not found (.venv). See README.' });

  const { epsg, cells } = await previewCells(lon, lat, n);
  const missing = cells.filter(c => !c.exists);
  if (!missing.length) {
    job = { lon, lat, n, step: 'Done', pct: 100, state: 'done', added: 0, message: 'Already covered: nothing to download.', started: Date.now() };
    broadcast('area', job); return res.json(job);
  }
  job = { lon, lat, n, cells: missing.map(c => c.id), step: 'Starting', pct: 1, state: 'running', started: Date.now() };
  broadcast('area', job);
  const p = spawn(PY, ['-W', 'ignore', 'pipeline/add_area.py', '--epsg', String(epsg), '--cells', missing.map(c => `${c.gx}:${c.gy}`).join(',')],
    { cwd: ROOT, env: process.env });
  let buf = '';
  p.stdout.on('data', chunk => {
    buf += chunk; const lines = buf.split('\n'); buf = lines.pop() ?? '';
    for (const line of lines) {
      try {
        const m = JSON.parse(line);
        if (!job) continue;
        if (m.step === 'error') Object.assign(job, { state: 'error', message: m.message });
        else if (m.step === 'done') Object.assign(job, { state: 'done', pct: 100, step: 'Done', added: m.added, message: m.message });
        else Object.assign(job, { step: m.step, pct: m.pct, ...(m.mb_total ? { mbDone: m.mb_done, mbTotal: m.mb_total } : {}) });
        broadcast('area', job);
      } catch { /* non-JSON output from libraries */ }
    }
  });
  p.stderr.on('data', d => process.stderr.write(d));
  p.on('close', code => {
    if (job && job.state === 'running') { Object.assign(job, { state: code === 0 ? 'done' : 'error', message: code === 0 ? undefined : `Pipeline exited with code ${code}` }); broadcast('area', job); }
  });
  res.status(202).json(job);
});
