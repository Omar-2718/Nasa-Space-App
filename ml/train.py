"""Train a U-Net to find buried channels in NISAR patches, then score every patch.

Labels: rule-based tracer masks (pseudo-labels from pipeline/make_patches.py), corrected by the crowd:
patches that taggers agree contain nothing become empty masks; patches they agree contain a channel get
their tracer mask kept with a higher weight. One tile is held out entirely to show the model on unseen desert.

usage: .venv/bin/python ml/train.py [--epochs 15] [--no-db]
writes: ml/models/unet.pt, ml/metrics.json, web_assets/ai_scores.json, web_assets/patches/<id>_ai.png, patches.ai_score in the DB
"""
import argparse, glob, json, os, time
import numpy as np, torch, torch.nn.functional as F
import segmentation_models_pytorch as smp
from PIL import Image

ap = argparse.ArgumentParser()
ap.add_argument('--epochs', type=int, default=15)
ap.add_argument('--holdout', default='t_30.91_22.97')
ap.add_argument('--no-db', action='store_true')
ap.add_argument('--score-only', action='store_true', help='skip training, rescore with ml/models/unet.pt')
args = ap.parse_args()
os.chdir(os.path.join(os.path.dirname(__file__), '..'))
torch.manual_seed(0); np.random.seed(0)
dev = 'cuda' if torch.cuda.is_available() else 'cpu'
DB_URL = os.environ.get('DATABASE_URL', 'postgresql://sand:sand@localhost:5433/beneath')

# ---------- data ----------
index = {p['id']: p for p in json.load(open('web_assets/patches/index.json'))}
ids = sorted(index)
X = np.zeros((len(ids), 3, 256, 256), np.float32); Y = np.zeros((len(ids), 2, 256, 256), np.float32)   # [channel lines, wide valleys]
from scipy import ndimage as ndi
for i, pid in enumerate(ids):
    d = np.load(f'data/patches/{pid}.npz')
    hh, hv = d['hh'].astype(np.float32), d['hv'].astype(np.float32)
    X[i] = [hh, hv, hh - hv]
    Y[i, 0] = ndi.binary_dilation(d['line'] > 0, iterations=2)   # thin channels, widened to ~5 px
    Y[i, 1] = d['valley']
mu, sd = X.mean((0, 2, 3), keepdims=True), X.std((0, 2, 3), keepdims=True)
X = (X - mu) / sd

# crowd corrections from the database (weighted consensus view)
weight = np.ones(len(ids), np.float32); crowd = {}
if not args.no_db:
    try:
        import psycopg
        with psycopg.connect(DB_URL) as con:
            crowd = {r[0]: (r[1], r[2]) for r in con.execute('SELECT id, votes, channel_share FROM consensus WHERE votes > 0')}
            gold = dict(con.execute('SELECT id, gold_label FROM patches WHERE gold_label IS NOT NULL').fetchall())
        for i, pid in enumerate(ids):
            if pid in gold:
                if gold[pid] == 'nothing': Y[i] = 0
                weight[i] = 3.0
            elif pid in crowd and crowd[pid][1] is not None and crowd[pid][0] >= 2:
                share = crowd[pid][1]
                if share < 0.25: Y[i] = 0; weight[i] = 2.0          # crowd says: no channel here
                elif share > 0.75: weight[i] = 2.0                 # crowd confirms the tracer
        print(f'crowd-labelled patches: {len(crowd)}, gold: {len(gold)}')
    except Exception as e:
        print('DB not used:', e)

# modern farms/roads are never rivers: teach the model that (hand-mapped list, see pipeline/modern_zones.json)
modern = set(json.load(open('pipeline/modern_zones.json'))['patches'])
for i, pid in enumerate(ids):
    if pid in modern: Y[i] = 0; weight[i] = 3.0
print(f'modern (negative) patches: {sum(p in modern for p in ids)}')

tiles = np.array([index[p]['tile'] for p in ids])
val = tiles == args.holdout
tr_idx, va_idx = np.where(~val)[0], np.where(val)[0]
print(f'{dev} | train {len(tr_idx)} patches, held-out tile {args.holdout}: {len(va_idx)} patches')

def batches(idx, bs, aug):
    idx = np.random.permutation(idx) if aug else idx
    for s in range(0, len(idx), bs):
        b = idx[s:s + bs]; x, y = torch.from_numpy(X[b]), torch.from_numpy(Y[b])
        if aug:
            k = np.random.randint(4); x, y = torch.rot90(x, k, (2, 3)), torch.rot90(y, k, (2, 3))
            if np.random.rand() < .5: x, y = x.flip(3), y.flip(3)
        yield x.contiguous().to(dev), y.contiguous().to(dev), torch.from_numpy(weight[b]).to(dev)

# ---------- model ----------
model = smp.Unet('resnet18', encoder_weights='imagenet', in_channels=3, classes=2).to(dev)
POS_W = torch.tensor([15.0, 1.0], device=dev).view(1, 2, 1, 1)   # channel pixels are rare: weight them up
opt = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=1e-4)
sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=1e-3, total_steps=args.epochs * int(np.ceil(len(tr_idx) / 8)))
dice = smp.losses.DiceLoss('multilabel', from_logits=True)
scaler = torch.amp.GradScaler(enabled=dev == 'cuda')

def evaluate(idx):
    model.eval(); inter = union = 0
    with torch.no_grad():
        for x, y, _ in batches(idx, 16, False):
            p = torch.sigmoid(model(x))[:, :1] > 0.5; t = y[:, :1] > 0.5
            inter += (p & t).sum().item(); union += (p | t).sum().item()
    return inter / max(union, 1)

if args.score_only:
    ck = torch.load('ml/models/unet.pt', weights_only=False); model.load_state_dict(ck['state'])
t0 = time.time()
for ep in range(0 if args.score_only else args.epochs):
    model.train(); tot = 0
    for x, y, w in batches(tr_idx, 8, True):
        with torch.autocast(dev, enabled=dev == 'cuda'):
            out = model(x)
            bce = F.binary_cross_entropy_with_logits(out, y, pos_weight=POS_W, reduction='none').mean((1, 2, 3))
            loss = (bce * w).mean() + dice(out, y)
        opt.zero_grad(); scaler.scale(loss).backward(); scaler.step(opt); scaler.update(); sched.step()
        tot += loss.item() * len(x)
    print(f'epoch {ep + 1:2d}  loss {tot / len(tr_idx):.3f}  held-out channel IoU vs tracer {evaluate(va_idx):.3f}  train {evaluate(tr_idx[:60]):.3f}  ({time.time() - t0:.0f}s)', flush=True)

os.makedirs('ml/models', exist_ok=True)
if not args.score_only: torch.save({'state': model.state_dict(), 'mu': mu, 'sd': sd}, 'ml/models/unet.pt')

# ---------- score every patch ----------
model.eval(); scores = {}
with torch.no_grad():
    for s in range(0, len(ids), 16):
        x = torch.from_numpy(X[s:s + 16]).to(dev)
        probs = torch.sigmoid(model(x)).cpu().numpy()
        for j, (pc, pv) in enumerate(probs):
            pid = ids[s + j]
            # calibrated on the predicted-cover distribution: the model marks ~8% of a typical patch as channel,
            # so the score starts above 5% channel cover and is full at 20% (or 30% wide-valley cover)
            c, v = (pc > 0.5).mean(), (pv > 0.5).mean()
            scores[pid] = round(float(max(np.clip((c - 0.05) / 0.15, 0, 1), np.clip(v / 0.3, 0, 1))), 3)
            p = np.maximum(pc, pv * 0.6)
            a = np.clip((p - 0.6) / 0.4, 0, 1)
            rgba = np.zeros((256, 256, 4), np.uint8); rgba[..., 0] = 255; rgba[..., 1] = 170; rgba[..., 2] = 60; rgba[..., 3] = (a * 220).astype(np.uint8)
            Image.fromarray(rgba).save(f'web_assets/patches/{pid}_ai.png', optimize=True)
json.dump(scores, open('web_assets/ai_scores.json', 'w'))

# agreement with crowd on patches people have tagged (the honest metric)
agree = [(scores[p] >= 0.5) == (c[1] >= 0.5) for p, c in crowd.items() if c[1] is not None and p in scores]
metrics = {'held_out_tile': args.holdout, 'held_out_iou_vs_tracer': round(evaluate(va_idx), 3), 'train_iou_vs_tracer': round(evaluate(tr_idx), 3), 'epochs': args.epochs if not args.score_only else 'rescored',
           'train_patches': int(len(tr_idx)), 'crowd_patches': len(agree), 'crowd_agreement': round(float(np.mean(agree)), 3) if agree else None,
           'patches_flagged_by_ai': int(sum(v >= 0.5 for v in scores.values())), 'trained_at': time.strftime('%Y-%m-%d %H:%M')}
json.dump(metrics, open('ml/metrics.json', 'w'), indent=1)
print(metrics)

if not args.no_db:
    try:
        import psycopg
        with psycopg.connect(DB_URL) as con:
            with con.cursor() as cur:
                cur.executemany('UPDATE patches SET ai_score = %s WHERE id = %s', [(v, k) for k, v in scores.items()])
        print('ai_score written to DB')
    except Exception as e:
        print('DB update skipped:', e)
