import { useEffect, useMemo, useState } from 'react';
import { qrcode, drawingSVG } from '@bwip-js/generic';
import { Printer, ScanLine, Tags } from 'lucide-react';
import type { Ctx } from '../App';
import type { Part } from '../../shared/types';
import { api } from '../api';
import { byTeam, lookup, TeamChips } from './Filters';
import { Dot, Empty } from './ui';

let scanOrigin = '';
let originLoaded: Promise<void> | null = null;
function useScanOrigin() {
  const [origin, setOrigin] = useState(scanOrigin || location.origin);
  useEffect(() => {
    originLoaded ??= api.config().then(c => { scanOrigin = c.scanOrigin; }).catch(() => {});
    void originLoaded.then(() => setOrigin(scanOrigin || location.origin));
  }, []);
  return origin;
}

const qrCache = new Map<string, string>();
function qrSrc(text: string) {
  let src = qrCache.get(text);
  if (!src) {
    const svg = qrcode({ bcid: 'qrcode', text, scale: 4, padding: 0, backgroundcolor: 'FFFFFF' }, drawingSVG());
    src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    qrCache.set(text, src);
  }
  return src;
}

export const scanUrl = (origin: string, id: string, key?: string) => `${origin}/scan/${encodeURIComponent(id)}${key ? `?k=${key}` : ''}`;

export function LabelCard({ ctx, part }: { ctx: Ctx; part: Part }) {
  const origin = useScanOrigin();
  const { team, cabinet } = lookup(ctx);
  const t = team(part.teamId); const c = cabinet(part.cabinetId);
  return <div className="label" style={{ '--team': t.color } as React.CSSProperties}>
    <img className="label-qr" src={qrSrc(scanUrl(origin, part.id, ctx.state.scanKeys?.[part.id]))} alt={`QR code for ${part.name}`} />
    <div className="label-text">
      <span className="label-team">{t.name}</span>
      <strong className="label-name">{part.name}</strong>
      {part.detail && <span className="label-detail">{part.detail}</span>}
      <span className="label-where">{c.name}{part.spot ? ` · ${part.spot}` : ''}</span>
      <span className="label-cta"><ScanLine aria-hidden />Low? Scan me</span>
    </div>
  </div>;
}

export function LabelsPage({ ctx, preset, clearPreset }: { ctx: Ctx; preset: string[] | null; clearPreset: () => void }) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(preset ?? []));
  useEffect(() => { if (preset) { setSelected(new Set(preset)); clearPreset(); } }, [preset, clearPreset]);
  const parts = byTeam(ctx, ctx.state.parts);
  const groups = ctx.state.cabinets.map(c => ({ ...c, parts: parts.filter(p => p.cabinetId === c.id) })).filter(g => g.parts.length);
  const chosen = useMemo(() => ctx.state.parts.filter(p => selected.has(p.id)), [ctx.state.parts, selected]);
  const toggle = (ids: string[], on: boolean) => setSelected(prev => { const next = new Set(prev); ids.forEach(id => on ? next.add(id) : next.delete(id)); return next; });
  const allShown = parts.length > 0 && parts.every(p => selected.has(p.id));

  return <section className="page">
    <div className="page-head">
      <div>
        <h1>Labels</h1>
        <p className="lede">Pick parts, print on plain paper, and tape each label to its bin at the low line. Scanning it with any phone camera flags the part.</p>
      </div>
      <button className="btn primary" disabled={!chosen.length} onClick={() => window.print()}><Printer aria-hidden />Print {chosen.length || ''} label{chosen.length === 1 ? '' : 's'}</button>
    </div>
    <TeamChips ctx={ctx} />

    <div className="labels-layout">
      <div className="card pick-list">
        <header className="pick-head">
          <label className="check"><input type="checkbox" checked={allShown} onChange={e => toggle(parts.map(p => p.id), e.target.checked)} /><span>Select all shown</span></label>
          {selected.size > 0 && <button className="link" onClick={() => setSelected(new Set())}>Clear</button>}
        </header>
        {groups.map(g => <div key={g.id} className="pick-group">
          <h3><Dot color={g.color} />{g.name}</h3>
          {g.parts.map(p => <label key={p.id} className="check pick-item">
            <input type="checkbox" checked={selected.has(p.id)} onChange={e => toggle([p.id], e.target.checked)} />
            <span>{p.name}<small>{p.detail}</small></span>
          </label>)}
        </div>)}
      </div>
      <div className="sheet-wrap">
        {chosen.length ? <div className="sheet print-sheet">{chosen.map(p => <LabelCard key={p.id} ctx={ctx} part={p} />)}</div>
          : <div className="card"><Empty icon={<Tags />} title="No labels picked">Choose parts on the left. A preview of the sheet shows up here.</Empty></div>}
      </div>
    </div>
  </section>;
}
