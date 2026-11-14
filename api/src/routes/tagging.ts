// Sessions, serving patches to tag, saving tags (with the AI/crowd reveal), and admin gold labels.
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { prisma, num, LABELS, patchImages, type Label } from '../db.js';
import { broadcast } from '../live.js';

export const tagging = Router();
const GOLD_EVERY = 10;                       // about 1 in 10 served patches is a gold (known-answer) patch
const ADMIN_KEY = process.env.ADMIN_KEY ?? (process.env.NODE_ENV === 'production' ? '' : 'sand-admin');

type PatchRow = { id: string; geom: string; center: string; tracer_line: number; tracer_valley: number; ai_score: number | null; gold_label: Label | null };
const PATCH_COLS = `id, ST_AsGeoJSON(geom) AS geom, ST_AsGeoJSON(center) AS center, tracer_line, tracer_valley, ai_score, gold_label`;

const shape = (p: PatchRow) => ({
  id: p.id,
  geometry: JSON.parse(p.geom),
  center: JSON.parse(p.center).coordinates as [number, number],
  images: patchImages(p.id),
});

tagging.post('/session', async (req, res) => {
  const id = randomUUID();
  await prisma.session.create({ data: { id, name: typeof req.body?.name === 'string' ? req.body.name.slice(0, 40) : null } });
  res.json({ id });
});

// Next patch for a session. quiz=1 -> gold patches only (practice round).
tagging.get('/patches/next', async (req, res) => {
  const session = String(req.query.session ?? '');
  const quiz = req.query.quiz === '1';
  const done = await prisma.tag.count({ where: { sessionId: session, isQuiz: false } });
  const wantGold = quiz || (done > 0 && done % GOLD_EVERY === GOLD_EVERY - 1);

  let rows: PatchRow[] = [];
  if (wantGold) {
    rows = await prisma.$queryRawUnsafe<PatchRow[]>(
      `SELECT ${PATCH_COLS} FROM patches p WHERE gold_label IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM tags t WHERE t.patch_id = p.id AND t.session_id = $1)
       ORDER BY random() LIMIT 1`, session);
  }
  if (!rows.length && !quiz) {
    // Active learning: patches with few votes first, then the ones the AI (or tracer) is least sure about.
    rows = await prisma.$queryRawUnsafe<PatchRow[]>(
      `SELECT ${PATCH_COLS.split(', ').map(c => c.startsWith('ST_') ? c : 'p.' + c).join(', ')}
       FROM patches p JOIN consensus c ON c.id = p.id
       WHERE p.gold_label IS NULL
         AND NOT EXISTS (SELECT 1 FROM tags t WHERE t.patch_id = p.id AND t.session_id = $1)
       ORDER BY p.modern, LEAST(c.votes, 5),
                abs(coalesce(p.ai_score, LEAST(p.tracer_line * 40, 1)) - 0.5),
                random()
       LIMIT 1`, session);
  }
  if (!rows.length) return res.json({ done: true });
  res.json({ patch: shape(rows[0]), gold: wantGold && rows[0].gold_label !== null });
});

// Save a tag. Response reveals what the AI and the crowd think (shown only after answering).
tagging.post('/tags', async (req, res) => {
  const { sessionId, patchId, label, ms, isQuiz } = req.body ?? {};
  if (!LABELS.includes(label)) return res.status(400).json({ error: 'label must be one of ' + LABELS.join(', ') });
  const patch = await prisma.patch.findUnique({ where: { id: String(patchId) }, select: { id: true, aiScore: true, tracerLine: true, goldLabel: true } });
  if (!patch) return res.status(404).json({ error: 'unknown patch' });
  const session = await prisma.session.findUnique({ where: { id: String(sessionId) } });
  if (!session) return res.status(404).json({ error: 'unknown session, call POST /api/session first' });

  await prisma.tag.create({ data: { patchId: patch.id, sessionId: session.id, label, ms: Number.isFinite(ms) ? Math.round(ms) : null, isQuiz: !!isQuiz } });
  const [c] = await prisma.$queryRaw<{ votes: bigint; channel_share: number | null }[]>`SELECT votes, channel_share FROM consensus WHERE id = ${patch.id}`;
  const [center] = await prisma.$queryRaw<{ c: string }[]>`SELECT ST_AsGeoJSON(center) AS c FROM patches WHERE id = ${patch.id}`;
  const reveal = {
    ai: patch.aiScore,
    tracer: Math.min(1, patch.tracerLine * 40),
    crowd: { votes: num(c.votes), channelShare: c.channel_share },
    gold: patch.goldLabel ? { label: patch.goldLabel, correct: patch.goldLabel === label } : null,
  };
  if (!isQuiz) broadcast('tag', { patchId: patch.id, label, center: JSON.parse(center.c).coordinates, votes: num(c.votes), channelShare: c.channel_share });
  res.json({ ok: true, reveal });
});

// Team-only: mark the known answer for a patch (gold set used for the quiz and trust scores).
tagging.post('/admin/gold', async (req, res) => {
  if (!ADMIN_KEY || req.get('x-admin-key') !== ADMIN_KEY) return res.status(403).json({ error: 'wrong admin key' });
  const { patchId, label } = req.body ?? {};
  if (label !== null && !LABELS.includes(label)) return res.status(400).json({ error: 'bad label' });
  await prisma.patch.update({ where: { id: String(patchId) }, data: { goldLabel: label } });
  res.json({ ok: true, gold: await prisma.patch.count({ where: { goldLabel: { not: null } } }) });
});
