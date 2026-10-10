import './dom-setup.ts';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React, { useState } from 'react';
import { render, screen, within, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { randomUUID } from 'node:crypto';
import { NotificationsView } from '../src/components/NotificationsView.tsx';
import { InventoryStore } from '../server/store.ts';
import { NotificationService } from '../server/notifications.ts';
import { ResendEmailTransport } from '../server/emailTransport.ts';
import { DomainError } from '../server/domain.ts';
import { ZodError } from 'zod';
import type { NotificationSnapshot } from '../shared/notifications.ts';

const originalFetch = globalThis.fetch;
let store: InventoryStore;
afterEach(() => { cleanup(); store?.close(); globalThis.fetch = originalFetch; window.sessionStorage.clear(); });
function setup(configured = false, loseTestResponse = false, initial?: (service: NotificationService) => void) {
  store = new InventoryStore(':memory:', false);
  const service = new NotificationService(store, new ResendEmailTransport(configured ? 'test-key' : '', configured ? 'Cabinet <alerts@example.org>' : '', async () => Response.json({ id: 'mock-email' })));
  let lost = false;
  initial?.(service);
  globalThis.fetch = async (_input, init) => {
    try {
      const command = JSON.parse(String(init?.body));
      const result = service.execute(command);
      if (loseTestResponse && command.action.type === 'test' && !lost) { lost = true; throw new TypeError('Network interruption'); }
      return Response.json(result);
    } catch (e) {
      if (e instanceof TypeError) throw e;
      return Response.json({ error: e instanceof Error ? e.message : 'Error' }, { status: e instanceof DomainError ? e.status : e instanceof ZodError ? 400 : 500 });
    }
  };
  function Harness() {
    const [snapshot, setSnapshot] = useState<NotificationSnapshot>(service.snapshot());
    return React.createElement(NotificationsView, { snapshot, alerts: [], busy: false, run: async () => true, onOpenPart: () => {}, onSnapshot: setSnapshot });
  }
  render(React.createElement(Harness));
  return { user: userEvent.setup(), service };
}

test('buyer can configure a recipient while missing server setup keeps delivery visibly disabled', async () => {
  const { user } = setup();
  assert.ok(screen.getByText("Email alerts aren't ready yet. Your system administrator will finish setup."));
  assert.equal(screen.queryByText(/RESEND_API_KEY|INVENTORY_EMAIL_FROM|Sender setup/), null);
  assert.equal(screen.queryByRole('link', { name: /Resend/ }), null);
  assert.equal((screen.getByText('Email settings').closest('details') as HTMLDetailsElement).open, false);
  assert.equal((screen.getByText('Delivery history').closest('details') as HTMLDetailsElement).open, false);
  await user.click(screen.getByText('Email settings'));
  assert.ok(!screen.queryByLabelText('Dashboard URL'), 'Administrator inventory link has no buyer control');
  await user.type(screen.getByLabelText('Recipient email'), 'buyer@example.org');
  await user.click(screen.getByRole('button', { name: 'Save email settings' }));
  await screen.findByText(/Email settings saved/);
  assert.equal(store.notifications.settings().recipient, 'buyer@example.org');
  assert.equal((screen.getByRole('button', { name: 'Enable email alerts' }) as HTMLButtonElement).disabled, true);
  await user.click(screen.getByRole('button', { name: 'Preview test email' }));
  const dialog = within(screen.getByRole('dialog', { name: 'Send a test email' }));
  assert.ok(!dialog.queryByRole('status'), 'fresh test preview does not show unrelated settings feedback');
  assert.ok(dialog.getByText('buyer@example.org'));
  assert.equal(dialog.queryByText('From'), null);
  assert.equal((dialog.getByRole('button', { name: 'Send test email' }) as HTMLButtonElement).disabled, true);
  assert.equal(store.notifications.snapshot({ configured: false, sender: '' }).history.length, 0);
});

test('test preview requires an explicit send, and an uncertain response retries the same saved email action', async () => {
  const { user, service } = setup(true, true);
  await user.click(screen.getByText('Email settings'));
  await user.type(screen.getByLabelText('Recipient email'), 'buyer@example.org');
  await user.click(screen.getByRole('button', { name: 'Save email settings' }));
  await screen.findByText(/Email settings saved/);
  await user.click(screen.getByRole('button', { name: 'Enable email alerts' }));
  await screen.findByText(/Email alerts enabled for future/);
  assert.equal(service.snapshot().history.length, 0);
  await user.click(screen.getByRole('button', { name: 'Preview test email' }));
  const dialog = within(screen.getByRole('dialog', { name: 'Send a test email' }));
  assert.ok(dialog.getByText(/This is a test of the BYU Racing/));
  assert.equal(service.snapshot().history.length, 0);
  await user.click(dialog.getByRole('button', { name: 'Send test email' }));
  await screen.findByText(/Email action not confirmed/);
  await user.click(screen.getByRole('button', { name: 'Retry email action safely' }));
  await waitFor(() => assert.equal(service.snapshot().history.length, 1));
  await screen.findByText('Email action already saved.');
  assert.equal(service.snapshot().settings.enabled, true);
  assert.equal((screen.getByText('Delivery history').closest('details') as HTMLDetailsElement).open, true);
  assert.ok(screen.getByText('Queued'));
  await user.click(screen.getByRole('button', { name: 'Pause email alerts' }));
  await screen.findByText(/Email alerts paused/);
  assert.equal(service.snapshot().settings.enabled, false);
});

test('stale email settings preserve typed values and expose explicit reload instead of overwriting another buyer', async () => {
  const { user, service } = setup(true);
  await user.click(screen.getByText('Email settings'));
  await user.type(screen.getByLabelText('Recipient email'), 'typed@example.org');
  service.execute({ eventId: randomUUID(), expectedRevision: 0, action: { type: 'save', recipient: 'other@example.org', reminderHours: 48, dashboardUrl: '' } });
  await user.click(screen.getByRole('button', { name: 'Save email settings' }));
  await screen.findByText(/Email settings changed/);
  assert.equal((screen.getByLabelText('Recipient email') as HTMLInputElement).value, 'typed@example.org');
  assert.equal(store.notifications.settings().recipient, 'other@example.org');
});

test('delivery review stays collapsed until requested and preserves buyer duplicate-risk confirmation without setup diagnostics', async () => {
  const { user, service } = setup(true, false, service => {
    service.execute({ eventId: randomUUID(), expectedRevision: 0, action: { type: 'save', recipient: 'buyer@example.org', reminderHours: 24, dashboardUrl: '' } });
    service.execute({ eventId: randomUUID(), expectedRevision: 1, action: { type: 'test' } });
    const job = store.notifications.claim(Date.now(), { configured: true, sender: 'Cabinet <alerts@example.org>' })!;
    store.notifications.finish(job.id, job.claimToken!, { accepted: false, temporary: false, ambiguous: true, error: 'RESEND_API_KEY fixture diagnostic' }, Date.now());
  });
  const original = service.snapshot().history[0];
  assert.equal((screen.getByText('Delivery history').closest('details') as HTMLDetailsElement).open, false);
  assert.equal(screen.queryByText(/RESEND_API_KEY/), null);
  await user.click(screen.getByRole('button', { name: '1 email needs review' }));
  assert.equal((screen.getByText('Delivery history').closest('details') as HTMLDetailsElement).open, true);
  await user.click(screen.getByRole('button', { name: 'Review retry' }));
  const dialog = within(screen.getByRole('dialog', { name: 'Review email retry' }));
  assert.equal(dialog.queryByText(/RESEND_API_KEY|provider history|sender setup/i), null);
  const queue = dialog.getByRole('button', { name: 'Queue new attempt' }) as HTMLButtonElement;
  assert.equal(queue.disabled, true);
  await user.click(dialog.getByRole('checkbox', { name: /checked with the recipient.*duplicate email/i }));
  assert.equal(queue.disabled, false);
  await user.click(queue);
  await waitFor(() => assert.equal(service.snapshot().history.length, 2));
  assert.deepEqual(service.snapshot().history[0].payload, original.payload);
  assert.notEqual(service.snapshot().history[0].idempotencyKey, original.idempotencyKey);
});

test('buyer recipient changes preserve the inventory link configured by the administrator', async () => {
  const { user } = setup(true, false, service => {
    service.execute({ eventId: randomUUID(), expectedRevision: 0, action: { type: 'save', recipient: 'old@example.org', reminderHours: 24, dashboardUrl: 'https://example.org/cabinet' } });
  });
  await user.click(screen.getByText('Email settings'));
  assert.ok(!screen.queryByLabelText('Dashboard URL'), 'Administrator inventory link has no buyer control');
  await user.clear(screen.getByLabelText('Recipient email'));
  await user.type(screen.getByLabelText('Recipient email'), 'new@example.org');
  await user.click(screen.getByRole('button', { name: 'Save email settings' }));
  await waitFor(() => assert.equal(store.notifications.settings().recipient, 'new@example.org'));
  assert.equal(store.notifications.settings().dashboardUrl, 'https://example.org/cabinet');
});
