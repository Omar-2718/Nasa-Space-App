// Live map: buried rivers traced from NISAR radar, highlighted on top of the radar and photo background, plus known sites
// and on-demand radar downloads.
import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { api, sessionId, SAT_STYLE, setBasemap, pct, type Stats, type AreaJob, type Basemap, type Label, type Reveal } from '../api';

const TAGS: { label: Label; text: string }[] = [
  { label: 'channel', text: 'Buried river here' }, { label: 'nothing', text: 'No river' }, { label: 'unsure', text: 'Not sure' }];

type RiverStats = { km: number; channels: number; valleys: number };
const LAYERS = [
  { id: 'rivers', text: 'Buried rivers: channels + riverbeds', sw: '#38d6ff' },
  { id: 'crowd', text: 'Squares people checked (brighter = more said river)', sw: 'linear-gradient(90deg,#5a4a7a,#c48bff)' },
  { id: 'ai', text: 'AI river likelihood per square', sw: 'linear-gradient(90deg,#4a3420,#ffaa3c)' },
  { id: 'radar', text: 'NISAR radar', sw: '#888' },
  { id: 'sites', text: 'Known sites (places people lived, not rivers)', sw: '#ff5c8a' },
] as const;

const sitePopup = (m: maplibregl.Map, p: Record<string, unknown>, at: maplibregl.LngLatLike) =>
  new maplibregl.Popup({ maxWidth: '260px' }).setLngLat(at).setHTML(
    `<b>${p.name}</b><br>${p.kind}<br>${p.age_text}<br><span style="opacity:.8">${p.note ?? ''}</span><br>` +
    `<i>${p.confidence === 'approximate' ? 'Approximate location' : 'Published location'}</i>` +
    (p.source_url ? ` · <a href="${p.source_url}" target="_blank" rel="noreferrer">source</a>` : '')).addTo(m);

const LAYER_IDS: Record<string, string[]> = { rivers: ['valleys', 'valleys-line', 'rivers-glow', 'rivers'] };
const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
const loadRivers = () => fetch(`/layers/channels.geojson?t=${Date.now()}`).then(r => (r.ok ? r.json() : EMPTY)).catch(() => EMPTY) as Promise<GeoJSON.FeatureCollection>;
const riverStats = (fc: GeoJSON.FeatureCollection): RiverStats => ({
  km: Math.round(fc.features.reduce((a, f) => a + Number(f.properties?.len_km ?? 0), 0)),
  channels: fc.features.filter(f => f.properties?.kind === 'channel').length,
  valleys: fc.features.filter(f => f.properties?.kind === 'valley').length });

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
  const [rs, setRs] = useState<RiverStats>();
  const [on, setOn] = useState<Record<string, boolean>>({ rivers: true, crowd: true, ai: false, radar: true, sites: true });
  const [sel, setSel] = useState<Record<string, unknown> | null>(null);
  // tag the clicked square right here: your answer, then what the AI and other people said
  const [mine, setMine] = useState<{ label: Label; reveal: Reveal } | null>(null);
  const selAt = useRef(0);
  useEffect(() => { setMine(null); selAt.current = performance.now(); }, [sel]);
  const tagSel = async (label: Label) => {
    if (!sel || mine) return;
    const r = await api.tag({ sessionId: await sessionId(), patchId: String(sel.id), label, ms: Math.round(performance.now() - selAt.current) });
    setMine({ label, reveal: r.reveal });
    const cons = await api.consensus(); patchesRef.current = cons;
    (map.current?.getSource('patches') as maplibregl.GeoJSONSource | undefined)?.setData(cons); api.stats().then(setStats);
  };
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
    const riv = await loadRivers(); (m.getSource('rivers') as maplibregl.GeoJSONSource | undefined)?.setData(riv); setRs(riverStats(riv));
    api.stats().then(setStats);
  };


  useEffect(() => {
    const m = new maplibregl.Map({ container: 'livemap', style: SAT_STYLE, center: [30.1, 22.8], zoom: 8, maxZoom: 15 });
    m.addControl(new maplibregl.NavigationControl(), 'bottom-right');
    map.current = m;
    (window as unknown as { __livemap: maplibregl.Map }).__livemap = m;   // handy for debugging in the console
    m.on('load', async () => {
      const [cons, sites, M, riv] = await Promise.all([api.consensus(), api.sites(), fetch('/layers/mosaic.json').then(r => (r.ok ? r.json() : null)).catch(() => null), loadRivers()]);
      setRs(riverStats(riv));
      if (M) {
        m.addSource('radar', { type: 'image', url: `/layers/mosaic_hh.png?t=${Date.now()}`, coordinates: M.corners });
        m.addLayer({ id: 'radar', type: 'raster', source: 'radar', paint: { 'raster-opacity': .9, 'raster-fade-duration': 0 } });
      }
      m.addSource('patches', { type: 'geojson', data: cons }); patchesRef.current = cons;
      // open on the main block of radar: patches within ~3° of the median centre (one far-off square shouldn't zoom out the map)
      const cs = cons.features.map(f => (f.geometry as GeoJSON.Polygon).coordinates[0][0]);
      const med = (v: number[]) => [...v].sort((x, y) => x - y)[Math.floor(v.length / 2)] ?? 0;
      const mx = med(cs.map(c => c[0])), my = med(cs.map(c => c[1]));
      const pts = cons.features.flatMap(f => (f.geometry as GeoJSON.Polygon).coordinates[0]).filter(c => Math.abs(c[0] - mx) < 3 && Math.abs(c[1] - my) < 3);
      if (pts.length) m.fitBounds([[Math.min(...pts.map(p => p[0])), Math.min(...pts.map(p => p[1]))], [Math.max(...pts.map(p => p[0])), Math.max(...pts.map(p => p[1]))]], { padding: 30, duration: 0 });
      m.addLayer({ id: 'ai', type: 'fill', source: 'patches', layout: { visibility: 'none' }, paint: {
        'fill-color': ['interpolate', ['linear'], ['coalesce', ['get', 'ai'], ['get', 'tracer']], 0, '#4a3420', 1, '#ffaa3c'],
        'fill-opacity': ['interpolate', ['linear'], ['coalesce', ['get', 'ai'], ['get', 'tracer']], 0, 0, 0.3, 0.05, 1, 0.45] } });
      // buried rivers: valleys as soft blue areas, channels as glowing lines (longer = brighter)
      m.addSource('rivers', { type: 'geojson', data: riv });
      m.addLayer({ id: 'valleys', type: 'fill', source: 'rivers', filter: ['==', ['get', 'kind'], 'valley'], paint: { 'fill-color': '#2fa8ff', 'fill-opacity': 0.22 } });
      m.addLayer({ id: 'valleys-line', type: 'line', source: 'rivers', filter: ['==', ['get', 'kind'], 'valley'], paint: { 'line-color': '#7fd8ff', 'line-width': 1.2, 'line-opacity': 0.8 } });
      m.addLayer({ id: 'rivers-glow', type: 'line', source: 'rivers', filter: ['==', ['get', 'kind'], 'channel'], layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#38d6ff', 'line-blur': 4, 'line-opacity': 0.35, 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 4, 13, 12] } });
      m.addLayer({ id: 'rivers', type: 'line', source: 'rivers', filter: ['==', ['get', 'kind'], 'channel'], layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#9beeff', 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1, 13, 3],
                 'line-opacity': ['interpolate', ['linear'], ['coalesce', ['get', 'len_km'], 1], 1, 0.55, 5, 1] } });
      m.addLayer({ id: 'crowd', type: 'fill', source: 'patches', filter: ['>', ['get', 'votes'], 0], paint: {
        'fill-color': ['interpolate', ['linear'], ['coalesce', ['get', 'channelShare'], 0], 0, '#5a4a7a', 1, '#c48bff'], 'fill-opacity': 0.35 } }, 'valleys');
      m.addLayer({ id: 'hit', type: 'fill', source: 'patches', paint: { 'fill-color': '#000', 'fill-opacity': 0 } });   // whole square clickable
      m.addLayer({ id: 'outline', type: 'line', source: 'patches', paint: { 'line-color': ['case', ['get', 'modern'], '#e9786b', '#ffffff'], 'line-opacity': ['case', ['get', 'modern'], 0.8, 0.2], 'line-width': 0.8 } });
      m.addSource('sites', { type: 'geojson', data: sites }); setSiteList(sites.features);
      m.addLayer({ id: 'sites', type: 'circle', source: 'sites', paint: { 'circle-radius': 7, 'circle-color': '#ff5c8a', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
      labels.current = sites.features.map(f => {
        const el = document.createElement('div'); el.className = 'sitelabel'; el.textContent = String(f.properties?.name);
        return new maplibregl.Marker({ element: el, anchor: 'top', offset: [0, 10] }).setLngLat((f.geometry as GeoJSON.Point).coordinates as [number, number]).addTo(m);
      });
      m.on('moveend', updateHiRes); updateHiRes();
      m.on('click', 'hit', e => { if (!pickingRef.current) setSel(e.features?.[0]?.properties ?? null); });
      m.on('click', e => { if (pickingRef.current) onPick(+e.lngLat.lng.toFixed(5), +e.lngLat.lat.toFixed(5)); });
      m.on('click', 'sites', e => { const p = e.features?.[0]?.properties; if (p) sitePopup(m, p, e.lngLat); });
    });

    // live updates: radar downloads finishing (on this or another computer)
    const es = new EventSource('/api/stream');
    es.addEventListener('area', ev => {
      const j = JSON.parse((ev as MessageEvent).data) as AreaJob; setJob(j);
      if (j.state === 'done') { setPreview(null); if (j.added) refresh(); }
    });
    api.stats().then(setStats);
    return () => { es.close(); m.remove(); if (map.current === m) map.current = null; };
  }, []);

  useEffect(() => {
    const m = map.current; if (!m?.isStyleLoaded()) return;
    for (const [k, v] of Object.entries(on)) for (const id of LAYER_IDS[k] ?? [k]) if (m.getLayer(id)) m.setLayoutProperty(id, 'visibility', v ? 'visible' : 'none');
    radarOn.current = on.radar; updateHiRes();
    labels.current.forEach(mk => { mk.getElement().style.display = on.sites ? '' : 'none'; });
  }, [on]);

  return (
    <div className="split">
      <aside className="panel">
        <p className="eyebrow">Live map</p>
        <h1>Where the buried rivers are</h1>
        <p className="muted small">Everything blue is one thing: buried rivers, traced from NISAR L-band radar, which sees through dry sand. Thin lines are narrow channels; filled areas are wide old riverbeds (valleys) the rivers cut. These are candidates for experts to check, not confirmed finds.</p>
        <div className="stats">
          <div className="stat"><b>{rs ? rs.km.toLocaleString() : '–'}</b><span>km of buried channels</span></div>
          <div className="stat"><b>{rs?.valleys ?? '–'}</b><span>wide old riverbeds</span></div>
          <div className="stat"><b>{stats?.patches ?? '–'}</b><span>5 km squares with radar</span></div>
          <div className="stat"><b>{siteList.length || '–'}</b><span>known sites</span></div>
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
          <span className="muted small">Click any square to tag it. Red outlines: modern farms (their lines are hidden, they're irrigation, not rivers).</span>
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
            {!mine ? (
              <>
                <p className="small">Do you see a buried river in this square? Narrow winding lines (channels) and wide smooth dark bands (old riverbeds) both count. Straight lines are usually rock cracks or tracks.</p>
                <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
                  {TAGS.map(t => <button key={t.label} className={t.label === 'channel' ? 'primary' : ''} onClick={() => tagSel(t.label)}>{t.text}</button>)}
                </div>
              </>
            ) : (
              <p className="small">
                You said <b>{TAGS.find(t => t.label === mine.label)?.text.toLowerCase()}</b>.{' '}
                {mine.reveal.ai !== null ? `AI: ${pct(mine.reveal.ai)} river.` : `Tracer: ${pct(mine.reveal.tracer)} river.`}{' '}
                {mine.reveal.crowd.channelShare !== null ? `People: ${pct(mine.reveal.crowd.channelShare)} river (${mine.reveal.crowd.votes} votes).` : ''}
                {mine.reveal.gold && <> {mine.reveal.gold.correct ? <span className="ok">Matches the team's answer.</span> : <span className="no">The team's answer differs.</span>}</>}
              </p>
            )}
            {String(sel.modern) === 'true' && <p className="muted small">Modern farm square.</p>}
          </div>
        )}
      </aside>
      <div className={'mapwrap' + (picking ? ' picking' : '')}><div id="livemap" className="map" /></div>
    </div>
  );
}
