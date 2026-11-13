import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();

// Postgres returns bigint for count(); make JSON-safe.
export const num = (v: unknown) => (typeof v === 'bigint' ? Number(v) : v === null || v === undefined ? null : Number(v));

export const LABELS = ['channel', 'site_feature', 'nothing', 'unsure'] as const;
export type Label = (typeof LABELS)[number];

export const patchImages = (id: string) => ({
  radar: `/patches/${id}_radar.png`,
  rgb: `/patches/${id}_rgb.png`,
  tracer: `/patches/${id}_tracer.png`,
  ai: `/patches/${id}_ai.png`,
});

// Where generated patches and map layers live (override with ASSETS_DIR, e.g. to simulate an empty computer).
import { fileURLToPath } from 'node:url';
export const ASSETS = process.env.ASSETS_DIR ?? fileURLToPath(new URL('../../web_assets/', import.meta.url));
