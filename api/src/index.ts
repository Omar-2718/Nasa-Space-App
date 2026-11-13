import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'node:url';
import { prisma } from './db.js';
import { stream } from './live.js';
import { tagging } from './routes/tagging.js';
import { maps } from './routes/maps.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const app = express();
app.use(cors());
app.use(express.json({ limit: '100kb' }));

// patch images and other generated assets
app.use('/patches', express.static(ROOT + 'web_assets/patches', { maxAge: '1h' }));

app.get('/api/health', async (_req, res) => {
  try { await prisma.$queryRaw`SELECT 1`; res.json({ ok: true, db: true }); }
  catch { res.status(503).json({ ok: false, db: false }); }
});
app.get('/api/stream', stream);
app.use('/api', tagging);
app.use('/api', maps);

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: 'server error' });
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`api on :${port}`));
