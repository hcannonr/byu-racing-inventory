import { ArrowRight, CircleCheck, ExternalLink, History, PackageCheck, ScanLine, ShoppingCart, Truck } from 'lucide-react';
import type { Ctx } from '../App';
import { canOrder, daysSince, eventText, timeAgo, type ActivityEvent, type Part } from '../../shared/types';
import { byTeam, lookup, TeamChips } from './Filters';
import { Dot, Empty, PartThumb } from './ui';

export function RestockBoard({ ctx }: { ctx: Ctx }) {
  const parts = byTeam(ctx, ctx.state.parts);
  const low = parts.filter(p => p.status === 'low').sort((a, b) => b.statusAt.localeCompare(a.statusAt));
  const ordered = parts.filter(p => p.status === 'ordered').sort((a, b) => b.statusAt.localeCompare(a.statusAt));
  const stocked = parts.length - low.length - ordered.length;
  const ids = new Set(parts.map(p => p.id));
  const buyer = canOrder(ctx.state.me);
  const events = ctx.state.events.filter(e => e.kind !== 'edited' && (ctx.teamFilter === 'all' || ids.has(e.partId))).slice(0, 9);

  return <section className="page">
    <div className="page-head">
      <div>
        <h1>Restock</h1>
        <p className="lede">{buyer ? 'When a bin drops to its low line, someone scans its label. The part shows up here so the buyer can order it.'
          : 'See what\'s low and what\'s on the way. The business team handles ordering.'}</p>
      </div>
    </div>
    <TeamChips ctx={ctx} />

    <div className="stats">
      <Stat tone="low" icon={<ScanLine />} n={low.length} label="Need ordering" />
      <Stat tone="ordered" icon={<Truck />} n={ordered.length} label="On the way" />
      <Stat tone="stocked" icon={<CircleCheck />} n={stocked} label="Stocked" onClick={() => ctx.go('parts')} />
    </div>

    <div className="board">
      <Column title="Need ordering" tone="low" count={low.length} hint={buyer ? 'Buy these, then mark them ordered.' : 'Scanned low. Waiting for the buyer to order.'}>
        {low.length ? low.map(p => <BoardCard key={p.id} ctx={ctx} part={p} />)
          : <Empty icon={<CircleCheck />} title="Nothing to order">When someone scans a low bin, it lands here.</Empty>}
      </Column>
      <Column title="On the way" tone="ordered" count={ordered.length} hint={buyer ? 'When it arrives, fill the bin and mark it restocked.' : 'Ordered. The buyer marks it restocked when it arrives.'}>
        {ordered.length ? ordered.map(p => <BoardCard key={p.id} ctx={ctx} part={p} />)
          : <Empty icon={<Truck />} title="No open orders">Parts you mark ordered wait here until they're restocked.</Empty>}
      </Column>
      <aside className="column column-activity">
        <header className="column-head"><h2><History aria-hidden />Recent activity</h2></header>
        {events.length ? <ol className="feed">{events.map(e => <FeedItem key={e.id} ctx={ctx} e={e} />)}</ol>
          : <Empty icon={<History />} title="No activity yet" />}
      </aside>
    </div>
  </section>;
}

function Stat({ tone, icon, n, label, onClick }: { tone: string; icon: React.ReactNode; n: number; label: string; onClick?: () => void }) {
  const Tag = onClick ? 'button' : 'div';
  return <Tag className={`stat stat-${tone}`} onClick={onClick}>
    <span className="stat-icon" aria-hidden>{icon}</span>
    <span><b>{n}</b><small>{label}</small></span>
    {onClick && <ArrowRight className="stat-go" aria-hidden />}
  </Tag>;
}

function Column({ title, tone, count, hint, children }: { title: string; tone: string; count: number; hint: string; children: React.ReactNode }) {
  return <section className={`column column-${tone}`} aria-label={title}>
    <header className="column-head"><h2><span className={`tone-dot tone-${tone}`} />{title}<em>{count}</em></h2><p>{hint}</p></header>
    <div className="column-list">{children}</div>
  </section>;
}

function BoardCard({ ctx, part }: { ctx: Ctx; part: Part }) {
  const { team, cabinet } = lookup(ctx);
  const t = team(part.teamId); const c = cabinet(part.cabinetId);
  const waiting = daysSince(part.statusAt);
  const fresh = Date.now() - new Date(part.statusAt).getTime() < 15_000;
  return <article className={`card board-card${fresh ? ' fresh' : ''}`}>
    <button className="board-card-main" onClick={() => ctx.openPart(part.id)} aria-label={`Open ${part.name}`}>
      <PartThumb part={part} />
      <span className="board-card-text">
        <strong>{part.name}</strong>
        <small>{part.detail}</small>
        <span className="meta"><span><Dot color={t.color} />{t.name}</span><span>{c.name}{part.spot ? ` · ${part.spot}` : ''}</span></span>
      </span>
    </button>
    <div className="board-card-foot">
      <span className={`when${waiting >= 3 ? ' late' : ''}`}>
        {part.status === 'low' ? `Flagged ${timeAgo(part.statusAt)}` : part.orderNote ? part.orderNote : `Ordered ${timeAgo(part.statusAt)}`}
      </span>
      {!canOrder(ctx.state.me) ? <span className={`waiting-tag waiting-${part.status}`}>{part.status === 'low' ? 'Needs ordering' : 'On the way'}</span>
      : part.status === 'low' ? <div className="btn-row">
        {part.link && <a className="btn ghost sm" href={part.link} target="_blank" rel="noreferrer"><ExternalLink aria-hidden />Buy {part.orderQty}</a>}
        <button className="btn primary sm" onClick={() => ctx.advance(part, 'ordered')}><ShoppingCart aria-hidden />Mark ordered</button>
      </div> : <button className="btn success sm" onClick={() => ctx.advance(part, 'stocked')}><PackageCheck aria-hidden />Restocked</button>}
    </div>
  </article>;
}

function FeedItem({ ctx, e }: { ctx: Ctx; e: ActivityEvent }) {
  const exists = ctx.state.parts.some(p => p.id === e.partId);
  const name = exists ? <button className="link" onClick={() => ctx.openPart(e.partId)}>{e.partName}</button> : <b>{e.partName}</b>;
  return <li className={`feed-item feed-${e.kind}`}>
    <span className="feed-dot" aria-hidden />
    <span className="feed-text">{name} {eventText[e.kind]}</span>
    <time dateTime={e.at}>{timeAgo(e.at)}</time>
  </li>;
}
