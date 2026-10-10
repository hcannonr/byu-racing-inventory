import { activeRequest, availableReceived, quantityToBuy, requestOrders, type InventoryState, type Part, type PurchaseOrder } from './types';

export type AttentionKind = 'out' | 'receipt' | 'overdue' | 'purchase' | 'refill';
export type AttentionAction =
  | { kind: 'purchase' }
  | { kind: 'receive'; orderId: string }
  | { kind: 'refill'; binId: string; cycle: number }
  | { kind: 'review' };
export interface AttentionReason {
  kind: AttentionKind;
  quantity?: number;
  orders?: PurchaseOrder[];
  date?: string;
}
export interface AttentionTask {
  part: Part;
  requestId?: string;
  reasons: AttentionReason[];
  action: AttentionAction;
  received: number;
  toBuy: number;
  critical: boolean;
}

function localDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// A buyer's YYYY-MM-DD is a calendar date. Carrier timestamps use the viewer's local day.
function calendarDate(value?: string): string | undefined {
  if (!value) return;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(year, month - 1, day);
    return localDay(date) === value ? value : undefined;
  }
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !calendarDate(value.slice(0, 10))) return;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? localDay(date) : undefined;
}

const priority: Record<AttentionKind, number> = { out: 0, receipt: 1, overdue: 2, purchase: 3, refill: 4 };

/** Today's buyer work, derived without changing carrier, receipt, or physical-bin state. */
export function attentionTasks(state: InventoryState, today = new Date()): AttentionTask[] {
  const tasks: AttentionTask[] = [];
  for (const part of state.parts) {
    const request = activeRequest(state, part.id);
    const emptyBins = part.bins.filter(bin => bin.status === 'empty');
    const critical = emptyBins.length === 2;
    const received = request ? availableReceived(state, request.id) : 0;
    const toBuy = quantityToBuy(state, part);
    const outstanding = request ? requestOrders(state, request.id).filter(order => order.received < order.quantity) : [];
    const delivered = outstanding.filter(order => order.delivery?.status === 'delivered');
    const overdue = outstanding.filter(order => order.delivery?.status !== 'delivered').flatMap(order => {
      const date = calendarDate(order.delivery?.eta) ?? calendarDate(order.eta);
      return date && date < localDay(today) ? [{ order, date }] : [];
    }).sort((a, b) => a.date.localeCompare(b.date));
    const reasons: AttentionReason[] = [];
    if (critical) reasons.push({ kind: 'out' });
    if (delivered.length) reasons.push({ kind: 'receipt', orders: delivered, quantity: delivered.reduce((sum, order) => sum + order.quantity - order.received, 0) });
    if (overdue.length) reasons.push({ kind: 'overdue', orders: overdue.map(item => item.order), date: overdue[0].date });
    if (toBuy > 0) reasons.push({ kind: 'purchase', quantity: toBuy });
    if (request && emptyBins.length && received >= part.binQuantity) reasons.push({ kind: 'refill', quantity: Math.min(emptyBins.length, Math.floor(received / part.binQuantity)) });
    if (!reasons.length) continue;
    const action: AttentionAction = reasons.some(reason => reason.kind === 'refill')
      ? { kind: 'refill', binId: emptyBins[0].id, cycle: emptyBins[0].cycle }
      : delivered.length ? { kind: 'receive', orderId: delivered[0].id }
      : toBuy > 0 ? { kind: 'purchase' } : { kind: 'review' };
    tasks.push({ part, requestId: request?.id, reasons, action, received, toBuy, critical });
  }
  return tasks.sort((a, b) => priority[a.reasons[0].kind] - priority[b.reasons[0].kind]
    || (a.reasons.find(reason => reason.kind === 'overdue')?.date ?? state.requests.find(request => request.id === a.requestId)?.createdAt ?? '')
      .localeCompare(b.reasons.find(reason => reason.kind === 'overdue')?.date ?? state.requests.find(request => request.id === b.requestId)?.createdAt ?? '')
    || a.part.name.localeCompare(b.part.name));
}
