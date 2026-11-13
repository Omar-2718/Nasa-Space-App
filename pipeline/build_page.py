"""Inline layers into prototype/index.html (self-contained, for sharing)."""
import base64, json, os
L = 'prototype/layers'; t = open('prototype/template.html').read()
uri = lambda f: 'data:image/jpeg;base64,' + base64.b64encode(open(f'{L}/{f}', 'rb').read()).decode()
meta = json.load(open(f'{L}/meta.json'))
t = t.replace('{{optical}}', uri('optical.jpg')).replace('{{radar}}', uri('radar_hh.jpg'))
if 'farms' in meta:
    F = meta['farms']; frames = [uri(f'farm_{d}.jpg') for d in F['dates']]
    html = '''<div class="farmbox" id="fb"><img id="fimg" alt="NISAR HV over Toshka farms"><div class="pin" id="pin" hidden></div></div>
<div class="controls"><button id="play" type="button">Play</button><input id="t" type="range" min="0" max="%d" value="0" aria-label="Date"><span class="date" id="d"></span></div>
<p class="muted">Green = strong HV radar signal (plants with leaves and stems scatter the radar). Dark = bare sand or empty field. Tap any field to see its growing season.</p>
<div class="chart"><svg id="ch" viewBox="0 0 600 180" width="100%%" role="img" aria-label="HV signal over time for the selected field"></svg></div>''' % (len(frames) - 1)
    js = 'const FR=%s,DT=%s,G=%s,GW=%d,GH=%d;' % (json.dumps(frames), json.dumps(F['dates']), json.dumps(F['grid']), F['gw'], F['gh'])
    js += r'''
const img=document.getElementById('fimg'),t=document.getElementById('t'),dl=document.getElementById('d'),fb=document.getElementById('fb'),pin=document.getElementById('pin'),ch=document.getElementById('ch');
const fmt=s=>new Date(s.slice(0,4)+'-'+s.slice(4,6)+'-'+s.slice(6)).toLocaleDateString('en-GB',{day:'numeric',month:'short'});
function show(i){img.src=FR[i];dl.textContent=fmt(DT[i]);t.value=i;mark(i)}
t.addEventListener('input',()=>show(+t.value));
let timer=null;document.getElementById('play').onclick=e=>{if(timer){clearInterval(timer);timer=null;e.target.textContent='Play';return}
e.target.textContent='Pause';timer=setInterval(()=>show((+t.value+1)%FR.length),700)};
let sel=null;
fb.addEventListener('click',e=>{const r=fb.getBoundingClientRect();const fx=(e.clientX-r.left)/r.width,fy=(e.clientY-r.top)/r.height;
pin.hidden=false;pin.style.left=fx*100+'%';pin.style.top=fy*100+'%';
const gx=Math.min(GW-1,Math.floor(fx*GW)),gy=Math.min(GH-1,Math.floor(fy*GH));
const v=G.map(fr=>{let s=0,n=0;for(let y=gy-1;y<=gy+1;y++)for(let x=gx-1;x<=gx+1;x++){if(fr[y]&&fr[y][x]!==undefined){s+=fr[y][x];n++}}return s/n});sel=v;draw(+t.value)});
function draw(i){const W=600,H=180,p=36;const lo=-35,hi=-10;let s='';
for(let g=lo;g<=hi;g+=5){const y=H-p/2-(g-lo)/(hi-lo)*(H-p);s+=`<line x1="${p}" x2="${W-8}" y1="${y}" y2="${y}" stroke="currentColor" opacity=".12"/><text x="4" y="${y+4}">${g} dB</text>`}
DT.forEach((d,k)=>{const x=p+k*(W-p-16)/(DT.length-1);s+=`<text x="${x-14}" y="${H-2}">${fmt(d)}</text>`});
if(sel){const pts=sel.map((v,k)=>[p+k*(W-p-16)/(DT.length-1),H-p/2-(Math.max(lo,Math.min(hi,v))-lo)/(hi-lo)*(H-p)]);
s+=`<polyline points="${pts.map(q=>q.join(',')).join(' ')}" fill="none" stroke="var(--crop)" stroke-width="2.5"/>`;
pts.forEach((q,k)=>s+=`<circle cx="${q[0]}" cy="${q[1]}" r="${k==i?6:3.5}" fill="var(--crop)"/>`)}
else s+=`<text x="${W/2-90}" y="${H/2}">Tap a field above to plot it</text>`;ch.innerHTML=s}
function mark(i){draw(i)}
show(0);'''
else:
    html = '<p class="muted">Farm time series loading (data still downloading).</p>'; js = ''
t = t.replace('{{farms}}', html).replace('{{farmjs}}', js)
open('prototype/index.html', 'w').write(t); print('index.html', os.path.getsize('prototype/index.html') // 1024, 'KB')
