import { useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import { ArrowUpRight, Check, ClipboardCheck, Pencil, Plus, Truck } from 'lucide-react';
import { InvoicePrices } from './OrderImportDialog';
import { activeRequest, availableReceived, requestOrders, requestStatus, statusLabels, type InventoryState, type Part, type PurchaseOrder, type InventoryEvent } from '../../shared/types';
import { CorrectionControl } from './CorrectionDialog';
import { Dialog } from './Dialog';
import { OrderForm } from './OrderForm';
import { TrackingSummary } from './OrderDialogs';
import { BinVisual, PartIcon, PartStatus, dateLabel, relativeTime } from './Visuals';
import type { RunAction } from './PartForm';
import { PhotoControls, type PhotoUploadOutcome } from './PhotoControls';
import { BinSizingPanel } from './BinSizingPanel';
import type { BinSizingSuggestion } from '../../shared/binSizing';

export type PartDetailAction = { kind: 'receive'; orderId: string } | { kind: 'refill'; binId: string; cycle: number };

function useInitialActionFocus(ref: RefObject<HTMLElement | null>, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    // The dialog's showModal effect runs after its children mount. Focus on the next frame.
    const frame = window.requestAnimationFrame(() => {
      const target = ref.current;
      target?.focus({ preventScroll: true });
      target?.closest<HTMLElement>('.receive-form, .confirm-panel')?.scrollIntoView?.({ block: 'center' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [ref, enabled]);
}

function OrderCard({ order, unit, run, busy, onUndo, onTracking, initialReceiving = false }: { order: PurchaseOrder; unit: string; run: RunAction; busy: boolean; onUndo: () => void; onTracking: () => void; initialReceiving?: boolean }) {
  const [receiving, setReceiving] = useState(initialReceiving && order.received < order.quantity);
  const lastReceived = useRef(order.received);
  const receiptInput = useRef<HTMLInputElement>(null);
  useInitialActionFocus(receiptInput, initialReceiving && receiving);
  const [amount, setAmount] = useState(order.quantity - order.received);
  const [error, setError] = useState('');
  useEffect(() => {
    if (lastReceived.current !== order.received) { setReceiving(false); setError(''); lastReceived.current = order.received; }
  }, [order.received]);
  async function receive(e: FormEvent) {
    e.preventDefault(); setError('');
    if (await run({ type: 'receive', orderId: order.id, quantity: amount })) setReceiving(false);
    else setError('Receipt not saved. Check the amount and try again.');
  }
  const left = order.quantity - order.received;
  return <div className="purchase-card">
    <div className="split"><strong>{order.reference || 'Purchase order'}</strong><span className={`badge ${order.status}`}>{order.status === 'in_transit' ? 'In transit' : order.status === 'arrived' ? 'Arrived' : 'Ordered'}</span></div>
    <p>{order.supplier}<span className="muted"> · {dateLabel(order.eta)}</span></p>
    <div className="receipt-progress"><span style={{ width: `${order.received / order.quantity * 100}%` }} /></div>
      <p className="small muted">{order.received} / {order.quantity} {unit} received</p>
      {order.orderImport && <InvoicePrices prices={order.orderImport.prices} />}
    {left > 0 && <div className="purchase-actions">
      {order.status === 'ordered' && <button className="button secondary small-button" disabled={busy} onClick={() => void run({ type: 'ship', orderId: order.id })}><Truck size={14} />Mark in transit</button>}
      <button className="button primary small-button" disabled={busy} onClick={() => { setAmount(left); setReceiving(!receiving); }}>Record arrival</button>
    </div>}
    <TrackingSummary order={order} />
    <div className="purchase-actions"><button className="text-button" disabled={busy} onClick={onTracking}>{order.tracking ? 'Edit tracking' : 'Add tracking'}</button><button className="text-button undo-action" disabled={busy || order.received > 0} title={order.received > 0 ? 'Received parts cannot be undone.' : undefined} onClick={onUndo}>Undo purchase</button></div>
    {receiving && left > 0 && <form onSubmit={receive} className="receive-form"><label>Quantity received this delivery<input ref={receiptInput} autoFocus type="number" required min="1" max={left} step="1" value={amount} onChange={e => setAmount(Number(e.target.value))} /></label><p className="small muted">Bins stay empty until physically refilled.</p><button className="button primary small-button" disabled={busy}>Save receipt</button>{error && <p className="inline-error" role="alert">{error}</p>}</form>}
  </div>;
}

export function PartDetail({ part, state, run, busy, onClose, onEdit, onSupplier, onUndo, onTracking, initialAction, onLocate, onUpload, photoBusy, onCorrect, onSizingReview }: { part: Part; state: InventoryState; run: RunAction; busy: boolean; onClose: () => void; onEdit: () => void; onSupplier?: () => void; onUndo: (order: PurchaseOrder) => void; onTracking: (order: PurchaseOrder) => void; initialAction?: PartDetailAction; onLocate?: () => void; onUpload?: (partId: string, file: File) => Promise<PhotoUploadOutcome>; photoBusy?: boolean; onCorrect?: (event: InventoryEvent) => void; onSizingReview?: (suggestion: BinSizingSuggestion) => void }) {
  const [extraOrder, setExtraOrder] = useState(false);
  const [confirmBin, setConfirmBin] = useState<{ id: string; cycle: number } | null>(initialAction?.kind === 'refill' ? { id: initialAction.binId, cycle: initialAction.cycle } : null);
  const refillHeading = useRef<HTMLHeadingElement>(null);
  useInitialActionFocus(refillHeading, initialAction?.kind === 'refill' && confirmBin !== null);
  const [refillError, setRefillError] = useState('');
  const r = activeRequest(state, part.id);
  const orders = r ? requestOrders(state, r.id) : [];
  useEffect(() => { setExtraOrder(false); }, [orders.length]);
  useEffect(() => {
    if (confirmBin && part.bins.find(b => b.id === confirmBin.id)?.cycle !== confirmBin.cycle) setConfirmBin(null);
  }, [part.bins, confirmBin]);
  const received = r ? availableReceived(state, r.id) : 0;
  const outstanding = orders.reduce((n, o) => n + o.quantity - o.received, 0);
  const empties = part.bins.filter(b => b.status === 'empty').length;
  const status = r ? requestStatus(state, r) : 'closed';
  const suggested = Math.max(1, empties * part.binQuantity - received - outstanding);
  const recent = state.events.filter(e => e.partId === part.id).slice(0, 12);
  return <Dialog title="Part overview" wide onClose={onClose}>
    <div className="detail-heading"><PartIcon part={part} /><div><span className="eyebrow">{part.location} {part.sample && ' / SAMPLE PART'}</span><h2>{part.name}</h2><p className="muted">{part.specification}</p></div><button className="button secondary small-button part-edit-button" aria-label="Edit part details" disabled={busy} onClick={onEdit}><Pencil size={15} />Edit part</button></div>
    <div className="detail-content">
      <div className="split"><PartStatus part={part} state={state} /></div>
      <section className="part-supplier" aria-label="Part supplier"><div><span className="eyebrow">Supplier</span><p>{part.supplier || 'Not assigned'}</p>{part.supplierUrl && <a className="text-button" href={part.supplierUrl} target="_blank" rel="noreferrer">Open product <ArrowUpRight size={14} /></a>}</div><button className="text-button" disabled={busy} onClick={onSupplier ?? onEdit}><Pencil size={14} />Edit supplier</button></section>
      <div className="detail-bins">{part.bins.map((bin, i) => <div key={bin.id}><BinVisual bin={bin} index={i} large /><code>{bin.id}</code><p className="small muted">Refill with {part.binQuantity} {part.unit}</p>{bin.status === 'empty' && <button className="button secondary small-button" disabled={busy || received < part.binQuantity} onClick={() => { setConfirmBin({ id: bin.id, cycle: bin.cycle }); setRefillError(''); }}>Confirm refill</button>}</div>)}</div>
      {empties > 0 && <p className="note"><ClipboardCheck size={16} /><span>{received >= part.binQuantity ? `${received} ${part.unit} ready. Fill the empty bin, then confirm.` : 'Bins stay empty until the parts arrive and you refill them.'}</span></p>}
      {confirmBin && <div className="confirm-panel"><h3 ref={refillHeading} tabIndex={-1}>Is {confirmBin.id} physically refilled?</h3><p>Confirm only after placing {part.binQuantity} correct {part.unit} into this bin.</p><div className="purchase-actions"><button className="button primary" disabled={busy} onClick={async () => { if (await run({ type: 'refill', binId: confirmBin.id, cycle: confirmBin.cycle })) setConfirmBin(null); else setRefillError('Refill not saved. Review the error and received quantity.'); }}><Check size={16} />Yes, bin is refilled</button><button className="button secondary" onClick={() => setConfirmBin(null)}>Cancel</button></div>{refillError && <p role="alert" className="inline-error">{refillError}</p>}</div>}
      <section className="detail-section"><div className="split"><h3>{!r ? 'All set' : received >= part.binQuantity && empties > 0 ? 'Next: refill the bin' : status === 'needs_order' ? 'Next: record your order' : 'Next: record the delivery'}</h3>{r && <span className="small muted">{statusLabels[status]}</span>}</div>
        {!r ? <div className="quiet-state"><Check size={22} /><div><strong>Ready for the next build.</strong><p>No open refill request. Scan a bin when it empties.</p></div></div> : <>
          {orders.map(order => <OrderCard key={order.id} order={order} unit={part.unit} run={run} busy={busy} initialReceiving={initialAction?.kind === 'receive' && initialAction.orderId === order.id} onUndo={() => onUndo(order)} onTracking={() => onTracking(order)} />)}
          {(orders.length === 0 && status !== 'arrived') || extraOrder || status === 'needs_order' ? <OrderForm key={r.id + orders.length} part={part} requestId={r.id} suggested={suggested} run={run} busy={busy} onSaved={() => setExtraOrder(false)} /> : <button className="text-button" onClick={() => setExtraOrder(true)}><Plus size={15} />Record another order</button>}
        </>}
      </section>
      <BinSizingPanel part={part} state={state} busy={busy} onReview={onSizingReview} />
      {onUpload && <PhotoControls part={part} busy={photoBusy ?? busy} mutationBusy={busy} run={run} upload={onUpload} />}
      {onLocate && <button className="text-button part-locate" onClick={onLocate}>Find {part.location} in cabinet<ArrowUpRight size={15} /></button>}
      <details className="detail-more"><summary>Part details & history</summary>
        {r && (r.attention ? !r.attention.snoozedUntil || Date.parse(r.attention.snoozedUntil) <= Date.now() : !r.acknowledged) && <button className="button secondary" disabled={busy} onClick={() => void run({ type: 'acknowledge', requestId: r.id })}>Acknowledge request</button>}
        {r?.attention?.snoozedUntil && Date.parse(r.attention.snoozedUntil) > Date.now() && <p className="small muted">Email reminders snoozed until {new Date(r.attention.snoozedUntil).toLocaleString()}.</p>}
        {!part.sample && part.practice !== false && <p className="note small">Practice or unverified stock. Automatic email stays off until a safe correction verifies previously clean stock, or the buyer completes a physical recount. A full recount workflow is not available yet.</p>}
      
      <section className="detail-section"><h3>Part history</h3>{!recent.length && <p className="muted small">No activity yet. Start with a test scan.</p>}<div className="timeline">{recent.map(e => <div key={e.id}><span className={`event-dot ${e.kind}`} /><div className="history-event"><p>{e.message}<small>{relativeTime(e.at)}</small></p>{onCorrect && <CorrectionControl event={e} state={state} busy={busy} onReview={onCorrect} />}</div></div>)}</div></section>
      </details>
    </div>
  </Dialog>;
}

