import { useEffect, useState } from 'react';
import { ArrowLeft, Clock } from 'lucide-react';
import type { Team } from '../../shared/types';
import { api, type Session } from '../api';
import { Dot, Shell } from './ui';

/**
 * A new person asks to join. Demo: name, email, team. Live: they already signed in with Google,
 * so only their name and team are asked. The request waits for a team lead or admin.
 */
export function JoinPage({ live, onDone }: { live?: Session; onDone?: () => void } = {}) {
  const [teams, setTeams] = useState<Team[] | null>(live?.teams ?? null);
  const [v, setV] = useState({ name: live?.name ?? '', email: '', teamId: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);

  useEffect(() => { if (!live) api.directory().then(d => setTeams(d.teams)).catch(e => setError(e.message)); }, [live]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      await api.join(live ? { name: v.name, teamId: v.teamId } : v);
      if (live) { onDone?.(); return; }
      setSent(teams?.find(t => t.id === v.teamId)?.name ?? '');
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }

  return <Shell>
    {sent !== null ? <div className="scan-card">
      <span className="scan-badge info"><Clock /></span>
      <h1>Request sent</h1>
      <p>The {sent} team lead or an admin will approve you. You'll get access as soon as they do.</p>
      <a className="btn ghost" href="/#/people"><ArrowLeft aria-hidden />Back to the app</a>
    </div> : <form className="scan-card join-card" onSubmit={submit} noValidate>
      <h1>Request access</h1>
      <p>{live ? `Signed in as ${live.email}. Tell us your name and team, and a team lead or admin will approve you.` : 'Ask to join the BYU Racing shop inventory. A team lead or admin approves new people.'}</p>
      <label className="field"><span>Your name</span><input value={v.name} onChange={e => setV({ ...v, name: e.target.value })} placeholder="First and last name" maxLength={60} autoFocus /></label>
      {!live && <label className="field"><span>BYU email</span><input type="email" value={v.email} onChange={e => setV({ ...v, email: e.target.value })} placeholder="you@byu.edu" maxLength={120} /></label>}
      <fieldset className="field"><legend>Your team</legend>
        <div className="choice-row">{(teams ?? []).filter(t => t.id !== 'general').map(t => <label key={t.id} className={`choice${v.teamId === t.id ? ' on' : ''}`}>
          <input type="radio" name="team" checked={v.teamId === t.id} onChange={() => setV({ ...v, teamId: t.id })} /><Dot color={t.color} />{t.name}
        </label>)}</div>
      </fieldset>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="btn primary full" disabled={busy}>{busy ? 'Sending…' : 'Request access'}</button>
      {live ? <button type="button" className="join-back" onClick={async () => { await api.logout().catch(() => {}); location.href = '/'; }}>Use a different Google account</button>
        : <a className="join-back" href="/"><ArrowLeft aria-hidden />Back to the app</a>}
    </form>}
  </Shell>;
}
