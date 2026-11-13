// Beneath the Sand: two synced maps (photo | radar) with a swipe, plus a farm time-lapse.
const SAT = {
  type: 'raster', tileSize: 256, maxzoom: 18,
  tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
  attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
};
const style = { version: 8, sources: { sat: SAT }, layers: [{ id: 'sat', type: 'raster', source: 'sat' }] };

const NOTES = {
  safsaf: 'The dark winding lines on the radar side are old riverbeds filled with fine sediment. In the photo there is only sand. First seen from the Space Shuttle in 1981.',
  escarpment: 'Control case: this bright band is a rock escarpment you can also see in the photo. Radar makes surface rock pop out too, so always compare both sides.',
};

let M, grid, frames, chart, timer = null, view = 'xray';
const $ = s => document.querySelector(s);
const mapA = new maplibregl.Map({ container: 'mapA', style, center: [29.35, 22.65], zoom: 9, attributionControl: false });
const mapB = new maplibregl.Map({ container: 'mapB', style, center: [29.35, 22.65], zoom: 9 });
mapB.addControl(new maplibregl.NavigationControl(), 'bottom-right');

// keep both maps in lockstep
let syncing = false;
function sync(src, dst) {
  src.on('move', () => {
    if (syncing) return; syncing = true;
    dst.jumpTo({ center: src.getCenter(), zoom: src.getZoom(), bearing: src.getBearing(), pitch: src.getPitch() });
    syncing = false;
  });
}
sync(mapA, mapB); sync(mapB, mapA);

// swipe handle: mapB (radar) is clipped to the right of the handle
const wrap = $('.mapwrap'), handle = $('#swipe');
function setPos(p) { wrap.style.setProperty('--pos', Math.max(0, Math.min(100, p)) + '%'); }
let dragging = false;
handle.addEventListener('pointerdown', e => { dragging = true; handle.setPointerCapture(e.pointerId); });
handle.addEventListener('pointermove', e => { if (!dragging) return; const r = wrap.getBoundingClientRect(); setPos((e.clientX - r.left) / r.width * 100); });
handle.addEventListener('pointerup', () => dragging = false);

const ready = m => new Promise(r => m.loaded() ? r() : m.once('load', r));

async function init() {
  M = await (await fetch('data/manifest.json')).json();
  await Promise.all([ready(mapA), ready(mapB)]);
  const sel = $('#site');
  for (const k of ['safsaf', 'escarpment']) if (M[k]) sel.add(new Option(M[k].title, k));
  sel.onchange = () => showSite(sel.value, true);
  $('#pol').onchange = () => showSite(sel.value, false);
  $('#opacity').oninput = e => mapB.getLayer('radar') && mapB.setPaintProperty('radar', 'raster-opacity', e.target.value / 100);
  showSite('safsaf', true);
  if (M.farms) initFarms();
  document.querySelectorAll('nav button').forEach(b => b.onclick = () => setView(b.dataset.view));
}

function setOverlay(map, id, url, corners, opacity = 1) {
  if (map.getSource(id)) { map.getSource(id).updateImage({ url, coordinates: corners }); return; }
  map.addSource(id, { type: 'image', url, coordinates: corners });
  map.addLayer({ id, type: 'raster', source: id, paint: { 'raster-opacity': opacity, 'raster-fade-duration': 0 } });
}

function showSite(site, fly) {
  const s = M[site];
  setOverlay(mapB, 'radar', `data/${site}_${$('#pol').value}.png`, s.corners, $('#opacity').value / 100);
  $('#siteNote').textContent = NOTES[site] || '';
  if (fly) fitCorners(s.corners);
}
function fitCorners(c) {
  const xs = c.map(p => p[0]), ys = c.map(p => p[1]);
  mapA.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], { padding: 30, duration: 1200 });
}

// ---------- Part 2: farms ----------
const fmt = d => new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
async function initFarms() {
  grid = await (await fetch('data/farm_grid.json')).json();
  const F = M.farms, t = $('#time');
  t.max = F.dates.length - 1;
  t.oninput = () => showFrame(+t.value);
  $('#play').onclick = e => {
    if (timer) { clearInterval(timer); timer = null; e.target.textContent = 'Play'; return; }
    e.target.textContent = 'Pause';
    timer = setInterval(() => showFrame((+t.value + 1) % F.dates.length), 800);
  };
  // preload frames into canvases so clicks can read full-resolution (20 m) values from the alpha channel
  frames = await Promise.all(F.dates.map(d => new Promise(res => {
    const im = new Image(); im.onload = () => {
      const cv = document.createElement('canvas'); cv.width = im.width; cv.height = im.height;
      const cx = cv.getContext('2d', { willReadFrequently: true }); cx.drawImage(im, 0, 0); res(cx);
    }; im.src = `data/farm_${d}.png`;
  })));
  chart = new Chart($('#chart'), {
    type: 'line',
    data: { labels: F.dates.map(fmt), datasets: [{ label: 'Crop greenness (radar HV, 0-100)', data: [], borderColor: '#6fdc7a', backgroundColor: '#6fdc7a33', fill: true, tension: .3, pointRadius: 3 }] },
    options: { animation: false, plugins: { legend: { display: false }, title: { display: true, text: 'Click a field on the map', color: '#a3967f' } },
      scales: { y: { min: 0, max: 100, ticks: { color: '#a3967f' }, grid: { color: '#352d22' } }, x: { ticks: { color: '#a3967f' }, grid: { display: false } } } },
  });
  mapB.on('click', e => { if (view === 'farms') pickField(e.lngLat); });
  mapA.on('click', e => { if (view === 'farms') pickField(e.lngLat); });
  stats();
}
function showFrame(i) {
  const F = M.farms; $('#time').value = i; $('#date').textContent = fmt(F.dates[i]);
  setOverlay(mapB, 'farm', `data/farm_${F.dates[i]}.png`, F.corners, 1);
  if (chart.data.datasets[0].data.length) { chart.data.datasets[0].pointRadius = F.dates.map((_, k) => k === i ? 7 : 3); chart.update(); }
}
// bilinear inverse of the 4-corner overlay is overkill at this scale: use the axis-aligned box
function lngLatToCell(ll) {
  const c = M.farms.corners, xs = c.map(p => p[0]), ys = c.map(p => p[1]);
  const fx = (ll.lng - Math.min(...xs)) / (Math.max(...xs) - Math.min(...xs));
  const fy = (Math.max(...ys) - ll.lat) / (Math.max(...ys) - Math.min(...ys));
  if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return null;
  return [Math.min(M.farms.gw - 1, Math.floor(fx * M.farms.gw)), Math.min(M.farms.gh - 1, Math.floor(fy * M.farms.gh))];
}
let marker;
function pickField(ll) {
  const c = M.farms.corners, xs = c.map(p => p[0]), ys = c.map(p => p[1]);
  const fx = (ll.lng - Math.min(...xs)) / (Math.max(...xs) - Math.min(...xs));
  const fy = (Math.max(...ys) - ll.lat) / (Math.max(...ys) - Math.min(...ys));
  if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return;
  const W = frames[0].canvas.width, H = frames[0].canvas.height, px = Math.floor(fx * W), py = Math.floor(fy * H), r = 4;
  // greenness 0-100 from the frame's alpha (alpha = 20 + 235*g), averaged over a 180 m box
  const series = frames.map(cx => {
    const d = cx.getImageData(Math.max(0, px - r), Math.max(0, py - r), 2 * r + 1, 2 * r + 1).data;
    let s = 0, n = 0; for (let i = 3; i < d.length; i += 4) { s += (d[i] - 20) / 235; n++; } return Math.round(s / n * 100);
  });
  chart.data.datasets[0].data = series;
  chart.options.plugins.title.text = `Field at ${ll.lat.toFixed(3)}°N ${ll.lng.toFixed(3)}°E`;
  chart.update(); showFrame(+$('#time').value);
  marker?.remove(); marker = new maplibregl.Marker({ color: '#e58a4b' }).setLngLat(ll).addTo(mapB);
}
function stats() {
  // share of cells above a "crop" threshold, first vs last date
  const thr = -18, share = fr => { let a = 0, n = 0; fr.forEach(r => r.forEach(v => { n++; if (v > thr) a++; })); return a / n * 100; };
  const first = share(grid[0]), last = share(grid[grid.length - 1]);
  $('#stats').innerHTML = `<div class="stat"><b>${first.toFixed(1)}%</b><span>green area, ${fmt(M.farms.dates[0])}</span></div>
    <div class="stat"><b>${last.toFixed(1)}%</b><span>green area, ${fmt(M.farms.dates.at(-1))}</span></div>`;
}

function setView(v) {
  view = v;
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  document.querySelectorAll('.panel section').forEach(s => s.classList.toggle('active', s.dataset.panel === v));
  const farms = v === 'farms';
  document.body.classList.toggle('noswipe', farms);
  if (mapB.getLayer('radar')) mapB.setLayoutProperty('radar', 'visibility', farms ? 'none' : 'visible');
  if (mapB.getLayer('farm')) mapB.setLayoutProperty('farm', 'visibility', farms ? 'visible' : 'none');
  mapA.resize(); mapB.resize();             // resize first: it cancels any running camera animation
  if (farms) { showFrame(+$('#time').value); fitCorners(M.farms.corners); }
  else if (v === 'xray') showSite($('#site').value, true);
}

init();
