import type { Ctx } from '../App';
import type { Part } from '../../shared/types';
import { Dot } from './ui';

/** Team chips shared by every page. Choice is remembered on this device. */
export function TeamChips({ ctx }: { ctx: Ctx }) {
  const { state, teamFilter, setTeamFilter } = ctx;
  return <div className="chips" role="group" aria-label="Filter by team">
    <button className={`chip${teamFilter === 'all' ? ' on' : ''}`} aria-pressed={teamFilter === 'all'} onClick={() => setTeamFilter('all')}>All teams</button>
    {state.teams.map(t => <button key={t.id} className={`chip${teamFilter === t.id ? ' on' : ''}`} aria-pressed={teamFilter === t.id} onClick={() => setTeamFilter(t.id)}>
      <Dot color={t.color} />{t.name}
    </button>)}
  </div>;
}

export function byTeam(ctx: Ctx, parts: Part[]) {
  return ctx.teamFilter === 'all' ? parts : parts.filter(p => p.teamId === ctx.teamFilter);
}

export function lookup(ctx: Ctx) {
  const team = (id: string) => ctx.state.teams.find(t => t.id === id) ?? { id, name: 'No team', color: '#94a3b8' };
  const cabinet = (id: string) => ctx.state.cabinets.find(c => c.id === id) ?? { id, name: 'Unassigned', color: '#94a3b8' };
  return { team, cabinet };
}
