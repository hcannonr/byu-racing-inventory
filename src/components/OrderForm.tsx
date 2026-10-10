import { useState, type FormEvent } from 'react';
import { ClipboardCheck } from 'lucide-react';
import type { Part } from '../../shared/types';
import type { RunAction } from './PartForm';
import { purchaseSnapshot, suggestedPurchaseQuantity } from '../../shared/purchasing';

export function OrderForm({ part, requestId, suggested, run, busy, onSaved, purchase = false }: { part: Part; requestId: string; suggested: number; run: RunAction; busy: boolean; onSaved: () => void; purchase?: boolean }) {
  const [supplier, setSupplier] = useState(part.supplier);
  const [reference, setReference] = useState('');
  const [quantity, setQuantity] = useState(suggestedPurchaseQuantity(suggested, part.purchasePack));
  const [eta, setEta] = useState('');
  const [error, setError] = useState('');
  async function save(e: FormEvent) {
    e.preventDefault(); setError('');
    if (await run({ type: 'order', requestId, supplier, reference, quantity, eta, ...(part.purchasePack && { purchasePack: purchaseSnapshot(quantity, part.purchasePack) }) })) onSaved();
    else setError('Purchase not confirmed. For an inventory conflict, close and reopen this form to refresh it.');
  }
  return <form className="order-form form-stack" onSubmit={save}>
    <h3>{purchase ? part.name : 'Record a purchase'}</h3><p className="muted small">{purchase ? 'Confirm what you bought. The bins stay empty until refilled.' : 'Already ordered? Save the purchase here.'}</p>
    <label>Supplier<input required maxLength={200} value={supplier} onChange={e => setSupplier(e.target.value)} /></label>
    <label>Quantity ({part.unit})<input required type="number" min="1" max="1000000" step="1" value={quantity} onChange={e => setQuantity(Number(e.target.value))} /></label>
    {part.purchasePack && <p className="muted small">Suggested from packs of {part.purchasePack.size}. Confirm the actual individual units bought.</p>}
    <details className="order-options"><summary>Add arrival date or order number</summary><div className="form-stack">
      <label>Expected arrival<input type="date" value={eta} onChange={e => setEta(e.target.value)} /></label>
      <label>Order reference<input maxLength={200} value={reference} onChange={e => setReference(e.target.value)} placeholder="PO or confirmation number" /></label>
    </div></details>
    {error && <p role="alert" className="inline-error">{error}</p>}
    <button className="button primary" disabled={busy}><ClipboardCheck size={16} />{busy ? 'Saving…' : purchase ? 'Mark purchased' : 'Record order'}</button>
  </form>;
}

