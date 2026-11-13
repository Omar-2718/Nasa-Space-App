// Tag the desert: 60-second guide -> practice quiz (gold patches) -> tagging with an AI/crowd reveal after each answer.
// Team members open #tag?admin (or /?admin#tag) to label gold patches instead.
import { useCallback, useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { api, sessionId, SAT_STYLE, pct, type Label, type Patch, type Reveal } from '../api';

const ANSWERS: { label: Label; text: string; key: string; hint: string }[] = [
  { label: 'channel', text: 'River channel', key: '1', hint: 'dark, winding, branching' },
  { label: 'site_feature', text: 'Other feature', key: '2', hint: 'ring, basin, odd shape' },
  { label: 'nothing', text: 'Nothing', key: '3', hint: 'rock, sand, farms' },
  { label: 'unsure', text: 'Not sure', key: '4', hint: 'skip honestly' },
];
const EXAMPLES = [
  { id: '32636_24_489', ok: true, t: 'River valley', d: 'Wide dark band with smooth, curving edges, continuing across the patch.' },
  { id: '32636_30_490', ok: false, t: 'Rock cracks', d: 'Bright, rough, angular lines. Straight segments that change direction sharply.' },
  { id: '32636_53_486', ok: false, t: 'Modern farms', d: 'Perfect circles and straight lines: centre-pivot irrigation, not rivers.' },
  { id: '32636_57_498', ok: false, t: 'Plain sand', d: 'Even grey speckle with no shapes at all.' },
];
const QUIZ_LEN = 5;
const admin = new URLSearchParams(location.search).has('admin');

export default function Tag() {
  const [phase, setPhase] = useState<'guide' | 'quiz' | 'tag'>(() => (sessionStorage.getItem('bts-guided') ? 'tag' : 'guide'));
  const [session, setSession] = useState<string>();
  const [patch, setPatch] = useState<Patch | null>(null);
  const [done, setDone] = useState(false);
  const [reveal, setReveal] = useState<{ r: Reveal; mine: Label } | null>(null);
  const [count, setCount] = useState(0);
  const [quizScore, setQuizScore] = useState(0);
  const [goldCount, setGoldCount] = useState(0);
  const [adminKey, setAdminKey] = useState('');
  const [busy, setBusy] = useState(false);
  const shownAt = useRef(0);
  const photo = useRef<maplibregl.Map | null>(null);

  useEffect(() => { sessionId().then(setSession); api.stats().then(s => setGoldCount(s.gold)); }, []);

  const load = useCallback(async () => {
    if (!session) return;
    setReveal(null);
    const quiz = phase === 'quiz';
    const r = await api.next(session, quiz && !admin);
    if (r.done || !r.patch) { if (quiz) { finishQuiz(); return; } setDone(true); setPatch(null); return; }
    setPatch(r.patch); shownAt.current = performance.now();
  }, [session, phase]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (phase !== 'guide') load(); }, [phase, load]);

  // photo of the same 5 km square
  useEffect(() => {
    if (!patch || phase === 'guide') return;
    const ring = patch.geometry.coordinates[0];
    const xs = ring.map(c => c[0]), ys = ring.map(c => c[1]);
    const b: maplibregl.LngLatBoundsLike = [[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]];
    if (!photo.current) {
      photo.current = new maplibregl.Map({ container: 'photo', style: SAT_STYLE, bounds: b, interactive: false, attributionControl: false });
    } else photo.current.fitBounds(b, { duration: 0 });
  }, [patch, phase]);
  useEffect(() => () => { photo.current?.remove(); photo.current = null; }, [phase]);

  const finishQuiz = () => { sessionStorage.setItem('bts-guided', '1'); setPhase('tag'); };

  const answer = useCallback(async (label: Label) => {
    if (!patch || !session || reveal || busy) return;
    setBusy(true);
    try {
      if (admin) {
        const r = await api.gold(patch.id, label === 'unsure' ? null : label, adminKey);
        setGoldCount(r.gold); setCount(c => c + 1); await load(); return;
      }
      const res = await api.tag({ sessionId: session, patchId: patch.id, label, ms: Math.round(performance.now() - shownAt.current), isQuiz: phase === 'quiz' });
      setReveal({ r: res.reveal, mine: label });
      if (phase === 'quiz' && res.reveal.gold?.correct) setQuizScore(s => s + 1);
      setCount(c => c + 1);
    } catch (e) { alertBox((e as Error).message); }
    finally { setBusy(false); }
  }, [patch, session, reveal, busy, phase, adminKey, load]);

  const next = useCallback(() => {
    if (phase === 'quiz' && count >= QUIZ_LEN) return finishQuiz();
    load();
  }, [phase, count, load]);

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      const a = ANSWERS.find(x => x.key === e.key); if (a) answer(a.label);
      if ((e.key === 'Enter' || e.key === ' ') && reveal) { e.preventDefault(); next(); }
    };
    addEventListener('keydown', on); return () => removeEventListener('keydown', on);
  }, [answer, next, reveal]);

  if (phase === 'guide') return <Guide goldReady={goldCount >= QUIZ_LEN} onStart={(quiz) => (quiz ? setPhase('quiz') : finishQuiz())} />;

  return (
    <div className="tagpage">
      <div className="tagcol">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div>
            <p className="eyebrow">{admin ? `Admin: gold labels (${goldCount})` : phase === 'quiz' ? `Practice ${Math.min(count + 1, QUIZ_LEN)} of ${QUIZ_LEN}` : `Your tags: ${count}`}</p>
            <h1>{admin ? 'Label the known answer' : 'Is there a buried river here?'}</h1>
          </div>
          {!admin && <button onClick={() => setPhase('guide')}>How to spot rivers</button>}
        </div>
        {admin && <input placeholder="Admin key" value={adminKey} onChange={e => setAdminKey(e.target.value)} style={{ padding: 8, borderRadius: 6, border: '1px solid var(--line)', background: 'var(--bg)', color: 'var(--fg)', maxWidth: 260 }} />}
        {phase === 'quiz' && <div className="progress"><i style={{ width: `${count / QUIZ_LEN * 100}%` }} /></div>}

        {done ? <div className="card"><h2>You've seen every patch. Thank you!</h2><p className="muted">See what everyone found on the <a href="#map">live map</a>.</p></div> : (
          <>
            <div className="pair">
              <div className="tile">
                <span className="cap">NISAR radar · 5 × 5 km</span>
                {patch && <img src={patch.images.radar} alt="Radar patch" />}
                {patch && reveal && <img src={reveal.r.ai !== null ? patch.images.ai : patch.images.tracer} alt="" style={{ opacity: .85 }} />}
              </div>
              <div className="tile">
                <span className="cap">Satellite photo · same place</span>
                <div id="photo" className="map" />
              </div>
            </div>

            {!reveal ? (
              <div className="answers">
                {ANSWERS.map(a => (
                  <button key={a.label} onClick={() => answer(a.label)} disabled={!patch || busy}>
                    {a.text}<span className="muted small">{a.hint}</span><kbd>key {a.key}</kbd>
                  </button>
                ))}
              </div>
            ) : (
              <div className="reveal pulse">
                {reveal.r.gold ? (
                  <div><span className="muted small">Expert answer</span><b className={reveal.r.gold.correct ? 'ok' : 'no'}>{reveal.r.gold.correct ? 'You got it' : `It was: ${labelText(reveal.r.gold.label)}`}</b></div>
                ) : null}
                <div><span className="muted small">{reveal.r.ai !== null ? 'AI thinks' : 'Tracer thinks'}</span><b>{pct(reveal.r.ai ?? reveal.r.tracer)} river</b></div>
                <div><span className="muted small">Crowd so far</span><b>{reveal.r.crowd.channelShare === null ? '–' : `${pct(reveal.r.crowd.channelShare)} river`}</b><span className="muted small">{reveal.r.crowd.votes} vote{reveal.r.crowd.votes === 1 ? '' : 's'}</span></div>
                <div style={{ marginLeft: 'auto' }}><button className="primary" onClick={next}>Next patch ⏎</button></div>
              </div>
            )}
            {phase === 'quiz' && count >= QUIZ_LEN && reveal && <p className="ok">Practice done: {quizScore}/{QUIZ_LEN} right. Your answers now count towards the map.</p>}
            <p className="muted small">The orange overlay appears after you answer: it shows where the AI (or the rule-based tracer) sees channels. We hide it before you answer so you judge with your own eyes.</p>
          </>
        )}
      </div>
    </div>
  );
}

const labelText = (l: Label) => ANSWERS.find(a => a.label === l)?.text ?? l;
function alertBox(msg: string) { console.error(msg); }

function Guide({ goldReady, onStart }: { goldReady: boolean; onStart: (quiz: boolean) => void }) {
  return (
    <div className="tagpage">
      <div className="tagcol">
        <div className="card">
          <p className="eyebrow">60-second guide</p>
          <h1>Help archaeologists know where to look</h1>
          <p>Thousands of years ago the Sahara was green, crossed by rivers where early humans lived. The rivers are now buried under sand, invisible from the ground or in photos. NISAR's radar sees through the sand. You look at 5 km radar squares and say whether you see an old river.</p>
          <p className="muted">Every answer does two things: it builds an open map that tells field teams where to walk and dig, and it trains an AI that can scan the whole Sahara.</p>
        </div>
        <div className="card">
          <h2>How to read the radar</h2>
          <p className="muted">Bright = rough rock or gravel bouncing the radar back. Dark = smooth fine sediment, which is what fills old riverbeds. Rivers look like <b style={{ color: 'var(--river)' }}>dark, winding, branching bands</b> that continue across the square.</p>
          <div className="examples">
            {EXAMPLES.map(e => (
              <figure key={e.id} className={e.ok ? 'yes' : 'no'}>
                <img src={`/patches/${e.id}_radar.png`} alt={e.t} />
                <figcaption><b className={e.ok ? 'ok' : 'no'}>{e.ok ? '✓ ' : '✗ '}{e.t}</b>{e.d}</figcaption>
              </figure>
            ))}
          </div>
        </div>
        <div className="row">
          {goldReady
            ? <><button className="primary" onClick={() => onStart(true)}>Take the 5-patch practice</button><button onClick={() => onStart(false)}>Skip practice</button></>
            : <button className="primary" onClick={() => onStart(false)}>Start tagging</button>}
        </div>
        <p className="muted small">Your answers are weighted by how often you agree with expert-labelled patches, so careful tagging counts more. Unsure is always a fine answer.</p>
      </div>
    </div>
  );
}
