import { useCallback, useEffect, useState } from 'react';
import { Clock, LogOut, RefreshCw } from 'lucide-react';
import App from '../App';
import { api, type Session } from '../api';
import { JoinPage } from './JoinPage';
import { NewPassword, SignIn } from './SignIn';
import { Shell } from './ui';

/** Decides what to show: the demo, a sign-in button, the join form, "waiting for approval", or the app. */
export function Gate({ join }: { join: boolean }) {
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => { setError(''); api.session().then(setSession).catch(e => setError(e.message)); }, []);
  useEffect(load, [load]);

  if (error) return <Shell><div className="scan-card"><h1>Can't connect</h1><p>{error}</p><button className="btn primary" onClick={load}>Try again</button></div></Shell>;
  if (!session) return <div className="boot"><div className="spinner" aria-label="Loading" /></div>;
  if (session.mode === 'demo') return join ? <JoinPage /> : <App />;
  if (session.status === 'signed_out') return <SignIn providers={session.providers ?? { google: true, microsoft: false, email: false }} onSignedIn={load} />;
  // Came back from a password-reset email: choose the new password before anything else.
  if (new URLSearchParams(location.search).get('reset') === '1') return <NewPassword onDone={load} />;
  if (session.status === 'new') return <JoinPage live={session} onDone={load} />;
  if (session.status === 'pending') return <Waiting session={session} recheck={load} />;
  if (join) history.replaceState(null, '', '/');
  return <App />;
}

function Waiting({ session, recheck }: { session: Session; recheck: () => void }) {
  return <Shell>
    <div className="scan-card">
      <span className="scan-badge info"><Clock /></span>
      <h1>Almost in</h1>
      <p>Thanks{session.name ? `, ${session.name.split(' ')[0]}` : ''}. A team lead or admin needs to approve you. Check back once they do.</p>
      <button className="btn primary" onClick={recheck}><RefreshCw aria-hidden />Check again</button>
      <button className="join-back" onClick={async () => { await api.logout().catch(() => {}); location.href = '/'; }}><LogOut aria-hidden />Sign out ({session.email})</button>
    </div>
  </Shell>;
}
