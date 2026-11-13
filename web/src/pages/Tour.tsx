// Guided tour: two synced maps (photo | NISAR radar) with a swipe, highlight pulse and slider sweep.
import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { SAT_STYLE } from '../api';

type Cam = 'all' | { center: [number, number]; zoom: number };
type Step = { title: string; text: string; pos: number; rivers: boolean | 'pulse'; cam: Cam; sweep?: number[] };

const STEPS: Step[] = [
  { title: 'An empty desert?', pos: 100, rivers: false, cam: 'all',
    text: 'The Egypt–Sudan border near Bir Safsaf, one of the driest places on Earth. From space it looks like sand in every direction.' },
  { title: 'Now look with radar', pos: 0, rivers: false, cam: 'all',
    text: "NISAR sends 24 cm radio waves. Dry sand is almost transparent to them, so they reach the rock and gravel 1–2 m below and bounce back. The hidden landscape appears." },
  { title: 'Rivers under the sand', pos: 0, rivers: 'pulse', cam: { center: [29.3, 22.66], zoom: 10.2 },
    text: 'The shaded band is a buried river valley, kilometres wide; the lines are smaller channels feeding it. They flowed when the Sahara was green.' },
  { title: 'Invisible to the eye', pos: 50, rivers: true, sweep: [30, 72, 45], cam: { center: [29.33, 22.66], zoom: 10.8 },
    text: 'Watch the line move, then drag it yourself. Where the radar shows rivers, the photo shows only sand.' },
  { title: 'People lived here', pos: 50, rivers: true, cam: 'all',
    text: 'In the 1980s field teams dug into these radar channels and found stone hand-axes hundreds of thousands of years old. The Sahara is 9 million km² and nobody can walk all of it. Help us map where to look.' },
];

const FULL: Record<string, [string, number]> = { valleys: ['fill-opacity', 0.22], 'rivers-glow': ['line-opacity', 0.55], rivers: ['line-opacity', 1] };

export default function Tour() {
  const wrap = useRef<HTMLDivElement>(null);
  const maps = useRef<{ a?: maplibregl.Map; b?: maplibregl.Map; bounds?: maplibregl.LngLatBoundsLike }>({});
  const run = useRef(0);
  const [step, setStep] = useState(0);
  const [ready, setReady] = useState(false);

  const setPos = (p: number, animate = true) => {
    const w = wrap.current; if (!w) return;
    w.classList.toggle('animate', animate);
    w.style.setProperty('--pos', Math.max(0, Math.min(100, p)) + '%');
  };
  const setHighlight = (h: number, ms = 900) => {
    const b = maps.current.b; if (!b?.getLayer('rivers')) return;
    for (const [id, [prop, max]] of Object.entries(FULL)) {
      b.setPaintProperty(id, `${prop}-transition`, { duration: ms, delay: 0 });
      b.setPaintProperty(id, prop, h * max);
    }
  };

  useEffect(() => {
    const a = new maplibregl.Map({ container: 'tourA', style: SAT_STYLE, center: [29.5, 22.8], zoom: 8, attributionControl: false });
    const b = new maplibregl.Map({ container: 'tourB', style: SAT_STYLE, center: [29.5, 22.8], zoom: 8 });
    b.addControl(new maplibregl.NavigationControl(), 'bottom-right');
    maps.current = { a, b };
    let syncing = false;
    for (const [s, d] of [[a, b], [b, a]] as const) s.on('move', () => {
      if (syncing) return; syncing = true;
      d.jumpTo({ center: s.getCenter(), zoom: s.getZoom(), bearing: s.getBearing(), pitch: s.getPitch() }); syncing = false;
    });
    let n = 0;
    const onLoad = async () => {
      if (++n < 2) return;
      const M = await (await fetch('/tour/manifest.json')).json();
      const c = M.radar.corners; maps.current.bounds = [c[3], c[1]];
      b.addSource('radar', { type: 'image', url: '/tour/radar_hh.png', coordinates: c });
      b.addLayer({ id: 'radar', type: 'raster', source: 'radar', paint: { 'raster-fade-duration': 0 } });
      b.addSource('rivers', { type: 'geojson', data: '/tour/channels.geojson' });
      b.addLayer({ id: 'valleys', type: 'fill', source: 'rivers', filter: ['==', ['get', 'kind'], 'valley'], paint: { 'fill-color': '#2fd3ff', 'fill-opacity': 0 } });
      b.addLayer({ id: 'rivers-glow', type: 'line', source: 'rivers', filter: ['==', ['get', 'kind'], 'channel'], layout: { 'line-cap': 'round' },
        paint: { 'line-color': '#2fd3ff', 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 4, 13, 14], 'line-blur': 6, 'line-opacity': 0 } });
      b.addLayer({ id: 'rivers', type: 'line', source: 'rivers', filter: ['==', ['get', 'kind'], 'channel'], layout: { 'line-cap': 'round' },
        paint: { 'line-color': '#bff3ff', 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1.2, 13, 3.5], 'line-opacity': 0 } });
      setReady(true);
    };
    a.on('load', onLoad); b.on('load', onLoad);

    // swipe handle drag
    const h = wrap.current!.querySelector('.swipe') as HTMLElement;
    let drag = false;
    const down = (e: PointerEvent) => { drag = true; h.setPointerCapture(e.pointerId); };
    const move = (e: PointerEvent) => { if (!drag) return; const r = wrap.current!.getBoundingClientRect(); setPos((e.clientX - r.left) / r.width * 100, false); };
    const up = () => { drag = false; };
    h.addEventListener('pointerdown', down); h.addEventListener('pointermove', move); h.addEventListener('pointerup', up);
    return () => { run.current++; a.remove(); b.remove(); };
  }, []);

  useEffect(() => {
    if (!ready) return;
    const s = STEPS[step], id = ++run.current, b = maps.current.b!;
    const wait = (ms: number) => new Promise<void>((res, rej) => setTimeout(() => (id === run.current ? res() : rej()), ms));
    setPos(s.pos);
    if (s.cam === 'all') b.fitBounds(maps.current.bounds!, { padding: 30, duration: 1600 }); else b.flyTo({ ...s.cam, duration: 1800 });
    setHighlight(s.rivers === true ? 1 : 0, s.rivers === 'pulse' ? 300 : 900);
    (async () => {
      await wait(1900);
      if (s.rivers === 'pulse') { setHighlight(1, 1000); await wait(3200); setHighlight(0, 1200); }
      if (s.sweep) for (const p of s.sweep) { setPos(p); await wait(1700); }
    })().catch(() => {});
  }, [step, ready]);

  const s = STEPS[step];
  return (
    <div className="split">
      <aside className="panel">
        <p className="eyebrow">Step {step + 1} of {STEPS.length}</p>
        <h1>{s.title}</h1>
        <p>{s.text}</p>
        <div className="row">
          <button onClick={() => setStep(step - 1)} disabled={step === 0}>Back</button>
          {step < STEPS.length - 1
            ? <button className="primary" onClick={() => setStep(step + 1)} disabled={!ready}>Next</button>
            : <a href="#tag"><button className="primary">Start tagging</button></a>}
        </div>
        <div className="dots">{STEPS.map((_, k) => <i key={k} className={k === step ? 'on' : ''} />)}</div>
        <p className="muted small">NISAR L2 GCOV, 17 Oct 2026, NASA/ISRO via ASF DAAC. Lines are traced automatically and are candidates, not confirmed rivers.</p>
      </aside>
      <div className="mapwrap" ref={wrap}>
        <div id="tourA" className="map" />
        <div id="tourB" className="map" />
        <div className="swipe"><span>⟷</span></div>
        <div className="tag l">Satellite photo</div>
        <div className="tag r">NISAR radar</div>
      </div>
    </div>
  );
}
