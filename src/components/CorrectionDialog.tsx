import { useState, type FormEvent } from 'react';
import { RotateCcw } from 'lucide-react';
import { correctionEligibility, correctionKinds } from '../../shared/corrections';
import type { CorrectionAction, InventoryEvent, InventoryState } from '../../shared/types';
import { Dialog } from './Dialog';

export function correctionLabel(event: InventoryEvent) {
  return event.kind === 'scan' ? 'Correct scan' : event.kind === 'receive' ? 'Correct receipt' : 'Undo refill';
}
export function CorrectionControl({ event, state, busy, onReview }: { event: InventoryEvent; state: InventoryState; busy: boolean; onReview: (event: InventoryEvent) => void }) {
  if (!correctionKinds.includes(event.kind as typeof correctionKinds[number])) return null;
  const eligibility = correctionEligibility(state, event);
  return eligibility.correctedBy ? <span className="correction-tag">Corrected</span> : <button className="text-button correction-link" disabled={busy} onClick={() => onReview(event)}><RotateCcw size={13} />{correctionLabel(event)}</button>;
}

const binLabels = { in_use: 'In use', ready: 'Reserve', empty: 'Empty' };
export function CorrectionDialog({ event, state, reviewRevision, busy, onClose, onRefresh, onSave }: { event: InventoryEvent; state: InventoryState; reviewRevision: number; busy: boolean; onClose: () => void; onRefresh: () => void; onSave: (action: CorrectionAction) => Promise<boolean> }) {
  const [reason, setReason] = useState('');
  const [quantity, setQuantity] = useState(String(event.data?.quantity ?? 0));
  const [physical, setPhysical] = useState(false);
  const [outcome, setOutcome] = useState<'not_refilled' | 'returned_unused'>('not_refilled');
  const eligibility = correctionEligibility(state, event);
  const part = state.parts.find(p => p.id === event.partId);
  const data = event.data;
  const unit = data?.after.part?.unit ?? part?.unit ?? 'units';
  const order = state.orders.find(o => o.id === data?.orderId);
  const max = order ? order.quantity - order.received + (data?.quantity ?? 0) : 1000000;
  const validQuantity = /^\d+$/.test(quantity) && Number.isSafeInteger(Number(quantity)) && Number(quantity) <= max;
  const stale = reviewRevision !== state.revision;
  async function save(e: FormEvent) {
    e.preventDefault(); if (!eligibility.eligible || !physical || !reason.trim() || stale || busy || event.kind === 'receive' && !validQuantity) return;
    const common = { targetEventId: event.id, reason: reason.trim(), physicallyConfirmed: true as const };
    const action: CorrectionAction = event.kind === 'scan' ? { type: 'correct_scan', ...common } : event.kind === 'receive' ? { type: 'correct_receipt', ...common, quantity: Number(quantity) } : { type: 'correct_refill', ...common, physicalOutcome: outcome };
    await onSave(action);
  }
  return <Dialog title="Correct inventory activity" onClose={onClose}><form className="form-stack correction-form" onSubmit={save}>
    <div><span className="eyebrow">{part?.location} · {part?.sample || part?.practice !== false ? 'PRACTICE / UNVERIFIED' : 'PHYSICAL INVENTORY'}</span><h2>{correctionLabel(event)}</h2><p>{part?.name}</p></div>
    <div className="correction-original"><span className="eyebrow">Original record</span><p>{event.message}</p><small>{new Date(event.at).toLocaleString()}</small></div>
    {eligibility.correctedBy ? <>
      <div className="correction-effect" role="status"><h3>Correction already recorded</h3><p>{eligibility.reason}</p></div>
      <p>The current history confirms this correction. If the original save response was lost, use Retry safely to confirm that same save.</p>
      <button type="button" className="button secondary" onClick={onClose}>Back to history</button>
    </> : !eligibility.eligible ? <>
      <div className="correction-blocked" role="status"><h3>Physical recount needed</h3><p>{eligibility.reason}</p></div>
      <p>Count both bins and loose stock. Review the actual deliveries and purchases before reconciling with the buyer. A full recount workflow is not available in this prototype.</p>
      <button type="button" className="button secondary" onClick={onClose}>Back to history</button>
    </> : <>
      {event.kind === 'scan' && <div className="correction-effect"><h3>Restore the previous bin roles</h3>{data!.before.part!.bins.map(bin => <div className="split" key={bin.id}><code>{bin.id}</code><strong>{binLabels[bin.status]}</strong></div>)}<p className="small muted">Existing purchases and receipts stay recorded.</p></div>}
      {event.kind === 'receive' && <><label>Actual quantity in this delivery<input autoFocus type="number" min="0" max={max} step="1" required value={quantity} onChange={e => setQuantity(e.target.value)} /></label><p className="small muted">Originally {data!.quantity} {unit}. Enter zero if this delivery never arrived. {validQuantity && order ? `${order.received - data!.quantity! + Number(quantity)} / ${order.quantity} ${unit} will be recorded received.` : 'Enter a whole quantity within the purchase limit.'} Bin status stays the same.</p></>}
      {event.kind === 'refill' && <><div className="correction-effect"><h3>Return this bin to Empty</h3><p>{data!.binId} will be empty. {data!.quantity} {unit} will return to loose stock.</p></div><label>What happened physically?<select value={outcome} onChange={e => { setOutcome(e.target.value as typeof outcome); setPhysical(false); }}><option value="not_refilled">The physical refill never happened</option><option value="returned_unused">All refill parts were returned unused</option></select></label><p className="small muted">If any parts were used, lost, or mixed, stop and do a physical recount.</p></>}
      <label>Reason for correction<textarea rows={3} required maxLength={500} value={reason} onChange={e => setReason(e.target.value)} placeholder="Describe the mistake and what you checked." /></label>
      <label className="correction-confirm"><input type="checkbox" checked={physical} onChange={e => setPhysical(e.target.checked)} /><span>{event.kind === 'scan' ? 'I checked both physical bins. The previous roles shown above match reality.' : event.kind === 'receive' ? 'I counted the actual delivery. This corrected quantity matches what arrived.' : `I checked that this bin is empty and all ${data!.quantity} ${unit} are in loose stock, unused.`}</span></label>
      <p className="small muted">The original record stays in history. This adds a correction with your reason.</p>
      {stale && <div className="correction-stale"><p>Inventory changed since this review opened. Review the current state before saving.</p><button type="button" className="button secondary small-button" disabled={busy} onClick={onRefresh}>Review current inventory</button></div>}
      <div className="form-actions"><button type="button" className="button secondary" onClick={onClose}>Cancel</button><button className="button primary" disabled={busy || stale || !reason.trim() || !physical || event.kind === 'receive' && !validQuantity}>Save correction</button></div>
    </>}
  </form></Dialog>;
}
