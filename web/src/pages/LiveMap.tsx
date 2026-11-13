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

export default function LiveMap() {
  const map = useRef<maplibregl.Map | null>(null);
  const labels = useRef<maplibregl.Marker[]>([]);
  const [stats, setStats] = useState<Stats>();
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [on, setOn] = useState<Record<string, boolean>>({ crowd: true, ai: false, radar: true, sites: true });
  const [sel, setSel] = useState<Record<string, unknown> | null>(null);
  const [base, setBase] = useState<Basemap>('s2');
  // download size presets as square blocks of 5.12 km patches (+ a small margin so edge patches are complete)
  const SIZES = [3, 5, 7, 10].map(n => ({ n, km: Math.round(n * 5.12 + 2) }));
  const [sizeKm, setSizeKm] = useState(SIZES[1].km);
  const sizeRef = useRef(SIZES[1].km);
  useEffect(() => { sizeRef.current = sizeKm; }, [sizeKm]);
  useEffect(() => { const m = map.current; if (m?.getLayer('s2')) setBasemap(m, base); }, [base]);
  // on-demand coverage: pick a spot -> confirm -> download progress
  const [picking, setPicking] = useState(false);
  const pickingRef = useRef(false);
  const [pick, setPick] = useState<{ lon: number; lat: number } | null>(null);
  // the exact 40 x 40 km square add_area.py will download, drawn as a map polygon so it scales with zoom
  const showPick = (p: { lon: number; lat: number } | null, side = sizeRef.current) => {
    const m = map.current;
    try { if (!m || !m.getLayer('outline')) return; } catch { return; }   // map not ready yet, or already removed
    const half = side / 2, dLat = half / 110.574, dLon = half / (111.32 * Math.cos(((p?.lat ?? 0) * Math.PI) / 180));
    const data: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: p ? [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon',
      coordinates: [[[p.lon - dLon, p.lat - dLat], [p.lon + dLon, p.lat - dLat], [p.lon + dLon, p.lat + dLat], [p.lon - dLon, p.lat + dLat], [p.lon - dLon, p.lat - dLat]]] } }] : [] };
    const src = m.getSource('pick') as maplibregl.GeoJSONSource | undefined;
    if (src) src.setData(data);
    else {
      m.addSource('pick', { type: 'geojson', data });
      m.addLayer({ id: 'pick-fill', type: 'fill', source: 'pick', paint: { 'fill-color': '#e58a4b', 'fill-opacity': 0.15 } });
      m.addLayer({ id: 'pick-line', type: 'line', source: 'pick', paint: { 'line-color': '#e58a4b', 'line-width': 2, 'line-dasharray': [2, 1] } });
    }
  };
  const [job, setJob] = useState<AreaJob | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { pickingRef.current = picking; }, [picking]);
  // keep the download square on the map while picking and while that area downloads
  useEffect(() => {
    if (pick) showPick(pick, sizeKm);
    else if (job?.state === 'running') showPick({ lon: job.lon, lat: job.lat }, job.sizeKm ?? 40);
    else showPick(null);
  }, [pick, job, sizeKm]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { api.setup().then(s => s.job && setJob(s.job)).catch(() => {}); }, []);

  const refresh = async () => {
    const m = map.current; if (!m) return;
    (m.getSource('patches') as maplibregl.GeoJSONSource | undefined)?.setData(await api.consensus());
    const M = await fetch('/layers/mosaic.json').then(r => r.json()).catch(() => null);
    const src = m.getSource('radar') as maplibregl.ImageSource | undefined;
    if (M && src) src.updateImage({ url: `/layers/mosaic_hh.png?t=${Date.now()}`, coordinates: M.corners });
    else if (M) { m.addSource('radar', { type: 'image', url: `/layers/mosaic_hh.png?t=${Date.now()}`, coordinates: M.corners }); m.addLayer({ id: 'radar', type: 'raster', source: 'radar' }, 'ai'); }
    api.stats().then(setStats);
  };
  const startDownload = async () => {
    if (!pick) return; setErr('');
    try { setJob({ ...(await api.addArea(pick.lon, pick.lat, sizeKm)), sizeKm }); setPick(null); }
    catch (e) { setErr((e as Error).message); }
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
      m.addSource('patches', { type: 'geojson', data: cons });
      const pts = cons.features.flatMap(f => (f.geometry as GeoJSON.Polygon).coordinates[0]);
      if (pts.length) m.fitBounds([[Math.min(...pts.map(p => p[0])), Math.min(...pts.map(p => p[1]))], [Math.max(...pts.map(p => p[0])), Math.max(...pts.map(p => p[1]))]], { padding: 30, duration: 0 });
      m.addLayer({ id: 'ai', type: 'fill', source: 'patches', layout: { visibility: 'none' }, paint: {
        'fill-color': ['interpolate', ['linear'], ['coalesce', ['get', 'ai'], ['get', 'tracer']], 0, '#4a3420', 1, '#ffaa3c'],
        'fill-opacity': ['interpolate', ['linear'], ['coalesce', ['get', 'ai'], ['get', 'tracer']], 0, 0, 0.3, 0.05, 1, 0.45] } });
      m.addLayer({ id: 'crowd', type: 'fill', source: 'patches', filter: ['>', ['get', 'votes'], 0], paint: {
        'fill-color': ['interpolate', ['linear'], ['coalesce', ['get', 'channelShare'], 0], 0, '#3a6b8a', 1, '#2fd3ff'],
        'fill-opacity': ['interpolate', ['linear'], ['get', 'votes'], 1, 0.35, 5, 0.75] } });
      m.addLayer({ id: 'outline', type: 'line', source: 'patches', paint: { 'line-color': ['case', ['get', 'modern'], '#e9786b', '#ffffff'], 'line-opacity': ['case', ['get', 'modern'], 0.8, 0.35], 'line-width': 0.8 } });
      m.addSource('sites', { type: 'geojson', data: sites });
      m.addLayer({ id: 'sites', type: 'circle', source: 'sites', paint: { 'circle-radius': 7, 'circle-color': '#ff5c8a', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
      labels.current = sites.features.map(f => {
        const el = document.createElement('div'); el.className = 'sitelabel'; el.textContent = String(f.properties?.name);
        return new maplibregl.Marker({ element: el, anchor: 'top', offset: [0, 10] }).setLngLat((f.geometry as GeoJSON.Point).coordinates as [number, number]).addTo(m);
      });
      m.on('click', 'outline', e => { if (!pickingRef.current) setSel(e.features?.[0]?.properties ?? null); });
      m.on('click', e => {
        if (!pickingRef.current) return;
        const p = { lon: +e.lngLat.lng.toFixed(3), lat: +e.lngLat.lat.toFixed(3) };
        setPick(p); setPicking(false);
      });
      m.on('click', 'sites', e => { const p = e.features?.[0]?.properties; if (p) new maplibregl.Popup().setLngLat(e.lngLat).setHTML(`<b>${p.name}</b><br>${p.kind}<br>${p.age_text}<br><i>${p.confidence === 'approximate' ? 'Approximate location' : 'Published location'}</i>`).addTo(m); });
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
      if (j.state === 'done' && j.added) { refresh(); m.flyTo({ center: [j.lon, j.lat], zoom: 9 }); }
    });
    api.stats().then(setStats);
    return () => { es.close(); m.remove(); if (map.current === m) map.current = null; };
  }, []);

  useEffect(() => {
    const m = map.current; if (!m?.isStyleLoaded()) return;
    for (const [id, v] of Object.entries(on)) if (m.getLayer(id)) m.setLayoutProperty(id, 'visibility', v ? 'visible' : 'none');
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
          <span className="muted small">Red outlines: modern farms, excluded from field plans.</span>
        </div>
        <div className="card addcard">
          <h2>Add radar for an area</h2>
          {job?.state === 'running' ? (
            <>
              <p className="small">{job.step}… ({job.lon.toFixed(2)}°E, {job.lat.toFixed(2)}°N)</p>
              <div className="bar"><i style={{ width: `${job.pct}%` }} /></div>
              <p className="muted small">Streaming only a {job.sizeKm ?? 40} × {job.sizeKm ?? 40} km crop from NASA, not the whole 1.6 GB file. Time depends on your connection.</p>
            </>
          ) : pick ? (
            <>
              <p className="small">Download NISAR radar around <b>{pick.lon}°E, {pick.lat}°N</b>?</p>
              <label className="small">Size
                <select value={sizeKm} onChange={e => setSizeKm(Number(e.target.value))} style={{ marginLeft: 8, background: 'var(--bg)', color: 'var(--fg)', border: '1px solid var(--line)', borderRadius: 4, padding: '3px 6px' }}>
                  {SIZES.map(s => <option key={s.km} value={s.km}>{s.n} × {s.n} = {s.n * s.n} patches ({s.km} km square)</option>)}
                </select>
              </label>
              <p className="muted small">Patches already covered are skipped. The orange square shows exactly what gets downloaded.</p>
              <div className="row"><button className="primary" onClick={startDownload}>Download this area</button><button onClick={() => setPick(null)}>Cancel</button></div>
            </>
          ) : (
            <>
              <p className="muted small">Pick a spot next to the existing grid and a size. The app downloads that area's radar and adds it for tagging.</p>
              <button className={picking ? '' : 'primary'} onClick={() => setPicking(!picking)}>{picking ? 'Click on the map… (cancel)' : 'Pick a spot on the map'}</button>
            </>
          )}
          {job?.state === 'done' && <p className="ok small">{job.added ? `Added ${job.added} patches.` : job.message ?? 'Done.'}</p>}
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
