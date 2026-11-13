// Community map: every 5 km patch coloured by weighted crowd vote, AI score layer, known sites, live tag feed (SSE).
import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { api, SAT_STYLE, setBasemap, pct, type Stats, type AreaJob, type Basemap } from '../api';

type FeedItem = { t: string; label: string; id: string };
const LAYERS = [
  { id: 'crowd', text: 'Crowd votes', sw: 'linear-gradient(90deg,#3a6b8a,#2fd3ff)' },
  { id: 'ai', text: 'AI / tracer score', sw: 'linear-gradient(90deg,#4a3420,#ffaa3c)' },
  { id: 'radar', text: 'NISAR radar', sw: '#888' },
  { id: 'sites', text: 'Known archaeological sites', sw: '#ff5c8a' },
] as const;

const sitePopup = (m: maplibregl.Map, p: Record<string, unknown>, at: maplibregl.LngLatLike) =>
  new maplibregl.Popup({ maxWidth: '260px' }).setLngLat(at).setHTML(
    `<b>${p.name}</b><br>${p.kind}<br>${p.age_text}<br><span style="opacity:.8">${p.note ?? ''}</span><br>` +
    `<i>${p.confidence === 'approximate' ? 'Approximate location' : 'Published location'}</i>` +
    (p.source_url ? ` · <a href="${p.source_url}" target="_blank" rel="noreferrer">source</a>` : '')).addTo(m);

export default function LiveMap() {
  const map = useRef<maplibregl.Map | null>(null);
  const labels = useRef<maplibregl.Marker[]>([]);
  const patchesRef = useRef<GeoJSON.FeatureCollection | null>(null);
  const hiRes = useRef<Set<string>>(new Set());
  const radarOn = useRef(true);
  // Two radar levels: the ~40 m overview mosaic everywhere, and from zoom 11 the full 20 m patch images
  // for the squares on screen (each image is pinned to its exact patch corners, so it lines up with the grid).
  const HIRES_ZOOM = 11, MAX_HIRES = 80;
  const updateHiRes = () => {
    const m = map.current, fc = patchesRef.current; if (!m || !fc || !m.getLayer('ai')) return;
    const want = new Set<string>();
    if (radarOn.current && m.getZoom() >= HIRES_ZOOM) {
      const b = m.getBounds();
      for (const f of fc.features) {
        const ring = (f.geometry as GeoJSON.Polygon).coordinates[0];
        const xs = ring.map(c => c[0]), ys = ring.map(c => c[1]);   // patch bbox overlaps the view
        if (Math.max(...xs) >= b.getWest() && Math.min(...xs) <= b.getEast() && Math.max(...ys) >= b.getSouth() && Math.min(...ys) <= b.getNorth()) want.add(String(f.properties?.id));
        if (want.size >= MAX_HIRES) break;
      }
    }
    for (const id of hiRes.current) if (!want.has(id)) { m.removeLayer('hr_' + id); m.removeSource('hr_' + id); hiRes.current.delete(id); }
    for (const f of fc.features) {
      const id = String(f.properties?.id);
      if (!want.has(id) || hiRes.current.has(id)) continue;
      const r = (f.geometry as GeoJSON.Polygon).coordinates[0];
      m.addSource('hr_' + id, { type: 'image', url: `/patches/${id}_radar.png`, coordinates: [r[0], r[1], r[2], r[3]] as [[number, number], [number, number], [number, number], [number, number]] });
      m.addLayer({ id: 'hr_' + id, type: 'raster', source: 'hr_' + id, paint: { 'raster-fade-duration': 150 } }, 'ai');
      hiRes.current.add(id);
    }
  };
  const [stats, setStats] = useState<Stats>();
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [on, setOn] = useState<Record<string, boolean>>({ crowd: true, ai: false, radar: true, sites: true });
  const [sel, setSel] = useState<Record<string, unknown> | null>(null);
  const [base, setBase] = useState<Basemap>('s2');
  const [siteList, setSiteList] = useState<GeoJSON.Feature[]>([]);
  useEffect(() => { const m = map.current; if (m?.getLayer('s2')) setBasemap(m, base); }, [base]);
  // on-demand coverage: choose a size (n x n patches on the real patch grid), click, review, download only missing cells
  const SIZES = [1, 3, 5, 7, 10];
  const [n, setN] = useState(1);
  const nRef = useRef(1);
  useEffect(() => { nRef.current = n; }, [n]);
  const [picking, setPicking] = useState(false);
  const pickingRef = useRef(false);
  type Preview = { lon: number; lat: number; n: number; epsg: number; missing: number; cells: { id: string; exists: boolean; geometry: GeoJSON.Polygon }[] };
  const [preview, setPreview] = useState<Preview | null>(null);
  const [job, setJob] = useState<AreaJob | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { pickingRef.current = picking; }, [picking]);
  // draw the exact grid cells (orange = will download, grey = already on this computer)
  const drawCells = (cells: Preview['cells']) => {
    const m = map.current;
    try { if (!m || !m.getLayer('outline')) return; } catch { return; }   // map not ready yet, or already removed
    const data: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: cells.map(c => ({ type: 'Feature', properties: { exists: c.exists }, geometry: c.geometry })) };
    const src = m.getSource('pick') as maplibregl.GeoJSONSource | undefined;
    if (src) { src.setData(data); return; }
    m.addSource('pick', { type: 'geojson', data });
    m.addLayer({ id: 'pick-fill', type: 'fill', source: 'pick', paint: { 'fill-color': ['case', ['get', 'exists'], '#888888', '#e58a4b'], 'fill-opacity': ['case', ['get', 'exists'], 0.15, 0.3] } });
    m.addLayer({ id: 'pick-line', type: 'line', source: 'pick', paint: { 'line-color': ['case', ['get', 'exists'], '#bbbbbb', '#e58a4b'], 'line-width': 1.5, 'line-dasharray': [2, 1] } });
  };
  useEffect(() => { drawCells(preview?.cells ?? []); }, [preview]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { api.setup().then(s => s.job && setJob(s.job)).catch(() => {}); }, []);

  const download = async (lon: number, lat: number, size: number) => {
    setErr('');
    try { setJob(await api.addArea(lon, lat, size)); }
    catch (e) { setErr((e as Error).message); }
  };
  const onPick = async (lon: number, lat: number) => {
    setErr('');
    const size = nRef.current;
    const p = { lon, lat, n: size, ...(await api.areaPreview(lon, lat, size)) };
    if (size === 1 && p.missing === 1) {           // 1 x 1: add straight away, stay in picking mode for the next click
      setPreview(p); await download(lon, lat, 1); return;
    }
    setPreview(p); setPicking(false);
  };

  const refresh = async () => {
    const m = map.current; if (!m) return;
    const cons = await api.consensus(); patchesRef.current = cons;
    (m.getSource('patches') as maplibregl.GeoJSONSource | undefined)?.setData(cons); updateHiRes();
    const M = await fetch('/layers/mosaic.json').then(r => r.json()).catch(() => null);
    const src = m.getSource('radar') as maplibregl.ImageSource | undefined;
    if (M && src) src.updateImage({ url: `/layers/mosaic_hh.png?t=${Date.now()}`, coordinates: M.corners });
    else if (M) { m.addSource('radar', { type: 'image', url: `/layers/mosaic_hh.png?t=${Date.now()}`, coordinates: M.corners }); m.addLayer({ id: 'radar', type: 'raster', source: 'radar' }, 'ai'); }
    api.stats().then(setStats);
  };


  useEffect(() => {
    const m = new maplibregl.Map({ container: 'livemap', style: SAT_STYLE, center: [30.1, 22.8], zoom: 8, maxZoom: 15 });
    m.addControl(new maplibregl.NavigationControl(), 'bottom-right');
    map.current = m;
    (window as unknown as { __livemap: maplibregl.Map }).__livemap = m;   // handy for debugging in the console
    m.on('load', async () => {
      const [cons, sites, M] = await Promise.all([api.consensus(), api.sites(), fetch('/layers/mosaic.json').then(r => (r.ok ? r.json() : null)).catch(() => null)]);
      if (M) {
        m.addSource('radar', { type: 'image', url: `/layers/mosaic_hh.png?t=${Date.now()}`, coordinates: M.corners });
        m.addLayer({ id: 'radar', type: 'raster', source: 'radar', paint: { 'raster-opacity': .9, 'raster-fade-duration': 0 } });
      }
      m.addSource('patches', { type: 'geojson', data: cons }); patchesRef.current = cons;
      const pts = cons.features.flatMap(f => (f.geometry as GeoJSON.Polygon).coordinates[0]);
      if (pts.length) m.fitBounds([[Math.min(...pts.map(p => p[0])), Math.min(...pts.map(p => p[1]))], [Math.max(...pts.map(p => p[0])), Math.max(...pts.map(p => p[1]))]], { padding: 30, duration: 0 });
      m.addLayer({ id: 'ai', type: 'fill', source: 'patches', layout: { visibility: 'none' }, paint: {
        'fill-color': ['interpolate', ['linear'], ['coalesce', ['get', 'ai'], ['get', 'tracer']], 0, '#4a3420', 1, '#ffaa3c'],
        'fill-opacity': ['interpolate', ['linear'], ['coalesce', ['get', 'ai'], ['get', 'tracer']], 0, 0, 0.3, 0.05, 1, 0.45] } });
      m.addLayer({ id: 'crowd', type: 'fill', source: 'patches', filter: ['>', ['get', 'votes'], 0], paint: {
        'fill-color': ['interpolate', ['linear'], ['coalesce', ['get', 'channelShare'], 0], 0, '#3a6b8a', 1, '#2fd3ff'],
        'fill-opacity': ['interpolate', ['linear'], ['get', 'votes'], 1, 0.35, 5, 0.75] } });
      m.addLayer({ id: 'outline', type: 'line', source: 'patches', paint: { 'line-color': ['case', ['get', 'modern'], '#e9786b', '#ffffff'], 'line-opacity': ['case', ['get', 'modern'], 0.8, 0.35], 'line-width': 0.8 } });
      m.addSource('sites', { type: 'geojson', data: sites }); setSiteList(sites.features);
      m.addLayer({ id: 'sites', type: 'circle', source: 'sites', paint: { 'circle-radius': 7, 'circle-color': '#ff5c8a', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
      labels.current = sites.features.map(f => {
        const el = document.createElement('div'); el.className = 'sitelabel'; el.textContent = String(f.properties?.name);
        return new maplibregl.Marker({ element: el, anchor: 'top', offset: [0, 10] }).setLngLat((f.geometry as GeoJSON.Point).coordinates as [number, number]).addTo(m);
      });
      m.on('moveend', updateHiRes); updateHiRes();
      m.on('click', 'outline', e => { if (!pickingRef.current) setSel(e.features?.[0]?.properties ?? null); });
      m.on('click', e => { if (pickingRef.current) onPick(+e.lngLat.lng.toFixed(5), +e.lngLat.lat.toFixed(5)); });
      m.on('click', 'sites', e => { const p = e.features?.[0]?.properties; if (p) sitePopup(m, p, e.lngLat); });
    });

    // live updates: refresh the patch layer (debounced) and show a pulse where someone just tagged
    let timer: number | undefined;
    const es = new EventSource('/api/stream');
    es.addEventListener('tag', ev => {
      const d = JSON.parse((ev as MessageEvent).data);
      setFeed(f => [{ t: new Date().toLocaleTimeString(), label: d.label, id: d.patchId }, ...f].slice(0, 30));
      const el = document.createElement('div'); el.className = 'ping';
      const mk = new maplibregl.Marker({ element: el }).setLngLat(d.center).addTo(m); setTimeout(() => mk.remove(), 2500);
      clearTimeout(timer);
      timer = window.setTimeout(async () => { (m.getSource('patches') as maplibregl.GeoJSONSource | undefined)?.setData(await api.consensus()); api.stats().then(setStats); }, 600);
    });
    es.addEventListener('area', ev => {
      const j = JSON.parse((ev as MessageEvent).data) as AreaJob; setJob(j);
      if (j.state === 'done') { setPreview(null); if (j.added) refresh(); }
    });
    api.stats().then(setStats);
    return () => { es.close(); m.remove(); if (map.current === m) map.current = null; };
  }, []);

  useEffect(() => {
    const m = map.current; if (!m?.isStyleLoaded()) return;
    for (const [id, v] of Object.entries(on)) if (m.getLayer(id)) m.setLayoutProperty(id, 'visibility', v ? 'visible' : 'none');
    radarOn.current = on.radar; updateHiRes();
    labels.current.forEach(mk => { mk.getElement().style.display = on.sites ? '' : 'none'; });
  }, [on]);

  return (
    <div className="split">
      <aside className="panel">
        <p className="eyebrow">Live map</p>
        <h1>What everyone has found</h1>
        <div className="stats">
          <div className="stat"><b>{stats?.tags ?? '–'}</b><span>tags</span></div>
          <div className="stat"><b>{stats?.people ?? '–'}</b><span>people</span></div>
          <div className="stat"><b>{stats ? `${stats.tagged}/${stats.patches}` : '–'}</b><span>patches tagged</span></div>
          <div className="stat"><b>{stats?.flagged ?? '–'}</b><span>low-trust taggers filtered</span></div>
        </div>
        <div className="legend">
          {LAYERS.map(l => (
            <label key={l.id}><input type="checkbox" checked={on[l.id]} onChange={e => setOn({ ...on, [l.id]: e.target.checked })} /><span className="sw" style={{ background: l.sw }} />{l.text}</label>
          ))}
          <label>Background
            <select value={base} onChange={e => setBase(e.target.value as Basemap)} style={{ marginLeft: 8, background: 'var(--bg)', color: 'var(--fg)', border: '1px solid var(--line)', borderRadius: 4, padding: '2px 4px' }}>
              <option value="s2">Sentinel-2 2020 (one consistent date)</option>
              <option value="esri">Esri high-detail (mixed dates)</option>
            </select>
          </label>
          <label>Go to site
            <select value="" onChange={e => { const f = siteList[Number(e.target.value)]; const m = map.current; if (!f || !m) return;
                const c = (f.geometry as GeoJSON.Point).coordinates as [number, number];
                m.flyTo({ center: c, zoom: 11 }); m.once('moveend', () => sitePopup(m, f.properties ?? {}, c)); }}
              style={{ marginLeft: 8, background: 'var(--bg)', color: 'var(--fg)', border: '1px solid var(--line)', borderRadius: 4, padding: '2px 4px' }}>
              <option value="">Choose… ({siteList.length})</option>
              {siteList.map((f, i) => <option key={i} value={i}>{String(f.properties?.name)}</option>)}
            </select>
          </label>
          <span className="muted small">Red outlines: modern farms, excluded from field plans.</span>
        </div>
        <div className="card addcard">
          <h2>Add radar for an area</h2>
          <label className="small">Size
            <select value={n} onChange={e => { setN(Number(e.target.value)); setPreview(null); }} style={{ marginLeft: 8, background: 'var(--bg)', color: 'var(--fg)', border: '1px solid var(--line)', borderRadius: 4, padding: '3px 6px' }}>
              {SIZES.map(k => <option key={k} value={k}>{k === 1 ? '1 patch (click to add instantly)' : `${k} × ${k} = ${k * k} patches`}</option>)}
            </select>
          </label>
          {job?.state === 'running' ? (
            <>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className="small">{job.step}…</span>
                <span className="small muted" style={{ fontVariantNumeric: 'tabular-nums' }}>{job.mbTotal ? `${job.mbDone?.toFixed(1)} / ${job.mbTotal.toFixed(1)} MB` : `${job.pct}%`}</span>
              </div>
              <div className="bar"><i style={{ width: `${job.pct}%` }} /></div>
              <span className="muted small">{job.cells?.length} patch{job.cells?.length === 1 ? '' : 'es'}</span>
            </>
          ) : preview && !picking ? (
            <>
              {preview.missing > 0
                ? <p className="small"><b>{preview.missing} new patch{preview.missing === 1 ? '' : 'es'}</b> to download{preview.cells.length > preview.missing ? `, ${preview.cells.length - preview.missing} already on this computer (skipped)` : ''}.</p>
                : <p className="small">You already have {preview.cells.length === 1 ? 'this patch' : `all ${preview.cells.length} patches`} here. Nothing to download.</p>}
              <div className="row">
                {preview.missing > 0 && <button className="primary" onClick={() => { download(preview.lon, preview.lat, preview.n); }}>Download {preview.missing} patch{preview.missing === 1 ? '' : 'es'}</button>}
                <button onClick={() => setPreview(null)}>{preview.missing > 0 ? 'Cancel' : 'Close'}</button>
              </div>
            </>
          ) : (
            <>
              <p className="muted small">{n === 1 ? 'Click any 5 km square on the map to add it.' : 'Click where the block should be centred. Squares you already have are skipped.'}</p>
              <button className={picking ? '' : 'primary'} onClick={() => { setPicking(!picking); setPreview(null); }}>{picking ? 'Stop picking' : 'Pick on the map'}</button>
            </>
          )}
          {job?.state === 'done' && <p className="ok small">{job.added ? `Added ${job.added} patch${job.added === 1 ? '' : 'es'}.` : job.message ?? 'Done.'}</p>}
          {job?.state === 'error' && <p className="no small">{job.message}</p>}
          {err && <p className="no small">{err}</p>}
        </div>
        {sel && (
          <div className="card">
            <h2>Patch {String(sel.id)}</h2>
            <img src={`/patches/${sel.id}_radar.png`} alt="" style={{ width: '100%', borderRadius: 6 }} />
            <p className="small">Crowd: {sel.channelShare === 'null' || sel.channelShare == null ? 'no votes yet' : `${pct(Number(sel.channelShare))} river (${sel.votes} votes)`} · {sel.ai !== null && sel.ai !== 'null' ? `AI ${pct(Number(sel.ai))}` : `Tracer ${pct(Number(sel.tracer))}`}</p>
          </div>
        )}
        <div>
          <h2>Live feed</h2>
          <div className="feed">{feed.length ? feed.map((f, i) => <span key={i}>{f.t} · someone tagged {f.id.split('_').slice(1).join('_')} as <b>{f.label.replace('_', ' ')}</b></span>) : <span>Waiting for tags… open “Tag the desert” on a phone.</span>}</div>
        </div>
      </aside>
      <div className={'mapwrap' + (picking ? ' picking' : '')}><div id="livemap" className="map" /></div>
    </div>
  );
}
