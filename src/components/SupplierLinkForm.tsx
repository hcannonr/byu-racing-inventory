import { useState, type FormEvent } from 'react';
import type { Part } from '../../shared/types';
import { Dialog } from './Dialog';
import { PurchasePackFields } from './PurchasePackFields';
import type { RunAction } from './PartForm';

export function SupplierLinkForm({ part, run, busy, onClose }: { part: Part; run: RunAction; busy: boolean; onClose: () => void }) {
  const [supplier, setSupplier] = useState(part.supplier);
  const [url, setUrl] = useState(part.supplierUrl);
  const [purchasePack, setPurchasePack] = useState(part.purchasePack);
  const [error, setError] = useState('');
  async function save(event: FormEvent) {
    event.preventDefault();
    setError('');
    const { id, bins, sample, practice, ...details } = part;
    if (await run({ type: 'edit_part', partId: id, part: { ...details, supplier, supplierUrl: url.trim(), purchasePack: purchasePack ?? null } })) onClose();
    else setError('Supplier not saved. If inventory changed, close and reopen to try again.');
  }
  return <Dialog title="Edit supplier" onClose={onClose}>
    <form className="form-stack" onSubmit={save}>
      <div><h2>{part.name}</h2><p className="muted">{part.specification}</p></div>
      <label>Supplier<input autoFocus maxLength={200} value={supplier} onChange={e => setSupplier(e.target.value)} /></label>
      <label>Supplier product link<input type="url" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://supplier.com/exact-part" /></label>
      <p className="muted small">Use the exact product page for this size and specification. Leave either field blank if unknown.</p>
      <PurchasePackFields value={part.purchasePack} onChange={setPurchasePack} />
      {error && <p className="inline-error" role="alert">{error}</p>}
      <div className="form-actions"><button type="button" className="button secondary" onClick={onClose}>Cancel</button><button className="button primary" disabled={busy}>Save supplier</button></div>
    </form>
  </Dialog>;
}
