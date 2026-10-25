import type { InventoryEvent, InventoryState, EventSnapshot, InventoryEventData, CommandProvenance } from './types.ts';

export const correctionKinds = ['scan', 'receive', 'refill'] as const;
export function isPracticeSource(provenance?: CommandProvenance) {
  return !provenance || !['buyer', 'scanner', 'phone'].includes(provenance.source) || !!provenance.sample;
}
export function eventSnapshot(state: InventoryState, partId: string, requestId?: string, orderId?: string): EventSnapshot {
  const part = state.parts.find(p => p.id === partId);
  const request = requestId ? state.requests.find(r => r.id === requestId) : state.requests.find(r => r.partId === partId && !r.closedAt);
  const order = orderId ? state.orders.find(o => o.id === orderId) : undefined;
  return structuredClone({
    part: part ? { sample: part.sample, practice: part.practice, capacity: part.binQuantity, unit: part.unit, specification: part.specification, bins: part.bins } : null,
    request: request ? { id: request.id, createdAt: request.createdAt, allocated: request.allocated, closedAt: request.closedAt, practice: request.practice, attention: request.attention } : null,
    ...(orderId && { order: order ? { id: order.id, createdAt: order.createdAt, quantity: order.quantity, received: order.received, status: order.status, voidedAt: order.voidedAt } : null }),
  });
}
export function sameMeasurement(a: EventSnapshot['part'], b: EventSnapshot['part']) {
  return !!a && !!b && a.capacity === b.capacity && a.unit === b.unit && a.specification === b.specification;
}
export function laterPartEvents(state: InventoryState, target: InventoryEvent) {
  const index = state.events.findIndex(e => e.id === target.id);
  return state.events.slice(0, index).filter(e => e.partId === target.partId && e.data?.commandId !== target.data?.commandId);
}
export interface CorrectionEligibility { eligible: boolean; reason: string; correctedBy?: string }
export function correctionEligibility(state: InventoryState, target: InventoryEvent): CorrectionEligibility {
  const reject = (reason: string): CorrectionEligibility => ({ eligible: false, reason });
  if (!correctionKinds.includes(target.kind as typeof correctionKinds[number])) return reject('This activity has no inventory correction.');
  const already = state.events.find(e => e.data?.correction?.targetEventId === target.id);
  if (already) return { eligible: false, reason: 'Already corrected. The original record is preserved.', correctedBy: already.id };
  const data = target.data;
  if (!data || data.version !== 1 || !data.before.part || !data.after.part || !data.requestId || !data.after.request) return reject('This older record has no reliable stock evidence. Check the physical inventory and use a physical recount.');
  const current = eventSnapshot(state, target.partId!, data.requestId, data.orderId);
  if (!sameMeasurement(data.after.part, current.part)) return reject('The part measurement changed. Check the physical inventory and use a physical recount.');
  for (const e of laterPartEvents(state, target)) {
    let dependency = '';
    if (e.kind === 'correction') dependency = 'correction';
    else if (e.kind === 'refill') dependency = 'refill';
    else if (e.kind === 'scan' && target.kind !== 'receive') dependency = 'scan';
    else if (e.kind === 'receive' && target.kind === 'receive' && (!e.data || e.data.orderId === data.orderId)) dependency = 'receipt';
    else if (e.kind === 'catalog' && (!e.data || !sameMeasurement(e.data.before.part, e.data.after.part))) dependency = 'measurement change';
    if (dependency) return reject(`A later ${dependency} depends on this record. Check the physical inventory and use a physical recount.`);
  }
  if (!current.request) return reject('The refill request is missing. Use a physical recount.');
  if (current.request.allocated !== data.after.request.allocated) return reject('The received stock was allocated later. Use a physical recount.');
  if (target.kind === 'receive') {
    if (!data.orderId || !data.before.order || !data.after.order || data.quantity === undefined || !current.order || current.order.voidedAt || current.order.received !== data.after.order.received) return reject('This receipt has changed or lacks reliable quantity evidence. Use a physical recount.');
  } else {
    if (!data.binId || target.kind === 'refill' && data.quantity === undefined || JSON.stringify(current.part!.bins) !== JSON.stringify(data.after.part.bins)) return reject('The physical bin cycle changed. Use a physical recount.');
  }
  return { eligible: true, reason: '' };
}
export type EventContext = Pick<InventoryEventData, 'binId' | 'requestId' | 'orderId' | 'quantity' | 'correction'>;
export function correctedAlertEpisodes(state: Pick<InventoryState, 'events'>) {
  return new Set(state.events.filter(e => e.data?.correction).map(e => e.data?.before.request?.attention?.id).filter((id): id is string => !!id));
}
