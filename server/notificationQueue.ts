import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from './domain.ts';
import { quantityToBuy, type Command, type InventoryState, type RefillRequest } from '../shared/types.ts';
import { sameRecipients, buyerRecipients, testEmailSubject, testEmailText, type EmailConfiguration, type EmailPayload, type NotificationJob, type NotificationKind, type NotificationSettings, type NotificationSnapshot } from '../shared/notifications.ts';
import type { EmailOutcome } from './emailTransport.ts';

const settingsSchema = z.object({
  type: z.literal('save'), recipients: z.array(z.string().trim().email().max(254)).max(20).optional(), recipient: z.union([z.literal(''), z.email()]).transform(s => s.trim()),
  reminderHours: z.number().int().min(24).max(168),
  dashboardUrl: z.union([z.literal(''), z.url().max(2000).refine(s => /^https?:\/\//i.test(s), 'Use an http or https dashboard URL.')]),
}).strict();
const inputSchema = z.object({
  eventId: z.uuid(), expectedRevision: z.number().int().nonnegative(),
  action: z.discriminatedUnion('type', [settingsSchema,
    z.object({ type: z.literal('set_enabled'), enabled: z.boolean() }).strict(),
    z.object({ type: z.literal('test') }).strict(),
    z.object({ type: z.literal('retry'), jobId: z.uuid(), confirmDuplicate: z.boolean() }).strict(),
  ]),
}).strict();
interface EpisodeSchedule { id: string; requestId: string; partId: string; nextReminderAt: number; correctionCooldown?: boolean }
const activeStatuses = ['queued', 'retry', 'sending'];
// Stop a full hour before Resend's 24-hour guarantee expires.
const safeRetryWindow = 23 * 3600000;
const leaseMs = 60_000;

export class NotificationQueue {
  constructor(private db: DatabaseSync, private readInventory: () => InventoryState, private clock: () => number) {
    db.exec(`CREATE TABLE IF NOT EXISTS notification_settings (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS notification_outbox (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS notification_episodes (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS notification_commands (id TEXT PRIMARY KEY, action TEXT NOT NULL);`);
    db.prepare('INSERT OR IGNORE INTO notification_settings VALUES(1,?)').run(JSON.stringify({ revision: 0, enabled: false, recipient: '', reminderHours: 24, dashboardUrl: '' }));
  }
  settings(): NotificationSettings {
    return JSON.parse((this.db.prepare('SELECT body FROM notification_settings WHERE id=1').get() as { body: string }).body);
  }
  private jobs(): NotificationJob[] {
    return (this.db.prepare('SELECT body FROM notification_outbox ORDER BY rowid').all() as { body: string }[]).map(r => JSON.parse(r.body));
  }
  private save(job: NotificationJob) {
    this.db.prepare('INSERT INTO notification_outbox VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(job.id, JSON.stringify(job));
  }
  snapshot(configuration: EmailConfiguration): NotificationSnapshot {
    const settings = this.settings();
    const history = this.jobs().reverse();
    const issues = history.some(j => !j.supersededBy && ['failed', 'needs_review'].includes(j.status));
    return { ...configuration, settings, history, mode: !configuration.configured || !settings.recipient ? 'setup' : !settings.enabled ? 'off' : issues ? 'issue' : 'enabled' };
  }
  private correctionSchedule(before: InventoryState, state: InventoryState, command: Command, now: number) {
    const settings = this.settings();
    if (['correct_scan', 'correct_receipt', 'correct_refill'].includes(command.action.type)) {
      const correction = state.events.find(e => e.data?.commandId === command.eventId && e.data.correction);
      const request = state.requests.find(r => r.id === correction?.data?.requestId);
      if (request) {
        const previous = before.requests.find(r => r.id === request.id);
        if (previous?.attention) this.db.prepare('DELETE FROM notification_episodes WHERE id=?').run(previous.attention.id);
        for (const job of this.jobs()) if (job.requestId === request.id && !['accepted', 'sending', 'cancelled'].includes(job.status) && !this.eligible(job, state)) {
          job.status = 'cancelled'; job.error = 'The inventory correction made this notice obsolete.'; this.save(job);
        }
        if (settings.enabled && request.attention && !request.closedAt && request.practice === false && !request.attention.sample && ['buyer', 'scanner', 'phone'].includes(request.attention.source)) {
          const hours = settings.reminderHours * 3600000;
          const latest = this.jobs().filter(j => j.partId === request.partId && j.status === 'accepted').reduce((last, j) => Math.max(last, j.acceptedAt ?? j.createdAt), 0);
          this.schedule({ id: request.attention.id, requestId: request.id, partId: request.partId, nextReminderAt: Math.max(now + hours, latest + hours), correctionCooldown: true });
        }
      }
      return;
    }
  }
  private schedule(episode: EpisodeSchedule) {
    this.db.prepare('INSERT INTO notification_episodes VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(episode.id, JSON.stringify(episode));
  }
  private enqueue(kind: NotificationKind, payload: EmailPayload, now: number, refs: Partial<NotificationJob> = {}) {
    const id = randomUUID();
    const job: NotificationJob = { ...refs, id, idempotencyKey: `byu-inventory/${id}`, kind, status: 'queued', payload: structuredClone(payload), createdAt: now, attempts: 0, nextAttemptAt: now };
    this.save(job); return job;
  }
  private payload(state: InventoryState, request: RefillRequest, kind: NotificationKind, sender: string, snapshotAt: number): EmailPayload {
    const part = state.parts.find(p => p.id === request.partId)!;
    const settings = this.settings(); const units = quantityToBuy(state, part);
    const prefix = kind === 'escalation' ? 'Both bins empty' : kind === 'reminder' ? 'Reminder: refill needed' : 'Refill needed';
    const demand = units > 0 ? `At ${new Date(snapshotAt).toISOString()}, ${units} additional ${part.unit} remained uncovered.` : `At ${new Date(snapshotAt).toISOString()}, replenishment was already covered by received stock or incoming purchases. Zero additional purchase needed. Confirm receipt and physically refill the empty bins.`;
    return { from: sender, to: buyerRecipients(settings), subject: `BYU Racing · ${prefix} · ${part.name}`,
      text: `${prefix}: ${part.name}\nSpecification: ${part.specification}\nLocation: ${part.location}\n${part.bins.every(b => b.status === 'empty') ? 'Both bins were empty at this snapshot.' : 'One bin was empty at this snapshot. Use the other bin.'}\n${demand}\nTarget per bin: ${part.binQuantity} ${part.unit}\nSupplier: ${part.supplier || 'Not assigned'}${part.supplierUrl ? `\nProduct: ${part.supplierUrl}` : ''}${settings.dashboardUrl ? `\nDashboard: ${settings.dashboardUrl}` : ''}\n\nCheck the current dashboard before purchasing. Purchases and carrier updates do not refill physical bins.` };
  }
  // Called within InventoryStore's stock transaction. Never calls an external service.
  afterCommand(before: InventoryState, state: InventoryState, command: Command, now: number) {
    if (command.action.type === 'reset') {
      for (const job of this.jobs()) if (job.kind !== 'test' && job.status !== 'accepted' && job.status !== 'sending') { job.status = 'cancelled'; job.error = 'Test inventory reset.'; this.save(job); }
      this.db.exec('DELETE FROM notification_episodes'); return;
    }
    if (['correct_scan', 'correct_receipt', 'correct_refill'].includes(command.action.type)) { this.correctionSchedule(before, state, command, now); return; }
    const settings = this.settings();
    if (!settings.enabled) return;
    const ids = new Set(before.alerts.map(a => a.id));
    for (const alert of state.alerts.filter(a => !ids.has(a.id))) {
      const request = state.requests.find(r => r.id === alert.requestId);
      const attention = request?.attention;
      if (!request || !attention || attention.sample || !['buyer', 'scanner', 'phone'].includes(attention.source) || !alert.episodeId) continue;
      // Sender is bound by the server when enabling, not supplied by stock callers.
      const sender = this.sender();
      if (!sender || !settings.recipient) continue;
      this.enqueue(alert.kind ?? 'initial', this.payload(state, request, alert.kind ?? 'initial', sender, now), now,
        { requestId: request.id, partId: request.partId, episodeId: alert.episodeId, alertId: alert.id });
      this.schedule({ id: attention.id, requestId: request.id, partId: request.partId, nextReminderAt: now + settings.reminderHours * 3600000 });
    }
    if (command.action.type === 'undo_purchase') {
      const order = state.orders.find(o => o.id === (command.action as { orderId: string }).orderId);
      const request = state.requests.find(r => r.id === order?.requestId);
      if (request?.attention) {
        const row = this.db.prepare('SELECT body FROM notification_episodes WHERE id=?').get(request.attention.id) as { body: string } | undefined;
        if (row) {
          const schedule = JSON.parse(row.body) as EpisodeSchedule;
          const latest = this.jobs().filter(j => j.episodeId === request.attention!.id && j.status === 'accepted').reduce((last, j) => Math.max(last, j.acceptedAt ?? j.createdAt), 0);
          this.schedule({ ...schedule, nextReminderAt: Math.max(schedule.correctionCooldown ? schedule.nextReminderAt : now, latest + settings.reminderHours * 3600000) });
        }
      }
    }
  }
  private sender() {
    const row = this.db.prepare('SELECT body FROM notification_settings WHERE id=1').get() as { body: string };
    return (JSON.parse(row.body) as NotificationSettings & { sender?: string }).sender ?? '';
  }
  execute(input: unknown, configuration: EmailConfiguration): { notifications: NotificationSnapshot; message: string } {
    const command = inputSchema.parse(input); const now = this.clock();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const fingerprint = JSON.stringify(command.action);
      const duplicate = this.db.prepare('SELECT action FROM notification_commands WHERE id=?').get(command.eventId) as { action: string } | undefined;
      if (duplicate) {
        if (duplicate.action !== fingerprint) throw new DomainError('This event ID was reused for a different email action.', 409);
        this.db.exec('COMMIT'); return { notifications: this.snapshot(configuration), message: 'Email action already saved.' };
      }
      const settings = this.settings();
      if (command.expectedRevision !== settings.revision) throw new DomainError('Email settings changed in another window. Reload settings and try again.', 409);
      const action = command.action; let message = '';
      const requireSetup = () => {
        if (!configuration.configured || !configuration.sender || !settings.recipient) throw new DomainError('Configure the server email key, verified sender and recipient first.');
      };
      if (action.type === 'save') {
        if (!sameRecipients(buyerRecipients(action), buyerRecipients(settings))) {
          settings.enabled = false;
          for (const job of this.jobs()) if (job.kind !== 'test' && job.status !== 'accepted' && job.status !== 'sending') { job.status = 'cancelled'; job.error = 'Recipient changed. Pending messages to the previous recipient were cancelled.'; this.save(job); }
          // Do not manufacture reminders for the new recipient from an old episode.
          this.db.exec('DELETE FROM notification_episodes');
        }
        Object.assign(settings, { recipient: buyerRecipients(action)[0] ?? '', recipients: buyerRecipients(action), reminderHours: action.reminderHours, dashboardUrl: action.dashboardUrl });
        settings.revision++; message = 'Email settings saved. Recipient changes keep delivery off until you enable it.';
      } else if (action.type === 'set_enabled') {
        if (action.enabled) requireSetup();
        settings.enabled = action.enabled; settings.revision++;
        message = action.enabled ? 'Email alerts enabled for future operational scans. Existing previews will not be sent.' : 'Email alerts paused. An email already accepted by the provider cannot be recalled.';
      } else if (action.type === 'test') {
        requireSetup();
        const latest = this.jobs().filter(j => j.kind === 'test').at(-1);
        if (latest && now - latest.createdAt < 60_000) throw new DomainError('Wait one minute before sending another test email.', 429);
        this.enqueue('test', { from: configuration.sender, to: buyerRecipients(settings), subject: testEmailSubject, text: testEmailText }, now);
        message = 'Test email queued to the displayed recipient. This does not change inventory.';
      } else {
        requireSetup();
        const old = this.jobs().find(j => j.id === action.jobId);
        if (!old || !['failed', 'needs_review'].includes(old.status) || old.supersededBy) throw new DomainError('This email is not available for retry.', 409);
        if (old.kind !== 'test' && !settings.enabled) throw new DomainError('Enable email alerts before retrying an operational notice.');
        if (old.status === 'needs_review' && !action.confirmDuplicate) throw new DomainError('Review provider history and confirm that retrying may create a duplicate.');
        if (!sameRecipients(old.payload.to, buyerRecipients(settings)) || old.payload.from !== configuration.sender) throw new DomainError('Recipient or sender changed. This old message cannot be retried to a different address.');
        const replacement = this.enqueue(old.kind, old.payload, now, { requestId: old.requestId, partId: old.partId, episodeId: old.episodeId, alertId: old.alertId });
        old.supersededBy = replacement.id; this.save(old);
        message = 'A new delivery attempt is queued. The original email history is preserved.';
      }
      this.db.prepare('UPDATE notification_settings SET body=? WHERE id=1').run(JSON.stringify({ ...settings, sender: configuration.sender }));
      this.db.prepare('INSERT INTO notification_commands VALUES(?,?)').run(command.eventId, fingerprint);
      this.db.exec('COMMIT'); return { notifications: this.snapshot(configuration), message };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private eligible(job: NotificationJob, state: InventoryState): boolean {
    if (job.kind === 'test') return true;
    const request = state.requests.find(r => r.id === job.requestId && !r.closedAt);
    const part = state.parts.find(p => p.id === job.partId);
    const episode = request?.attention;
    if (!request || request.practice !== false || !part || part.sample || part.practice !== false || !episode || episode.sample || episode.id !== job.episodeId || !['buyer', 'scanner', 'phone'].includes(episode.source)) return false;
    return job.kind === 'escalation' ? part.bins.every(b => b.status === 'empty') : quantityToBuy(state, part) > 0;
  }
  private reminders(now: number, configuration: EmailConfiguration, state: InventoryState) {
    const settings = this.settings();
    if (!settings.enabled || !configuration.configured) return;
    const rows = this.db.prepare('SELECT body FROM notification_episodes').all() as { body: string }[];
    for (const row of rows) {
      const schedule = JSON.parse(row.body) as EpisodeSchedule;
      const candidate = { kind: 'reminder', requestId: schedule.requestId, partId: schedule.partId, episodeId: schedule.id } as NotificationJob;
      if (!this.eligible(candidate, state)) continue;
      const request = state.requests.find(r => r.id === schedule.requestId)!;
      const snooze = Date.parse(request.attention?.snoozedUntil ?? '') || 0;
      const related = this.jobs().filter(j => j.episodeId === schedule.id && !j.supersededBy);
      if (related.some(j => activeStatuses.includes(j.status) || j.status === 'failed' || j.status === 'needs_review')) continue;
      const accepted = schedule.correctionCooldown ? this.jobs().filter(j => j.partId === schedule.partId) : related;
      const lastAccepted = accepted.filter(j => j.status === 'accepted').reduce((last, j) => Math.max(last, j.acceptedAt ?? j.createdAt), 0);
      if (now < Math.max(schedule.nextReminderAt, snooze, lastAccepted + settings.reminderHours * 3600000)) continue;
      this.enqueue('reminder', this.payload(state, request, 'reminder', configuration.sender, now), now, { requestId: request.id, partId: request.partId, episodeId: schedule.id });
      this.schedule({ ...schedule, nextReminderAt: now + settings.reminderHours * 3600000 });
    }
  }
  claim(now: number, configuration: EmailConfiguration): NotificationJob | undefined {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const state = this.readInventory(); const settings = this.settings();
      for (const job of this.jobs()) {
        if (job.status === 'sending' && (job.leaseUntil ?? 0) <= now) {
          job.status = 'retry'; job.ambiguous = true; job.error = 'Previous email attempt was interrupted. Retrying with the same key.';
          job.claimToken = undefined; job.leaseUntil = undefined; this.save(job);
        }
        if (!['queued', 'retry'].includes(job.status)) continue;
        if (!this.eligible(job, state) || !sameRecipients(job.payload.to, buyerRecipients(settings)) || job.payload.from !== configuration.sender) {
          job.status = 'cancelled'; job.error = 'This notice is obsolete or its destination changed.'; this.save(job); continue;
        }
        if (job.ambiguous && job.firstAttemptAt !== undefined && now - job.firstAttemptAt >= safeRetryWindow) {
          job.status = 'needs_review'; job.error = 'Acceptance is uncertain and the safe retry window has ended. Check provider history before sending again.'; this.save(job);
        }
        if (job.attempts === 0 && job.status === 'queued' && job.kind !== 'test') {
          const request = state.requests.find(r => r.id === job.requestId)!;
          const current = this.payload(state, request, job.kind, configuration.sender, job.createdAt);
          if (JSON.stringify(current) !== JSON.stringify(job.payload)) {
            const replacement = this.enqueue(job.kind, this.payload(state, request, job.kind, configuration.sender, now), now,
              { requestId: job.requestId, partId: job.partId, episodeId: job.episodeId, alertId: job.alertId });
            job.status = 'cancelled'; job.supersededBy = replacement.id; job.error = 'Demand changed before the first delivery. Replaced with an updated notice.'; this.save(job);
          }
        }
      }
      this.reminders(now, configuration, state);
      const job = this.jobs().find(j => ['queued', 'retry'].includes(j.status) && j.nextAttemptAt <= now && configuration.configured && (j.kind === 'test' || settings.enabled)
        && (j.kind !== 'reminder' || now >= (Date.parse(state.requests.find(r => r.id === j.requestId)?.attention?.snoozedUntil ?? '') || 0)));
      if (job) {
        job.status = 'sending'; job.claimToken = randomUUID(); job.leaseUntil = now + leaseMs;
        job.firstAttemptAt ??= now; job.attempts++; job.priorAmbiguous = !!job.ambiguous; job.ambiguous = true; this.save(job);
      }
      this.db.exec('COMMIT'); return job;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  finish(id: string, claimToken: string, outcome: EmailOutcome, now: number) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const job = this.jobs().find(j => j.id === id);
      if (job?.status === 'sending' && job.claimToken === claimToken) {
        job.claimToken = undefined; job.leaseUntil = undefined;
        if (outcome.accepted) {
          job.status = 'accepted'; job.providerId = outcome.providerId; job.acceptedAt = now; job.ambiguous = false; job.error = undefined;
        } else {
          // A later definitive rejection cannot disprove an earlier uncertain acceptance.
          job.ambiguous = !!job.priorAmbiguous || outcome.ambiguous;
          job.status = outcome.temporary ? 'retry' : job.ambiguous ? 'needs_review' : 'failed';
          job.error = outcome.error;
          const backoff = Math.min(6 * 3600000, 60_000 * 2 ** Math.min(job.attempts - 1, 9));
          job.nextAttemptAt = now + Math.max(backoff, outcome.retryAfterMs ?? 0);
        }
        job.priorAmbiguous = undefined;
        this.save(job);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
