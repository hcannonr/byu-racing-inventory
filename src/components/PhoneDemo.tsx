import { useState } from 'react';
import { RotateCcw, X } from 'lucide-react';
import type { Part } from '../../shared/types';

/** Shows exactly what a phone sees after scanning the label, so a demo works without a phone. */
export function PhoneDemo({ part, onClose }: { part: Part; onClose: () => void }) {
  const [run, setRun] = useState(0);
  return <div className="overlay phone-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="phone-wrap" role="dialog" aria-modal="true" aria-label={`Phone scan of ${part.name}`}>
      <div className="phone-caption">
        <strong>What a phone sees</strong>
        <span>Scanning the label on the {part.name.toLowerCase()} bin opens this page. No app, no sign-in.</span>
        <div className="btn-row">
          <button className="btn ghost-light sm" onClick={() => setRun(n => n + 1)}><RotateCcw aria-hidden />Scan again</button>
          <button className="btn ghost-light sm" onClick={onClose}><X aria-hidden />Close</button>
        </div>
      </div>
      <div className="phone">
        <div className="phone-notch" />
        <iframe key={run} title="Phone scan" src={`/scan/${encodeURIComponent(part.id)}`} />
      </div>
    </div>
  </div>;
}
