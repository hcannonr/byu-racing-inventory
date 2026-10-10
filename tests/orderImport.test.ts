import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InventoryStore } from '../server/store.ts';

test('extraction metadata can be registered without changing inventory', () => {
  const store = new InventoryStore(':memory:', false);
  try {
    assert.equal(typeof (store as any).registerOrderImport, 'function', 'Order-import metadata registration is required');
    const before = store.read();
    (store as any).registerOrderImport({ id: randomUUID(), sourceHash: 'a'.repeat(64), sourceKind: 'text', model: 'fixture', lineIds: ['line-1'], createdAt: Date.now() });
    assert.deepEqual(store.read(), before);
  } finally { store.close(); }
});

function fixture(path = ':memory:') {
  const store = new InventoryStore(path, false);
  for (const p of store.read().parts.slice(0, 2)) store.execute({ eventId: randomUUID(), provenance: { source: 'simulator' }, action: { type: 'scan', binId: p.bins[0].id, cycle: 0 } });
  const session = { id: randomUUID(), sourceHash: 'b'.repeat(64), sourceKind: 'text', model: 'fixture', lineIds: ['line-1', 'line-2'], createdAt: Date.now() };
  const register = () => (store as any).registerOrderImport(session);
  const command = { eventId: randomUUID(), expectedRevision: store.read().revision, provenance: { source: 'buyer' }, action: {
    type: 'order_batch', supplier: 'Invoice vendor', reference: 'INV-123', eta: '', orderImport: { id: session.id, reviewed: true },
    lines: store.read().requests.map((r, i) => ({ requestId: r.id, quantity: 50, importLine: { sourceLineIds: [`line-${i + 1}`], prices: [{ amount: '4.123', currency: 'CAD', basis: 'pack' }] } })),
  } };
  return { store, session, command, register };
}

test('reviewed imports commit one group and retain actual non-USD prices without touching estimate metadata or stock', () => {
  const f = fixture();
  try {
    f.register(); const before = f.store.read(); f.store.execute(f.command); const after = f.store.read();
    assert.equal(after.orders.length, 2); assert.equal(after.orders[0].purchaseGroupId, after.orders[1].purchaseGroupId);
    assert.deepEqual(after.parts, before.parts); assert.equal(after.orders[0].received, 0);
    assert.deepEqual(after.orders[0].orderImport?.prices, [{ amount: '4.123', currency: 'CAD', basis: 'pack' }]);
    assert.equal(after.orders[0].purchasePack?.priceCents, undefined);
    assert.equal(after.orders[0].orderImport?.sourceHash, f.session.sourceHash);
    assert.ok(after.events.some(e => e.data?.orderId === after.orders[0].id));
  } finally { f.store.close(); }
});

test('an invalid import line rolls back the receipt and purchases so the same draft remains usable', () => {
  const f = fixture();
  try {
    f.register(); const before = f.store.read();
    assert.throws(() => f.store.execute({ ...f.command, action: { ...f.command.action, lines: [f.command.action.lines[0], { ...f.command.action.lines[1], requestId: 'missing' }] } }));
    assert.deepEqual(f.store.read(), before); f.store.execute(f.command); assert.equal(f.store.read().orders.length, 2);
  } finally { f.store.close(); }
});

test('confirmed source and reference deduplication survive new command IDs, restart, undo, and reset', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'racing-import-')), 'inventory.sqlite'); const f = fixture(path);
  f.register(); f.store.execute(f.command); f.store.close(); const store = new InventoryStore(path, false);
  try {
    assert.equal(store.execute(f.command).changed, false);
    assert.throws(() => store.execute({ ...f.command, eventId: randomUUID(), expectedRevision: store.read().revision }), /already.*import|already.*recorded/i);
    store.execute({ eventId: randomUUID(), action: { type: 'undo_purchase', orderId: store.read().orders[0].id } });
    assert.equal((store as any).hasImportedSource(f.session.sourceHash), true);
    const alternate = { ...f.session, id: randomUUID(), sourceHash: 'c'.repeat(64) }; (store as any).registerOrderImport(alternate);
    assert.throws(() => store.execute({ ...f.command, eventId: randomUUID(), expectedRevision: store.read().revision, action: { ...f.command.action, supplier: ' invoice vendor ', reference: ' inv-123 ', orderImport: { id: alternate.id, reviewed: true } } }), /reference.*recorded/i);
    store.execute({ eventId: randomUUID(), action: { type: 'reset', confirmation: 'RESET DEMO' } });
    assert.equal((store as any).hasImportedSource(f.session.sourceHash), true);
  } finally { store.close(); }
});

test('imports reject unknown sessions, missing reference acknowledgement, repeated source lines and stale reviews', () => {
  const f = fixture();
  try {
    f.register(); const before = f.store.read();
    const bad = [
      { ...f.command, action: { ...f.command.action, orderImport: { id: randomUUID(), reviewed: true } } },
      { ...f.command, action: { ...f.command.action, reference: '' } },
      { ...f.command, expectedRevision: 0 },
      { ...f.command, action: { ...f.command.action, lines: f.command.action.lines.map(l => ({ ...l, importLine: { ...l.importLine, sourceLineIds: ['line-1'] } })) } },
      { ...f.command, action: { ...f.command.action, lines: [{ ...f.command.action.lines[0], importLine: { sourceLineIds: ['line-99'], prices: [] } }] } },
    ];
    for (const value of bad) { assert.throws(() => f.store.execute(value)); assert.deepEqual(f.store.read(), before); }
    f.store.execute({ ...f.command, action: { ...f.command.action, reference: '', orderImport: { id: f.session.id, reviewed: true, missingReferenceAcknowledged: true } } });
    assert.equal(f.store.read().orders.length, 2);
  } finally { f.store.close(); }
});

test('buyer may consolidate two source lines into one reviewed individual-unit purchase', () => {
  const f = fixture();
  try {
    f.register(); const line = f.command.action.lines[0];
    f.store.execute({ ...f.command, action: { ...f.command.action, lines: [{ ...line, quantity: 100, importLine: { sourceLineIds: ['line-1', 'line-2'], prices: [] } }] } });
    assert.equal(f.store.read().orders.length, 1); assert.equal(f.store.read().orders[0].quantity, 100);
    assert.deepEqual(f.store.read().orders[0].orderImport?.sourceLineIds, ['line-1', 'line-2']);
  } finally { f.store.close(); }
});

test('expired and unreviewed drafts cannot record purchases', () => {
  const f = fixture();
  try {
    f.register(); const before = f.store.read();
    assert.throws(() => f.store.execute({ ...f.command, action: { ...f.command.action, orderImport: { id: f.session.id, reviewed: false } } }));
    assert.deepEqual(f.store.read(), before);
    const expired = { ...f.session, id: randomUUID(), createdAt: Date.now() - 25 * 60 * 60 * 1000 }; (f.store as any).registerOrderImport(expired);
    assert.throws(() => f.store.execute({ ...f.command, action: { ...f.command.action, orderImport: { id: expired.id, reviewed: true } } }), /expired/);
    assert.deepEqual(f.store.read(), before);
  } finally { f.store.close(); }
});
