// Thin client for the Express API. Session id lives in localStorage so a person keeps their trust score.
export type Label = 'channel' | 'site_feature' | 'nothing' | 'unsure';
export type Images = { radar: string; rgb: string; tracer: string; ai: string };
export type Patch = { id: string; geometry: GeoJSON.Polygon; center: [number, number]; images: Images };
export type Reveal = { ai: number | null; tracer: number; crowd: { votes: number; channelShare: number | null }; gold: { label: Label; correct: boolean } | null };
export type Candidate = { id: string; lon: number; lat: number; score: number; votes: number; crowd: number | null; ai: number; nearestSite: string | null; distKm: number | null; why: string[]; images: Images };
export type Stats = { patches: number; tags: number; people: number; tagged: number; flagged: number; gold: number };

async function j<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? r.statusText);
  return r.json();
}

const KEY = 'bts-session';
export async function sessionId(): Promise<string> {
  let id: string | null = null;
  try { id = localStorage.getItem(KEY); } catch { /* private mode */ }
  if (id) return id;
  id = (await j<{ id: string }>('/api/session', { method: 'POST', body: '{}' })).id;
  try { localStorage.setItem(KEY, id); } catch { /* ignore */ }
  return id;
}

export const api = {
  next: (session: string, quiz = false) => j<{ patch?: Patch; gold?: boolean; done?: boolean }>(`/api/patches/next?session=${session}${quiz ? '&quiz=1' : ''}`),
  tag: (body: { sessionId: string; patchId: string; label: Label; ms: number; isQuiz?: boolean }) =>
    j<{ ok: true; reveal: Reveal }>('/api/tags', { method: 'POST', body: JSON.stringify(body) }),
  gold: (patchId: string, label: Label | null, key: string) =>
    j<{ ok: true; gold: number }>('/api/admin/gold', { method: 'POST', body: JSON.stringify({ patchId, label }), headers: { 'x-admin-key': key } }),
  consensus: () => j<GeoJSON.FeatureCollection>('/api/consensus'),
  sites: () => j<GeoJSON.FeatureCollection>('/api/sites'),
  candidates: (limit = 20) => j<Candidate[]>(`/api/candidates?limit=${limit}`),
  stats: () => j<Stats>('/api/stats'),
  metrics: () => j<Record<string, unknown>>('/api/metrics'),
};

export const SAT_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    sat: {
      type: 'raster', tileSize: 256, maxzoom: 18,
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
    },
  },
  layers: [{ id: 'sat', type: 'raster', source: 'sat' }],
};

export const pct = (v: number | null | undefined) => (v === null || v === undefined ? '–' : `${Math.round(v * 100)}%`);
