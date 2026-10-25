import { randomUUID } from 'node:crypto';
import { activeRequest, availableReceived, requestOrders, type Command, type CommandResult, type InventoryState, type RefillRequest } from '../shared/types.ts';
import { seedState } from './seed.ts';
import { inventoryCategories } from '../shared/organization.ts';
import { correctionEligibility, eventSnapshot, isPracticeSource, laterPartEvents, type EventContext } from '../shared/corrections.ts';
import type { ImportSession } from '../shared/orderImport.ts';
export class DomainError extends Error { constructor(message: string, public status = 400) { super(message); } }
export function applyCommand(original: InventoryState, command: Command, now = new Date().toISOString(), importSession?: ImportSession): CommandResult {
  const state = structuredClone(original);
  const a = command.action;
  const provenance = command.provenance ?? { source: 'demo' as const };
  const practice = ['demo', 'seed', 'simulator'].includes(provenance.source) || !!provenance.sample;
  const noChange = (message: string): CommandResult => ({ state: original, changed: false, message });
  const createdEvents: string[] = [];
  function event(partId: string | null, kind: string, message: string, context: EventContext = {}) {
    const part = state.parts.find(p => p.id === partId);
    const requestId = context.requestId ?? state.requests.find(r => r.partId === partId && !r.closedAt)?.id;
    const before = partId ? eventSnapshot(original, partId, requestId, context.orderId) : null;
    const id = randomUUID(); createdEvents.push(id);
    state.events.unshift({ id, partId, kind, message, at: now, provenance,
      sample: practice || !!part?.sample || !!part && part.practice !== false || !!state.requests.find(r => r.id === requestId)?.practice,
      ...(partId && before && { data: { version: 1, commandId: command.eventId, revision: original.revision + 1, actionType: a.type,
        ...context, ...(requestId && { requestId }), before, after: eventSnapshot(state, partId, requestId, context.orderId) } }),
    });
  }
  function binInfo(binId: string) {
    const part = state.parts.find(p => p.bins.some(b => b.id === binId));
    if (!part) throw new DomainError('Unknown bin code. Check the label and try again.', 404);
    return { part, bin: part.bins.find(b => b.id === binId)! };
  }
  function openRequest(id: string) {
    const r = state.requests.find(r => r.id === id && !r.closedAt);
    if (!r) throw new DomainError('This refill request is no longer open.', 409);
    markPractice(r);
    return r;
  }
  function markPractice(r: RefillRequest) {
    if (practice) {
      r.practice = true; if (r.attention) r.attention.sample = true;
      const part = state.parts.find(p => p.id === r.partId); if (part) part.practice = true;
    }
  }
  function closeIfComplete(r: RefillRequest, correction = false) {
    const part = state.parts.find(p => p.id === r.partId)!;
    const orders = requestOrders(state, r.id);
    if (part.bins.every(b => b.status !== 'empty') && orders.every(o => o.received === o.quantity)) {
      r.closedAt = now;
      event(part.id, 'closed', correction ? 'Correction complete. Both bins available; request closed.' : 'Refill complete. Both bins available; request closed.', { requestId: r.id });
    }
  }
  let message = '';
  function registerCategory(name: string): string {
    const names = inventoryCategories(state);
    const existing = names.find(value => value.toLowerCase() === name.toLowerCase());
    if (!existing && names.length >= 100) throw new DomainError('Use up to 100 categories.');
    state.categories = existing ? names : [...names, name];
    return existing ?? name;
  }
  switch (a.type) {
    case 'correct_scan':
    case 'correct_receipt':
    case 'correct_refill': {
      if (command.expectedRevision === undefined) throw new DomainError('Inventory correction requires a revision.');
      const target = state.events.find(e => e.id === a.targetEventId);
      if (!target) throw new DomainError('Inventory activity not found.', 404);
      const expectedKind = a.type === 'correct_scan' ? 'scan' : a.type === 'correct_receipt' ? 'receive' : 'refill';
      if (target.kind !== expectedKind) throw new DomainError('Choose the matching inventory correction.', 409);
      const eligibility = correctionEligibility(state, target);
      if (eligibility.correctedBy) return noChange('This activity is already corrected.');
      if (!eligibility.eligible) throw new DomainError(eligibility.reason, 409);
      const data = target.data!;
      const part = state.parts.find(p => p.id === target.partId)!;
      const r = state.requests.find(r => r.id === data.requestId)!;
      const open = activeRequest(state, part.id);
      if (open && open.id !== r.id) throw new DomainError('A later refill request depends on this stock. Use a physical recount.', 409);
      const correction = { targetEventId: target.id, reason: a.reason,
        operation: a.type === 'correct_scan' ? 'undo_scan' as const : a.type === 'correct_receipt' ? 'set_receipt_quantity' as const : 'undo_refill' as const,
        ...(a.type === 'correct_receipt' && { correctedQuantity: a.quantity }),
        ...(a.type === 'correct_refill' && { physicalOutcome: a.physicalOutcome }),
      };
      let quantity: number | undefined;
      if (a.type === 'correct_receipt') {
        const order = state.orders.find(o => o.id === data.orderId)!;
        quantity = a.quantity - data.quantity!;
        const total = order.received + quantity;
        if (total < 0 || total > order.quantity) throw new DomainError('Corrected receipt exceeds the order quantity.');
        if (availableReceived(state, r.id) + quantity < 0) throw new DomainError('This would make loose stock negative. Use a physical recount.', 409);
        order.received = total;
        if (total === order.quantity) order.status = 'arrived';
        else if (order.status === 'arrived') order.status = data.before.order!.status === 'in_transit' ? 'in_transit' : 'ordered';
        message = `Receipt corrected from ${data.quantity} to ${a.quantity} ${data.after.part!.unit}. ${total} / ${order.quantity} received.`;
      } else {
        if (a.type === 'correct_refill') {
          quantity = -data.quantity!;
          if (r.allocated < data.quantity!) throw new DomainError('This allocation no longer matches the refill. Use a physical recount.', 409);
          r.allocated -= data.quantity!;
        }
        for (const bin of part.bins) {
          const prior = data.before.part!.bins.find(b => b.id === bin.id)!;
          if (bin.id === data.binId || bin.status !== prior.status) { bin.status = prior.status; bin.cycle++; }
        }
        message = a.type === 'correct_scan' ? `${data.binId}: accidental empty scan corrected. Prior bin roles restored.` : `${data.binId}: refill reversed. ${data.quantity} ${data.after.part!.unit} returned to loose stock.`;
      }
      // Clearing practice requires clean prior evidence and an operational physical confirmation.
      // Later buyer receipts remain valid; a later direct practice mutation cannot be cleared here.
      const practiceActions = ['scan', 'receive', 'refill', 'order', 'order_batch', 'undo_purchase', 'acknowledge', 'ship', 'correct_scan', 'correct_receipt', 'correct_refill'];
      const clean = data.before.part!.practice === false && !data.before.part!.sample && !isPracticeSource(provenance)
        && (!data.before.request || data.before.request.practice === false)
        && !laterPartEvents(state, target).some(e => !e.data || practiceActions.includes(e.data.actionType) && isPracticeSource(e.provenance));
      part.practice = clean ? false : part.practice !== false || practice || part.sample;
      r.practice = clean ? false : r.practice !== false || part.practice;
      r.closedAt = null;
      delete r.attention;
      if (part.bins.some(b => b.status === 'empty')) {
        r.attention = { id: randomUUID(), source: provenance.source, sample: part.sample || part.practice || r.practice,
          urgent: part.bins.every(b => b.status === 'empty'), createdAt: now };
        r.acknowledged = false;
      }
      if (availableReceived(state, r.id) < 0 || part.bins.filter(b => b.status === 'in_use').length !== (part.bins.some(b => b.status !== 'empty') ? 1 : 0)) throw new DomainError('Correction would leave inconsistent physical inventory. Use a physical recount.', 409);
      event(part.id, 'correction', `${message} Reason: ${a.reason}`, { binId: data.binId, requestId: r.id, orderId: data.orderId, quantity, correction });
      closeIfComplete(r, true);
      break;
    }
    case 'attach_photo': {
      const part = state.parts.find(p => p.id === a.partId);
      if (!part) throw new DomainError('Part not found.', 404);
      part.photoId = a.photoId;
      message = 'Part photo saved.'; event(part.id, 'photo', message); break;
    }
    case 'remove_photo': {
      const part = state.parts.find(p => p.id === a.partId);
      if (!part) throw new DomainError('Part not found.', 404);
      if (!part.photoId) return noChange('This part has no photo.');
      delete part.photoId;
      message = 'Part photo removed.'; event(part.id, 'photo', message); break;
    }
    case 'save_categories': {
      for (const assignment of a.assignments) {
        const part = state.parts.find(part => part.id === assignment.partId);
        if (!part) throw new DomainError('Part not found. Refresh categories and try again.', 409);
        if (!a.categories.includes(assignment.category)) throw new DomainError('Choose an existing category for each part.');
        part.category = assignment.category;
      }
      if (state.parts.some(part => !a.categories.includes(part.category))) throw new DomainError('Assign every part before removing its category.');
      state.categories = a.categories;
      message = 'Categories saved.'; event(null, 'catalog', message); break;
    }
    case 'save_cabinet_map': {
      const known = new Set(state.parts.map(p => p.location));
      for (const location of a.map.drawers.flatMap(d => d.compartments).flatMap(c => c.locations)) {
        if (!known.has(location)) throw new DomainError(`Unknown cabinet location: ${location}.`);
      }
      state.cabinetMap = a.map;
      message = 'Cabinet diagram saved.'; event(null, 'cabinet', message); break;
    }
    case 'scan': {
      const { part, bin } = binInfo(a.binId);
      if (bin.cycle !== a.cycle) throw new DomainError('This scan belongs to an older refill cycle. Refresh before scanning again.', 409);
      if (bin.status === 'empty') return noChange('Already empty. No duplicate refill request created.');
      part.practice = part.practice !== false || practice || part.sample;
      bin.status = 'empty';
      const other = part.bins.find(b => b.id !== bin.id)!;
      if (other.status === 'ready') other.status = 'in_use';
      let request = activeRequest(state, part.id);
      if (!request) {
        request = { id: randomUUID(), partId: part.id, createdAt: now, closedAt: null, allocated: 0, acknowledged: false, practice: part.practice };
        state.requests.push(request);
      }
      const urgent = other.status === 'empty';
      // A practice or unknown legacy request cannot become live just because a later command is operational.
      request.practice = request.practice === undefined || request.practice || part.practice;
      const episode = { id: randomUUID(), source: provenance.source, sample: request.practice, urgent, createdAt: now };
      request.attention = episode;
      request.acknowledged = false;
      message = urgent ? `${part.name}: both bins empty. Existing request is now urgent.` : `${part.name}: bin marked empty. Refill requested.`;
      state.alerts.push({ id: randomUUID(), requestId: request.id, partId: part.id, title: `${urgent ? 'Out of stock' : 'Refill needed'} · ${part.name}`,
        body: `${bin.id} is empty. ${urgent ? 'Both bins need replenishment.' : 'Use the other bin.'} Target per bin: ${part.binQuantity} ${part.unit}. Supplier: ${part.supplier || 'Not assigned'}.`, createdAt: now, read: false, delivery: 'preview', provenance, sample: episode.sample, episodeId: episode.id, kind: urgent ? 'escalation' : 'initial' });
      event(part.id, 'scan', message, { binId: bin.id, requestId: request.id });
      break;
    }
    case 'order': {
      const r = openRequest(a.requestId);
      state.orders.push({ id: randomUUID(), requestId: r.id, supplier: a.supplier, reference: a.reference, quantity: a.quantity, received: 0, eta: a.eta, createdAt: now, status: 'ordered', ...(a.purchasePack && { purchasePack: structuredClone(a.purchasePack) }) });
      r.acknowledged = true;
      message = `Order recorded: ${a.quantity} units from ${a.supplier}.`;
      event(r.partId, 'order', message, { requestId: r.id, orderId: state.orders.at(-1)!.id, quantity: a.quantity });
      break;
    }
    case 'order_batch': {
      if (command.expectedRevision === undefined) throw new DomainError('Supplier checkout requires an inventory revision.');
      if (a.orderImport && !importSession) throw new DomainError('Use a validated order-import review.');
      const requests = a.lines.map(line => openRequest(line.requestId));
      const purchaseGroupId = randomUUID();
      a.lines.forEach((line, index) => {
        const request = requests[index];
        state.orders.push({ id: randomUUID(), requestId: request.id, supplier: a.supplier, reference: a.reference,
          quantity: line.quantity, received: 0, eta: a.eta, createdAt: now, status: 'ordered', purchaseGroupId,
          ...(line.purchasePack && { purchasePack: structuredClone(line.purchasePack) }),
          ...(importSession && line.importLine && { orderImport: { id: importSession.id, sourceHash: importSession.sourceHash, sourceKind: importSession.sourceKind, model: importSession.model,
            sourceLineIds: [...line.importLine.sourceLineIds], prices: structuredClone(line.importLine.prices) } }) });
        request.acknowledged = true;
        event(request.partId, 'order', `Checkout recorded: ${line.quantity} units from ${a.supplier}${a.reference ? ` (${a.reference})` : ''}.`, { requestId: request.id, orderId: state.orders.at(-1)!.id, quantity: line.quantity });
      });
      message = `Checkout recorded: ${a.lines.length} ${a.lines.length === 1 ? 'part' : 'parts'} from ${a.supplier}.`;
      break;
    }
    case 'undo_purchase': {
      const order = state.orders.find(o => o.id === a.orderId);
      if (!order) throw new DomainError('Order not found.', 404);
      if (order.voidedAt) return noChange('Purchase already undone.');
      if (order.received > 0) throw new DomainError('This purchase has received parts and cannot be undone.');
      const r = openRequest(order.requestId);
      order.voidedAt = now;
      if (r.attention) { r.attention.snoozedUntil = undefined; r.acknowledged = false; }
      message = `Purchase undone: ${order.quantity} units from ${order.supplier}. Supplier order is unchanged.`;
      event(r.partId, 'undo_purchase', message, { requestId: r.id, orderId: order.id, quantity: order.quantity });
      closeIfComplete(r);
      break;
    }
    case 'save_tracking': {
      const order = state.orders.find(o => o.id === a.orderId);
      if (!order) throw new DomainError('Order not found.', 404);
      if (order.voidedAt) throw new DomainError('This purchase was undone. Record a new purchase before updating it.', 409);
      if (JSON.stringify(order.tracking) === JSON.stringify(a.tracking)) return noChange('Tracking details already saved.');
      order.tracking = a.tracking;
      message = a.tracking.live ? 'Tracking saved. Checking with Ship24.' : 'Tracking link saved.';
      event(state.requests.find(r => r.id === order.requestId)!.partId, 'tracking', `Tracking details saved for ${order.supplier}: ${a.tracking.carrier} ${a.tracking.number}.`, { requestId: order.requestId, orderId: order.id });
      break;
    }
    case 'ship': {
      const order = state.orders.find(o => o.id === a.orderId);
      if (!order) throw new DomainError('Order not found.', 404);
      if (order.voidedAt) throw new DomainError('This purchase was undone. Record a new purchase before updating it.', 409);
      openRequest(order.requestId);
      if (order.received === order.quantity) throw new DomainError('This order has already arrived.');
      if (order.status === 'in_transit') return noChange('Order already marked in transit.');
      order.status = 'in_transit'; message = 'Order marked in transit. Bins stay unchanged.';
      event(state.requests.find(r => r.id === order.requestId)!.partId, 'ship', message, { requestId: order.requestId, orderId: order.id });
      break;
    }
    case 'receive': {
      const order = state.orders.find(o => o.id === a.orderId);
      if (!order) throw new DomainError('Order not found.', 404);
      if (order.voidedAt) throw new DomainError('This purchase was undone. Record a new purchase before updating it.', 409);
      const r = openRequest(order.requestId);
      if (a.quantity > order.quantity - order.received) throw new DomainError('Receipt exceeds the remaining order quantity.');
      order.received += a.quantity;
      if (order.received === order.quantity) order.status = 'arrived';
      message = `Received ${a.quantity} units. Confirm physical refill separately.`;
      event(r.partId, 'receive', message, { requestId: r.id, orderId: order.id, quantity: a.quantity }); closeIfComplete(r);
      break;
    }
    case 'refill': {
      const { part, bin } = binInfo(a.binId);
      if (bin.cycle !== a.cycle) throw new DomainError('This bin changed refill cycle. Check its physical state and open a new confirmation.', 409);
      if (bin.status !== 'empty') throw new DomainError('Only an empty bin can be refilled.');
      const r = activeRequest(state, part.id);
      if (!r || availableReceived(state, r.id) < part.binQuantity) throw new DomainError(`Not enough received units. Receive at least ${part.binQuantity} unallocated ${part.unit} before refilling this bin.`);
      markPractice(r);
      r.allocated += part.binQuantity;
      bin.status = part.bins.some(b => b.id !== bin.id && b.status === 'in_use') ? 'ready' : 'in_use';
      bin.cycle++;
      message = `${bin.id} refilled with ${part.binQuantity} ${part.unit}.`;
      event(part.id, 'refill', message, { requestId: r.id, binId: bin.id, quantity: part.binQuantity }); closeIfComplete(r);
      break;
    }
    case 'acknowledge': {
      const r = openRequest(a.requestId);
      if (r.attention?.snoozedUntil && r.attention.snoozedUntil > now) return noChange('Reminders already snoozed for this attention episode.');
      if (!r.attention && r.acknowledged) return noChange('Request already acknowledged.');
      if (r.attention) r.attention.snoozedUntil = new Date(Date.parse(now) + 86400000).toISOString();
      r.acknowledged = true; message = 'Request acknowledged. Reminders snoozed for one day.'; event(r.partId, 'acknowledge', message); break;
    }
    case 'read_alert': {
      const alert = state.alerts.find(n => n.id === a.alertId);
      if (!alert) throw new DomainError('Alert not found.', 404);
      if (alert.read) return noChange('Alert already read.');
      alert.read = true; message = 'Alert marked read.'; break;
    }
    case 'delete_part': {
      if (command.expectedRevision === undefined) throw new DomainError('Deleting a part requires the current inventory revision.');
      const part = state.parts.find(p => p.id === a.partId);
      if (!part) return noChange('Part already removed.');
      state.archivedParts = [...(state.archivedParts ?? []), part];
      state.parts = state.parts.filter(p => p.id !== part.id);
      for (const request of state.requests) if (request.partId === part.id && !request.closedAt) request.closedAt = now;
      state.alerts = state.alerts.filter(alert => alert.partId !== part.id);
      for (const drawer of state.cabinetMap?.drawers ?? []) for (const compartment of drawer.compartments) compartment.locations = compartment.locations.filter(location => location !== part.location);
      message = `${part.name} removed. Its labels are retired; purchase records are retained.`;
      event(null, 'catalog', message); break;
    }
    case 'add_part': {
      if (state.parts.some(p => p.location === a.part.location)) throw new DomainError('This location is already assigned to another part.');
      const id = randomUUID();
      const binCode = `BIN-${id.replaceAll('-', '').toUpperCase()}`;
      const { purchasePack, ...details } = a.part;
      details.category = registerCategory(details.category);
      state.parts.push({ ...details, ...(purchasePack && { purchasePack }), id, sample: false, practice, bins: [
        { id: `${binCode}-1`, status: 'in_use', cycle: 0 },
        { id: `${binCode}-2`, status: 'ready', cycle: 0 },
      ] });
      message = `${a.part.name} added with two stocked bins.`; event(id, 'catalog', message); break;
    }
    case 'edit_part': {
      const p = state.parts.find(p => p.id === a.partId);
      if (!p) throw new DomainError('Part not found.', 404);
      if (a.part.location !== p.location) throw new DomainError('Location cannot change after bin IDs are assigned.');
      if (activeRequest(state, p.id) && a.part.binQuantity !== p.binQuantity) throw new DomainError('Close the active refill request before changing bin capacity.');
      const { purchasePack, ...details } = a.part;
      details.category = registerCategory(details.category);
      Object.assign(p, details);
      if (purchasePack === null) delete p.purchasePack;
      else if (purchasePack) p.purchasePack = structuredClone(purchasePack);
      message = 'Part details saved.'; event(p.id, 'catalog', message); break;
    }
    case 'reset': {
      const clean = seedState(); clean.revision = state.revision + 1;
      event(null, 'reset', 'Test inventory reset. All example bins are stocked.');
      clean.events = [state.events[0]];
      // Keep cycle generations increasing, so pre-reset scanner retries cannot affect new state.
      for (const part of clean.parts) for (const bin of part.bins) {
        const previous = state.parts.flatMap(p => p.bins).find(b => b.id === bin.id);
        bin.cycle = (previous?.cycle ?? 0) + 1;
      }
      return { state: clean, changed: true, message: 'Test inventory reset. All example bins are stocked.' };
    }
  }
  state.revision++;
  for (const record of state.events) if (createdEvents.includes(record.id) && record.data && record.partId) {
    record.data.after = eventSnapshot(state, record.partId, record.data.requestId, record.data.orderId);
  }
  return { state, changed: true, message };
}
