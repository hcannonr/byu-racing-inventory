import { useState } from 'react';
import { Plus, RotateCcw, Trash2, Users, Warehouse } from 'lucide-react';
import type { Ctx } from '../App';
import { palette, type Cabinet, type Team } from '../../shared/types';
import { api } from '../api';
import { Modal } from './ui';

export function SetupPage({ ctx }: { ctx: Ctx }) {
  const [resetting, setResetting] = useState(false);
  return <section className="page">
    <div className="page-head">
      <div>
        <h1>Teams & storage</h1>
        <p className="lede">Each part belongs to a team and lives in a storage spot. General holds the parts every team uses. Rename anything by clicking its name.</p>
      </div>
    </div>
    <div className="setup-grid">
      <GroupCard ctx={ctx} kind="teams" title="Teams" icon={<Users />} items={ctx.state.teams} placeholder="New team, e.g. Aero" />
      <GroupCard ctx={ctx} kind="cabinets" title="Storage" icon={<Warehouse />} items={ctx.state.cabinets} placeholder="New spot, e.g. Red toolbox" />
    </div>
    {ctx.state.mode === 'demo' && <div className="card demo-card">
      <div><strong>Demo data</strong><p className="muted">Put the sample parts and history back the way they started.</p></div>
      <button className="btn ghost" onClick={() => setResetting(true)}><RotateCcw aria-hidden />Reset demo</button>
    </div>}
    {resetting && <Modal title="Reset the demo?" onClose={() => setResetting(false)} footer={<>
      <button className="btn ghost" onClick={() => setResetting(false)}>Cancel</button>
      <button className="btn danger" onClick={async () => { setResetting(false); await ctx.run(() => api.reset(), 'Demo data reset'); }}>Reset</button>
    </>}><p>All parts, teams, storage spots, and history go back to the sample set. Anything you added is cleared.</p></Modal>}
  </section>;
}

function GroupCard({ ctx, kind, title, icon, items, placeholder }: { ctx: Ctx; kind: 'teams' | 'cabinets'; title: string; icon: React.ReactNode; items: (Team | Cabinet)[]; placeholder: string }) {
  const [name, setName] = useState('');
  const key = kind === 'teams' ? 'teamId' : 'cabinetId';
  const count = (id: string) => ctx.state.parts.filter(p => p[key] === id).length;
  return <section className="card setup-card">
    <header className="setup-head"><span className="setup-icon" aria-hidden>{icon}</span><h2>{title}</h2><em>{items.length}</em></header>
    <ul className="setup-list">
      {items.map(item => <li key={item.id}>
        <ColorPick color={item.color} onPick={color => ctx.run(() => api.editGroup(kind, item.id, { color }))} />
        <input className="inline-edit" defaultValue={item.name} key={item.name} aria-label={`${title} name`}
          onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { e.currentTarget.value = item.name; e.currentTarget.blur(); } }}
          onBlur={e => { const next = e.target.value.trim(); if (next && next !== item.name) void ctx.run(() => api.editGroup(kind, item.id, { name: next }), `Renamed to ${next}`); else e.target.value = item.name; }} />
        <span className="muted small">{item.id === 'general' && <span className="tag shared">All teams</span>} {count(item.id)} part{count(item.id) === 1 ? '' : 's'}</span>
        <button className="icon-btn" aria-label={`Delete ${item.name}`} title={item.id === 'general' ? 'General is shared by every team' : count(item.id) ? 'Move its parts to another one first' : 'Delete'} disabled={count(item.id) > 0 || item.id === 'general'} onClick={() => ctx.run(() => api.deleteGroup(kind, item.id), `${item.name} deleted`)}><Trash2 /></button>
      </li>)}
    </ul>
    <form className="add-row" onSubmit={async e => { e.preventDefault(); if (!name.trim()) return; const ok = await ctx.run(() => api.addGroup(kind, name), `${name.trim()} added`); if (ok) setName(''); }}>
      <input value={name} onChange={e => setName(e.target.value)} placeholder={placeholder} maxLength={40} aria-label={`New ${kind === 'teams' ? 'team' : 'storage spot'} name`} />
      <button className="btn ghost" disabled={!name.trim()}><Plus aria-hidden />Add</button>
    </form>
  </section>;
}

function ColorPick({ color, onPick }: { color: string; onPick: (c: string) => void }) {
  const [open, setOpen] = useState(false);
  return <span className="color-pick">
    <button className="swatch" style={{ background: color }} onClick={() => setOpen(o => !o)} aria-label="Change color" aria-expanded={open} />
    {open && <span className="swatches" onMouseLeave={() => setOpen(false)}>
      {palette.map(c => <button key={c} className={`swatch${c === color ? ' on' : ''}`} style={{ background: c }} aria-label={`Use color ${c}`} onClick={() => { setOpen(false); if (c !== color) onPick(c); }} />)}
    </span>}
  </span>;
}
