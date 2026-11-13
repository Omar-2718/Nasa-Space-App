// Beneath the Sand: two synced maps (photo | radar) with a swipe, traced buried rivers, and a guided tour.
const SAT = {
  type: 'raster', tileSize: 256, maxzoom: 18,
  tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
  attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
};
const style = { version: 8, sources: { sat: SAT }, layers: [{ id: 'sat', type: 'raster', source: 'sat' }] };
const $ = s => document.querySelector(s);

let M, bounds, step = 0;
const mapA = new maplibregl.Map({ container: 'mapA', style, center: [29.5, 22.8], zoom: 8, attributionControl: false });
const mapB = new maplibregl.Map({ container: 'mapB', style, center: [29.5, 22.8], zoom: 8 });
mapB.addControl(new maplibregl.NavigationControl(), 'bottom-right');

// keep both maps in lockstep
let syncing = false;
for (const [src, dst] of [[mapA, mapB], [mapB, mapA]]) src.on('move', () => {
  if (syncing) return; syncing = true;
  dst.jumpTo({ center: src.getCenter(), zoom: src.getZoom(), bearing: src.getBearing(), pitch: src.getPitch() });
  syncing = false;
});

// swipe: mapB (radar) shows to the right of the handle
const wrap = $('.mapwrap'), handle = $('#swipe');
let pos = 50;
function setPos(p, animate) {
  pos = Math.max(0, Math.min(100, p));
  wrap.classList.toggle('animate', !!animate);
  wrap.style.setProperty('--pos', pos + '%');
}
let dragging = false;
handle.addEventListener('pointerdown', e => { dragging = true; handle.setPointerCapture(e.pointerId); });
handle.addEventListener('pointermove', e => { if (!dragging) return; const r = wrap.getBoundingClientRect(); setPos((e.clientX - r.left) / r.width * 100); });
handle.addEventListener('pointerup', () => dragging = false);

const ready = m => new Promise(r => m.loaded() ? r() : m.once('load', r));

function addRivers(map) {
  map.addSource('rivers', { type: 'geojson', data: 'data/channels.geojson' });
  map.addLayer({ id: 'valleys', type: 'fill', source: 'rivers', filter: ['==', ['get', 'kind'], 'valley'],
    paint: { 'fill-color': '#2fd3ff', 'fill-opacity': .22, 'fill-outline-color': '#8fe6ff' } });
  map.addLayer({ id: 'rivers-glow', type: 'line', source: 'rivers', filter: ['==', ['get', 'kind'], 'channel'], layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#2fd3ff', 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 4, 13, 14], 'line-blur': 6, 'line-opacity': .55 } });
  map.addLayer({ id: 'rivers', type: 'line', source: 'rivers', filter: ['==', ['get', 'kind'], 'channel'], layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#bff3ff', 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1.2, 13, 3.5] } });
}
function showRivers(on) {
  for (const id of ['valleys', 'rivers-glow', 'rivers']) mapB.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  $('#showRivers').checked = on;
}
function setRadar(pol, opacity) {
  const url = `data/radar_${pol}.png`, c = M.radar.corners;
  if (mapB.getSource('radar')) mapB.getSource('radar').updateImage({ url, coordinates: c });
  else {
    mapB.addSource('radar', { type: 'image', url, coordinates: c });
    mapB.addLayer({ id: 'radar', type: 'raster', source: 'radar', paint: { 'raster-fade-duration': 0 } }, 'valleys');
  }
  mapB.setPaintProperty('radar', 'raster-opacity', opacity);
}

// ---------- guided tour ----------
const TOUR = [
  { title: 'An empty desert?', pos: 100, rivers: false, cam: 'all',
    text: 'This is the Egypt–Sudan border near Bir Safsaf, one of the driest places on Earth. From space it looks like flat sand in every direction.' },
  { title: 'Now look with radar', pos: 0, rivers: false, cam: 'all',
    text: 'NISAR sends 24 cm radio waves. Dry sand is almost transparent to them, so they reach the rock and gravel 1–2 m below and bounce back. The hidden landscape appears.' },
  { title: 'Rivers under the sand', pos: 0, rivers: true, cam: { center: [29.3, 22.66], zoom: 10.2 },
    text: 'The shaded band is a buried river valley, kilometres wide. The blue lines are smaller channels feeding it. Fine sediment in the old riverbeds looks dark to the radar. We traced them automatically. They flowed when the Sahara was green, thousands of years ago.' },
  { title: 'Invisible to the eye', pos: 50, rivers: true, cam: { center: [29.33, 22.66], zoom: 10.8 },
    text: 'Drag the white line back and forth. Where the radar shows rivers, the photo shows only featureless sand. Without radar, nobody would know they are there.' },
  { title: '1981 → 2026', pos: 50, rivers: true, cam: 'all',
    text: 'The Space Shuttle first glimpsed these rivers in 1981, on a single flight. NISAR now sees them every 12 days, free for anyone. Next: scan the whole Western Desert for channels nobody has mapped, and point water and archaeology teams to them.' },
];
function fit(opts) {
  if (opts === 'all') mapB.fitBounds(bounds, { padding: 30, duration: 1600 });
  else mapB.flyTo({ ...opts, duration: 1800 });
}
function goStep(i) {
  step = Math.max(0, Math.min(TOUR.length - 1, i)); const s = TOUR[step];
  $('#stepNum').textContent = `Step ${step + 1} of ${TOUR.length}`;
  $('#stepTitle').textContent = s.title; $('#stepText').textContent = s.text;
  $('#prev').disabled = step === 0; $('#next').textContent = step === TOUR.length - 1 ? 'Explore yourself' : 'Next';
  [...$('#dots').children].forEach((d, k) => d.classList.toggle('on', k === step));
  setPos(s.pos, true); showRivers(s.rivers); fit(s.cam);
}
$('#prev').onclick = () => goStep(step - 1);
$('#next').onclick = () => step === TOUR.length - 1 ? setView('explore') : goStep(step + 1);

function setView(v) {
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  document.querySelectorAll('.panel section').forEach(s => s.classList.toggle('active', s.dataset.panel === v));
  mapA.resize(); mapB.resize();
  if (v === 'tour') goStep(step);
  if (v === 'explore') { setPos(50, true); showRivers($('#showRivers').checked); }
}

async function init() {
  M = await (await fetch('data/manifest.json')).json();
  const c = M.radar.corners; bounds = [c[3], c[1]];   // [SW, NE]
  await Promise.all([ready(mapA), ready(mapB)]);
  addRivers(mapB);
  setRadar('hh', 1);
  $('#km').textContent = M.channels_km;
  $('#dots').innerHTML = TOUR.map(() => '<i></i>').join('');
  $('#pol').onchange = () => setRadar($('#pol').value, $('#opacity').value / 100);
  $('#opacity').oninput = () => setRadar($('#pol').value, $('#opacity').value / 100);
  $('#showRivers').onchange = e => showRivers(e.target.checked);
  document.querySelectorAll('nav button').forEach(b => b.onclick = () => setView(b.dataset.view));
  goStep(0);
}
init();
