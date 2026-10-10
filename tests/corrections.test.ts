import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { InventoryStore } from '../server/store.ts';
import { NotificationService } from '../server/notifications.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { availableReceived, type InventoryState, type PartInput } from '../shared/types.ts';

function fixture() {
  let clock = Date.parse('2026-10-05T12:00:00Z');
  const store = new InventoryStore(':memory:', false, () => clock);
  const run = (action: unknown, source = 'buyer', eventId = randomUUID(), revision = store.read().revision) => store.execute({ eventId, expectedRevision: revision, provenance: { source }, action });
  const details: PartInput = { name: 'Verified bolts', specification: 'M6', category: 'Fasteners', location: 'REAL-01', supplier: 'Supplier', supplierUrl: '', binQuantity: 50, unit: 'pieces' };
  run({ type: 'add_part', part: details });
  const part = store.read().parts.at(-1)!;
  const scan = (index = 0, source = 'scanner') => { const p = store.read().parts.find(p => p.id === part.id)!; run({ type: 'scan', binId: p.bins[index].id, cycle: p.bins[index].cycle }, source); return store.read().events.find(e => e.partId === part.id && e.kind === 'scan')!; };
  const order = (quantity = 100) => { run({ type: 'order', requestId: store.read().requests.at(-1)!.id, supplier: 'Supplier', reference: 'PO', quantity, eta: '' }); return store.read().orders.at(-1)!; };
  const receive = (orderId: string, quantity: number, source = 'buyer') => { run({ type: 'receive', orderId, quantity }, source); return store.read().events.find(e => e.partId === part.id && e.kind === 'receive')!; };
  const correction = (type: string, targetEventId: string, extras = {}) => ({ type, targetEventId, reason: 'Checked the physical inventory.', physicallyConfirmed: true, ...extras });
  return { store, run, part, details, scan, order, receive, correction, advance: (ms: number) => { clock += ms; } };
}
const partState = (s: InventoryState, id: string) => s.parts.find(p => p.id === id)!;

test('scan correction preserves independent purchases and receipts, immutable evidence and stale cycle protection', () => {
  const f = fixture(); const scanned = f.scan(0, 'simulator'); const original = structuredClone(scanned);
  const o = f.order(); f.receive(o.id, 75); f.run({ type: 'save_tracking', orderId: o.id, tracking: { carrier: 'UPS', number: 'TEST-12345', url: '' } });
  const action = f.correction('correct_scan', scanned.id); const commandId = randomUUID(); f.run(action, 'buyer', commandId);
  const s = f.store.read(); assert.deepEqual(partState(s, f.part.id).bins.map(b => b.status), ['in_use', 'ready']);
  assert.equal(s.orders[0].received, 75); assert.equal(s.orders[0].tracking?.number, 'TEST-12345'); assert.equal(s.requests[0].closedAt, null);
  assert.deepEqual(s.events.find(e => e.id === scanned.id), original); assert.equal(partState(s, f.part.id).practice, false);
  assert.equal(f.run(action, 'buyer', commandId, 0).changed, false); assert.equal(f.run(action).changed, false);
  assert.throws(() => f.run({ type: 'scan', binId: f.part.bins[0].id, cycle: 0 }, 'scanner'), /cycle/);
  assert.throws(() => f.run({ type: 'scan', binId: f.part.bins[1].id, cycle: 0 }, 'scanner'), /cycle/);
  assert.equal(s.events.filter(e => e.kind === 'correction').length, 1); f.store.close();
});

test('latest second-bin scan correction restores one empty bin and invalidates the urgent attention', () => {
  const f = fixture(); f.scan(); const scanned = f.scan(1); const oldEpisode = f.store.read().requests[0].attention!.id;
  f.run(f.correction('correct_scan', scanned.id)); const s = f.store.read();
  assert.deepEqual(partState(s, f.part.id).bins.map(b => b.status), ['empty', 'in_use']);
  assert.notEqual(s.requests[0].attention?.id, oldEpisode); assert.equal(s.requests[0].attention?.urgent, false);
  assert.equal(s.alerts.length, 2, 'correction must not replay an old preview'); f.store.close();
});

test('receipt correction replaces the delivery amount, preserves independent receipts and shipping, and supports zero', () => {
  const f = fixture(); f.scan(); const o = f.order(100); const receipt = f.receive(o.id, 60);
  const other = f.order(50); f.receive(other.id, 20); f.run({ type: 'ship', orderId: o.id }); f.scan(1);
  f.run(f.correction('correct_receipt', receipt.id, { quantity: 0 })); const s = f.store.read();
  assert.equal(s.orders[0].received, 0); assert.equal(s.orders[0].status, 'in_transit'); assert.equal(s.orders[1].received, 20);
  assert.equal(availableReceived(s, s.requests[0].id), 20); assert.deepEqual(partState(s, f.part.id).bins.map(b => b.status), ['empty', 'empty']);
  assert.equal(s.events.find(e => e.id === receipt.id)?.message, receipt.message); f.store.close();
});

test('receipt correction restores previous logistics status after mistaken full arrival and rejects invalid totals atomically', () => {
  const f = fixture(); f.scan(); const o = f.order(50); f.run({ type: 'ship', orderId: o.id }); const receipt = f.receive(o.id, 50);
  const before = f.store.read(); assert.throws(() => f.run(f.correction('correct_receipt', receipt.id, { quantity: 51 })), /order quantity/);
  assert.deepEqual(f.store.read(), before); f.run(f.correction('correct_receipt', receipt.id, { quantity: 20 }));
  assert.equal(f.store.read().orders[0].status, 'in_transit'); assert.equal(f.store.read().orders[0].received, 20); f.store.close();
});

test('refill correction returns recorded units, reopens a closed request, preserves later receipts and completes normally', () => {
  const f = fixture(); f.scan(); const o = f.order(50); f.receive(o.id, 50);
  f.run({ type: 'refill', binId: f.part.bins[0].id, cycle: 0 }); const refill = f.store.read().events.find(e => e.kind === 'refill')!;
  assert.ok(f.store.read().requests[0].closedAt);
  f.run(f.correction('correct_refill', refill.id, { physicalOutcome: 'not_refilled' })); let s = f.store.read();
  assert.equal(s.requests[0].allocated, 0); assert.equal(s.requests[0].closedAt, null); assert.equal(availableReceived(s, s.requests[0].id), 50);
  assert.equal(partState(s, f.part.id).bins[0].cycle, 2); assert.equal(partState(s, f.part.id).bins[0].status, 'empty');
  f.run({ type: 'refill', binId: f.part.bins[0].id, cycle: 2 }); s = f.store.read(); assert.ok(s.requests[0].closedAt); assert.equal(s.requests[0].allocated, 50); f.store.close();
});

test('dependent refill, subsequent scan, newer same-order receipt and measurement edits require a physical recount', () => {
  const f = fixture(); const first = f.scan(); const second = f.scan(1); const o = f.order(); const receipt = f.receive(o.id, 50);
  assert.throws(() => f.run(f.correction('correct_scan', first.id)), /later scan.*physical recount/i);
  f.run({ type: 'refill', binId: f.part.bins[0].id, cycle: 0 }); const refill = f.store.read().events.find(e => e.kind === 'refill')!;
  assert.throws(() => f.run(f.correction('correct_scan', second.id)), /later refill.*physical recount/i);
  assert.throws(() => f.run(f.correction('correct_receipt', receipt.id, { quantity: 20 })), /later refill.*physical recount/i);
  f.scan(0); assert.throws(() => f.run(f.correction('correct_refill', refill.id, { physicalOutcome: 'returned_unused' })), /later scan.*physical recount/i); f.store.close();
  const g = fixture(); g.scan(); const p = g.order(); const old = g.receive(p.id, 20); g.receive(p.id, 20);
  assert.throws(() => g.run(g.correction('correct_receipt', old.id, { quantity: 10 })), /later receipt.*physical recount/i);
  const last = g.store.read().events.find(e => e.kind === 'receive')!;
  g.run({ type: 'edit_part', partId: g.part.id, part: { ...g.details, specification: 'M8' } });
  assert.throws(() => g.run(g.correction('correct_receipt', last.id, { quantity: 10 })), /measurement.*physical recount/i); g.store.close();
});

test('practice correction cannot clear inherited or subsequent contamination or sample stock', () => {
  const f = fixture(); const scanned = f.scan(0, 'simulator'); const o = f.order(); f.receive(o.id, 50, 'simulator');
  f.run(f.correction('correct_scan', scanned.id)); assert.equal(partState(f.store.read(), f.part.id).practice, true); f.store.close();
  const g = fixture(); const sample = g.store.read().parts[0]; g.run({ type: 'scan', binId: sample.bins[0].id, cycle: 0 }, 'simulator'); const e = g.store.read().events[0];
  g.run(g.correction('correct_scan', e.id)); assert.equal(partState(g.store.read(), sample.id).practice, true); g.store.close();
});

test('structured audit captures final closure, actual quantity, activation, purchase IDs and same-time revisions', () => {
  const f = fixture(); const scan = f.scan(); const o = f.order(50); const receipt = f.receive(o.id, 50); f.run({ type: 'refill', binId: f.part.bins[0].id, cycle: 0 });
  const s = f.store.read(); const refill = s.events.find(e => e.kind === 'refill')! as any; const data = (receipt as any).data;
  assert.ok((scan as any).data, 'new scan carries machine-readable evidence');
  assert.equal((scan as any).data.after.part.bins[1].status, 'in_use'); assert.equal(data.orderId, o.id); assert.equal(data.quantity, 50);
  assert.equal(data.before.order.received, 0); assert.equal(data.after.order.received, 50); assert.equal(data.after.order.status, 'arrived');
  assert.equal(refill.data.quantity, 50); assert.ok(refill.data.after.request.closedAt); assert.equal(refill.data.after.request.allocated, 50);
  assert.equal(refill.data.after.part.capacity, 50); assert.equal(refill.data.after.part.practice, false);
  assert.ok(refill.data.revision > data.revision); assert.equal(refill.at, receipt.at); f.store.close();
});

test('corrections require reason, physical confirmation and revision and reject unknown targets', () => {
  const f = fixture(); const e = f.scan(); const base = f.correction('correct_scan', e.id);
  assert.throws(() => f.store.execute({ eventId: randomUUID(), provenance: { source: 'buyer' }, action: base }), /revision/i);
  assert.throws(() => f.run({ ...base, reason: '' })); assert.throws(() => f.run({ ...base, physicallyConfirmed: false }));
  assert.throws(() => f.run(f.correction('correct_scan', randomUUID())), /not found/i);
  assert.throws(() => f.run(base, 'buyer', randomUUID(), 0), /changed/); f.store.close();
});

test('correction cancels obsolete notices immediately and restarts remaining reminders without replay or a burst', async () => {
  const f = fixture(); const configuration = { configured: true, sender: 'Fixture <fixture@example.org>' };
  const configure = (action: unknown) => f.store.notifications.execute({ eventId: randomUUID(), expectedRevision: f.store.notifications.settings().revision, action }, configuration);
  configure({ type: 'save', recipient: 'buyer@example.org', reminderHours: 24, dashboardUrl: '' }); configure({ type: 'set_enabled', enabled: true });
  const history = () => f.store.notifications.snapshot(configuration).history;
  const worker = new NotificationService(f.store, { configuration, send: async () => ({ accepted: true, providerId: 'fixture' }) }, () => Date.parse('2026-10-05T12:00:00Z') + elapsed);
  let elapsed = 0;
  f.scan(); await worker.sync(); const second = f.scan(1); assert.equal(history().filter(j => j.status === 'queued').length, 1);
  f.run(f.correction('correct_scan', second.id)); assert.equal(history().find(j => j.kind === 'escalation')?.status, 'cancelled');
  await worker.sync(); assert.equal(history().length, 2, 'old initial previews must not be replayed');
  elapsed = 23 * 3600000; f.advance(elapsed); await worker.sync(); assert.equal(history().length, 2);
  elapsed += 3600000; f.advance(3600000); await worker.sync(); assert.equal(history().length, 3); assert.equal(history()[0].kind, 'reminder');
  f.store.close();
});

test('structured evidence and correction idempotency survive restart; legacy prose remains ineligible', () => {
  const directory = mkdtempSync(join(tmpdir(), 'racing-corrections-')); const path = join(directory, 'inventory.sqlite');
  let store = new InventoryStore(path, false);
  try {
    const run = (action: unknown, eventId = randomUUID()) => store.execute({ eventId, expectedRevision: store.read().revision, provenance: { source: 'buyer' }, action });
    run({ type: 'scan', binId: 'BLUE-A01-1', cycle: 0 }); const target = store.read().events[0];
    const action = { type: 'correct_scan', targetEventId: target.id, reason: 'Physical check', physicallyConfirmed: true }; const id = randomUUID(); run(action, id);
    store.close(); store = new InventoryStore(path, false); assert.equal(run(action, id).changed, false); assert.equal(store.read().events.filter(e => e.kind === 'correction').length, 1);
    run({ type: 'scan', binId: 'BLUE-A01-2', cycle: 1 }); const legacy = store.read(); delete legacy.events[0].data;
    const inspection = new DatabaseSync(path); inspection.prepare('UPDATE inventory SET body=? WHERE id=1').run(JSON.stringify(legacy)); inspection.close();
    assert.throws(() => run({ ...action, targetEventId: legacy.events[0].id }), /older record.*physical recount/i);
    assert.deepEqual(store.read(), legacy);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('purchase undo cannot erase the correction reminder deadline', () => {
  const f = fixture(); const configuration = { configured: true, sender: 'Fixture <fixture@example.org>' };
  const configure = (action: unknown) => f.store.notifications.execute({ eventId: randomUUID(), expectedRevision: f.store.notifications.settings().revision, action }, configuration);
  configure({ type: 'save', recipient: 'buyer@example.org', reminderHours: 24, dashboardUrl: '' }); configure({ type: 'set_enabled', enabled: true });
  f.scan(); const second = f.scan(1); f.run(f.correction('correct_scan', second.id));
  const o = f.order(20); f.run({ type: 'undo_purchase', orderId: o.id });
  const now = Date.parse('2026-10-05T12:00:00Z'); assert.equal(f.store.notifications.claim(now, configuration), undefined);
  assert.equal(f.store.notifications.claim(now + 23 * 3600000, configuration), undefined);
  assert.equal(f.store.notifications.claim(now + 24 * 3600000, configuration)?.kind, 'reminder'); f.store.close();
});
