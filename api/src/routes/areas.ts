// On-demand coverage: download NISAR radar for a clicked area and cut it into patches (pipeline/add_area.py).
// One job at a time; progress goes to every browser over SSE ('area' events) and to GET /api/areas/job.
import { Router } from 'express';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { prisma } from '../db.js';
import { broadcast } from '../live.js';

export const areas = Router();
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const PY = process.env.PYTHON ?? ROOT + '.venv/bin/python';

type Job = { lon: number; lat: number; step: string; pct: number; state: 'running' | 'done' | 'error'; message?: string; added?: number; started: number };
let job: Job | null = null;

// What this computer has: patch images on disk, patches in the DB, a NASA login, the Python env.
areas.get('/setup', async (_req, res) => {
  const patchesInDb = await prisma.patch.count();
  res.json({
    patchesInDb,
    patchFilesOnDisk: existsSync(ROOT + 'web_assets/patches/index.json'),
    earthdataLogin: existsSync(homedir() + '/.netrc'),
    python: existsSync(PY),
    job,
  });
});

areas.get('/areas/job', (_req, res) => res.json(job));

areas.post('/areas', (req, res) => {
  const lon = Number(req.body?.lon), lat = Number(req.body?.lat);
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 85) return res.status(400).json({ error: 'lon and lat are required' });
  if (job?.state === 'running') return res.status(409).json({ error: 'Another area is downloading. Wait for it to finish.', job });
  if (!existsSync(PY)) return res.status(500).json({ error: 'Python environment not found (.venv). See README.' });

  job = { lon, lat, step: 'Starting', pct: 1, state: 'running', started: Date.now() };
  broadcast('area', job);
  const p = spawn(PY, ['-W', 'ignore', 'pipeline/add_area.py', String(lon), String(lat)], { cwd: ROOT, env: process.env });
  let buf = '';
  p.stdout.on('data', chunk => {
    buf += chunk; const lines = buf.split('\n'); buf = lines.pop() ?? '';
    for (const line of lines) {
      try {
        const m = JSON.parse(line);
        if (!job) continue;
        if (m.step === 'error') Object.assign(job, { state: 'error', message: m.message });
        else if (m.step === 'done') Object.assign(job, { state: 'done', pct: 100, step: 'Done', added: m.added, message: m.message });
        else Object.assign(job, { step: m.step, pct: m.pct });
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
