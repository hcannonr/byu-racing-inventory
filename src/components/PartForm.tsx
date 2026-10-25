import { useState, type FormEvent } from 'react';
import { Dialog } from './Dialog';
import { PurchasePackFields } from './PurchasePackFields';
import type { Action, Part, PartInput } from '../../shared/types';
import { defaultCategories } from '../../shared/organization';

export type RunAction = (action: Action) => Promise<boolean>;
export function PartForm({ part, categories = defaultCategories, busy, run, onClose }: { part?: Part; categories?: string[]; busy: boolean; run: RunAction; onClose: () => void }) {
  const [value, setValue] = useState<PartInput>(part ?? { name: '', specification: '', category: categories[0] ?? '', location: '', supplier: '', supplierUrl: '', binQuantity: 50, unit: 'pieces' });
  const [newCategory, setNewCategory] = useState(!part && !categories.length);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState('');
  const update = (key: keyof PartInput, v: string | number) => setValue(old => ({ ...old, [key]: v }));
  async function submit(e: FormEvent) {
    e.preventDefault(); setError('');
    const clean: PartInput = { name: value.name, specification: value.specification, category: value.category, location: value.location, supplier: value.supplier, supplierUrl: value.supplierUrl, binQuantity: value.binQuantity, unit: value.unit, purchasePack: value.purchasePack ?? null };
    if (await run(part ? { type: 'edit_part', partId: part.id, part: clean } : { type: 'add_part', part: clean })) onClose();
    else setError('Could not save this part. If inventory changed, close and reopen this form to load the latest details.');
  }
  return <Dialog title={part ? 'Edit part' : 'Add a part'} onClose={onClose}>
    <form onSubmit={submit} className="form-stack">
      <div><h2>{part ? 'Part details' : 'Make room for a new part.'}</h2><p className="muted">One part specification. Two permanent bin labels.</p></div>
      <label>Part name<input autoFocus required maxLength={200} value={value.name} onChange={e => update('name', e.target.value)} placeholder="e.g. Hex bolts" /></label>
      <label>Specification<input maxLength={500} value={value.specification} onChange={e => update('specification', e.target.value)} placeholder="Size, grade, material or verified terminal series" /></label>
      <div className="form-grid"><div><label>Category<select value={newCategory ? '' : value.category} onChange={e => { setNewCategory(e.target.value === ''); update('category', e.target.value === '' ? '' : e.target.value); }}>{[...new Set([...categories, ...(part ? [part.category] : [])])].map(name => <option key={name}>{name}</option>)}<option value="">+ New category</option></select></label>{newCategory && <label>New category name<input required maxLength={60} value={value.category} onChange={e => update('category', e.target.value)} /></label>}</div>
      <label>Cabinet location<input required disabled={!!part} pattern="[A-Za-z0-9][A-Za-z0-9-]{1,29}" value={value.location} onChange={e => update('location', e.target.value.toUpperCase())} placeholder="BLUE-D01" /></label></div>
      <div className="form-grid"><label>Fill quantity per bin<input type="number" required min="1" max="1000000" step="1" value={value.binQuantity} onChange={e => update('binQuantity', Number(e.target.value))} /></label>
      <label>Unit<input required maxLength={30} value={value.unit} onChange={e => update('unit', e.target.value)} /></label></div>
      <label>Supplier<input maxLength={200} value={value.supplier} onChange={e => update('supplier', e.target.value)} placeholder="Supplier name" /></label>
      <label>Supplier product link<input type="url" value={value.supplierUrl} onChange={e => update('supplierUrl', e.target.value)} placeholder="https://..." /></label>
      <PurchasePackFields value={value.purchasePack ?? undefined} onChange={purchasePack => setValue(old => ({ ...old, purchasePack }))} />
      {!part && <label className="check-label"><input type="checkbox" required checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />Start with both bins stocked. Bin 1 will be in use and bin 2 will be reserve.</label>}
      {error && <p className="inline-error" role="alert">{error}</p>}
      <div className="form-actions"><button type="button" className="button secondary" onClick={onClose}>Cancel</button><button className="button primary" disabled={busy}>{busy ? 'Saving…' : part ? 'Save changes' : 'Add part'}</button></div>
    </form>
  </Dialog>;
}
