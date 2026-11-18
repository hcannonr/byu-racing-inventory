import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, LogOut, UserPlus } from 'lucide-react';
import type { Ctx } from '../App';
import { roleLabel, type Team } from '../../shared/types';
import { api, type Account } from '../api';
import { Avatar } from './PeoplePage';

/** Demo account switcher. The live app signs in with Google instead; this lets the video show each role. */
export function UserMenu({ ctx, onSwitch }: { ctx: Ctx; onSwitch: (a: Account, teamName: string) => void }) {
  const { me } = ctx.state;
  const [open, setOpen] = useState(false);
  const [dir, setDir] = useState<{ teams: Team[]; accounts: Account[] } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const teamOf = (id: string) => (dir?.teams ?? ctx.state.teams).find(t => t.id === id);
  const color = (a: { role: string; teamId: string }) => a.role === 'admin' ? '#475569' : teamOf(a.teamId)?.color ?? '#64748b';
  const sub = (a: { role: Account['role']; teamId: string }) => a.role === 'admin' ? 'Admin' : `${roleLabel[a.role]} · ${teamOf(a.teamId)?.name ?? ''}`;

  useEffect(() => {
    if (!open) return;
    if (ctx.state.mode === 'demo') api.directory().then(setDir).catch(() => {});
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);

  return <div className="user-menu" ref={ref}>
    <button className="user-btn" onClick={() => setOpen(o => !o)} aria-expanded={open} aria-haspopup="menu">
      <Avatar user={me} color={color(me)} />
      <span className="user-text"><b>{me.name}</b><small>{sub(me)}</small></span>
      <ChevronDown aria-hidden className="user-chev" />
    </button>
    {open && ctx.state.mode === 'live' && <div className="menu" role="menu">
      <p className="menu-label">Signed in as</p>
      <div className="menu-item on"><Avatar user={me} color={color(me)} /><span><b>{me.name}</b><small>{me.email}</small></span></div>
      <hr />
      <button role="menuitem" className="menu-item" onClick={async () => { await api.logout().catch(() => {}); location.href = '/'; }}>
        <span className="menu-plus"><LogOut aria-hidden /></span><span><b>Sign out</b></span>
      </button>
    </div>}
    {open && ctx.state.mode === 'demo' && <div className="menu" role="menu">
      <p className="menu-label">Demo: view the app as</p>
      {(dir?.accounts ?? []).map(a => <button key={a.id} role="menuitem" className={`menu-item${a.id === me.id ? ' on' : ''}`} onClick={() => { setOpen(false); if (a.id !== me.id) onSwitch(a, teamOf(a.teamId)?.name ?? ''); }}>
        <Avatar user={a} color={color(a)} /><span><b>{a.name}</b><small>{sub(a)}</small></span>{a.id === me.id && <Check aria-hidden className="menu-check" />}
      </button>)}
      {!dir && <p className="menu-label">Loading…</p>}
      <hr />
      <a role="menuitem" className="menu-item" href="/join"><span className="menu-plus"><UserPlus aria-hidden /></span><span><b>Request access</b><small>What a new person sees</small></span></a>
    </div>}
  </div>;
}
