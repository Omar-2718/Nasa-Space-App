// NASA Earthdata login for on-demand radar downloads, set from the app's first page.
// The password is checked with NASA, then saved only on this computer in ~/.netrc (mode 600), the standard place
// earthaccess reads it from. It is never logged or sent back to the browser.
// Only the person at this computer can change it: requests must come from a localhost page (not a phone on the Wi-Fi).
import { Router, type Request } from 'express';
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';

export const earthdata = Router();
const NETRC = homedir() + '/.netrc';
const HOST = 'urs.earthdata.nasa.gov';
const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

const isLocal = (req: Request) => {
  const addr = req.socket.remoteAddress ?? '';
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(addr)) return false;
  const from = req.get('origin') ?? req.get('referer');
  if (!from) return true;                                           // curl on this machine
  try { return LOCAL.has(new URL(from).hostname); } catch { return false; }
};

// ~/.netrc as entries ("machine X login Y password Z", on one line or several); other machines' entries are kept
type Entry = string[];
const entries = (): Entry[] => {
  if (!existsSync(NETRC)) return [];
  const out: Entry[] = [];
  for (const t of readFileSync(NETRC, 'utf8').split(/\s+/).filter(Boolean)) {
    if (t === 'machine' || t === 'default' || !out.length) out.push([]);
    out[out.length - 1].push(t);
  }
  return out;
};
const isUrs = (e: Entry) => e[0] === 'machine' && e[1] === HOST;
const otherLines = () => entries().filter(e => !isUrs(e)).map(e => e.join(' '));
const currentUser = () => { const e = entries().find(isUrs); const i = e?.indexOf('login') ?? -1; return e && i >= 0 ? e[i + 1] ?? null : null; };

earthdata.get('/earthdata', (req, res) => {
  const user = currentUser();
  const local = isLocal(req);
  res.json({ connected: !!user, user: local ? user : null, canEdit: local });   // the username only for this computer
});

earthdata.post('/earthdata', async (req, res) => {
  if (!isLocal(req)) return res.status(403).json({ error: 'Open the app on this computer (localhost) to change the NASA login.' });
  const username = String(req.body?.username ?? '').trim(), password = String(req.body?.password ?? '');
  if (!username || !password) return res.status(400).json({ error: 'Enter your NASA Earthdata username and password.' });
  if (/\s/.test(username) || /\s/.test(password)) return res.status(400).json({ error: 'Username and password cannot contain spaces here. Edit ~/.netrc by hand instead (see README).' });
  // check the login with NASA before saving it
  let r: Response;
  try {
    r = await fetch(`https://${HOST}/api/users/tokens`, { headers: { authorization: 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64') }, signal: AbortSignal.timeout(20000) });
  } catch {
    return res.status(502).json({ error: "Couldn't reach NASA to check the login. Check your internet and try again." });
  }
  if (r.status === 401 || r.status === 403) return res.status(401).json({ error: 'NASA says the username or password is wrong.' });
  if (!r.ok) return res.status(502).json({ error: `NASA returned an error (${r.status}). Try again in a minute.` });
  writeFileSync(NETRC, [...otherLines(), `machine ${HOST} login ${username} password ${password}`].join('\n') + '\n', { mode: 0o600 });
  chmodSync(NETRC, 0o600);
  res.json({ connected: true, user: username });
});

earthdata.delete('/earthdata', (req, res) => {
  if (!isLocal(req)) return res.status(403).json({ error: 'Open the app on this computer (localhost) to change the NASA login.' });
  const rest = otherLines();
  if (existsSync(NETRC)) writeFileSync(NETRC, rest.length ? rest.join('\n') + '\n' : '', { mode: 0o600 });
  res.json({ connected: false, user: null });
});
