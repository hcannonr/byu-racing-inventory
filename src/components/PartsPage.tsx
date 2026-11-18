import { useState } from 'react';
import { ChevronRight, Plus, Search, SearchX } from 'lucide-react';
import type { Ctx } from '../App';
import type { Part, PartStatus } from '../../shared/types';
import { byTeam, lookup, TeamChips } from './Filters';
import { Dot, Empty, PartThumb, StatusPill } from './ui';

type GroupBy = 'cabinet' | 'team';
const statusOrder: Record<PartStatus, number> = { low: 0, ordered: 1, stocked: 2 };

export function PartsPage({ ctx }: { ctx: Ctx }) {
  const [query, setQuery] = useState('');
  const [groupBy, setGroupBy] = useState<GroupBy>('cabinet');
  const [status, setStatus] = useState<'all' | PartStatus>('all');
  const { team, cabinet } = lookup(ctx);
  const q = query.trim().toLowerCase();
  const parts = byTeam(ctx, ctx.state.parts)
    .filter(p => status === 'all' || p.status === status)
    .filter(p => !q || [p.name, p.detail, p.spot, p.supplier, team(p.teamId).name, cabinet(p.cabinetId).name].join(' ').toLowerCase().includes(q));
  const groups = (groupBy === 'cabinet' ? ctx.state.cabinets : ctx.state.teams)
    .map(g => ({ ...g, parts: parts.filter(p => (groupBy === 'cabinet' ? p.cabinetId : p.teamId) === g.id) }))
    .filter(g => g.parts.length);
  const all = byTeam(ctx, ctx.state.parts);
  const count = (s: PartStatus) => all.filter(p => p.status === s).length;

  return <section className="page">
    <div className="page-head">
      <div>
        <h1>Parts</h1>
        <p className="lede">Every part in the shop and where it lives. Click one to see details, print its label, or change its status.</p>
      </div>
    </div>
    <TeamChips ctx={ctx} />

    <div className="toolbar">
      <label className="search"><Search aria-hidden /><input type="search" placeholder="Search parts, sizes, drawers" value={query} onChange={e => setQuery(e.target.value)} aria-label="Search parts" /></label>
      <div className="seg" role="group" aria-label="Show">
        {(['all', 'low', 'ordered', 'stocked'] as const).map(s => <button key={s} className={status === s ? 'on' : ''} aria-pressed={status === s} onClick={() => setStatus(s)}>
          {s === 'all' ? 'All' : s[0].toUpperCase() + s.slice(1)}{s !== 'all' && <em>{count(s)}</em>}
        </button>)}
      </div>
      <div className="seg" role="group" aria-label="Group by">
        <button className={groupBy === 'cabinet' ? 'on' : ''} aria-pressed={groupBy === 'cabinet'} onClick={() => setGroupBy('cabinet')}>By storage</button>
        <button className={groupBy === 'team' ? 'on' : ''} aria-pressed={groupBy === 'team'} onClick={() => setGroupBy('team')}>By team</button>
      </div>
    </div>

    {groups.length === 0 && <div className="card"><Empty icon={<SearchX />} title={all.length ? 'No parts match' : 'No parts yet'}>
      {all.length ? 'Try a different search or filter.' : <button className="btn accent" onClick={ctx.addPart}><Plus aria-hidden />Add your first part</button>}
    </Empty></div>}

    {groups.map(g => <section key={g.id} className="group">
      <h2 className="group-head"><Dot color={g.color} />{g.name}<em>{g.parts.length} part{g.parts.length === 1 ? '' : 's'}</em></h2>
      <div className="card list">
        {[...g.parts].sort((a, b) => (groupBy === 'cabinet' ? 0 : statusOrder[a.status] - statusOrder[b.status]) || `${a.spot} ${a.name}`.localeCompare(`${b.spot} ${b.name}`, undefined, { numeric: true }))
          .map(p => <Row key={p.id} ctx={ctx} part={p} groupBy={groupBy} />)}
      </div>
    </section>)}
  </section>;
}

function Row({ ctx, part, groupBy }: { ctx: Ctx; part: Part; groupBy: GroupBy }) {
  const { team, cabinet } = lookup(ctx);
  const t = team(part.teamId); const c = cabinet(part.cabinetId);
  return <button className="row" onClick={() => ctx.openPart(part.id)}>
    <PartThumb part={part} size="sm" />
    <span className="row-name"><strong>{part.name}</strong><small>{part.detail}</small></span>
    <span className="row-cell">{groupBy === 'cabinet' ? <><Dot color={t.color} />{t.name}</> : <><Dot color={c.color} />{c.name}</>}</span>
    <span className="row-cell muted">{part.spot || '—'}</span>
    <span className="row-status"><StatusPill status={part.status} /></span>
    <ChevronRight className="row-go" aria-hidden />
  </button>;
}
