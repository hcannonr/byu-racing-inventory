export interface NotificationSettings {
  recipients?: string[];
  revision: number; enabled: boolean; recipient: string; reminderHours: number; dashboardUrl: string;
}
export interface EmailConfiguration { configured: boolean; sender: string; verification?: 'mock-provider' }
export interface EmailPayload { from: string; to: string[]; subject: string; text: string }
export type NotificationStatus = 'queued' | 'sending' | 'retry' | 'accepted' | 'failed' | 'needs_review' | 'cancelled';
export type NotificationKind = 'initial' | 'escalation' | 'reminder' | 'test';
export interface NotificationJob {
  id: string; idempotencyKey: string; kind: NotificationKind; status: NotificationStatus;
  requestId?: string; partId?: string; episodeId?: string; alertId?: string;
  payload: EmailPayload; createdAt: number; attempts: number; nextAttemptAt: number;
  firstAttemptAt?: number; claimToken?: string; leaseUntil?: number; ambiguous?: boolean; priorAmbiguous?: boolean;
  providerId?: string; acceptedAt?: number; error?: string; supersededBy?: string;
}
export interface NotificationSnapshot extends EmailConfiguration {
  settings: NotificationSettings; history: NotificationJob[];
  mode: 'setup' | 'off' | 'enabled' | 'issue';
}
export interface NotificationCommand {
  eventId: string; expectedRevision: number;
  action:
    | { type: 'save'; recipient: string; recipients?: string[]; reminderHours: number; dashboardUrl: string }
    | { type: 'set_enabled'; enabled: boolean }
    | { type: 'test' }
    | { type: 'retry'; jobId: string; confirmDuplicate: boolean };
}
export const testEmailSubject = 'BYU Racing cabinet · Test email';
export function buyerRecipients(settings: { recipient: string; recipients?: string[] }): string[] {
  return [...new Set((settings.recipients ?? (settings.recipient ? [settings.recipient] : [])).map(email => email.trim().toLowerCase()))];
}
export function sameRecipients(left: string[], right: string[]): boolean {
  const normalize = (values: string[]) => [...new Set(values.map(value => value.trim().toLowerCase()))].sort();
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}
export const testEmailText = 'This is a test of the BYU Racing cabinet email alerts. No inventory was changed. Future alerts will identify the part, cabinet location and next action.';
