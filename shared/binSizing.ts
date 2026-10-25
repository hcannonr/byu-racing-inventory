import { activeRequest, type EventSnapshot, type InventoryEvent, type InventoryEventData, type InventoryState } from './types';

export interface SizingCycle { binId: string; fillEventId: string; activationEventId: string; emptyEventId: string; quantity: number; start: string; end: string; days: number; rate: number }
export interface SizingPurchase { orderId: string; requestId: string; purchaseEventId: string; receiptEventId: string; start: string; end: string; days: number }
export interface SizingReplenishment { requestId: string; start: string; end: string; buyingDays: number; receiptDays: number; refillDays: number; days: number }
export type SizingExclusionReason = 'before_measurement_change' | 'legacy' | 'practice' | 'unknown_provenance' | 'corrected_period' | 'unknown_fill' | 'incomplete_cycle' | 'stockout_gap' | 'invalid_history' | 'incomplete_purchase' | 'incomplete_replenishment';
export interface SizingExclusion { reason: SizingExclusionReason; count: number }
export interface BinSizingSuggestion {
  partId: string; status: 'learning' | 'increase' | 'adequate'; currentTarget: number; target?: number;
  cycles: SizingCycle[]; purchases: SizingPurchase[]; replenishments: SizingReplenishment[];
  exclusions: SizingExclusion[]; missing: string[]; epochAt?: string;
  evidenceStart?: string; evidenceEnd?: string; fastestRate?: number; slowestReplenishmentDays?: number;
  canApply: boolean; applyBlocked?: string; buffer: number;
}

export function binSizingSuggestion(state: InventoryState, partId: string): BinSizingSuggestion {
  const part = state.parts.find(p => p.id === partId);
  const result: BinSizingSuggestion = { partId, status: 'learning', currentTarget: part?.binQuantity ?? 0, cycles: [], purchases: [], replenishments: [], exclusions: [], missing: [], canApply: false, buffer: .25 };
  const excluded = new Map<SizingExclusionReason, number>();
  const exclude = (reason: SizingExclusionReason, count = 1) => { if (count > 0) excluded.set(reason, (excluded.get(reason) ?? 0) + count); };
  const finish = () => { result.exclusions = [...excluded].map(([reason, count]) => ({ reason, count })); return result; };
  if (!part) { result.missing.push('This part is no longer in the catalog.'); return finish(); }
  const raw = state.events.filter(e => e.partId === partId).slice().reverse();
  // Revision orders equal timestamps deterministically. Array order only resolves companion events.
  const records = raw.map((event, index) => ({ event, index })).sort((a, b) =>
    (a.event.data?.revision ?? -1) - (b.event.data?.revision ?? -1) || a.index - b.index).map(item => item.event);
  const changedMeasurement = (e: InventoryEvent) => e.kind === 'catalog' && e.data?.before.part && e.data.after.part
    && measurement(e.data.before.part) !== measurement(e.data.after.part);
  const boundaries = records.filter(e => changedMeasurement(e) || e.kind === 'catalog' && !e.data);
  const structuredBoundary = boundaries.filter(e => e.data).at(-1);
  const legacyBoundary = boundaries.filter(e => !e.data).sort((a, b) => time(a.at) - time(b.at)).at(-1);
  // A later legacy edit has no revision. Its timestamp must still censor earlier measurements.
  const epoch = !structuredBoundary || legacyBoundary && time(legacyBoundary.at) >= time(structuredBoundary.at) ? legacyBoundary : structuredBoundary;
  if (boundaries.some(e => !Number.isFinite(time(e.at)))) result.missing.push('An undated measurement edit prevents linking this history. Start with newly verified workshop records.');
  const epochRevision = epoch?.data?.revision;
  if (epoch) result.epochAt = epoch.at;
  const afterEpoch = (e: InventoryEvent) => !epoch || (epochRevision !== undefined && e.data
    ? e.data.revision > epochRevision : time(e.at) > time(epoch.at));
  const correctedEvents = new Set(records.flatMap(e => e.data?.correction ? [e.data.correction.targetEventId] : []));
  const correctedRequests = new Set(records.flatMap(e => e.data?.correction && e.data.requestId ? [e.data.requestId] : []));
  const latest = records.filter(e => e.data?.after.part).at(-1)?.data?.after.part;
  if (latest && measurement(latest) !== measurement({ capacity: part.binQuantity, unit: part.unit, specification: part.specification })) {
    exclude('invalid_history'); result.missing.push('Current measurements do not match the recorded history. Start with a verified refill.'); return finish();
  }
  if (part.sample || part.practice !== false) result.missing.push('Real workshop records are needed. Sample, practice, and unknown stock are excluded.');
  const eligible = new Set<string>();
  for (const e of records) {
    if (!afterEpoch(e)) { exclude('before_measurement_change'); continue; }
    if (!e.data || e.data.version !== 1) { exclude('legacy'); continue; }
    if (correctedEvents.has(e.id) || e.data.correction || e.data.requestId && correctedRequests.has(e.data.requestId)) { exclude('corrected_period'); continue; }
    if (!e.provenance || !['buyer', 'scanner', 'phone'].includes(e.provenance.source)) { exclude(e.provenance ? 'practice' : 'unknown_provenance'); continue; }
    if (part.sample || part.practice !== false || e.sample !== false || e.provenance.sample || !clean(e.data.before) || !clean(e.data.after)) { exclude('practice'); continue; }
    if (!Number.isSafeInteger(e.data.revision) || e.data.revision < 1 || !e.data.commandId || !Number.isFinite(time(e.at))
      || !e.data.after.part || measurement(e.data.after.part) !== measurement({ capacity: part.binQuantity, unit: part.unit, specification: part.specification })) { exclude('invalid_history'); continue; }
    eligible.add(e.id);
  }
  interface Fill { event: InventoryEvent; quantity: number; cycle: number; status: string; activation?: InventoryEvent }
  const ambiguousSpan = (start: InventoryEvent, end: InventoryEvent) => records.some(e =>
    ['scan', 'refill', 'correction', 'catalog', 'receive', 'order'].includes(e.kind) && !eligible.has(e.id)
    && (e.data && start.data && end.data
      ? e.data.revision > start.data.revision && e.data.revision <= end.data.revision
      : !Number.isFinite(time(e.at)) || time(e.at) >= time(start.at) && time(e.at) <= time(end.at)));
  const fills = new Map<string, Fill>();
  for (const e of records) {
    if (!['scan', 'refill', 'correction', 'catalog'].includes(e.kind)) continue;
    const d = e.data;
    if (!eligible.has(e.id) || !d?.before.part || !d.after.part) { fills.clear(); continue; }
    if (e.kind === 'catalog') continue;
    const before = d.before.part.bins;
    const after = d.after.part.bins;
    for (const [binId, fill] of fills) {
      const b = before.find(bin => bin.id === binId);
      if (!b || b.cycle !== fill.cycle || b.status !== fill.status) { exclude('invalid_history'); fills.delete(binId); }
    }
    if (e.kind === 'refill') {
      const old = before.find(b => b.id === d.binId); const bin = after.find(b => b.id === d.binId);
      if (!old || !bin || old.status !== 'empty' || !['ready', 'in_use'].includes(bin.status) || bin.cycle !== old.cycle + 1
        || !Number.isSafeInteger(d.quantity) || d.quantity! <= 0 || d.quantity !== d.after.part.capacity
        || !d.before.request || !d.after.request || d.after.request.allocated - d.before.request.allocated !== d.quantity) { exclude('invalid_history'); fills.clear(); continue; }
      fills.set(bin.id, { event: e, quantity: d.quantity, cycle: bin.cycle, status: bin.status, ...(bin.status === 'in_use' && { activation: e }) });
    } else if (e.kind === 'scan') {
      const old = before.find(b => b.id === d.binId); const bin = after.find(b => b.id === d.binId);
      const fill = d.binId ? fills.get(d.binId) : undefined;
      if (old?.status === 'in_use' && bin?.status === 'empty' && old.cycle === bin.cycle && fill?.activation) {
        const days = (time(e.at) - time(fill.activation.at)) / DAY;
        if (days > 0 && Number.isFinite(days) && !ambiguousSpan(fill.event, e)) result.cycles.push({ binId: bin.id, fillEventId: fill.event.id, activationEventId: fill.activation.id, emptyEventId: e.id,
          quantity: fill.quantity, start: fill.activation.at, end: e.at, days, rate: fill.quantity / days });
        else exclude('invalid_history');
      } else exclude('unknown_fill');
      if (d.binId) fills.delete(d.binId);
      // Only an explicit ready→in_use transition activates a known full reserve bin.
      for (const b of after) {
        const oldBin = before.find(candidate => candidate.id === b.id); const known = fills.get(b.id);
        if (oldBin?.status === 'ready' && b.status === 'in_use' && oldBin.cycle === b.cycle && known) { known.activation = e; known.status = 'in_use'; }
      }
      if (after.every(b => b.status === 'empty')) exclude('stockout_gap');
    }
  }
  exclude('incomplete_cycle', fills.size);
  for (const order of state.orders.filter(o => state.requests.some(r => r.id === o.requestId && r.partId === partId))) {
    const events = records.filter(e => e.data?.orderId === order.id);
    const created = events.find(e => e.kind === 'order' && eligible.has(e.id));
    const receipts = events.filter(e => e.kind === 'receive');
    if (!created || !receipts.length || order.voidedAt || order.received !== order.quantity || order.status !== 'arrived' || receipts.some(e => !eligible.has(e.id))) { exclude('incomplete_purchase'); continue; }
    const start = created.data!.after.order;
    let cumulative = 0; let previousAt = time(created.at);
    let valid = !!start && start.id === order.id && start.createdAt === created.at && start.quantity === order.quantity && start.received === 0;
    for (const receipt of receipts) {
      const d = receipt.data!; const previous = d.before.order; const next = d.after.order;
      valid = valid && !!previous && !!next && previous.id === order.id && next.id === order.id && previous.received === cumulative
        && next.quantity === order.quantity && previous.quantity === order.quantity && Number.isSafeInteger(d.quantity) && d.quantity! > 0
        && next.received === cumulative + d.quantity! && time(receipt.at) >= previousAt;
      cumulative += d.quantity ?? 0;
      previousAt = time(receipt.at);
    }
    const completed = receipts.at(-1)!;
    const days = (time(completed.at) - time(created.at)) / DAY;
    if (!valid || cumulative !== order.quantity || !Number.isFinite(days) || days <= 0) { exclude('invalid_history'); continue; }
    result.purchases.push({ orderId: order.id, requestId: order.requestId, purchaseEventId: created.id, receiptEventId: completed.id, start: created.at, end: completed.at, days });
  }
  for (const request of state.requests.filter(r => r.partId === partId)) {
    const events = records.filter(e => e.data?.requestId === request.id && e.kind !== 'closed');
    const stockEvents = events.filter(e => ['scan', 'order', 'receive', 'refill', 'correction', 'undo_purchase'].includes(e.kind));
    const scan = events.find(e => e.kind === 'scan' && e.data?.before.request === null && e.data.after.request?.createdAt === e.at);
    const orders = state.orders.filter(o => o.requestId === request.id);
    const purchases = result.purchases.filter(p => p.requestId === request.id);
    const refills = events.filter(e => e.kind === 'refill');
    if (!request.closedAt || request.practice !== false || !scan || !orders.length || purchases.length !== orders.length || !refills.length
      || stockEvents.some(e => !eligible.has(e.id)) || refills.reduce((n, e) => n + (e.data?.quantity ?? 0), 0) !== request.allocated) { exclude('incomplete_replenishment'); continue; }
    const bought = Math.min(...purchases.map(p => time(p.start)));
    const received = Math.max(...purchases.map(p => time(p.end)));
    const refilled = time(refills.at(-1)!.at);
    const started = time(scan.at);
    // If refill preceded final receipt, this history cannot measure receipt→refill delay.
    if (!(bought >= started && received > bought && refilled >= received && time(request.closedAt) >= refilled)
      || ambiguousSpan(scan, refills.at(-1)!)) { exclude('incomplete_replenishment'); continue; }
    result.replenishments.push({ requestId: request.id, start: scan.at, end: refills.at(-1)!.at,
      buyingDays: (bought - started) / DAY, receiptDays: (received - bought) / DAY, refillDays: (refilled - received) / DAY, days: (refilled - started) / DAY });
  }
  if (result.cycles.length < 3) result.missing.push(`Need 3 full active cycles; ${result.cycles.length} eligible so far.`);
  if (result.purchases.length < 3) result.missing.push(`Need 3 complete purchase histories; ${result.purchases.length} eligible so far.`);
  if (!result.replenishments.length) result.missing.push('Need a complete empty-scan → purchase → final receipt → physical refill timeline.');
  if (result.missing.length) return finish();
  result.fastestRate = Math.max(...result.cycles.map(c => c.rate));
  result.slowestReplenishmentDays = Math.max(...result.replenishments.map(r => r.days));
  const target = Math.ceil(result.fastestRate * result.slowestReplenishmentDays * (1 + result.buffer));
  if (!Number.isSafeInteger(target) || target > 1000000 || target < 1) { result.missing.push('Calculated target is outside the supported 1–1,000,000 units. Review the history and physical bin size.'); return finish(); }
  result.target = target;
  result.status = target > part.binQuantity ? 'increase' : 'adequate';
  const observed = [...result.cycles.flatMap(c => [c.start, c.end]), ...result.purchases.flatMap(p => [p.start, p.end]), ...result.replenishments.flatMap(r => [r.start, r.end])].sort();
  result.evidenceStart = observed[0]; result.evidenceEnd = observed.at(-1);
  result.applyBlocked = activeRequest(state, partId) ? 'Close the active refill request before changing the future target.' : undefined;
  result.canApply = result.status === 'increase' && !result.applyBlocked;
  return finish();
}

const DAY = 86400000;
function measurement(part: Pick<NonNullable<EventSnapshot['part']>, 'capacity' | 'unit' | 'specification'>) { return JSON.stringify([part.capacity, part.unit, part.specification]); }
function clean(snapshot: EventSnapshot) {
  return (!snapshot.part || !snapshot.part.sample && snapshot.part.practice === false)
    && (!snapshot.request || snapshot.request.practice === false && !snapshot.request.attention?.sample);
}
function time(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value)) return NaN;
  const day = value.slice(0, 10); const checked = new Date(`${day}T12:00:00Z`);
  if (!Number.isFinite(checked.getTime()) || checked.toISOString().slice(0, 10) !== day) return NaN;
  return Date.parse(value);
}
