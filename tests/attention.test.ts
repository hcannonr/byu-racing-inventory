import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { applyCommand } from '../server/domain.ts';
import { seedState } from '../server/seed.ts';
import { attentionTasks } from '../shared/attention.ts';
import type { Action, InventoryState } from '../shared/types.ts';

const today = new Date(2026, 9, 5, 12);
function fixture() {
  let state = seedState();
  const run = (action: Action) => { state = applyCommand(state, { eventId: randomUUID(), action }).state; return state; };
  const scan = (partIndex = 0, binIndex = 0) => {
    const bin = state.parts[partIndex].bins[binIndex];
    return run({ type: 'scan', binId: bin.id, cycle: bin.cycle });
  };
  const buy = (quantity = 50, eta = '') => {
    run({ type: 'order', requestId: state.requests.at(-1)!.id, supplier: 'Supplier', reference: '', quantity, eta });
    return state.orders.at(-1)!;
  };
  return { get state() { return state; }, run, scan, buy };
}
const reasons = (state: InventoryState) => attentionTasks(state, today).map(task => task.reasons.map(reason => reason.kind));

test('stocked inventory has no attention tasks; scanning creates uncovered purchasing work', () => {
  const f = fixture();
  assert.deepEqual(attentionTasks(f.state, today), []);
  f.scan();
  const [task] = attentionTasks(f.state, today);
  assert.equal(task.part.id, 'part-1');
  assert.equal(task.toBuy, 50);
  assert.equal(task.action.kind, 'purchase');
});

test('both empty bins make one critical row and an insufficient purchase remains actionable', () => {
  const f = fixture();
  f.scan(); f.scan(0, 1); f.buy(30);
  const tasks = attentionTasks(f.state, today);
  assert.equal(tasks.length, 1);
  assert.deepEqual(tasks[0].reasons.map(reason => reason.kind), ['out', 'purchase']);
  assert.equal(tasks[0].toBuy, 70);
});

test('overdue uses local calendar dates, carrier ETA precedence, and valid manual fallback', () => {
  const cases = [
    { eta: '2026-10-04', carrier: undefined, overdue: true },
    { eta: '2026-10-05', carrier: undefined, overdue: false },
    { eta: '2026-10-06', carrier: undefined, overdue: false },
    { eta: '', carrier: undefined, overdue: false },
    { eta: '2026-10-04', carrier: '2026-10-06', overdue: false },
    { eta: '2026-10-06', carrier: '2026-10-04', overdue: true },
    { eta: '2026-10-04', carrier: 'invalid', overdue: true },
    { eta: '', carrier: '2026-02-30', overdue: false },
    { eta: '2026-10-06', carrier: '2026-02-30T12:00:00Z', overdue: false },
    { eta: '', carrier: new Date(2026, 9, 4, 23, 30).toISOString(), overdue: true },
    { eta: '', carrier: new Date(2026, 9, 5, 0, 30).toISOString(), overdue: false },
  ];
  for (const item of cases) {
    const f = fixture(); f.scan(); f.buy(50, item.eta);
    if (item.carrier) f.state.orders[0].delivery = { status: 'in_transit', eta: item.carrier, events: [] };
    const tasks = attentionTasks(f.state, today);
    assert.equal(tasks.some(task => task.reasons.some(reason => reason.kind === 'overdue')), item.overdue, JSON.stringify(item));
  }
});

test('carrier delivery prompts physical receipt without enabling refill or changing stock', () => {
  const f = fixture(); f.scan(); const order = f.buy(50, '2026-10-01');
  f.state.orders[0].delivery = { status: 'delivered', events: [] };
  const before = structuredClone(f.state);
  const [task] = attentionTasks(f.state, today);
  assert.deepEqual(task.reasons.map(reason => reason.kind), ['receipt']);
  assert.deepEqual(task.action, { kind: 'receive', orderId: order.id });
  assert.equal(task.received, 0);
  assert.deepEqual(f.state, before);
  f.run({ type: 'receive', orderId: order.id, quantity: 20 });
  assert.equal(attentionTasks(f.state, today)[0].action.kind, 'receive');
  f.run({ type: 'receive', orderId: order.id, quantity: 30 });
  assert.deepEqual(reasons(f.state), [['refill']]);
  assert.equal(attentionTasks(f.state, today)[0].action.kind, 'refill');
});

test('partial stock below a full bin is not refill-ready and undone orders are excluded', () => {
  const f = fixture(); f.scan(); const order = f.buy(50, '2026-10-01');
  f.run({ type: 'receive', orderId: order.id, quantity: 20 });
  assert.deepEqual(reasons(f.state), [['overdue']]);
  f.state.orders[0].received = 0;
  f.state.orders[0].voidedAt = '2026-10-05T12:00:00Z';
  f.state.orders[0].delivery = { status: 'delivered', events: [] };
  assert.deepEqual(reasons(f.state), [['purchase']]);
  assert.equal(attentionTasks(f.state, today)[0].toBuy, 50);
});

test('refill takes action precedence and carries prior received surplus into a new cycle', () => {
  const f = fixture(); f.scan(); const order = f.buy(150);
  f.run({ type: 'receive', orderId: order.id, quantity: 150 });
  f.run({ type: 'refill', binId: f.state.parts[0].bins[0].id, cycle: 0 });
  f.scan(); f.scan(0, 1);
  const [task] = attentionTasks(f.state, today);
  assert.deepEqual(task.reasons.map(reason => reason.kind), ['out', 'refill']);
  assert.equal(task.received, 100);
  assert.equal(task.action.kind, 'refill');
});

test('critical parts sort first, then receipt, oldest overdue, purchase, and refill', () => {
  const f = fixture();
  f.scan(0); f.scan(0, 1);
  f.scan(1); f.buy(50).delivery = { status: 'delivered', events: [] };
  f.scan(2); f.buy(100, '2026-10-03');
  f.scan(3); f.buy(50, '2026-10-01');
  f.scan(4);
  f.scan(5); const order = f.buy(25); f.run({ type: 'receive', orderId: order.id, quantity: 25 });
  assert.deepEqual(attentionTasks(f.state, today).map(task => task.part.id), ['part-1', 'part-2', 'part-4', 'part-3', 'part-5', 'part-6']);
});
