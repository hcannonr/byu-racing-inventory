import { useState, type FormEvent } from 'react';
import { ClipboardCheck } from 'lucide-react';
import { purchaseEstimate, purchaseSnapshot, suggestedPurchaseQuantity, usd } from '../../shared/purchasing';
import { activeRequest, quantityToBuy, type InventoryState, type Part, type PurchaseBatchLine } from '../../shared/types';
import { Dialog } from './Dialog';
import type { RunAction } from './PartForm';

export function SupplierPurchaseDialog({ state, parts, supplier, run, busy, onClose }: {
  state: InventoryState; parts: Part[]; supplier: string; run: RunAction; busy: boolean; onClose: () => void;
}) {
  const [actualSupplier, setSupplier] = useState(supplier);
  const [reference, setReference] = useState('');
  const [eta, setEta] = useState('');
  const [error, setError] = useState('');
  const [lines, setLines] = useState(() => parts.map(part => ({ part, requestId: activeRequest(state, part.id)!.id,
    needed: quantityToBuy(state, part), quantity: String(suggestedPurchaseQuantity(quantityToBuy(state, part), part.purchasePack)), included: true })));
  const selected = lines.filter(line => line.included);
  const estimates = selected.map(line => purchaseEstimate(Number(line.quantity), line.part.purchasePack));
  const subtotal = estimates.reduce((total, estimate) => total + (estimate.totalCents ?? 0), 0);
  const unknown = estimates.filter(estimate => estimate.totalCents === undefined).length;
  async function submit(event: FormEvent) {
    event.preventDefault(); setError('');
    if (!selected.length) { setError('Select at least one purchased part.'); return; }
    const checkoutLines: PurchaseBatchLine[] = selected.map(line => ({ requestId: line.requestId, quantity: Number(line.quantity),
      ...(line.part.purchasePack && { purchasePack: purchaseSnapshot(Number(line.quantity), line.part.purchasePack) }) }));
    if (await run({ type: 'order_batch', supplier: actualSupplier, reference, eta, lines: checkoutLines })) onClose();
    else setError('Checkout not confirmed. Your entries are still here. For an inventory conflict, reopen this review with current quantities.');
  }
  return <Dialog title="Supplier checkout" wide onClose={onClose}><form className="form-stack checkout-form" onSubmit={submit}>
    <div><h2>Confirm your checkout.</h2><p className="muted">After buying from the supplier, select what you actually purchased. All selected parts save together.</p></div>
    <label>Actual supplier<input autoFocus required maxLength={200} value={actualSupplier} onChange={event => setSupplier(event.target.value)} /></label>
    <div className="checkout-lines">{lines.map((line, index) => {
      const setLine = (value: Partial<typeof line>) => setLines(previous => previous.map((item, position) => position === index ? { ...item, ...value } : item));
      const estimate = purchaseEstimate(line.needed, line.part.purchasePack);
      return <fieldset className={`checkout-line ${line.included ? '' : 'excluded'}`} key={line.part.id}>
        <legend className="sr-only">{line.part.name}</legend>
        <label className="checkout-include"><input type="checkbox" aria-label={`Include ${line.part.name}`} checked={line.included} onChange={event => setLine({ included: event.target.checked })} /><strong>{line.part.name}</strong></label>
        <p className="muted small">{line.part.specification}</p>
        <p className="small">Needed: {line.needed} {line.part.unit}. {line.part.purchasePack ? `${estimate.packs} packs of ${line.part.purchasePack.size} = ${estimate.quantity} units${estimate.surplus ? ` (${estimate.surplus} extra)` : ''}.` : 'Pack size unknown.'}</p>
        <label>Quantity for {line.part.name} ({line.part.unit})<input required={line.included} disabled={!line.included} type="number" min="1" max="1000000" step="1" value={line.quantity} onChange={event => setLine({ quantity: event.target.value })} /></label>
      </fieldset>;
    })}</div>
    <div className="checkout-total"><span>{Number.isSafeInteger(subtotal) ? `${usd(subtotal)} estimated merchandise${unknown ? ' (incomplete)' : ''}` : 'Estimate exceeds supported total'}</span><small>{unknown > 0 ? `${unknown} selected ${unknown === 1 ? 'part has' : 'parts have'} an unknown pack price. ` : ''}USD. Excludes shipping and tax. Saved pack prices are catalog estimates.</small></div>
    <details className="order-options"><summary>Add arrival date or order number</summary><div className="form-grid">
      <label>Expected arrival<input type="date" value={eta} onChange={event => setEta(event.target.value)} /></label>
      <label>Order reference<input maxLength={200} value={reference} onChange={event => setReference(event.target.value)} /></label>
    </div></details>
    <p className="muted small">This records your purchase. It does not place an order. Bins stay empty until physically refilled.</p>
    {error && <p role="alert" className="inline-error">{error}</p>}
    <div className="form-actions"><button type="button" className="button secondary" onClick={onClose}>Cancel</button><button className="button primary" disabled={busy || !selected.length || selected.length > 100}><ClipboardCheck size={16} />{busy ? 'Saving…' : 'Record checkout'}</button></div>
    {selected.length > 100 && <p role="alert" className="inline-error">Select up to 100 parts per checkout.</p>}
  </form></Dialog>;
}
