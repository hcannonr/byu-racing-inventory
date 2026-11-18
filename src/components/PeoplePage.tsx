import { useState } from 'react';
import { Check, Clock, ShieldCheck, Trash2, UserPlus, Users, Wrench, X } from 'lucide-react';
import type { Ctx } from '../App';
import { GENERAL, roleHelp, roleLabel, timeAgo, type Role, type User } from '../../shared/types';
import { api } from '../api';
import { lookup } from './Filters';
import { Dot, Modal } from './ui';

const roleIcon = { admin: ShieldCheck, lead: Wrench, member: Users };
const roles: Role[] = ['admin', 'lead', 'member'];

export function Avatar({ user, color }: { user: Pick<User, 'name'>; color: string }) {
  const initials = user.name.split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
  return <span className="avatar" style={{ background: color }} aria-hidden>{initials}</span>;
}

export function PeoplePage({ ctx }: { ctx: Ctx }) {
  const { me, users } = ctx.state;
  const { team } = lookup(ctx);
  const isAdmin = me.role === 'admin';
  const pending = users.filter(u => u.status === 'pending').sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
  const active = users.filter(u => u.status === 'active').sort((a, b) => roles.indexOf(a.role) - roles.indexOf(b.role) || a.name.localeCompare(b.name));
  const [removing, setRemoving] = useState<User | null>(null);
  const colorOf = (u: User) => u.role === 'admin' ? '#475569' : team(u.teamId).color;
  const workTeams = ctx.state.teams.filter(t => t.id !== GENERAL);

  return <section className="page">
    <div className="page-head">
      <div>
        <h1>People</h1>
        <p className="lede">{isAdmin ? 'Approve new people and choose what each person can do.' : `People on the ${team(me.teamId).name} team. Approve teammates who ask to join.`}</p>
      </div>
      <button className="btn ghost" onClick={async () => {
        const link = ctx.state.mode === 'live' ? location.origin : `${location.origin}/join`;
        try { await navigator.clipboard.writeText(link); ctx.notify('Invite link copied. New people sign in with Google and pick their team.'); }
        catch { ctx.notify(`Invite link: ${link}`); }
      }}><UserPlus aria-hidden />Copy invite link</button>
    </div>

    <div className="roles">
      {roles.map(r => { const Icon = roleIcon[r]; return <div key={r} className={`role-card role-${r}`}>
        <span className="role-icon"><Icon aria-hidden /></span>
        <div><strong>{roleLabel[r]}</strong><p>{roleHelp[r]}</p></div>
      </div>; })}
    </div>

    <section className="card people-card">
      <header className="people-head"><Clock aria-hidden /><h2>Waiting for approval</h2><em className={pending.length ? 'hot' : ''}>{pending.length}</em></header>
      {pending.length ? <ul className="people-list">{pending.map(u => <PendingRow key={u.id} ctx={ctx} user={u} color={colorOf(u)} />)}</ul>
        : <p className="people-empty">No one is waiting. Send new people the invite link. They sign in and pick their team.</p>}
    </section>

    <section className="card people-card">
      <header className="people-head"><Users aria-hidden /><h2>Active</h2><em>{active.length}</em></header>
      <ul className="people-list">
        {active.map(u => <li key={u.id} className="person">
          <Avatar user={u} color={colorOf(u)} />
          <div className="person-name"><b>{u.name}{u.id === me.id && <span className="tag">You</span>}</b><small>{u.email}</small></div>
          {isAdmin && u.id !== me.id ? <>
            <select className="select" value={u.role} aria-label={`Role for ${u.name}`} onChange={e => {
              const role = e.target.value as Role;
              const teamId = role === 'admin' ? '' : u.teamId || workTeams[0]?.id || GENERAL;
              void ctx.run(() => api.updateUser(u.id, { role, teamId }), `${u.name} is now ${role === 'admin' ? 'an admin' : `a ${roleLabel[role].toLowerCase()}`}`);
            }}>{roles.map(r => <option key={r} value={r}>{roleLabel[r]}</option>)}</select>
            {u.role === 'admin' ? <span className="person-team muted">Every team</span>
              : <select className="select" value={u.teamId} aria-label={`Team for ${u.name}`} onChange={e => void ctx.run(() => api.updateUser(u.id, { teamId: e.target.value }), `${u.name} moved to ${team(e.target.value).name}`)}>
                {ctx.state.teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>}
            <button className="icon-btn" aria-label={`Remove ${u.name}`} onClick={() => setRemoving(u)}><Trash2 /></button>
          </> : <>
            <span className={`role-pill role-${u.role}`}>{roleLabel[u.role]}</span>
            <span className="person-team">{u.role === 'admin' ? <span className="muted">Every team</span> : <><Dot color={team(u.teamId).color} />{team(u.teamId).name}</>}</span>
            <span />
          </>}
        </li>)}
      </ul>
    </section>

    {removing && <Modal title="Remove access?" onClose={() => setRemoving(null)} footer={<>
      <button className="btn ghost" onClick={() => setRemoving(null)}>Cancel</button>
      <button className="btn danger" onClick={async () => { const u = removing; setRemoving(null); await ctx.run(() => api.removeUser(u.id), `${u.name} removed`); }}>Remove</button>
    </>}><p><b>{removing.name}</b> won't be able to sign in anymore. Their parts and history stay.</p></Modal>}
  </section>;
}

function PendingRow({ ctx, user, color }: { ctx: Ctx; user: User; color: string }) {
  const isAdmin = ctx.state.me.role === 'admin';
  const { team } = lookup(ctx);
  const [role, setRole] = useState<Role>('member');
  const t = team(user.teamId);
  return <li className="person pending">
    <Avatar user={user} color={color} />
    <div className="person-name"><b>{user.name}</b><small>{user.email}</small></div>
    <span className="person-ask">Wants to join <span className="person-team"><Dot color={t.color} />{t.name}</span><small>{timeAgo(user.requestedAt)}</small></span>
    {isAdmin ? <select className="select" value={role} onChange={e => setRole(e.target.value as Role)} aria-label={`Role for ${user.name}`}>
      {roles.map(r => <option key={r} value={r}>As {roleLabel[r].toLowerCase()}</option>)}
    </select> : <span className="muted small">As member</span>}
    <div className="person-actions">
      <button className="btn ghost sm" onClick={() => ctx.run(() => api.decline(user.id), `Declined ${user.name}`)}><X aria-hidden />Decline</button>
      <button className="btn primary sm" onClick={() => ctx.run(() => api.approve(user.id, { role, teamId: role === 'admin' ? '' : user.teamId }), `${user.name} approved`)}><Check aria-hidden />Approve</button>
    </div>
  </li>;
}
