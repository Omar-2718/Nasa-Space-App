// Community map: every 5 km patch coloured by weighted crowd vote, AI score layer, known sites, live tag feed (SSE).
import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { api, SAT_STYLE, pct, type Stats } from '../api';

type FeedItem = { t: string; label: string; id: string };
const LAYERS = [
  { id: 'crowd', text: 'Crowd votes', sw: 'linear-gradient(90deg,#3a6b8a,#2fd3ff)' },
  { id: 'ai', text: 'AI / tracer score', sw: 'linear-gradient(90deg,#4a3420,#ffaa3c)' },
  { id: 'radar', text: 'Radar (tour area)', sw: '#888' },
  { id: 'sites', text: 'Known archaeological sites', sw: '#ff5c8a' },
] as const;

export default function LiveMap() {
  const map = useRef<maplibregl.Map | null>(null);
  const labels = useRef<maplibregl.Marker[]>([]);
  const [stats, setStats] = useState<Stats>();
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [on, setOn] = useState<Record<string, boolean>>({ crowd: true, ai: false, radar: false, sites: true });
  const [sel, setSel] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    const m = new maplibregl.Map({ container: 'livemap', style: SAT_STYLE, center: [30.1, 22.8], zoom: 8 });
    m.addControl(new maplibregl.NavigationControl(), 'bottom-right');
    map.current = m;
    m.on('load', async () => {
      const [cons, sites, M] = await Promise.all([api.consensus(), api.sites(), fetch('/tour/manifest.json').then(r => r.json())]);
      m.addSource('radar', { type: 'image', url: '/tour/radar_hh.png', coordinates: M.radar.corners });
      m.addLayer({ id: 'radar', type: 'raster', source: 'radar', layout: { visibility: 'none' }, paint: { 'raster-opacity': .85 } });
      m.addSource('patches', { type: 'geojson', data: cons });
      const pts = cons.features.flatMap(f => (f.geometry as GeoJSON.Polygon).coordinates[0]);
      m.fitBounds([[Math.min(...pts.map(p => p[0])), Math.min(...pts.map(p => p[1]))], [Math.max(...pts.map(p => p[0])), Math.max(...pts.map(p => p[1]))]], { padding: 30, duration: 0 });
      m.addLayer({ id: 'ai', type: 'fill', source: 'patches', layout: { visibility: 'none' }, paint: {
        'fill-color': ['interpolate', ['linear'], ['coalesce', ['get', 'ai'], ['get', 'tracer']], 0, '#4a3420', 1, '#ffaa3c'],
        'fill-opacity': ['interpolate', ['linear'], ['coalesce', ['get', 'ai'], ['get', 'tracer']], 0, 0.05, 1, 0.7] } });
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
      m.on('click', 'outline', e => setSel(e.features?.[0]?.properties ?? null));
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
    api.stats().then(setStats);
    return () => { es.close(); m.remove(); };
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
          <span className="muted small">Red outlines: modern farms, excluded from field plans.</span>
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
      <div className="mapwrap"><div id="livemap" className="map" /></div>
    </div>
  );
}
