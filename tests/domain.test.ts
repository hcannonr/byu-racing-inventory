import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InventoryStore } from '../server/store.ts';
import { activeRequest, quantityToBuy, type Action } from '../shared/types.ts';

function fixture() {
  const store = new InventoryStore(':memory:', false);
  const part = store.read().parts[0];
  const run = (action: Action, eventId = randomUUID()) => store.execute({ eventId, action });
  const scan = (index: number) => run({ type: 'scan', binId: part.bins[index].id, cycle: 0 });
  return { store, part, run, scan };
}

test('one empty-bin scan rotates the reserve and creates one request and alert', () => {
  const { store, part, scan } = fixture();
  scan(0);
  const s = store.read();
  assert.deepEqual(s.parts[0].bins.map(b => b.status), ['empty', 'in_use']);
  assert.equal(s.requests.length, 1);
  assert.equal(s.alerts.length, 1);
  assert.equal(s.requests[0].partId, part.id);
  scan(0);
  assert.equal(store.read().requests.length, 1);
  assert.equal(store.read().alerts.length, 1);
  store.close();
});

test('second bin depletion escalates the existing request without ordering', () => {
  const { store, scan } = fixture(); scan(0); scan(1);
  assert.equal(store.read().requests.length, 1);
  assert.equal(store.read().orders.length, 0);
  assert.match(store.read().alerts[1].title, /Out of stock/);
  store.close();
});

test('partial receipts and ordering never mark a bin stocked; refill requires sufficient received units', () => {
  const { store, part, run, scan } = fixture(); scan(0);
  const requestId = store.read().requests[0].id;
  run({ type: 'order', requestId, supplier: 'Test supplier', reference: 'PO-1', quantity: 50, eta: '' });
  const orderId = store.read().orders[0].id;
  run({ type: 'ship', orderId });
  run({ type: 'receive', orderId, quantity: 20 });
  assert.equal(store.read().parts[0].bins[0].status, 'empty');
  assert.throws(() => run({ type: 'refill', binId: part.bins[0].id, cycle: 0 }), /received/);
  run({ type: 'receive', orderId, quantity: 30 });
  assert.equal(store.read().parts[0].bins[0].status, 'empty');
  run({ type: 'refill', binId: part.bins[0].id, cycle: 0 });
  assert.deepEqual(store.read().parts[0].bins.map(b => b.status), ['ready', 'in_use']);
  assert.equal(activeRequest(store.read(), part.id), undefined);
  assert.equal(store.read().parts[0].bins[0].cycle, 1);
  store.close();
});

test('late retry and stale cycle cannot empty a newly refilled bin', () => {
  const { store, part, run } = fixture();
  const eventId = randomUUID();
  const action: Action = { type: 'scan', binId: part.bins[0].id, cycle: 0 };
  run(action, eventId);
  run({ type: 'order', requestId: store.read().requests[0].id, supplier: 'Supplier', reference: '', quantity: 50, eta: '' });
  run({ type: 'receive', orderId: store.read().orders[0].id, quantity: 50 });
  run({ type: 'refill', binId: part.bins[0].id, cycle: 0 });
  assert.equal(run(action, eventId).changed, false);
  assert.throws(() => run(action), /cycle/);
  assert.equal(store.read().parts[0].bins[0].status, 'ready');
  store.close();
});

test('restoring both empty bins needs enough receipts and leaves one working bin', () => {
  const { store, part, run, scan } = fixture(); scan(0); scan(1);
  const requestId = store.read().requests[0].id;
  run({ type: 'order', requestId, supplier: 'Supplier', reference: '', quantity: 100, eta: '' });
  run({ type: 'receive', orderId: store.read().orders[0].id, quantity: 50 });
  run({ type: 'refill', binId: part.bins[0].id, cycle: 0 });
  assert.equal(store.read().requests[0].closedAt, null);
  assert.throws(() => run({ type: 'refill', binId: part.bins[1].id, cycle: 0 }), /received/);
  run({ type: 'receive', orderId: store.read().orders[0].id, quantity: 50 });
  run({ type: 'refill', binId: part.bins[1].id, cycle: 0 });
  assert.deepEqual(store.read().parts[0].bins.map(b => b.status), ['in_use', 'ready']);
  assert.ok(store.read().requests[0].closedAt);
  store.close();
});

test('rejects invalid quantities, over-receipts and unknown bins without changing state', () => {
  const { store, run, scan } = fixture(); scan(0);
  const requestId = store.read().requests[0].id;
  assert.throws(() => run({ type: 'order', requestId, supplier: 'S', reference: '', quantity: -1, eta: '' }));
  run({ type: 'order', requestId, supplier: 'S', reference: '', quantity: 50, eta: '' });
  const before = store.read();
  assert.throws(() => run({ type: 'receive', orderId: before.orders[0].id, quantity: 51 }), /remaining/);
  assert.throws(() => run({ type: 'scan', binId: 'UNKNOWN', cycle: 0 }), /Unknown/);
  assert.deepEqual(store.read(), before);
  store.close();
});

test('stale buyer revision conflicts and event IDs cannot be reused for another action', () => {
  const { store, part, run } = fixture();
  const eventId = randomUUID();
  run({ type: 'scan', binId: part.bins[0].id, cycle: 0 }, eventId);
  assert.throws(() => store.execute({ eventId: randomUUID(), expectedRevision: 0, action: { type: 'acknowledge', requestId: store.read().requests[0].id } }), /changed/);
  assert.throws(() => run({ type: 'scan', binId: part.bins[1].id, cycle: 0 }, eventId), /reused/);
  store.close();
});

test('SQLite state and idempotency records survive closing and reopening', () => {
  const dir = mkdtempSync(join(tmpdir(), 'racing-test-'));
  try {
    const path = join(dir, 'inventory.sqlite');
    let store = new InventoryStore(path, false);
    const action: Action = { type: 'scan', binId: store.read().parts[0].bins[0].id, cycle: 0 };
    const eventId = randomUUID();
    store.execute({ eventId, action }); store.close();
    store = new InventoryStore(path, false);
    assert.equal(store.read().parts[0].bins[0].status, 'empty');
    assert.equal(store.execute({ eventId, action }).changed, false);
    assert.equal(store.read().requests.length, 1); store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('surplus received units remain available for the next replenishment cycle', () => {
  const { store, part, run, scan } = fixture(); scan(0);
  run({ type: 'order', requestId: store.read().requests[0].id, supplier: 'Supplier', reference: '', quantity: 100, eta: '' });
  run({ type: 'receive', orderId: store.read().orders[0].id, quantity: 100 });
  run({ type: 'refill', binId: part.bins[0].id, cycle: 0 });
  scan(1);
  run({ type: 'refill', binId: part.bins[1].id, cycle: 0 });
  assert.equal(store.read().requests.filter(r => !r.closedAt).length, 0);
  assert.equal(store.read().orders.length, 1);
  store.close();
});

test('old refill confirmation cannot refill a bin emptied in a later cycle', () => {
  const { store, part, run, scan } = fixture(); scan(0); scan(1);
  run({ type: 'order', requestId: store.read().requests[0].id, supplier: 'Supplier', reference: '', quantity: 150, eta: '' });
  run({ type: 'receive', orderId: store.read().orders[0].id, quantity: 100 });
  run({ type: 'refill', binId: part.bins[0].id, cycle: 0 });
  run({ type: 'scan', binId: part.bins[0].id, cycle: 1 });
  assert.throws(() => run({ type: 'refill', binId: part.bins[0].id, cycle: 0 }), /cycle/);
  assert.equal(store.read().parts[0].bins[0].status, 'empty');
  store.close();
});


test('undoing a mistaken purchase restores demand, keeps history, and cannot be replayed into an active purchase', () => {
  const { store, part, run, scan } = fixture(); scan(0);
  const purchaseId = randomUUID();
  const action: Action = { type: 'order', requestId: store.read().requests[0].id, supplier: 'S', reference: 'Mistake', quantity: 50, eta: '' };
  run(action, purchaseId);
  const orderId = store.read().orders[0].id;
  assert.equal(quantityToBuy(store.read(), store.read().parts[0]), 0);
  run({ type: 'undo_purchase', orderId });
  assert.ok(store.read().orders[0].voidedAt);
  assert.equal(quantityToBuy(store.read(), store.read().parts[0]), 50);
  assert.equal(store.read().parts[0].bins[0].status, 'empty');
  assert.equal(run({ type: 'undo_purchase', orderId }).changed, false);
  run(action, purchaseId);
  assert.ok(store.read().orders[0].voidedAt);
  assert.throws(() => run({ type: 'receive', orderId, quantity: 1 }), /undone/);
  assert.throws(() => run({ type: 'ship', orderId }), /undone/);
  assert.equal(store.read().events.filter(e => e.kind === 'undo_purchase').length, 1);
  store.close();
});

test('received purchases cannot be undone; tracking never changes stock or delivery state', () => {
  const { store, run, scan } = fixture(); scan(0);
  run({ type: 'order', requestId: store.read().requests[0].id, supplier: 'S', reference: '', quantity: 50, eta: '' });
  const orderId = store.read().orders[0].id;
  run({ type: 'save_tracking', orderId, tracking: { carrier: 'UPS', number: '1ZTEST123', url: '' } });
  assert.equal(store.read().orders[0].tracking?.number, '1ZTEST123');
  assert.equal(store.read().orders[0].status, 'ordered');
  assert.equal(store.read().orders[0].received, 0);
  assert.equal(store.read().parts[0].bins[0].status, 'empty');
  assert.throws(() => run({ type: 'save_tracking', orderId, tracking: { carrier: 'Other', number: '123', url: 'javascript:alert(1)' } }));
  run({ type: 'receive', orderId, quantity: 1 });
  assert.throws(() => run({ type: 'undo_purchase', orderId }), /received/);
  assert.equal(store.read().orders[0].voidedAt, undefined);
  store.close();
});
