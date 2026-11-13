import { useEffect, useState } from 'react';
import Tour from './pages/Tour';
import Tag from './pages/Tag';
import LiveMap from './pages/LiveMap';
import Planner from './pages/Planner';
import OpenData from './pages/OpenData';

const PAGES = [
  { id: 'tour', label: 'Tour', el: <Tour /> },
  { id: 'tag', label: 'Tag the desert', el: <Tag /> },
  { id: 'map', label: 'Live map', el: <LiveMap /> },
  { id: 'plan', label: 'Field plan', el: <Planner /> },
  { id: 'data', label: 'Open data', el: <OpenData /> },
] as const;

const fromHash = () => PAGES.find(p => '#' + p.id === location.hash)?.id ?? 'tour';

export default function App() {
  const [page, setPage] = useState<string>(fromHash());
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
      <main>{PAGES.find(p => p.id === page)!.el}</main>
    </div>
  );
}
