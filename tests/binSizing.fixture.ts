import { randomUUID } from 'node:crypto';
import { applyCommand } from '../server/domain.ts';
import { seedState } from '../server/seed.ts';
import type { Action, CommandSource, PartInput } from '../shared/types.ts';

export const sizingDetails: PartInput = { name: 'Verified M6 bolts', specification: 'M6 × 20 mm · verified fixture', category: 'Fasteners', location: 'VERIFIED-01', supplier: 'Fixture supplier', supplierUrl: '', binQuantity: 50, unit: 'pieces', purchasePack: { size: 25, priceCents: 499 } };

/** Synthetic operational records, never workshop evidence. Dates are deliberately explicit. */
export function sizingFixture(rounds = 5, intervalDays = 5, details = sizingDetails) {
  let state = seedState();
  const origin = Date.parse('2026-08-01T12:00:00Z');
  function run(action: Action, day: number, source: CommandSource = 'buyer') {
    state = applyCommand(state, { eventId: randomUUID(), expectedRevision: state.revision, provenance: { source }, action }, new Date(origin + day * 86400000).toISOString()).state;
    return state.events[0];
  }
  run({ type: 'add_part', part: details }, -1);
  const partId = state.parts.at(-1)!.id;
  const part = () => state.parts.find(p => p.id === partId)!;
  for (let index = 0; index < rounds; index++) {
    const day = index * intervalDays;
    const bin = part().bins[index % 2];
    run({ type: 'scan', binId: bin.id, cycle: bin.cycle }, day, 'scanner');
    const requestId = state.requests.at(-1)!.id;
    run({ type: 'order', requestId, supplier: 'Fixture supplier', reference: `FIXTURE-${index + 1}`, quantity: 50, eta: '' }, day + 1);
    const orderId = state.orders.at(-1)!.id;
    run({ type: 'receive', orderId, quantity: 20 }, day + 3);
    run({ type: 'receive', orderId, quantity: 30 }, day + 4);
    run({ type: 'refill', binId: bin.id, cycle: bin.cycle }, day + 4.5);
  }
  return { get state() { return state; }, partId, part, run };
}
