import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { InventoryStore } from '../server/store.ts';
import { seedState } from '../server/seed.ts';
import { NotificationService } from '../server/notifications.ts';
import { ResendEmailTransport } from '../server/emailTransport.ts';
import type { Action } from '../shared/types.ts';

const configuration = { configured: true, sender: 'Cabinet <alerts@example.org>' };
function fixture(path = ':memory:', initiallyEnabled = true) {
  let now = Date.parse('2026-10-05T12:00:00Z');
  const store = new InventoryStore(path, false, () => now);
  const run = (action: Action, source = 'buyer') => store.execute({ eventId: randomUUID(), action, provenance: { source } });
  const settings = (action: unknown, eventId = randomUUID()) => store.notifications.execute({ eventId, expectedRevision: store.notifications.settings().revision, action }, configuration);
  settings({ type: 'save', recipient: 'buyer@example.org', reminderHours: 24, dashboardUrl: '' });
  if (initiallyEnabled) settings({ type: 'set_enabled', enabled: true });
  run({ type: 'add_part', part: { name: 'Verified bolt', specification: 'M8', category: 'Fasteners', location: 'REAL-A1', supplier: 'Workshop supply', supplierUrl: '', binQuantity: 50, unit: 'pieces' } });
  const scan = (bin = 1, source = 'scanner', eventId = randomUUID()) => store.execute({ eventId, provenance: { source }, action: { type: 'scan', binId: `REAL-A1-${bin}`, cycle: 0 } });
  const history = () => store.notifications.snapshot(configuration).history;
  return { store, run, settings, scan, history, advance: (ms: number) => { now += ms; }, now: () => now };
}

test('a failed outbox insert rolls back the inventory change and its command ID so the same scan can retry', () => {
  const directory = mkdtempSync(join(tmpdir(), 'racing-email-atomic-'));
  const path = join(directory, 'inventory.sqlite'); const f = fixture(path);
  const inspection = new DatabaseSync(path);
  try {
    inspection.exec("CREATE TRIGGER reject_mail BEFORE INSERT ON notification_outbox BEGIN SELECT RAISE(ABORT,'Outbox unavailable'); END");
    const before = f.store.read(); const id = randomUUID();
    assert.throws(() => f.scan(1, 'scanner', id), /Outbox unavailable/);
    assert.deepEqual(f.store.read(), before);
    assert.equal(f.history().length, 0);
    inspection.exec('DROP TRIGGER reject_mail');
    f.scan(1, 'scanner', id);
    assert.equal(f.history().length, 1);
    assert.equal(f.store.read().requests.length, 1);
  } finally { inspection.close(); f.store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('old two-column command databases open without reset and preserve legacy idempotency without email backfill', () => {
  const directory = mkdtempSync(join(tmpdir(), 'racing-email-legacy-'));
  const path = join(directory, 'inventory.sqlite'); const old = new DatabaseSync(path);
  const state = seedState(); state.revision = 42;
  const id = randomUUID(); const action = { type: 'scan', binId: 'BLUE-A01-1', cycle: 0 };
  old.exec('CREATE TABLE inventory(id INTEGER PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE commands(id TEXT PRIMARY KEY,action TEXT NOT NULL)');
  old.prepare('INSERT INTO inventory VALUES(1,?)').run(JSON.stringify(state));
  old.prepare('INSERT INTO commands VALUES(?,?)').run(id, JSON.stringify(action)); old.close();
  const store = new InventoryStore(path);
  try {
    assert.deepEqual(store.read(), state);
    assert.equal(store.execute({ eventId: id, action }).changed, false);
    assert.equal(store.notifications.snapshot(configuration).history.length, 0);
    assert.equal(store.notifications.settings().enabled, false);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('scan and durable email enqueue commit once; demo, simulator, samples and old previews never backfill', async () => {
  const f = fixture();
  const id = randomUUID(); f.scan(1, 'scanner', id); f.scan(1, 'scanner', id);
  assert.equal(f.history().length, 1);
  assert.equal(f.history()[0].status, 'queued');
  assert.match(f.history()[0].payload.text, /REAL-A1/);
  f.run({ type: 'scan', binId: 'BLUE-A01-1', cycle: 0 }, 'scanner');
  assert.equal(f.history().length, 1, 'sample catalog cannot email');
  assert.throws(() => f.scan(1, 'simulator', id), /event ID/);
  f.scan(2, 'simulator');
  assert.equal(f.history().length, 1, 'simulator cannot email a real catalog part');
  await new NotificationService(f.store, new ResendEmailTransport('test-key', configuration.sender, async () => { throw new Error('No eligible delivery expected'); }), f.now).sync();
  assert.equal(f.history()[0].status, 'cancelled', 'superseded operational work is obsolete');
  f.store.close();
  const disabled = fixture(':memory:', false); disabled.scan();
  disabled.settings({ type: 'set_enabled', enabled: true });
  await new NotificationService(disabled.store, new ResendEmailTransport('key', configuration.sender, async () => { throw new Error('No backfill expected'); }), disabled.now).sync();
  assert.equal(disabled.history().length, 0);
  disabled.store.close();
});

test('temporary and uncertain responses persist retries with the same recipient, body and idempotency key', async () => {
  const f = fixture(); f.scan();
  const sent: { body: string; key: string }[] = [];
  let attempts = 0;
  const transport = new ResendEmailTransport('secret-never-in-state', configuration.sender, async (_url, init) => {
    sent.push({ body: String(init?.body), key: new Headers(init?.headers).get('Idempotency-Key')! });
    if (++attempts === 1) throw new Error('timeout containing secret-never-in-state');
    if (attempts === 2) return Response.json({ name: 'rate_limit_exceeded' }, { status: 429, headers: { 'Retry-After': '120' } });
    return Response.json({ id: 'email-accepted-1' });
  });
  const worker = new NotificationService(f.store, transport, f.now);
  await worker.sync();
  assert.equal(f.history()[0].status, 'retry');
  assert.equal(JSON.stringify(f.history()).includes('secret-never-in-state'), false);
  f.advance(60_000); await worker.sync();
  assert.equal(f.history()[0].status, 'retry');
  f.advance(120_000); await worker.sync();
  assert.equal(f.history()[0].status, 'accepted');
  assert.equal(f.history()[0].providerId, 'email-accepted-1');
  assert.deepEqual(sent[0], sent[1]); assert.deepEqual(sent[1], sent[2]);
  assert.equal(f.store.read().parts.at(-1)!.bins[0].status, 'empty');
  f.store.close();
});

test('restart recovers an expired claim and two workers cannot claim the same pending email', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'racing-mail-'));
  try {
    const path = join(directory, 'inventory.sqlite'); const f = fixture(path); f.scan();
    const claimed = f.store.notifications.claim(f.now(), configuration)!;
    assert.ok(claimed.claimToken);
    const payload = claimed.payload; f.store.close();
    const store = new InventoryStore(path, false, () => f.now());
    assert.equal(store.notifications.claim(f.now(), configuration), undefined);
    f.advance(61_000);
    let release!: (r: Response) => void;
    let calls = 0;
    const transport = new ResendEmailTransport('key', configuration.sender, async (_url, init) => {
      calls++; assert.equal(JSON.stringify(payload), String(init?.body));
      return new Promise<Response>(resolve => { release = resolve; });
    });
    const one = new NotificationService(store, transport, f.now).sync();
    await new NotificationService(store, transport, f.now).sync();
    assert.equal(calls, 1); release(Response.json({ id: 'recovered' })); await one;
    assert.equal(store.notifications.snapshot(configuration).history[0].status, 'accepted');
    store.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('ambiguous expired sends require review and intentional retry cannot duplicate on a lost response', async () => {
  const f = fixture(); f.scan();
  const worker = new NotificationService(f.store, new ResendEmailTransport('key', configuration.sender, async () => { throw new Error('Timeout'); }), f.now);
  await worker.sync(); const original = f.history()[0];
  f.advance(24 * 3600000); await worker.sync();
  assert.equal(f.history()[0].status, 'needs_review');
  assert.throws(() => f.settings({ type: 'retry', jobId: original.id, confirmDuplicate: false }), /duplicate/);
  const id = randomUUID(); const input = { eventId: id, expectedRevision: f.store.notifications.settings().revision, action: { type: 'retry', jobId: original.id, confirmDuplicate: true } };
  f.store.notifications.execute(input, configuration); f.store.notifications.execute(input, configuration);
  assert.equal(f.history().length, 2);
  assert.notEqual(f.history()[0].idempotencyKey, original.idempotencyKey);
  f.store.close();
});

test('daily reminders honor one-day episode snooze, retain partial demand and cancel covered demand', async () => {
  const f = fixture(); f.scan();
  const worker = new NotificationService(f.store, new ResendEmailTransport('key', configuration.sender, async () => Response.json({ id: randomUUID() })), f.now);
  await worker.sync();
  f.advance(20 * 3600000);
  const request = f.store.read().requests.at(-1)!;
  f.run({ type: 'acknowledge', requestId: request.id });
  f.advance(5 * 3600000); await worker.sync();
  assert.equal(f.history().length, 1);
  f.advance(19 * 3600000); await worker.sync();
  assert.equal(f.history().length, 2);
  f.run({ type: 'order', requestId: request.id, supplier: 'S', quantity: 20, reference: '', eta: '' });
  f.advance(5 * 86400000); await worker.sync();
  assert.equal(f.history().length, 3, 'downtime yields one reminder; partial purchase retains demand');
  await worker.sync(); assert.equal(f.history().length, 3);
  f.run({ type: 'order', requestId: request.id, supplier: 'S', quantity: 30, reference: '', eta: '' });
  f.advance(86400000); await worker.sync();
  assert.equal(f.history().length, 3, 'coverage stops reminders');
  f.run({ type: 'undo_purchase', orderId: f.store.read().orders.at(-1)!.id });
  await worker.sync(); assert.equal(f.history().length, 4, 'undo reopens demand');
  f.store.close();
});

test('second-bin escalation bypasses prior acknowledgement and buying coverage but stale buying jobs cancel', async () => {
  const f = fixture(); f.scan(); const requestId = f.store.read().requests.at(-1)!.id;
  f.run({ type: 'acknowledge', requestId });
  f.run({ type: 'order', requestId, supplier: 'S', quantity: 100, reference: '', eta: '' });
  f.scan(2);
  await new NotificationService(f.store, new ResendEmailTransport('key', configuration.sender, async () => Response.json({ id: 'urgent' })), f.now).sync();
  assert.equal(f.history().find(j => j.kind === 'initial')?.status, 'cancelled');
  assert.equal(f.history().find(j => j.kind === 'escalation')?.status, 'accepted');
  assert.match(f.history().find(j => j.kind === 'escalation')!.payload.text, /already covered/);
  f.store.close();
});

test('configuration is required for explicit enable and test; pause prevents operational delivery but permits an intentional test', async () => {
  const f = fixture(); f.scan(); f.settings({ type: 'set_enabled', enabled: false });
  assert.throws(() => f.store.notifications.execute({ eventId: randomUUID(), expectedRevision: f.store.notifications.settings().revision, action: { type: 'set_enabled', enabled: true } }, { configured: false, sender: '' }), /Configure/);
  let calls = 0;
  const worker = new NotificationService(f.store, new ResendEmailTransport('key', configuration.sender, async () => { calls++; return Response.json({ id: 'test' }); }), f.now);
  await worker.sync(); assert.equal(calls, 0);
  const id = randomUUID(); const input = { eventId: id, expectedRevision: f.store.notifications.settings().revision, action: { type: 'test' } };
  f.store.notifications.execute(input, configuration); f.store.notifications.execute(input, configuration);
  await worker.sync(); assert.equal(calls, 1); assert.equal(f.history()[0].kind, 'test');
  f.settings({ type: 'save', recipient: 'new@example.org', reminderHours: 24, dashboardUrl: '' });
  f.settings({ type: 'set_enabled', enabled: true }); await worker.sync();
  assert.equal(f.history().find(j => j.kind === 'initial')?.status, 'cancelled');
  f.store.close();
});

test('reset cancels outstanding practice-era work and creates no delivery; malformed provider success requires review', async () => {
  const f = fixture(); f.scan();
  await new NotificationService(f.store, new ResendEmailTransport('key', configuration.sender, async () => Response.json({ unexpected: 'not acceptance' })), f.now).sync();
  assert.equal(f.history()[0].status, 'retry');
  assert.equal(f.history()[0].ambiguous, true);
  f.run({ type: 'reset', confirmation: 'RESET DEMO' }, 'demo');
  await new NotificationService(f.store, new ResendEmailTransport('key', configuration.sender, async () => { throw new Error('No sends after reset'); }), f.now).sync();
  assert.equal(f.history()[0].status, 'cancelled');
  assert.equal(f.history().length, 1);
  f.store.close();
});

test('definitive repeated rate limits can retry after a day without uncertain-delivery review', async () => {
  const f = fixture(); f.scan();
  const worker = new NotificationService(f.store, new ResendEmailTransport('key', configuration.sender, async () => Response.json({ name: 'rate_limit_exceeded' }, { status: 429 })), f.now);
  await worker.sync(); f.advance(60_000); await worker.sync();
  assert.equal(f.history()[0].ambiguous, false);
  f.advance(25 * 3600000); await worker.sync();
  assert.equal(f.history()[0].status, 'retry');
  f.store.close();
});

test('first delivery replaces an obsolete buying snapshot while attempted retries remain immutable', async () => {
  const f = fixture(); f.scan(); const requestId = f.store.read().requests.at(-1)!.id;
  f.run({ type: 'order', requestId, supplier: 'S', quantity: 20, reference: '', eta: '' });
  let sentText = '';
  const worker = new NotificationService(f.store, new ResendEmailTransport('key', configuration.sender, async (_url, init) => { sentText = JSON.parse(String(init?.body)).text; return Response.json({ id: 'updated' }); }), f.now);
  await worker.sync();
  assert.match(sentText, /30 additional pieces remained uncovered/);
  assert.equal(f.history().length, 2);
  assert.equal(f.history().find(j => j.payload.text.includes('50 additional'))!.status, 'cancelled');
  f.scan(2);
  f.run({ type: 'order', requestId, supplier: 'S', quantity: 80, reference: '', eta: '' });
  await worker.sync();
  assert.match(sentText, /Zero additional purchase needed/);
  f.store.close();
});

test('a scanner cannot promote existing simulator demand into operational alerts on the same request', async () => {
  const f = fixture(); f.scan(1, 'simulator'); f.scan(2, 'scanner');
  assert.equal(f.history().length, 0);
  assert.equal(f.store.read().requests.at(-1)!.attention?.sample, true);
  f.store.close();
});

test('repeated partial purchase undo cannot bypass the daily reminder limit', async () => {
  const f = fixture(); f.scan();
  const worker = new NotificationService(f.store, new ResendEmailTransport('key', configuration.sender, async () => Response.json({ id: randomUUID() })), f.now);
  await worker.sync(); const requestId = f.store.read().requests.at(-1)!.id;
  for (let i = 0; i < 2; i++) {
    f.run({ type: 'order', requestId, supplier: 'S', quantity: 20, reference: '', eta: '' });
    f.run({ type: 'undo_purchase', orderId: f.store.read().orders.at(-1)!.id });
    await worker.sync();
  }
  assert.equal(f.history().filter(j => j.status === 'accepted').length, 1);
  f.advance(86400000); await worker.sync();
  assert.equal(f.history().filter(j => j.status === 'accepted').length, 2);
  f.store.close();
});

test('a delayed reminder acceptance starts a fresh interval and does not immediately send another reminder', async () => {
  const f = fixture(); f.scan(); let sends = 0;
  const worker = new NotificationService(f.store, new ResendEmailTransport('key', configuration.sender, async () => ++sends === 2 ? Response.json({}, { status: 429 }) : Response.json({ id: randomUUID() })), f.now);
  await worker.sync(); f.advance(86400000); await worker.sync();
  f.advance(25 * 3600000); await worker.sync();
  assert.equal(f.history().filter(j => j.status === 'accepted').length, 2);
  assert.equal(f.history().filter(j => j.kind === 'reminder').length, 1);
  f.advance(86400000); await worker.sync();
  assert.equal(f.history().filter(j => j.status === 'accepted').length, 3);
  f.store.close();
});

test('practice purchases cannot alter operational demand and then send real buying guidance', async () => {
  const f = fixture(); f.scan();
  f.run({ type: 'order', requestId: f.store.read().requests.at(-1)!.id, supplier: 'S', quantity: 20, reference: '', eta: '' }, 'simulator');
  await new NotificationService(f.store, new ResendEmailTransport('key', configuration.sender, async () => { throw new Error('Practice purchase must stop operational email'); }), f.now).sync();
  assert.equal(f.history()[0].status, 'cancelled');
  assert.equal(f.store.read().requests.at(-1)!.practice, true);
  f.store.close();
});

test('completing a practice request does not turn simulated physical stock into operational stock', async () => {
  const f = fixture(); f.scan(1, 'simulator');
  const requestId = f.store.read().requests.at(-1)!.id;
  f.run({ type: 'order', requestId, supplier: 'S', quantity: 50, reference: '', eta: '' });
  f.run({ type: 'receive', orderId: f.store.read().orders.at(-1)!.id, quantity: 50 });
  f.run({ type: 'refill', binId: 'REAL-A1-1', cycle: 0 });
  f.store.execute({ eventId: randomUUID(), provenance: { source: 'scanner' }, action: { type: 'scan', binId: 'REAL-A1-1', cycle: 1 } });
  assert.equal(f.history().length, 0);
  assert.equal(f.store.read().parts.at(-1)!.practice, true);
  f.store.close();
});

test('operational scans keep their provenance and escalate into a fresh attention episode', () => {
  const store = new InventoryStore(':memory:', false);
  const run = (action: unknown) => store.execute({ eventId: randomUUID(), provenance: { source: 'scanner' }, action });
  run({ type: 'add_part', part: { name: 'Verified bolt', specification: 'M8', category: 'Fasteners', location: 'REAL-A1', supplier: '', supplierUrl: '', binQuantity: 50, unit: 'pieces' } });
  run({ type: 'scan', binId: 'REAL-A1-1', cycle: 0 });
  const initial = store.read().requests.at(-1)!;
  assert.equal(initial.attention?.source, 'scanner');
  assert.equal(initial.attention?.sample, false);
  run({ type: 'acknowledge', requestId: initial.id });
  assert.ok(store.read().requests.at(-1)!.attention?.snoozedUntil);
  run({ type: 'scan', binId: 'REAL-A1-2', cycle: 0 });
  const urgent = store.read().requests.at(-1)!;
  assert.notEqual(urgent.attention?.id, initial.attention?.id);
  assert.equal(urgent.attention?.urgent, true);
  assert.equal(urgent.attention?.snoozedUntil, undefined);
  assert.equal(store.read().alerts.at(-1)?.provenance?.source, 'scanner');
  store.close();
});
