import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { InventoryStore } from '../server/store.ts';
import { Ship24Service } from '../server/ship24.ts';

function fixture(live = true) {
  const store = new InventoryStore(':memory:', false);
  const run = (action: unknown) => store.execute({ eventId: randomUUID(), action });
  const part = store.read().parts[0];
  run({ type: 'scan', binId: part.bins[0].id, cycle: 0 });
  run({ type: 'order', requestId: store.read().requests[0].id, supplier: 'Test', reference: '', quantity: 50, eta: '' });
  const order = store.read().orders[0];
  run({ type: 'save_tracking', orderId: order.id, tracking: { carrier: 'UPS', number: '1Z-TEST-12345', url: '', live } });
  return { store, run, order };
}
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const result = (status = 'in_transit', date = '2026-10-05T10:00:00Z') => ({ data: { trackings: [{ tracker: { trackerId: 'trk-test' }, shipment: { statusMilestone: status, delivery: { estimatedDeliveryDate: '2026-10-08T12:00:00Z' } }, events: [{ eventId: status, status: 'Package update', occurrenceDatetime: date, statusMilestone: status }] }] } });

test('live tracking is opt-in and a missing key does not call Ship24', async () => {
  const { store } = fixture(false);
  let calls = 0;
  const transport = async () => { calls++; return json({}); };
  await new Ship24Service(store, 'secret', transport).sync();
  await new Ship24Service(store, '', transport).sync();
  assert.equal(calls, 0); store.close();
});

test('registers once, caches delivery without changing inventory, and respects polling interval', async () => {
  const { store } = fixture();
  const before = store.read();
  const calls: string[] = [];
  const service = new Ship24Service(store, 'secret', async (url, init) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    return init?.method === 'POST' ? json({ data: { tracker: { trackerId: 'trk-test' } } }, 201) : json(result('delivered'));
  });
  await Promise.all([service.sync(), service.sync()]);
  await service.sync();
  assert.equal(calls.length, 2);
  assert.equal(service.snapshot().orders[0].delivery?.status, 'delivered');
  assert.deepEqual(store.read(), before, 'carrier delivery must not mutate stock, receipt or revision');
  assert.equal(JSON.stringify(service.snapshot()).includes('secret'), false);
  store.close();
});

test('shared packages reuse persisted tracker after service restart', async () => {
  const { store, run, order } = fixture();
  run({ type: 'order', requestId: order.requestId, supplier: 'Test', reference: 'second', quantity: 10, eta: '' });
  run({ type: 'save_tracking', orderId: store.read().orders[1].id, tracking: { carrier: 'UPS', number: '1Z-TEST-12345', url: '', live: true } });
  let creates = 0;
  const transport = async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') { creates++; return json({ data: { tracker: { trackerId: 'trk-test' } } }); }
    return json(result());
  };
  const service = new Ship24Service(store, 'secret', transport);
  await service.sync();
  await new Ship24Service(store, 'secret', transport).sync();
  assert.equal(creates, 1);
  assert.equal(service.snapshot().orders[1].delivery?.status, 'in_transit');
  store.close();
});

test('provider failures preserve saved tracking and expose a safe actionable error', async () => {
  const { store } = fixture();
  let calls = 0;
  const service = new Ship24Service(store, 'secret', async () => { calls++; return json({ errors: [{ message: 'secret' }] }, 401); });
  await service.sync(); await service.sync();
  assert.equal(calls, 1);
  assert.match(service.snapshot().orders[0].delivery!.error!, /API key/);
  assert.equal(JSON.stringify(service.snapshot()).includes('secret'), false);
  assert.equal(store.read().orders[0].tracking?.number, '1Z-TEST-12345');
  store.close();
});

test('late provider result cannot attach to corrected tracking or an undone purchase', async () => {
  const { store, run, order } = fixture();
  const service = new Ship24Service(store, 'secret', async (_url, init) => {
    if (init?.method === 'POST') return json({ data: { tracker: { trackerId: 'trk-test' } } });
    run({ type: 'save_tracking', orderId: order.id, tracking: { carrier: 'UPS', number: 'NEW-TRACKING-123', url: '', live: false } });
    run({ type: 'undo_purchase', orderId: order.id });
    return json(result('delivered'));
  });
  await service.sync();
  assert.equal(service.snapshot().orders[0].delivery, undefined);
  store.close();
});

test('live tracking validates provider limits while old manual links still work', () => {
  const { store, run, order } = fixture(false);
  assert.throws(() => run({ type: 'save_tracking', orderId: order.id, tracking: { carrier: 'UPS', number: 'ABC', url: '', live: true } }));
  run({ type: 'save_tracking', orderId: order.id, tracking: { carrier: 'UPS', number: 'ABC', url: '' } });
  store.close();
});

test('an older carrier result cannot overwrite a newer event', async () => {
  const { store } = fixture();
  const service = new Ship24Service(store, 'secret', async (_url, init) => init?.method === 'POST'
    ? json({ data: { tracker: { trackerId: 'trk-test' } } }) : json(result('out_for_delivery')));
  await service.sync();
  const { createHash } = await import('node:crypto');
  const id = createHash('sha256').update('UPS:1Z-TEST-12345').digest('hex');
  const cached = store.readDelivery<{ attemptedAt: number }>(id)!;
  store.saveDelivery(id, { ...cached, attemptedAt: 0 });
  await new Ship24Service(store, 'secret', async () => json(result('in_transit', '2026-10-04T10:00:00Z'))).sync();
  assert.equal(service.snapshot().orders[0].delivery?.status, 'out_for_delivery');
  store.close();
});

test('a timed-out registration retries the identical payload without losing the saved number', async () => {
  const { store } = fixture();
  const payloads: unknown[] = [];
  let first = true;
  const service = new Ship24Service(store, 'secret', async (_url, init) => {
    if (init?.method === 'POST') {
      payloads.push(JSON.parse(String(init.body)));
      if (first) { first = false; throw new Error('Simulated lost response'); }
      return json({ data: { tracker: { trackerId: 'trk-test' } } });
    }
    return json(result());
  });
  await service.sync();
  const { createHash } = await import('node:crypto');
  const id = createHash('sha256').update('UPS:1Z-TEST-12345').digest('hex');
  store.saveDelivery(id, { ...store.readDelivery<object>(id), attemptedAt: 0 });
  await service.sync();
  assert.equal(payloads.length, 2); assert.deepEqual(payloads[0], payloads[1]);
  assert.equal(service.snapshot().orders[0].delivery?.status, 'in_transit');
  store.close();
});
