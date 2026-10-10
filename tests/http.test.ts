import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { InventoryStore } from '../server/store.ts';
import { createApp } from '../server/http.ts';
import { Ship24Service } from '../server/ship24.ts';
import { NotificationService } from '../server/notifications.ts';
import { ResendEmailTransport } from '../server/emailTransport.ts';

test('email APIs validate settings, require setup, preserve idempotent tests and never expose credentials', async () => {
  const store = new InventoryStore(':memory:', false);
  let sends = 0;
  const emails = new NotificationService(store, new ResendEmailTransport('http-private-email-key', 'Cabinet <alerts@example.org>', async () => { sends++; return Response.json({ id: 'http-email' }); }));
  const server = createApp(store, undefined, emails).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (body: unknown, origin?: string) => fetch(`${base}/api/notifications/commands`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) });
  try {
    let snapshot = await (await fetch(`${base}/api/notifications`)).json();
    assert.equal(snapshot.settings.enabled, false);
    assert.equal(snapshot.configured, true);
    const action = { type: 'save', recipient: 'buyer@example.org', reminderHours: 24, dashboardUrl: '' };
    assert.equal((await post({ eventId: randomUUID(), expectedRevision: 0, action }, 'https://foreign.example')).status, 403);
    assert.equal((await post({ eventId: randomUUID(), expectedRevision: 0, action: { ...action, recipient: 'bad' } })).status, 400);
    assert.equal((await post({ eventId: randomUUID(), expectedRevision: 0, action })).status, 200);
    assert.equal(sends, 0, 'save never sends');
    assert.equal((await post({ eventId: randomUUID(), expectedRevision: 0, action })).status, 409);
    snapshot = await (await fetch(`${base}/api/notifications`)).json();
    const testCommand = { eventId: randomUUID(), expectedRevision: snapshot.settings.revision, action: { type: 'test' } };
    assert.equal((await post(testCommand)).status, 200);
    assert.equal((await post(testCommand)).status, 200);
    await emails.sync(); assert.equal(sends, 1);
    snapshot = await (await fetch(`${base}/api/state`)).json();
    assert.equal(snapshot.notifications.history.length, 1);
    assert.equal(snapshot.notifications.history[0].status, 'accepted');
    assert.equal(JSON.stringify(snapshot).includes('http-private-email-key'), false);
    assert.equal(snapshot.notifications.settings.enabled, false, 'test does not enable automatic delivery');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); }
});

test('API serves saved inventory, rejects malformed/foreign writes, and reports conflicts', async () => {
  const store = new InventoryStore(':memory:', false);
  const app = createApp(store);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.parts.length, 8);
    const post = (body: unknown, headers = {}) => fetch(`${base}/api/commands`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    assert.equal((await post({ nonsense: true })).status, 400);
    const command = { eventId: randomUUID(), action: { type: 'scan', binId: state.parts[0].bins[0].id, cycle: 0 } };
    assert.equal((await post(command, { origin: 'https://unrelated.example' })).status, 403);
    assert.equal((await post(command)).status, 200);
    assert.equal((await post({ ...command, eventId: randomUUID(), expectedRevision: 0 })).status, 409);
    assert.equal((await (await fetch(`${base}/api/state`)).json()).requests.length, 1);
    assert.equal((await fetch(`${base}/api/export`)).status, 200);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); }
});

test('API saves live tracking before fetching delivery and keeps secrets and stock out of provider updates', async () => {
  const store = new InventoryStore(':memory:', false);
  const tracking = new Ship24Service(store, 'private-api-key', async (_url, init) => Response.json(init?.method === 'POST'
    ? { data: { tracker: { trackerId: 'http-tracker' } } }
    : { data: { trackings: [{ tracker: { trackerId: 'http-tracker' }, shipment: { statusMilestone: 'delivered' }, events: [] }] } }));
  const server = createApp(store, tracking).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    store.execute({ eventId: randomUUID(), action: { type: 'scan', binId: 'BLUE-A01-1', cycle: 0 } });
    store.execute({ eventId: randomUUID(), action: { type: 'order', requestId: store.read().requests[0].id, supplier: 'Test', reference: '', quantity: 50, eta: '' } });
    const orderId = store.read().orders[0].id;
    const response = await fetch(`${base}/api/commands`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ eventId: randomUUID(), action: { type: 'save_tracking', orderId, tracking: { carrier: 'UPS', number: 'TEST-12345', url: '', live: true } } }) });
    assert.equal(response.status, 200);
    await tracking.sync();
    const snapshot = await (await fetch(`${base}/api/state`)).json();
    assert.equal(snapshot.trackingService.configured, true);
    assert.equal(snapshot.orders[0].delivery.status, 'delivered');
    assert.equal(snapshot.orders[0].received, 0);
    assert.equal(snapshot.parts[0].bins[0].status, 'empty');
    assert.equal(JSON.stringify(snapshot).includes('private-api-key'), false);
    const rejected = await fetch(`${base}/api/tracking/${orderId}/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://elsewhere.example' }, body: '{}' });
    assert.equal(rejected.status, 403);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); }
});
