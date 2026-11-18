import { useEffect, useRef, useState } from 'react';
import { CircleAlert, CircleCheck, Truck, Undo2 } from 'lucide-react';
import type { Part } from '../../shared/types';
import { api } from '../api';
import { Logo, PartThumb } from './ui';

type Result =
  | { kind: 'loading' }
  | { kind: 'flagged'; part: Part; eventId: string | null }
  | { kind: 'already'; part: Part }
  | { kind: 'undone'; part: Part }
  | { kind: 'error'; message: string; missing?: boolean };

/** The page a phone opens after scanning a bin label. It flags the part right away. No sign-in. */
export function ScanPage({ id }: { id: string }) {
  const k = new URLSearchParams(location.search).get('k');
  const [result, setResult] = useState<Result>({ kind: 'loading' });
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return; started.current = true;
    api.scan(id, k)
      .then(r => setResult(r.changed ? { kind: 'flagged', part: r.part, eventId: r.eventId } : { kind: 'already', part: r.part }))
      .catch(e => setResult({ kind: 'error', message: e.message, missing: e.status === 404 }));
  }, [id]);

  return <div className="scan">
    <header className="scan-top"><Logo /><span>Shop Inventory</span></header>
    <main className="scan-main">
      {result.kind === 'loading' && <div className="scan-card"><div className="spinner" aria-label="Saving" /><p>Saving…</p></div>}
      {result.kind === 'flagged' && <div className="scan-card">
        <span className="scan-badge ok"><CircleCheck aria-hidden /></span>
        <h1>Marked low</h1>
        <PartLine part={result.part} />
        <p>It's on the restock list. The buyer will order more. Keep using the bin.</p>
        {result.eventId && <button className="scan-undo" onClick={async () => {
          try { await api.undo(result.eventId!, k); setResult({ kind: 'undone', part: result.part }); }
          catch (e) { setResult({ kind: 'error', message: (e as Error).message }); }
        }}><Undo2 aria-hidden />Scanned by mistake? Undo</button>}
      </div>}
      {result.kind === 'already' && <div className="scan-card">
        <span className={`scan-badge ${result.part.status === 'ordered' ? 'info' : 'ok'}`}>{result.part.status === 'ordered' ? <Truck aria-hidden /> : <CircleCheck aria-hidden />}</span>
        <h1>{result.part.status === 'ordered' ? 'Already ordered' : 'Already on the list'}</h1>
        <PartLine part={result.part} />
        <p>{result.part.status === 'ordered' ? `More is on the way${result.part.orderNote ? ` (${result.part.orderNote})` : ''}. Nothing else to do.` : 'Someone already scanned this bin. Nothing else to do.'}</p>
      </div>}
      {result.kind === 'undone' && <div className="scan-card">
        <span className="scan-badge muted"><Undo2 aria-hidden /></span>
        <h1>Undone</h1>
        <PartLine part={result.part} />
        <p>The bin is back to stocked. You can close this page.</p>
      </div>}
      {result.kind === 'error' && <div className="scan-card">
        <span className="scan-badge bad"><CircleAlert aria-hidden /></span>
        <h1>{result.missing ? 'Label not found' : "Didn't go through"}</h1>
        <p>{result.missing ? "This label isn't linked to a part anymore. Let your team lead know so it can be reprinted." : result.message}</p>
        {!result.missing && <button className="btn primary" onClick={() => location.reload()}>Try again</button>}
      </div>}
    </main>
    <footer className="scan-foot">BYU Racing · scan a bin when it hits the low line</footer>
  </div>;
}

function PartLine({ part }: { part: Part }) {
  return <div className="scan-part"><PartThumb part={part} /><div><strong>{part.name}</strong><small>{part.detail}</small></div></div>;
}
