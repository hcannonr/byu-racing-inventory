import { useState } from 'react';
import { BellOff, BellRing, Inbox, Mail, Plus, Send, Sun, X, Zap } from 'lucide-react';
import type { Ctx } from '../App';
import { timeAgo, type AlertSettings, type EmailLog } from '../../shared/types';
import { api } from '../api';

export function AlertsPage({ ctx }: { ctx: Ctx }) {
  const alerts = ctx.state.alerts;
  const [email, setEmail] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  if (!alerts) return null;
  const save = (patch: Partial<AlertSettings>, done?: string) => ctx.run(() => api.saveAlerts(patch), done);
  const lowCount = ctx.state.parts.filter(p => p.status === 'low').length;

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const next = email.trim().toLowerCase();
    if (!next) return;
    const ok = await save({ recipients: [...alerts!.recipients, next] }, `${next} will get buyer emails`);
    if (ok) setEmail('');
  }

  return <section className="page">
    <div className="page-head">
      <div>
        <h1>Buyer alerts</h1>
        <p className="lede">The business team gets an email when a bin is scanned low, with what to buy and where to buy it. No one has to keep checking the board.</p>
      </div>
    </div>

    <section className={`card alert-status ${alerts.enabled ? 'on' : 'off'}`}>
      <span className="alert-status-icon">{alerts.enabled ? <BellRing aria-hidden /> : <BellOff aria-hidden />}</span>
      <div>
        <h2>{alerts.enabled ? 'Emails are on' : 'Emails are paused'}</h2>
        <p>{alerts.enabled
          ? alerts.timing === 'instant' ? 'Each low bin sends one email right away.' : `One summary goes out each morning at 7:00. ${lowCount} bin${lowCount === 1 ? ' is' : 's are'} low right now.`
          : 'Nothing is sent. Scans still show up on the Restock board.'}</p>
      </div>
      <button className={`btn ${alerts.enabled ? 'ghost' : 'primary'}`} onClick={() => save({ enabled: !alerts.enabled }, alerts.enabled ? 'Buyer emails paused' : 'Buyer emails on')}>
        {alerts.enabled ? <><BellOff aria-hidden />Pause</> : <><BellRing aria-hidden />Turn on</>}
      </button>
    </section>

    <div className="alert-grid">
      <section className="card alert-card">
        <h2><Mail aria-hidden />Who gets the emails</h2>
        <p className="muted small">Usually the business team or whoever places orders.</p>
        <ul className="recipients">
          {alerts.recipients.map(r => <li key={r}><span>{r}</span>
            <button className="icon-btn" aria-label={`Stop emailing ${r}`} onClick={() => save({ recipients: alerts.recipients.filter(x => x !== r) }, `${r} removed`)}><X /></button>
          </li>)}
          {!alerts.recipients.length && <li className="muted">No one yet. Add an email below.</li>}
        </ul>
        <form className="add-row" onSubmit={add}>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="name@byu.edu" aria-label="Email to add" maxLength={120} />
          <button className="btn ghost" disabled={!email.trim()}><Plus aria-hidden />Add</button>
        </form>
      </section>

      <section className="card alert-card">
        <h2><Zap aria-hidden />When to send</h2>
        <div className="timing">
          <label className={`timing-opt${alerts.timing === 'instant' ? ' on' : ''}`}>
            <input type="radio" name="timing" checked={alerts.timing === 'instant'} onChange={() => save({ timing: 'instant' }, 'Emails go out right away')} />
            <Zap aria-hidden /><span><b>Right away</b><small>One email for each bin the moment it's scanned.</small></span>
          </label>
          <label className={`timing-opt${alerts.timing === 'daily' ? ' on' : ''}`}>
            <input type="radio" name="timing" checked={alerts.timing === 'daily'} onChange={() => save({ timing: 'daily' }, 'Emails go out as a morning summary')} />
            <Sun aria-hidden /><span><b>Morning summary</b><small>One email at 7:00 with every low bin.</small></span>
          </label>
        </div>
        <button className="btn ghost" disabled={!alerts.recipients.length} onClick={() => ctx.run(() => api.testAlert(), 'Test email sent')}><Send aria-hidden />Send a test email</button>
      </section>
    </div>

    <section className="card alert-card">
      <h2><Inbox aria-hidden />Recent emails</h2>
      {ctx.state.mode === 'demo' ? <p className="muted small">Demo version: emails show up here instead of being sent.</p>
        : !ctx.state.emailReady && <p className="email-setup">Email isn't connected yet, so these are saved here but not sent. Rylek adds the email key once and they start going out.</p>}
      {alerts.outbox.length ? <ul className="outbox">{alerts.outbox.map(m => <OutboxItem key={m.id} mail={m} open={open === m.id} toggle={() => setOpen(open === m.id ? null : m.id)} />)}</ul>
        : <p className="people-empty">Nothing yet. Scan a part with Try a scan, or send a test, and the email appears here.</p>}
    </section>
  </section>;
}

const deliveryText = (m: EmailLog) => ({ sent: 'Sent', failed: 'Not sent', not_set_up: 'Not sent', demo: 'Demo', queued: 'Sending', sending: 'Sending' } as const)[m.status ?? 'demo'];

function OutboxItem({ mail, open, toggle }: { mail: EmailLog; open: boolean; toggle: () => void }) {
  return <li className={`mail${open ? ' open' : ''}`}>
    <button className="mail-head" onClick={toggle} aria-expanded={open}>
      <span className={`mail-kind mail-${mail.kind}`}>{mail.kind === 'test' ? 'Test' : mail.kind === 'digest' ? 'Summary' : 'Low bin'}</span>
      <b>{mail.subject}</b>
      <small>To {mail.to.length === 1 ? mail.to[0] : `${mail.to.length} people`}</small>
      <time dateTime={mail.at}>{deliveryText(mail)} · {timeAgo(mail.at)}</time>
    </button>
    {open && <div className="mail-body"><div className="mail-to">To: {mail.to.join(', ')}{mail.error && <span className="mail-error"> · {mail.error}</span>}</div><pre>{mail.body}</pre></div>}
  </li>;
}
