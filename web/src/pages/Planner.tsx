// Field plan: ranked survey targets (crowd + AI + closeness to known sites), map, and KML/GPX/CSV export.
import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { api, SAT_STYLE, pct, type Candidate } from '../api';

export default function Planner() {
  const map = useRef<maplibregl.Map | null>(null);
  const markers = useRef<maplibregl.Marker[]>([]);
  const [cands, setCands] = useState<Candidate[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [focus, setFocus] = useState<string | null>(null);

  useEffect(() => {
    const m = new maplibregl.Map({ container: 'planmap', style: SAT_STYLE, center: [30.1, 22.8], zoom: 8 });
    m.addControl(new maplibregl.NavigationControl(), 'bottom-right');
    map.current = m;
    m.on('load', async () => {
      const sites = await api.sites();
      m.addSource('sites', { type: 'geojson', data: sites });
      m.addLayer({ id: 'sites', type: 'circle', source: 'sites', paint: { 'circle-radius': 6, 'circle-color': '#ff5c8a', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
    });
    api.candidates(15).then(c => {
      setCands(c); setPicked(new Set(c.slice(0, 8).map(x => x.id)));
      if (c.length) m.fitBounds([[Math.min(...c.map(x => x.lon)), Math.min(...c.map(x => x.lat))], [Math.max(...c.map(x => x.lon)), Math.max(...c.map(x => x.lat))]], { padding: 80, duration: 0, maxZoom: 11 });
    });
    return () => m.remove();
  }, []);

  useEffect(() => {
    const m = map.current; if (!m) return;
    markers.current.forEach(mk => mk.remove());
    markers.current = cands.map((c, i) => {
      const el = document.createElement('div');
      el.className = 'target' + (picked.has(c.id) ? ' on' : '') + (focus === c.id ? ' focus' : '');
      el.textContent = String(i + 1);
      el.onclick = () => setFocus(c.id);
      return new maplibregl.Marker({ element: el }).setLngLat([c.lon, c.lat]).addTo(m);
    });
  }, [cands, picked, focus]);

  useEffect(() => {
    const c = cands.find(x => x.id === focus); if (c) map.current?.flyTo({ center: [c.lon, c.lat], zoom: 11, duration: 1200 });
  }, [focus, cands]);

  const ids = [...picked].join(',');
  const toggle = (id: string) => { const s = new Set(picked); if (s.has(id)) s.delete(id); else s.add(id); setPicked(s); };

  return (
    <div className="split">
      <aside className="panel">
        <p className="eyebrow">Field plan</p>
        <h1>Where a survey team should go</h1>
        <p className="muted">Targets are ranked by what the crowd saw, what the AI predicts, and closeness to known prehistoric sites. Pick the stops, then export for a GPS or Google Earth. On the ground the team walks the old riverbanks looking for stone tools, and digs test pits in the river sediment.</p>
        <div className="dl">
          <a href={`/api/export/kml?ids=${ids}`}>KML (Google Earth)</a>
          <a href={`/api/export/gpx?ids=${ids}`}>GPX (handheld GPS)</a>
          <a href={`/api/export/csv?ids=${ids}`}>CSV</a>
        </div>
        <p className="small muted">{picked.size} stops selected</p>
        {cands.length === 0 && <p className="muted">No candidates yet. Add radar on the <a href="#map">Live map</a>.</p>}
        <div className="cands">
          {cands.map((c, i) => (
            <div key={c.id} className={'cand' + (focus === c.id ? ' sel' : '')} onClick={() => setFocus(c.id)}>
              <input type="checkbox" checked={picked.has(c.id)} onChange={() => toggle(c.id)} onClick={e => e.stopPropagation()} aria-label={`Include target ${i + 1}`} />
              <img src={c.images.radar} alt="" />
              <div>
                <b>#{i + 1} · score {pct(c.score)}</b>
                <div className="why">{c.why.join(' · ')}</div>
                <div className="why">{c.lat.toFixed(4)}°N {c.lon.toFixed(4)}°E</div>
              </div>
            </div>
          ))}
        </div>
        <p className="muted small">Candidates for experts to check, not confirmed sites. Modern farmland is excluded.</p>
      </aside>
      <div className="mapwrap"><div id="planmap" className="map" /></div>
    </div>
  );
}
