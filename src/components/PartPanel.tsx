import { useEffect, useState } from 'react';
import { ExternalLink, PackageCheck, Pencil, Printer, ScanLine, ShoppingCart, Smartphone, Trash2, X } from 'lucide-react';
import type { Ctx } from '../App';
import { canOrder, eventText, timeAgo, type Part } from '../../shared/types';
import { api } from '../api';
import { lookup } from './Filters';
import { Dot, Modal, PartThumb, StatusPill } from './ui';

const stepCopy = {
  stocked: { title: 'Bin is stocked', body: 'When it drops to the low line, scan the label on the bin.' },
  low: { title: 'Bin is low', body: 'Order more, then mark it ordered so everyone knows it\'s handled.' },
  ordered: { title: 'Order is on the way', body: 'When it arrives, fill the bin and mark it restocked.' },
};

export function PartPanel({ ctx, part, onClose }: { ctx: Ctx; part: Part; onClose: () => void }) {
  const { team, cabinet } = lookup(ctx);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const t = team(part.teamId); const c = cabinet(part.cabinetId);
  const history = ctx.state.events.filter(e => e.partId === part.id).slice(0, 6);
  const buyer = canOrder(ctx.state.me);
  const step = buyer || part.status === 'stocked' ? stepCopy[part.status] : part.status === 'low'
    ? { title: 'Bin is low', body: 'The business team has been told. It moves to On the way once they order it.' }
    : { title: 'Order is on the way', body: 'The business team marks it restocked when it arrives.' };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('.modal')) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return <>
    <div className="scrim" onClick={onClose} />
    <aside className="panel" role="dialog" aria-label={part.name}>
      <header className="panel-head">
        <StatusPill status={part.status} />
        <button className="icon-btn" onClick={onClose} aria-label="Close"><X /></button>
      </header>
      <div className="panel-body">
        <div className="panel-hero">
          <PartThumb part={part} size="lg" />
          <div>
            <h2>{part.name}</h2>
            {part.detail && <p className="muted">{part.detail}</p>}
          </div>
        </div>

        <div className={`next next-${part.status}`}>
          <div><strong>{step.title}</strong><p>{step.body}</p>{part.status === 'ordered' && part.orderNote && <p className="note">“{part.orderNote}”</p>}</div>
          {part.status === 'stocked' && <button className="btn ghost" onClick={() => ctx.advance(part, 'low')}><ScanLine aria-hidden />Mark low</button>}
          {buyer && part.status === 'low' && <button className="btn primary" onClick={() => ctx.advance(part, 'ordered')}><ShoppingCart aria-hidden />Mark ordered</button>}
          {buyer && part.status === 'ordered' && <button className="btn success" onClick={() => ctx.advance(part, 'stocked')}><PackageCheck aria-hidden />Restocked</button>}
        </div>

        <dl className="facts">
          <div><dt>Team</dt><dd><Dot color={t.color} />{t.name}</dd></div>
          <div><dt>Stored in</dt><dd><Dot color={c.color} />{c.name}{part.spot && <span className="muted"> · {part.spot}</span>}</dd></div>
          <div><dt>Order amount</dt><dd>{part.orderQty} when low</dd></div>
          <div><dt>Buy from</dt><dd>{part.link ? <a href={part.link} target="_blank" rel="noreferrer">{part.supplier || 'Supplier link'}<ExternalLink aria-hidden /></a> : part.supplier || <span className="muted">Not set</span>}</dd></div>
        </dl>

        <div className="panel-actions">
          <button className="btn ghost" onClick={() => ctx.printLabels([part.id])}><Printer aria-hidden />Print label</button>
          {ctx.state.mode === 'demo' && <button className="btn ghost" onClick={() => ctx.phoneDemo(part)}><Smartphone aria-hidden />Try a scan</button>}
          <button className="btn ghost" onClick={() => ctx.editPart(part)}><Pencil aria-hidden />Edit</button>
        </div>

        <section className="panel-history">
          <h3>History</h3>
          {history.length ? <ol className="feed compact">{history.map(e => <li key={e.id} className={`feed-item feed-${e.kind}`}>
            <span className="feed-dot" aria-hidden /><span className="feed-text">{eventText[e.kind][0].toUpperCase() + eventText[e.kind].slice(1)}{e.kind === 'scanned' && ' from a phone'}{e.note && <span className="muted"> · {e.note}</span>}</span><time dateTime={e.at}>{timeAgo(e.at)}</time>
          </li>)}</ol> : <p className="muted small">Nothing yet.</p>}
        </section>

        <button className="btn danger-text" onClick={() => setConfirmDelete(true)}><Trash2 aria-hidden />Remove part</button>
      </div>
    </aside>
    {confirmDelete && <Modal title="Remove this part?" onClose={() => setConfirmDelete(false)} footer={<>
      <button className="btn ghost" onClick={() => setConfirmDelete(false)}>Cancel</button>
      <button className="btn danger" onClick={async () => { setConfirmDelete(false); onClose(); await ctx.run(() => api.deletePart(part.id), `${part.name} removed`); }}>Remove</button>
    </>}>
      <p><b>{part.name}</b> will be taken off the list. Its printed label will stop working.</p>
    </Modal>}
  </>;
}
