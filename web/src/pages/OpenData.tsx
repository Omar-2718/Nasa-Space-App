// Open data + method: downloads, model metrics, how the pipeline works.
import { useEffect, useState } from 'react';
import { api, type Stats } from '../api';

export default function OpenData() {
  const [stats, setStats] = useState<Stats>();
  const [metrics, setMetrics] = useState<Record<string, unknown> | null>(null);
  useEffect(() => { api.stats().then(setStats); api.metrics().then(setMetrics).catch(() => setMetrics(null)); }, []);
  return (
    <div className="page">
      <div>
        <div>
          <p className="eyebrow">Open data</p>
          <h1>A training set the field doesn't have yet</h1>
        </div>
        <p>Researchers trying to map buried rivers with AI say the bottleneck is labelled data. Every tag here becomes part of an open dataset (CC-BY 4.0): radar patches, crowd labels weighted by tagger reliability, and model predictions.</p>
        <div className="dl">
          <a href="/api/dataset.geojson">Labels + scores (GeoJSON)</a>
          <a href="/layers/patches/index.json">Patch index (JSON)</a>
          <a href="/api/export/csv?limit=100">Top 100 candidates (CSV)</a>
        </div>
        <div className="stats" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))' }}>
          <div className="stat"><b>{stats?.patches ?? '–'}</b><span>radar patches (5 × 5 km)</span></div>
          <div className="stat"><b>{stats ? Math.round(stats.patches * 5.12 * 5.12).toLocaleString() : '–'} km²</b><span>area covered</span></div>
          <div className="stat"><b>{stats?.tags ?? '–'}</b><span>crowd tags</span></div>
          <div className="stat"><b>{stats?.gold ?? '–'}</b><span>expert gold labels</span></div>
        </div>

        <h2>The AI</h2>
        {metrics ? (
          <table><tbody>
            <tr><th>Model</th><td>U-Net, ResNet-18 encoder, input HH / HV / HH−HV radar at 20 m</td></tr>
            <tr><th>Trained on</th><td>{String(metrics.train_patches)} patches: tracer pseudo-labels corrected by crowd votes, farms as negatives</td></tr>
            <tr><th>Held-out tile</th><td>{String(metrics.held_out_tile)}: never seen in training. IoU vs tracer {String(metrics.held_out_iou_vs_tracer)}</td></tr>
            <tr><th>Agreement with crowd</th><td>{metrics.crowd_agreement === null ? 'not enough crowd votes yet' : `${Math.round(Number(metrics.crowd_agreement) * 100)}% on ${metrics.crowd_patches} patches`}</td></tr>
            <tr><th>Patches the AI flags</th><td>{String(metrics.patches_flagged_by_ai)}</td></tr>
            <tr><th>Last trained</th><td>{String(metrics.trained_at)}</td></tr>
          </tbody></table>
        ) : <p className="muted">Model not trained yet. Scores currently come from the rule-based tracer.</p>}

        <h2>Trust model</h2>
        <p className="muted">Each tagger's votes are weighted by accuracy on expert gold patches, and by a Dawid–Skene model that estimates reliability from agreement with others. Answers faster than a second, or the same button every time, get filtered. Low-trust votes are down-weighted, never deleted.</p>

        <h2>Pipeline</h2>
        <table><tbody>
          <tr><th>1. Data</th><td>NISAR L2 GCOV (provisional), track 079 descending, 17 Oct 2026, HH + HV at 20 m. Streamed from NASA ASF DAAC as small crops instead of the whole 1.6 GB file.</td></tr>
          <tr><th>2. Tracer</th><td>dB conversion, speckle filter, background removal, Sato ridge filter for dark winding lines, rough-rock mask, skeleton. Wide valleys from km-scale dark elongated regions.</td></tr>
          <tr><th>3. Patches</th><td>Fixed UTM grid, 256 × 256 px (5.12 km), deduplicated across tiles.</td></tr>
          <tr><th>4. Crowd + trust</th><td>Tags weighted by tagger reliability; consensus per patch in PostGIS.</td></tr>
          <tr><th>5. AI loop</th><td>U-Net retrained on corrected labels, then scores every patch and suggests the next ones to tag.</td></tr>
          <tr><th>6. Field plan</th><td>Ranking by crowd, AI and distance to known sites; export as KML / GPX / CSV.</td></tr>
        </tbody></table>
        <p className="muted small">Limitations: single radar date, provisional NISAR data, automatic tracer false positives in rocky areas, some site coordinates approximate. Bir Safsaf and Wadi Arid site locations are not yet verified.</p>
      </div>
    </div>
  );
}
