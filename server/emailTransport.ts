import { z } from 'zod';
import type { EmailConfiguration, NotificationJob } from '../shared/notifications.ts';

export type EmailOutcome = { accepted: true; providerId: string }
  | { accepted: false; temporary: boolean; ambiguous: boolean; error: string; retryAfterMs?: number };
export interface EmailTransport {
  configuration: EmailConfiguration;
  send(job: Readonly<NotificationJob>): Promise<EmailOutcome>;
}
type FetchTransport = (url: string, init?: RequestInit) => Promise<Response>;

export class ResendEmailTransport implements EmailTransport {
  readonly configuration: EmailConfiguration;
  constructor(private key: string, sender: string, private transport: FetchTransport = fetch) {
    const address = sender.match(/<([^<>]+)>$/)?.[1] ?? sender;
    const valid = z.email().safeParse(address.trim()).success && !/[\r\n]/.test(sender);
    this.configuration = { configured: !!key.trim() && valid, sender: valid ? sender.trim() : '' };
  }
  async send(job: Readonly<NotificationJob>): Promise<EmailOutcome> {
    if (!this.configuration.configured) return { accepted: false, temporary: false, ambiguous: false, error: 'Configure the Resend API key and verified sender on the server.' };
    try {
      const response = await this.transport('https://api.resend.com/emails', {
        method: 'POST', headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json', 'Idempotency-Key': job.idempotencyKey },
        body: JSON.stringify(job.payload), signal: AbortSignal.timeout(15_000),
      });
      if (response.ok) {
        const result = z.object({ id: z.string().min(1).max(200) }).safeParse(await response.json());
        if (result.success) return { accepted: true, providerId: result.data.id };
        return { accepted: false, temporary: true, ambiguous: true, error: 'Email acceptance could not be confirmed. Retrying safely.' };
      }
      // Only inspect a known error name; never persist raw provider bodies or transport errors.
      const data = await response.json().catch(() => ({})) as { name?: string };
      if (response.status === 429) {
        const retry = response.headers.get('Retry-After');
        const ms = retry && /^\d+$/.test(retry) ? Number(retry) * 1000 : retry ? Date.parse(retry) - Date.now() : 0;
        return { accepted: false, temporary: true, ambiguous: false, error: 'Email provider is limiting requests. We will retry.', retryAfterMs: Number.isFinite(ms) ? Math.max(0, ms) : undefined };
      }
      if (response.status === 409 && data.name === 'concurrent_idempotent_requests') return { accepted: false, temporary: true, ambiguous: true, error: 'The same email is being processed. We will retry safely.' };
      if (response.status >= 500) return { accepted: false, temporary: true, ambiguous: true, error: 'Email provider is unavailable. We will retry safely.' };
      return { accepted: false, temporary: false, ambiguous: false, error: response.status === 401 || response.status === 403
        ? 'Email provider rejected the configuration. Check the server key and verified sender.'
        : response.status === 409 ? 'Email payload conflicts with its retry key. Review before retrying.'
        : 'Email provider rejected this message. Check the recipient and sender before retrying.' };
    } catch {
      return { accepted: false, temporary: true, ambiguous: true, error: 'Email acceptance was not confirmed. We will retry safely.' };
    }
  }
}
