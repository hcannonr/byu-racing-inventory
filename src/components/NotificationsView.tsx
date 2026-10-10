import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AlertTriangle, ArrowRight, Bell, Check, Mail, Pause, Send } from 'lucide-react';
import type { Action, AlertPreview, InventoryEvent } from '../../shared/types';
import { correctedAlertEpisodes } from '../../shared/corrections';
import { testEmailSubject, testEmailText, type NotificationCommand, type NotificationJob, type NotificationSnapshot, type NotificationStatus } from '../../shared/notifications';
import { ApiError, getNotifications, persistPendingEmailCommand, readPendingEmailCommand, sendNotificationCommand } from '../api';
import { Dialog } from './Dialog';
import { relativeTime } from './Visuals';

const emptySnapshot: NotificationSnapshot = { configured: false, sender: '', mode: 'setup', settings: { revision: 0, enabled: false, recipient: '', reminderHours: 24, dashboardUrl: '' }, history: [] };
const labels: Record<NotificationStatus, string> = { queued: 'Queued', sending: 'Sending', retry: 'Trying again', accepted: 'Accepted for sending', failed: 'Not sent', needs_review: 'Needs review', cancelled: 'Cancelled' };
const setupMessage = "Email alerts aren't ready yet. Your system administrator will finish setup.";
const date = (value: number) => new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
interface Props {
  events?: InventoryEvent[];
  snapshot?: NotificationSnapshot; alerts: AlertPreview[]; busy: boolean;
  run: (action: Action) => Promise<boolean>; onOpenPart: (id: string) => void;
  onSnapshot: (snapshot: NotificationSnapshot) => void;
}
export function NotificationsView({ snapshot = emptySnapshot, alerts, busy, run, onOpenPart, onSnapshot, events = [] }: Props) {
  const correctedEpisodes = correctedAlertEpisodes({ events });
  const [draft, setDraft] = useState({ recipient: snapshot.settings.recipient, reminderHours: snapshot.settings.reminderHours, dashboardUrl: snapshot.settings.dashboardUrl });
  const [revision, setRevision] = useState(snapshot.settings.revision);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ text: string; error: boolean } | null>(null);
  const [pending, setPending] = useState<NotificationCommand | null>(readPendingEmailCommand);
  const [conflict, setConflict] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const [retryJob, setRetryJob] = useState<NotificationJob | null>(null);
  const [confirmDuplicate, setConfirmDuplicate] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const inFlight = useRef(false);
  const blocked = busy || saving || pending !== null;
  const configured = snapshot.configured && !!snapshot.settings.recipient;
  useEffect(() => {
    if (dirty || pending) return;
    setDraft({ recipient: snapshot.settings.recipient, reminderHours: snapshot.settings.reminderHours, dashboardUrl: snapshot.settings.dashboardUrl });
    setRevision(snapshot.settings.revision);
  }, [snapshot.settings.recipient, snapshot.settings.reminderHours, snapshot.settings.dashboardUrl, snapshot.settings.revision, dirty, pending]);
  useEffect(() => { if (pending) setFeedback({ text: 'Email action not confirmed. Retry the same action safely before another email change.', error: true }); }, []);

  async function execute(command: NotificationCommand) {
    if (inFlight.current || pending && pending.eventId !== command.eventId) return false;
    inFlight.current = true; setSaving(true); setFeedback(null); setConflict(false);
    persistPendingEmailCommand(command);
    try {
      const result = await sendNotificationCommand(command);
      setPending(null); persistPendingEmailCommand(null); onSnapshot(result.notifications);
      if (command.action.type === 'save') {
        const settings = result.notifications.settings;
        setDraft({ recipient: settings.recipient, reminderHours: settings.reminderHours, dashboardUrl: settings.dashboardUrl });
        setRevision(settings.revision); setDirty(false);
      }
      if (command.action.type === 'test') setTestOpen(false);
      if (command.action.type === 'retry') setRetryJob(null);
      if (command.action.type === 'test' || command.action.type === 'retry') setHistoryOpen(true);
      setFeedback({ text: result.message, error: false }); return true;
    } catch (error) {
      const uncertain = error instanceof TypeError || error instanceof DOMException || error instanceof ApiError && error.status >= 500;
      if (uncertain) setPending(command);
      else { setPending(null); persistPendingEmailCommand(null); }
      setConflict(error instanceof ApiError && error.status === 409);
      const text = !snapshot.configured ? setupMessage : error instanceof ApiError && error.status === 409 ? 'Email settings changed in another window. Reload saved settings before trying again.' : error instanceof ApiError && error.status === 429 ? 'Please wait a minute before sending another test email.' : 'This email action could not be completed. Check your settings or ask your system administrator.';
      setFeedback({ text: uncertain ? 'Email action not confirmed. Retry the same action safely before another email change.' : text, error: true });
      return false;
    } finally { inFlight.current = false; setSaving(false); }
  }
  const sendAction = (action: NotificationCommand['action'], capturedRevision = snapshot.settings.revision) => execute({ eventId: crypto.randomUUID(), expectedRevision: capturedRevision, action });
  async function save(e: FormEvent) { e.preventDefault(); await sendAction({ type: 'save', ...draft }, revision); }
  function freshDialog() { if (!pending) { setFeedback(null); setConflict(false); } }
  async function reload() {
    try {
      const current = await getNotifications(); onSnapshot(current);
      setDraft({ recipient: current.settings.recipient, reminderHours: current.settings.reminderHours, dashboardUrl: current.settings.dashboardUrl });
      setRevision(current.settings.revision); setDirty(false); setConflict(false); setFeedback(null);
    } catch { setFeedback({ text: 'Could not reload email settings. Your typed values are preserved.', error: true }); }
  }
  const message = feedback && <div className={`email-feedback ${feedback.error ? 'error' : ''}`} role={feedback.error ? 'alert' : 'status'}>
    <p>{feedback.text}</p>{pending && <button className="button secondary" disabled={busy || saving} onClick={() => void execute(pending)}>Retry email action safely</button>}
    {conflict && <button className="text-button" disabled={blocked} onClick={() => void reload()}>Reload saved email settings</button>}
  </div>;
  const issueCount = snapshot.history.filter(j => !j.supersededBy && ['failed', 'needs_review'].includes(j.status)).length;
  const status = !snapshot.configured ? 'Email alerts not ready' : !snapshot.settings.recipient ? 'Choose a recipient' : snapshot.settings.enabled ? 'Email alerts on' : 'Email alerts off';
  return <div className="email-page buyer-email-page">
    {snapshot.verification === 'mock-provider' && <p className="buyer-email-fixture">Preview only · No real emails are sent.</p>}
    {!testOpen && !retryJob && message}
    <section className={`buyer-email-primary ${snapshot.mode}`} aria-label="Email delivery status">
      <div className="buyer-email-status"><div className="email-status-icon"><Mail size={24} /></div><div><h2>{status}</h2><p>{!snapshot.configured ? setupMessage : !snapshot.settings.recipient ? 'Add the buyer’s address in Email settings to receive cabinet updates.' : snapshot.settings.enabled ? 'Get an email when a bin needs refilling.' : 'Automatic cabinet emails are paused.'}</p></div></div>
      <div className="buyer-email-recipient"><div><span className="eyebrow">RECIPIENT</span><strong>{snapshot.settings.recipient || 'No recipient selected'}</strong></div><button className={`button ${snapshot.settings.enabled ? 'secondary' : 'primary'}`} disabled={blocked || dirty || !configured && !snapshot.settings.enabled} onClick={() => void sendAction({ type: 'set_enabled', enabled: !snapshot.settings.enabled })}>{snapshot.settings.enabled ? <><Pause size={15} />Pause email alerts</> : <><Mail size={15} />Enable email alerts</>}</button></div>
      {issueCount > 0 && <button className="buyer-email-attention" onClick={() => setHistoryOpen(true)}><AlertTriangle size={16} /><span>{issueCount} {issueCount === 1 ? 'email needs' : 'emails need'} review</span><ArrowRight size={15} /></button>}
      {dirty && <p className="buyer-email-unsaved">Save your email settings before turning alerts on or off.</p>}
    </section>
    <details className="buyer-email-disclosure buyer-email-settings"><summary><span>Email settings</span><span className="buyer-email-summary-note">Recipient, reminders & test</span></summary>
      <form className="form-stack" onSubmit={e => void save(e)}>
        <label>Recipient email<input type="email" maxLength={254} placeholder="Buyer’s email address" value={draft.recipient} disabled={blocked} onChange={e => { setDraft({ ...draft, recipient: e.target.value }); setDirty(true); }} /></label>
        <p className="small muted">Changing the recipient pauses alerts. Save, then turn them on for the new recipient.</p>
        <label>Reminder frequency<select value={draft.reminderHours} disabled={blocked} onChange={e => { setDraft({ ...draft, reminderHours: Number(e.target.value) }); setDirty(true); }}><option value={24}>Once a day</option><option value={48}>Every 2 days</option><option value={72}>Every 3 days</option><option value={168}>Once a week</option></select></label>
        <div className="email-settings-actions"><button className="button secondary" disabled={blocked || !dirty}>Save email settings</button><button type="button" className="text-button" disabled={blocked || dirty || !snapshot.settings.recipient} onClick={() => { freshDialog(); setTestOpen(true); }}><Send size={15} />Preview test email</button></div>
        {dirty && <p className="small muted">Save changes before testing.</p>}
      </form>
    </details>
    <details className="buyer-email-disclosure buyer-email-history" open={historyOpen} onToggle={e => setHistoryOpen(e.currentTarget.open)}><summary><span>Delivery history</span><span className="buyer-email-summary-note">{snapshot.history.length} {snapshot.history.length === 1 ? 'email' : 'emails'}</span></summary>
      <section className="buyer-email-disclosure-body" aria-label="Email history"><p className="small muted buyer-email-history-note">Accepted for sending does not confirm arrival in the inbox.</p>
      {!snapshot.history.length ? <div className="email-empty"><Mail size={25} /><div><h3>No email queued yet.</h3><p>Your first cabinet email or test will appear here.</p></div></div> : <div className="email-history-list">{snapshot.history.map(job => <article className={`email-job ${job.kind === 'escalation' ? 'urgent' : ''}`} key={job.id}>
        <div className="email-job-heading"><span className={`badge email-${job.status}`}>{labels[job.status]}</span><time dateTime={new Date(job.createdAt).toISOString()}>{relativeTime(new Date(job.createdAt).toISOString())}</time></div><h3>{job.payload.subject}</h3><p className="email-destination">To {job.payload.to.join(', ')}</p>
        {job.status === 'needs_review' && !job.supersededBy && <p className="email-job-note error">The previous attempt may have gone through. Check with the recipient before sending again.</p>}
        {job.status === 'failed' && !job.supersededBy && <p className="email-job-note error">This email could not be sent. Your system administrator may need to check email delivery.</p>}
        {job.status === 'retry' && <p className="small muted">Trying again {date(job.nextAttemptAt)}.</p>}
        {job.status === 'accepted' && <p className="small muted">Accepted {date(job.acceptedAt!)}. Inbox delivery is unconfirmed.</p>}
        <div className="purchase-actions">{job.partId && <button className="text-button" onClick={() => onOpenPart(job.partId!)}>Open part <ArrowRight size={14} /></button>}{['failed', 'needs_review'].includes(job.status) && !job.supersededBy && <button className="button secondary small-button" disabled={blocked} onClick={() => { freshDialog(); setRetryJob(job); setConfirmDuplicate(false); }}>Review retry</button>}{job.supersededBy && <span className="small muted">Replaced by a newer attempt</span>}</div>
        <details className="email-message-details"><summary>View email</summary><pre>{job.payload.text}</pre></details>
      </article>)}</div>}
      </section>
    </details>
    <details className="buyer-email-disclosure email-previews"><summary><span>Scan previews</span><span className="buyer-email-summary-note">{alerts.length} {alerts.length === 1 ? 'preview' : 'previews'}</span></summary><div className="buyer-email-preview-body"><p className="small muted">Scan records for reference. Practice previews do not send email. Mark read clears the in-app badge.</p>
      {!alerts.length && <p className="email-empty-copy">No scan previews yet.</p>}{[...alerts].reverse().map(alert => <article className={`alert-card ${alert.read || correctedEpisodes.has(alert.episodeId ?? '') ? 'read' : ''}`} key={alert.id}><div className="alert-symbol"><Bell size={20} /></div><div><div className="split"><span className="eyebrow">{alert.sample !== false ? 'PRACTICE PREVIEW · NOT SENT' : 'SCAN RECORD'}</span><time>{relativeTime(alert.createdAt)}</time></div><h3>{alert.title}</h3><p>{alert.body}</p>{correctedEpisodes.has(alert.episodeId ?? '') && <span className="correction-tag">Superseded by correction</span>}<div className="purchase-actions"><button className="text-button" onClick={() => onOpenPart(alert.partId)}>Open part <ArrowRight size={14} /></button>{!alert.read && !correctedEpisodes.has(alert.episodeId ?? '') ? <button className="text-button muted" disabled={blocked} onClick={() => void run({ type: 'read_alert', alertId: alert.id })}>Mark read</button> : alert.read && <span className="small muted"><Check size={12} />Read</span>}</div></div></article>)}</div>
    </details>
    <details className="buyer-email-disclosure"><summary><span>How alerts work</span></summary><div className="buyer-email-disclosure-body buyer-email-rules"><ul><li>An empty bin starts a refill notice. Both bins empty starts an urgent notice.</li><li>Acknowledge a request to snooze its reminders for one day.</li><li>Buying enough stops purchase reminders. Partial purchases keep them active.</li><li>Practice scans stay in the app. They never send automatic email.</li></ul><p className="small muted">Turning alerts on starts with future scans. Old previews stay unsent. Pausing cannot recall an email already being sent.</p></div></details>
    {testOpen && <Dialog title="Send a test email" onClose={() => setTestOpen(false)}><div className="form-stack"><h2>Review the test first.</h2><p>This sends one email to the saved recipient. It does not turn on automatic alerts.</p><dl className="email-test-address"><dt>To</dt><dd>{snapshot.settings.recipient}</dd></dl><div className="email-preview-message"><strong>{testEmailSubject}</strong><p>{testEmailText}</p></div>{!snapshot.configured && <p className="inline-error">{setupMessage}</p>}{message}<div className="form-actions"><button className="button secondary" disabled={saving} onClick={() => setTestOpen(false)}>Cancel</button><button className="button primary" disabled={blocked || !configured} onClick={() => void sendAction({ type: 'test' })}><Send size={16} />Send test email</button></div></div></Dialog>}
    {retryJob && <Dialog title="Review email retry" onClose={() => setRetryJob(null)}><div className="form-stack"><h2>Review before sending again.</h2><p>{retryJob.status === 'needs_review' ? 'The previous attempt may have gone through. Check with the recipient before sending again.' : 'This email could not be sent. Ask your system administrator to check email delivery if the problem continues.'}</p><p className="small">Recipient: {retryJob.payload.to.join(', ')}</p><details className="email-message-details"><summary>View email</summary><div className="email-preview-message"><strong>{retryJob.payload.subject}</strong><pre>{retryJob.payload.text}</pre></div></details>{retryJob.status === 'needs_review' && <label className="email-confirm"><input type="checkbox" checked={confirmDuplicate} disabled={blocked} onChange={e => setConfirmDuplicate(e.target.checked)} /><span>I checked with the recipient whether the previous email arrived. I understand sending again may create a duplicate email.</span></label>}{message}<div className="form-actions"><button className="button secondary" onClick={() => setRetryJob(null)}>Cancel</button><button className="button primary" disabled={blocked || !configured || retryJob.status === 'needs_review' && !confirmDuplicate} onClick={() => void sendAction({ type: 'retry', jobId: retryJob.id, confirmDuplicate })}><AlertTriangle size={16} />Queue new attempt</button></div></div></Dialog>}
  </div>;
}

