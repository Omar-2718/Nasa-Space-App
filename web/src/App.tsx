import { useEffect, useState } from 'react';
import { api, type Setup } from './api';
import EarthdataConnect, { useEarthdata } from './Earthdata';
import Tour from './pages/Tour';
import LiveMap from './pages/LiveMap';
import Planner from './pages/Planner';
import OpenData from './pages/OpenData';

const PAGES = [
  { id: 'tour', label: 'Tour', el: <Tour /> },
  { id: 'map', label: 'Live map', el: <LiveMap /> },
  { id: 'plan', label: 'Field plan', el: <Planner /> },
  { id: 'data', label: 'Open data', el: <OpenData /> },
] as const;

const fromHash = () => PAGES.find(p => '#' + p.id === location.hash)?.id ?? 'tour';

export default function App() {
  const [page, setPage] = useState<string>(fromHash());
  const [setup, setSetup] = useState<Setup>();
  const [ed, setEd] = useEarthdata();
  useEffect(() => { api.setup().then(setSetup).catch(() => {}); }, [page]);
  useEffect(() => {
    const on = () => setPage(fromHash());
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return (
    <div className="shell">
      <header className="top">
        <a className="brand" href="#tour"><span className="logo">◐</span> Beneath the Sand</a>
        <nav>
          {PAGES.map(p => (
            <a key={p.id} href={'#' + p.id} className={page === p.id ? 'active' : ''}>{p.label}</a>
          ))}
        </nav>
      </header>
      {page === 'tour' && ed && !ed.connected && ed.canEdit && (
        <div className="banner"><EarthdataConnect status={ed} onChange={setEd} /></div>
      )}
      {setup && setup.patchesInDb === 0 && page !== 'map' && (
        <div className="banner">
          <b>No radar on this computer yet.</b>
          <span>Open the <a href="#map">Live map</a> and use “Add radar for an area” to download it from NASA.</span>
        </div>
      )}
      <main>{PAGES.find(p => p.id === page)!.el}</main>
    </div>
  );
}
