"""Trust model: estimate how reliable each tagger and each tag is, and flag likely trolls.

Signals
  1. Gold patches (known answers): accuracy with a Beta(2,1) prior.
  2. Dawid-Skene EM (binary: channel/site vs nothing; 'unsure' ignored): estimates each tagger's
     sensitivity/specificity from agreement with others, without needing gold answers.
  3. Behaviour: median answer time under 1 s, or the same button > 95% of the time.
Writes sessions.trust, sessions.flagged and tags.p_correct. Flagged sessions are ignored by the consensus view.

usage: .venv/bin/python ml/trust.py [--loop 30]
"""
import argparse, os, time
from collections import defaultdict
import numpy as np, psycopg

DB_URL = os.environ.get('DATABASE_URL', 'postgresql://sand:sand@localhost:5433/beneath')

def run():
    with psycopg.connect(DB_URL) as con:
        rows = con.execute("""SELECT t.id, t.session_id, t.patch_id, t.label::text, t.ms, t.is_quiz, p.gold_label::text
                              FROM tags t JOIN patches p ON p.id = t.patch_id""").fetchall()
        if not rows: return print('no tags yet')
        pos = lambda l: None if l in (None, 'unsure') else (1 if l in ('channel', 'site_feature') else 0)

        by_s = defaultdict(list)
        for r in rows: by_s[r[1]].append(r)

        # --- behaviour flags
        flagged = set()
        for s, ts in by_s.items():
            ms = [t[4] for t in ts if t[4] is not None]
            labels = [t[3] for t in ts]
            fast = len(ms) >= 5 and np.median(ms) < 1000
            same = len(labels) >= 10 and max(labels.count(l) for l in set(labels)) / len(labels) > 0.95
            if fast or same: flagged.add(s)

        # --- gold accuracy
        gold_acc = {}
        for s, ts in by_s.items():
            g = [(pos(t[3]), pos(t[6])) for t in ts if t[6] is not None and pos(t[3]) is not None]
            if g: gold_acc[s] = ((sum(a == b for a, b in g) + 2) / (len(g) + 3), len(g))

        # --- Dawid-Skene (binary) over non-quiz tags from unflagged sessions
        obs = [(r[1], r[2], pos(r[3])) for r in rows if not r[5] and r[1] not in flagged and pos(r[3]) is not None]
        patches = sorted({o[1] for o in obs}); sessions = sorted({o[0] for o in obs})
        pi = {p: i for i, p in enumerate(patches)}; si = {s: i for i, s in enumerate(sessions)}
        T = np.full(len(patches), 0.5)
        votes = defaultdict(list)
        for s, p, y in obs: votes[pi[p]].append((si[s], y))
        for k, v in votes.items(): T[k] = np.mean([y for _, y in v])          # init: majority vote
        sens = np.full(len(sessions), 0.8); spec = np.full(len(sessions), 0.8)
        for _ in range(20):
            # M-step: per-tagger sensitivity / specificity (smoothed)
            a1 = np.ones(len(sessions)); n1 = np.full(len(sessions), 2.0); a0 = np.ones(len(sessions)); n0 = np.full(len(sessions), 2.0)
            for k, v in votes.items():
                for j, y in v:
                    a1[j] += T[k] * y; n1[j] += T[k]; a0[j] += (1 - T[k]) * (1 - y); n0[j] += 1 - T[k]
            sens, spec = a1 / n1, a0 / n0
            prior = np.clip(T.mean(), 0.05, 0.95)
            # E-step: posterior that each patch truly has a channel
            for k, v in votes.items():
                l1, l0 = np.log(prior), np.log(1 - prior)
                for j, y in v:
                    l1 += np.log(sens[j] if y else 1 - sens[j]); l0 += np.log(1 - spec[j] if y else spec[j])
                T[k] = 1 / (1 + np.exp(l0 - l1))

        # --- combine into trust per session
        trust = {}
        for s in by_s:
            if s in flagged: trust[s] = 0.0; continue
            if s in gold_acc and gold_acc[s][1] >= 3: trust[s] = gold_acc[s][0]
            elif s in si: trust[s] = float((sens[si[s]] + spec[si[s]]) / 2)
            else: trust[s] = 0.7
        # per-tag probability of being right = posterior of the label it chose
        p_correct = []
        for r in rows:
            y = pos(r[3])
            if r[2] in pi and y is not None: p_correct.append((float(T[pi[r[2]]] if y else 1 - T[pi[r[2]]]), r[0]))

        with con.cursor() as cur:
            cur.executemany('UPDATE sessions SET trust = %s, flagged = %s WHERE id = %s', [(round(t, 3), s in flagged, s) for s, t in trust.items()])
            cur.executemany('UPDATE tags SET p_correct = %s WHERE id = %s', [(round(p, 3), i) for p, i in p_correct])
        print(f'{time.strftime("%H:%M:%S")} tags {len(rows)} | sessions {len(by_s)} | flagged {len(flagged)} | patches modelled {len(patches)}')

if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('--loop', type=int, default=0); a = ap.parse_args()
    while True:
        run()
        if not a.loop: break
        time.sleep(a.loop)
