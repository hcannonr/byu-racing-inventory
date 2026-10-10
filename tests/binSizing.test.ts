import { test } from 'node:test';
import assert from 'node:assert/strict';
import { binSizingSuggestion } from '../shared/binSizing.ts';
import { sizingDetails, sizingFixture } from './binSizing.fixture.ts';

test('recorded full active cycles and completed physical receipts support an explicit 25% buffered increase', () => {
  const f = sizingFixture(); const before = structuredClone(f.state);
  const s = binSizingSuggestion(f.state, f.partId);
  assert.equal(s.status, 'increase'); assert.equal(s.target, 57);
  assert.equal(s.cycles.length, 3); assert.equal(s.purchases.length, 5); assert.equal(s.replenishments.length, 5);
  assert.deepEqual(s.cycles.map(c => c.days), [5, 5, 5]);
  assert.equal(s.fastestRate, 10); assert.equal(s.slowestReplenishmentDays, 4.5);
  assert.deepEqual(s.replenishments.map(r => [r.buyingDays, r.receiptDays, r.refillDays]), Array(5).fill([1, 3, .5]));
  assert.deepEqual(f.state, before);
});

test('minimum history gates recommendation and initial asserted stock is never a measured fill', () => {
  const f = sizingFixture(4); const s = binSizingSuggestion(f.state, f.partId);
  assert.equal(s.status, 'learning'); assert.equal(s.target, undefined); assert.equal(s.cycles.length, 2);
  assert.ok(s.missing.some(m => m.includes('3 full active cycles')));
  assert.ok(s.exclusions.some(e => e.reason === 'unknown_fill'));
});

test('sample, simulator, unknown provenance and legacy records never become recommendation evidence', () => {
  for (const mode of ['sample', 'simulator', 'unknown', 'legacy'] as const) {
    const f = sizingFixture();
    for (const e of f.state.events) if (e.partId === f.partId) {
      if (mode === 'sample') e.sample = true;
      if (mode === 'simulator') e.provenance = { source: 'simulator' };
      if (mode === 'unknown') delete e.provenance;
      if (mode === 'legacy') delete e.data;
    }
    const s = binSizingSuggestion(f.state, f.partId);
    assert.equal(s.status, 'learning', mode); assert.equal(s.target, undefined, mode); assert.equal(s.cycles.length, 0, mode);
  }
});

test('measurement edits start a fresh epoch while existing bins retain their physical states', () => {
  for (const change of [{ binQuantity: 57 }, { unit: 'items' }, { specification: 'M8' }]) {
    const f = sizingFixture(); const bins = structuredClone(f.part().bins);
    f.run({ type: 'edit_part', partId: f.partId, part: { ...sizingDetails, ...change } }, 26);
    const s = binSizingSuggestion(f.state, f.partId);
    assert.equal(s.status, 'learning'); assert.equal(s.cycles.length, 0); assert.equal(s.purchases.length, 0);
    assert.ok(s.epochAt); assert.deepEqual(f.part().bins, bins);
    assert.ok(s.exclusions.some(e => e.reason === 'before_measurement_change'));
  }
});

test('corrected requests and any active spans crossing a correction are excluded', () => {
  const f = sizingFixture(); const refill = f.state.events.find(e => e.partId === f.partId && e.kind === 'refill')!;
  f.run({ type: 'correct_refill', targetEventId: refill.id, reason: 'Fixture bins were not actually filled.', physicallyConfirmed: true, physicalOutcome: 'not_refilled' }, 25);
  const s = binSizingSuggestion(f.state, f.partId);
  assert.equal(s.replenishments.length, 4); assert.equal(s.purchases.length, 4);
  assert.ok(s.exclusions.some(e => e.reason === 'corrected_period'));
});

test('partial receipts, missing refill timing and carrier-delivered statuses do not supply complete replenishment evidence', () => {
  const f = sizingFixture();
  f.state.events = f.state.events.filter(e => e.partId !== f.partId || e.kind !== 'refill');
  for (const o of f.state.orders) o.delivery = { status: 'delivered', events: [] };
  const s = binSizingSuggestion(f.state, f.partId);
  assert.equal(s.status, 'learning'); assert.equal(s.replenishments.length, 0); assert.equal(s.target, undefined);
  const g = sizingFixture(); const last = g.state.orders.at(-1)!; last.received = 20;
  assert.equal(binSizingSuggestion(g.state, g.partId).purchases.length, 4);
});

test('no automatic decreases and open request blocks applying an otherwise eligible increase', () => {
  const f = sizingFixture();
  const latest = f.part().bins.find(b => b.status === 'in_use')!;
  f.run({ type: 'scan', binId: latest.id, cycle: latest.cycle }, 25, 'scanner');
  const s = binSizingSuggestion(f.state, f.partId);
  assert.equal(s.status, 'increase'); assert.equal(s.canApply, false); assert.match(s.applyBlocked!, /Close/);
  const g = sizingFixture(); g.part().binQuantity = 100;
  const same = binSizingSuggestion(g.state, g.partId);
  assert.equal(same.status, 'learning', 'unlogged current measurement mismatch cannot reuse old evidence');
  const adequate = binSizingSuggestion(sizingFixture(5, 6).state, sizingFixture(0).partId);
  assert.equal(adequate.status, 'learning', 'unknown part stays unavailable');
  const slow = sizingFixture(5, 6); const enough = binSizingSuggestion(slow.state, slow.partId);
  assert.equal(enough.status, 'adequate'); assert.equal(enough.target, 47); assert.equal(enough.canApply, false);
});

test('extended reserve waiting is excluded and legacy stock activity inside an active span invalidates that span', () => {
  const f = sizingFixture(5, 10); const s = binSizingSuggestion(f.state, f.partId);
  assert.deepEqual(s.cycles.map(c => c.days), [10, 10, 10]);
  const g = sizingFixture();
  g.state.events.push({ id: 'unknown-event', partId: g.partId, kind: 'scan', message: 'Unstructured stock change', at: '2026-08-08T12:00:00Z' });
  const mixed = binSizingSuggestion(g.state, g.partId);
  assert.equal(mixed.cycles.length, 2);
  assert.equal(mixed.status, 'learning');
});

test('a stockout gap never stretches a full-bin usage interval or supplies a negative refill delay', () => {
  const f = sizingFixture(0);
  const first = f.part().bins[0]; const second = f.part().bins[1];
  f.run({ type: 'scan', binId: first.id, cycle: first.cycle }, 0, 'scanner');
  f.run({ type: 'scan', binId: second.id, cycle: second.cycle }, 1, 'scanner');
  const requestId = f.state.requests.at(-1)!.id;
  f.run({ type: 'order', requestId, supplier: 'Fixture', reference: '', quantity: 100, eta: '' }, 2);
  const orderId = f.state.orders.at(-1)!.id;
  f.run({ type: 'receive', orderId, quantity: 50 }, 5);
  f.run({ type: 'refill', binId: first.id, cycle: first.cycle }, 6);
  f.run({ type: 'receive', orderId, quantity: 50 }, 7);
  f.run({ type: 'refill', binId: second.id, cycle: second.cycle }, 8);
  f.run({ type: 'scan', binId: first.id, cycle: f.part().bins[0].cycle }, 11, 'scanner');
  const s = binSizingSuggestion(f.state, f.partId);
  assert.equal(s.cycles[0].days, 5); assert.equal(s.cycles[0].rate, 10);
  assert.ok(s.exclusions.some(e => e.reason === 'stockout_gap'));
  assert.ok(s.replenishments.every(r => r.refillDays >= 0));
});

test('receipts that go backwards in time disqualify their purchase and replenishment path', () => {
  const f = sizingFixture(); const order = f.state.orders.at(-1)!;
  const partial = f.state.events.find(e => e.data?.orderId === order.id && e.kind === 'receive' && e.data.quantity === 20)!;
  partial.at = '2026-08-26T12:00:00Z';
  const s = binSizingSuggestion(f.state, f.partId);
  assert.equal(s.purchases.length, 4); assert.equal(s.replenishments.length, 4);
});

test('a later legacy catalog event is a fresh unknown measurement boundary even after structured edits', () => {
  const f = sizingFixture();
  const first = f.state.events.find(e => e.partId === f.partId && e.kind === 'catalog')!;
  const before = structuredClone(first.data!.after); const after = structuredClone(before);
  before.part!.unit = 'items';
  f.state.events.push({ ...structuredClone(first), id: 'earlier-measurement', at: '2026-07-31T18:00:00Z', data: { ...structuredClone(first.data!), revision: 2, actionType: 'edit_part', before, after } });
  f.state.events.unshift({ id: 'later-legacy-catalog', partId: f.partId, kind: 'catalog', message: 'Unknown old catalog edit', at: '2026-09-01T12:00:00Z' });
  const s = binSizingSuggestion(f.state, f.partId);
  assert.equal(s.epochAt, '2026-09-01T12:00:00Z'); assert.equal(s.status, 'learning'); assert.equal(s.target, undefined);
});
