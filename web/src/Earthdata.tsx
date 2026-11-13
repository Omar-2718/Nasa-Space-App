// Connect a NASA Earthdata account so this computer can download NISAR radar on demand.
// The login is checked with NASA by our local API and saved only on this computer (~/.netrc).
import { useEffect, useState } from 'react';

export type EdStatus = { connected: boolean; user: string | null; canEdit: boolean };

async function call(method: string, body?: unknown): Promise<EdStatus> {
  const r = await fetch('/api/earthdata', { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? r.statusText);
  return j;
}

export function useEarthdata() {
  const [st, setSt] = useState<EdStatus | null>(null);
  useEffect(() => { call('GET').then(setSt).catch(() => setSt(null)); }, []);
  return [st, setSt] as const;
}

export default function EarthdataConnect({ status, onChange, compact }: { status: EdStatus | null; onChange: (s: EdStatus) => void; compact?: boolean }) {
  const [user, setUser] = useState(''), [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false), [err, setErr] = useState('');
  if (!status) return null;
  if (status.connected) return (
    <p className="small ok" style={{ margin: 0 }}>
      NASA Earthdata connected{status.user ? ` as ${status.user}` : ''}.
      {status.canEdit && <button className="linkbtn" onClick={async () => onChange(await call('DELETE'))}>Disconnect</button>}
    </p>
  );
  if (!status.canEdit) return <p className="small muted">Radar downloads need a NASA login, set up on the computer running the app.</p>;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try { onChange(await call('POST', { username: user, password: pass })); setPass(''); }
    catch (x) { setErr((x as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <form className="edform" onSubmit={submit}>
      {!compact && <b>Connect your NASA Earthdata account</b>}
      <span className="small muted">Needed to download radar from NASA. Free account: <a href="https://urs.earthdata.nasa.gov/users/new" target="_blank" rel="noreferrer">sign up</a>. Saved only on this computer and sent only to NASA.</span>
      <input autoComplete="username" placeholder="Earthdata username" value={user} onChange={e => setUser(e.target.value)} />
      <input type="password" autoComplete="current-password" placeholder="Password" value={pass} onChange={e => setPass(e.target.value)} />
      <button className="primary" disabled={busy || !user || !pass}>{busy ? 'Checking with NASA…' : 'Connect'}</button>
      {err && <span className="no small">{err}</span>}
    </form>
  );
}
