import { useState } from 'react';
import { ArrowLeft, MailCheck } from 'lucide-react';
import { api, type Session } from '../api';
import { Shell } from './ui';

type Mode = 'signin' | 'signup' | 'forgot';

/** Live sign-in: Google, Microsoft (once it's switched on), or email + password. */
export function SignIn({ providers, onSignedIn }: { providers: NonNullable<Session['providers']>; onSignedIn: () => void }) {
  const params = new URLSearchParams(location.search);
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(params.get('signin') === 'failed' ? 'Sign-in didn\'t finish. If you just confirmed your email, sign in with your password below.' : '');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<null | 'confirm' | 'reset'>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      if (mode === 'signin') { await api.signIn(email, password); history.replaceState(null, '', '/'); onSignedIn(); }
      else if (mode === 'signup') { await api.signUp(email, password); setSent('confirm'); }
      else { await api.forgotPassword(email); setSent('reset'); }
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }
  const switchTo = (m: Mode) => { setMode(m); setError(''); setPassword(''); };

  if (sent) return <Shell>
    <div className="scan-card join-card">
      <span className="scan-badge info"><MailCheck /></span>
      <h1>Check your email</h1>
      <p>{sent === 'confirm'
        ? <>We sent a link to <b>{email}</b>. Click it to confirm your email, then you're in. Check spam if it's not there in a minute.</>
        : <>If <b>{email}</b> has an account, we sent a link to set a new password. Open it on this device.</>}</p>
      <button className="join-back" onClick={() => { setSent(null); switchTo('signin'); }}><ArrowLeft aria-hidden />Back to sign in</button>
    </div>
  </Shell>;

  return <Shell>
    <div className="scan-card join-card signin-card">
      <h1>{mode === 'signup' ? 'Create account' : mode === 'forgot' ? 'Reset password' : 'Shop Inventory'}</h1>
      <p>{mode === 'signup' ? 'Use any email. We\'ll send a link to confirm it.' : mode === 'forgot' ? 'Enter your email and we\'ll send a link to set a new password.' : 'Sign in to see the shop\'s parts, add new ones, and print bin labels.'}</p>

      {mode === 'signin' && (providers.google || providers.microsoft) && <div className="oauth">
        {providers.google && <a className="google-btn" href="/api/auth/google"><GoogleMark />Sign in with Google</a>}
        {providers.microsoft && <a className="google-btn" href="/api/auth/microsoft"><MicrosoftMark />Sign in with Microsoft</a>}
      </div>}
      {mode === 'signin' && providers.email && <div className="or"><span>or use email</span></div>}

      {providers.email && <form className="pw-form" onSubmit={submit} noValidate>
        <label className="field"><span>Email</span><input type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@byu.edu" maxLength={120} /></label>
        {mode !== 'forgot' && <label className="field"><span>Password{mode === 'signup' && <i>8+ characters</i>}</span>
          <input type="password" autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} value={password} onChange={e => setPassword(e.target.value)} maxLength={72} />
        </label>}
        {error && <p className="signin-error" role="alert">{error}</p>}
        <button className="btn primary full" disabled={busy}>{busy ? 'One sec…' : mode === 'signup' ? 'Create account' : mode === 'forgot' ? 'Send reset link' : 'Sign in'}</button>
      </form>}
      {!providers.email && error && <p className="signin-error" role="alert">{error}</p>}

      {providers.email && <div className="pw-links">
        {mode === 'signin' ? <>
          <button type="button" onClick={() => switchTo('signup')}>New here? <b>Create an account</b></button>
          <button type="button" onClick={() => switchTo('forgot')}>Forgot password?</button>
        </> : <button type="button" onClick={() => switchTo('signin')}><ArrowLeft aria-hidden />Back to sign in</button>}
      </div>}

      {mode === 'signin' && <p className="signin-note">New people pick their team after signing in, then a team lead or admin approves them. Scanning a bin label never needs a sign-in.</p>}
    </div>
  </Shell>;
}

/** Shown after following a reset link: they're signed in, now they choose a new password. */
export function NewPassword({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return <Shell>
    <form className="scan-card join-card signin-card" noValidate onSubmit={async e => {
      e.preventDefault(); setBusy(true); setError('');
      try { await api.newPassword(password); history.replaceState(null, '', '/'); onDone(); }
      catch (err) { setError((err as Error).message); }
      finally { setBusy(false); }
    }}>
      <h1>New password</h1>
      <p>Choose a new password for your account.</p>
      <label className="field"><span>New password<i>8+ characters</i></span><input type="password" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} maxLength={72} autoFocus /></label>
      {error && <p className="signin-error" role="alert">{error}</p>}
      <button className="btn primary full" disabled={busy}>{busy ? 'Saving…' : 'Save password'}</button>
    </form>
  </Shell>;
}

function GoogleMark() {
  return <svg viewBox="0 0 48 48" aria-hidden><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.1 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.1 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>;
}
function MicrosoftMark() {
  return <svg viewBox="0 0 21 21" aria-hidden><path fill="#f25022" d="M1 1h9v9H1z"/><path fill="#00a4ef" d="M1 11h9v9H1z"/><path fill="#7fba00" d="M11 1h9v9h-9z"/><path fill="#ffb900" d="M11 11h9v9h-9z"/></svg>;
}
