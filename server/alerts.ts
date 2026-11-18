import { randomUUID } from 'node:crypto';
import type { AlertSettings, EmailLog, InventoryState, Part } from '../shared/types.ts';
import { UserError } from './errors.ts';

const MAX_OUTBOX = 60;
const emailOk = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
export const SHOP_TIME_ZONE = 'America/Denver';

/** Every buyer email starts as queued. The server sends it right after the change is saved. */
function queue(state: InventoryState, mail: Omit<EmailLog, 'id' | 'status'>) {
  state.alerts.outbox = [{ id: randomUUID(), status: 'queued' as const, ...mail }, ...state.alerts.outbox].slice(0, MAX_OUTBOX);
}

function where(state: InventoryState, part: Part) {
  return [state.cabinets.find(c => c.id === part.cabinetId)?.name, part.spot].filter(Boolean).join(', ') || 'Not set';
}
const teamName = (state: InventoryState, part: Part) => state.teams.find(t => t.id === part.teamId)?.name ?? 'Unknown team';

function lowEmail(state: InventoryState, part: Part, scanned: boolean) {
  const lines = [
    `${part.name}${part.detail ? ` (${part.detail})` : ''} ${scanned ? 'was scanned low' : 'was marked low'}.`,
    '',
    `Team: ${teamName(state, part)}`,
    `Where: ${where(state, part)}`,
    `Order: ${part.orderQty}${part.supplier ? ` from ${part.supplier}` : ''}`,
    ...(part.link ? [`Buy link: ${part.link}`] : []),
    '',
    'Mark it ordered on the Restock board once it is bought.',
  ];
  return { subject: `Low bin: ${part.name}${part.detail ? ` (${part.detail})` : ''}`, body: lines.join('\n') };
}

/** Called whenever a part becomes Low. Instant mode emails right away; daily mode waits for the morning summary. */
export function emailBuyers(state: InventoryState, part: Part, scanned: boolean, now: string) {
  const a = state.alerts;
  if (!a?.enabled || a.timing !== 'instant' || !a.recipients.length) return;
  queue(state, { at: now, kind: 'low', to: [...a.recipients], ...lowEmail(state, part, scanned) });
}

export function saveAlerts(state: InventoryState, raw: Partial<AlertSettings>, now = new Date()) {
  const a = state.alerts;
  if (typeof raw.enabled === 'boolean') a.enabled = raw.enabled;
  if ((raw.timing === 'instant' || raw.timing === 'daily') && raw.timing !== a.timing) {
    a.timing = raw.timing;
    // Switching to the summary after 7:00 waits for tomorrow instead of sending one right away.
    if (a.timing === 'daily' && shopClock(now).hour >= 7) a.lastDigest = shopClock(now).date;
  }
  if (Array.isArray(raw.recipients)) {
    const list = [...new Set(raw.recipients.map(e => String(e).trim().toLowerCase()).filter(Boolean))];
    const bad = list.find(e => !emailOk(e));
    if (bad) throw new UserError(`"${bad}" doesn't look like an email address.`);
    if (list.length > 20) throw new UserError('Use 20 addresses or fewer.');
    a.recipients = list;
  }
  return a;
}

export function sendTest(state: InventoryState, now = new Date().toISOString()) {
  const a = state.alerts;
  if (!a.recipients.length) throw new UserError('Add at least one email first.');
  const sample = state.parts.find(p => p.status === 'low') ?? state.parts[0];
  const mail = sample ? lowEmail(state, sample, true)
    : { subject: 'Low bin: sample part', body: 'This is what a low-bin email looks like. Real ones list the part, where it lives, and what to order.' };
  queue(state, { at: now, kind: 'test', to: [...a.recipients], subject: `Test: ${mail.subject}`, body: mail.body });
  return a;
}

/** Shop-local date and hour, so the morning summary goes out at 7:00 Utah time. */
export function shopClock(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: SHOP_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(now).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

/** Run every minute by the scheduler. Queues one summary between 7:00 and 7:59 if any bins are low. */
export function queueMorningSummary(state: InventoryState, now = new Date()) {
  const a = state.alerts;
  const { date, hour } = shopClock(now);
  if (!a.enabled || a.timing !== 'daily' || !a.recipients.length || hour !== 7 || a.lastDigest === date) return false;
  a.lastDigest = date;
  const low = state.parts.filter(p => p.status === 'low');
  if (!low.length) return false;
  const lines = low.map(p => `- ${p.name}${p.detail ? ` (${p.detail})` : ''}: order ${p.orderQty}${p.supplier ? ` from ${p.supplier}` : ''}. ${teamName(state, p)}, ${where(state, p)}${p.link ? `. ${p.link}` : ''}`);
  queue(state, {
    at: now.toISOString(), kind: 'digest', to: [...a.recipients],
    subject: `${low.length} bin${low.length === 1 ? '' : 's'} to order today`,
    body: [`Good morning. These bins are low:`, '', ...lines, '', 'Mark each one ordered on the Restock board once it is bought.'].join('\n'),
  });
  return true;
}

/** Claim queued emails so only one server sends each one. Also frees emails stuck mid-send for 5+ minutes. */
export function claimQueued(state: InventoryState, now = Date.now()) {
  const claimed: EmailLog[] = [];
  for (const m of state.alerts.outbox) {
    const stuck = m.status === 'sending' && now - new Date(m.claimedAt ?? m.at).getTime() > 5 * 60_000;
    if (m.status === 'queued' || stuck) { m.status = 'sending'; m.claimedAt = new Date(now).toISOString(); claimed.push({ ...m }); }
  }
  return claimed;
}

export function markSent(state: InventoryState, results: { id: string; status: EmailLog['status']; error?: string }[]) {
  for (const r of results) {
    const m = state.alerts.outbox.find(x => x.id === r.id);
    if (m) { m.status = r.status; if (r.error) m.error = r.error; else delete m.error; }
  }
}
