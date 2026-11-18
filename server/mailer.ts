import type { EmailLog } from '../shared/types.ts';
import { claimQueued, markSent } from './alerts.ts';
import type { StateStore } from './store.ts';

export interface Mailer {
  ready: boolean;
  /** demo: the local build never sends. */
  demo: boolean;
  send(mail: EmailLog): Promise<{ ok: true } | { ok: false; error: string }>;
}

export const demoMailer: Mailer = { ready: false, demo: true, send: async () => ({ ok: false, error: 'Demo build' }) };

/** Resend (resend.com). Needs RESEND_API_KEY and a verified sender in INVENTORY_EMAIL_FROM. */
export function resendMailer(key: string, from: string, transport: typeof fetch = fetch): Mailer {
  const address = from.match(/<([^<>]+)>$/)?.[1] ?? from;
  const ready = !!key.trim() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address.trim()) && !/[\r\n]/.test(from);
  return {
    ready, demo: false,
    async send(mail) {
      if (!ready) return { ok: false, error: 'Email is not set up yet.' };
      try {
        const res = await transport('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Idempotency-Key': mail.id },
          body: JSON.stringify({ from: from.trim(), to: mail.to, subject: mail.subject, text: mail.body }),
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) return { ok: true };
        // Never store the provider's raw response; just a plain reason.
        return { ok: false, error: res.status === 401 || res.status === 403 ? 'The email provider rejected the server key or sender.'
          : res.status === 422 ? 'The email provider rejected this message. Check the addresses.'
          : res.status === 429 ? 'Too many emails at once. Try a test again in a minute.'
          : 'The email provider had a problem. Try again later.' };
      } catch { return { ok: false, error: 'Could not reach the email provider.' }; }
    },
  };
}

/** Send everything that's queued. Safe to call after every change: each email is claimed once. */
export async function flushEmail(store: StateStore, mailer: Mailer) {
  const outbox = (await store.read()).alerts?.outbox ?? [];
  if (!outbox.some(m => m.status === 'queued' || m.status === 'sending')) return;
  if (mailer.demo || !mailer.ready) {
    const status = mailer.demo ? 'demo' as const : 'not_set_up' as const;
    await store.change(s => markSent(s, s.alerts.outbox.filter(m => m.status === 'queued').map(m => ({ id: m.id, status }))));
    return;
  }
  const claimed = await store.change(s => claimQueued(s));
  if (!claimed.length) return;
  const results = await Promise.all(claimed.map(async m => {
    const r = await mailer.send(m);
    return r.ok ? { id: m.id, status: 'sent' as const } : { id: m.id, status: 'failed' as const, error: r.error };
  }));
  await store.change(s => markSent(s, results));
}
