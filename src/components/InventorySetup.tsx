import { useState, type FormEvent } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { initialCabinetSetup, inventoryCategories } from '../../shared/organization';
import type { Action, InventoryState } from '../../shared/types';
import { Dialog } from './Dialog';

type SetupProps = { state: InventoryState; busy: boolean; onSave: (action: Action) => Promise<boolean>; onClose: () => void };

export function CategorySetup({ state, busy, onSave, onClose }: SetupProps) {
  const [names, setNames] = useState(() => inventoryCategories(state));
  const [assignments, setAssignments] = useState(() => Object.fromEntries(state.parts.map(part => [part.id, inventoryCategories(state).findIndex(name => name.toLowerCase() === part.category.toLowerCase())])));
  const [error, setError] = useState('');
  function removeCategory(index: number) {
    const next = names.filter((_, i) => i !== index);
    if (!next.length && state.parts.length) next.push('Uncategorized');
    setNames(next);
    setAssignments(current => Object.fromEntries(Object.entries(current).map(([id, value]) => [id, value === index ? 0 : value > index ? value - 1 : value])));
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); setError('');
    const categories = names.map(name => name.trim());
    if (new Set(categories.map(name => name.toLowerCase())).size !== categories.length) { setError('Give each category a different name.'); return; }
    if (await onSave({ type: 'save_categories', categories, assignments: state.parts.filter(part => part.category !== categories[assignments[part.id]]).map(part => ({ partId: part.id, category: categories[assignments[part.id]] })) })) onClose();
    else setError('Not saved. Close and reopen setup to load the latest inventory, then try again.');
  }
  return <Dialog title="Manage categories" onClose={onClose}><form className="form-stack inventory-setup" onSubmit={submit}>
    <p className="muted">Add or remove categories. Parts in a removed category move to the first remaining category; you can change them below.</p>
    <fieldset disabled={busy}><legend>Categories</legend><div className="setup-names">{names.map((name, index) => <div key={index} className="setup-name-row"><label>Category {index + 1}<input required maxLength={60} value={name} onChange={event => setNames(current => current.map((value, i) => i === index ? event.target.value : value))} /></label><button type="button" className="icon-button" aria-label={`Remove category ${name || index + 1}`} onClick={() => removeCategory(index)}><Trash2 size={16} /></button></div>)}</div>
    <button type="button" className="text-button" disabled={names.length >= 100} onClick={() => setNames(current => [...current, ''])}><Plus size={16} />Add category</button></fieldset>
    {!!state.parts.length && <fieldset disabled={busy}><legend>Assign parts</legend><div className="setup-assignments">{state.parts.map(part => <label key={part.id}><span>{part.name}<small>{part.location}</small></span><select aria-label={`Category for ${part.name}`} value={assignments[part.id]} onChange={event => setAssignments(current => ({ ...current, [part.id]: Number(event.target.value) }))}>{names.map((name, index) => <option key={index} value={index}>{name.trim() || 'New category'}</option>)}</select></label>)}</div></fieldset>}
    {error && <p role="alert" className="inline-error">{error}</p>}<div className="form-actions"><button type="button" className="button secondary" onClick={onClose}>Cancel</button><button className="button primary" disabled={busy}>{busy ? 'Saving…' : 'Save categories'}</button></div>
  </form></Dialog>;
}

export function CabinetSetup({ state, busy, onSave, onClose }: SetupProps) {
  const [map, setMap] = useState(() => initialCabinetSetup(state));
  const [error, setError] = useState('');
  function assign(location: string, drawerId: string) {
    setMap(current => {
      const next = structuredClone(current);
      for (const drawer of next.drawers) for (const compartment of drawer.compartments) compartment.locations = compartment.locations.filter(value => value !== location);
      const drawer = next.drawers.find(value => value.id === drawerId);
      if (drawer) { if (!drawer.compartments.length) drawer.compartments.push({ id: crypto.randomUUID(), label: 'Parts', locations: [] }); drawer.compartments[0].locations.push(location); }
      return next;
    });
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); setError('');
    if (await onSave({ type: 'save_cabinet_map', map })) onClose();
    else setError('Not saved. Close and reopen setup to load the latest inventory, then try again.');
  }
  return <Dialog title="Set up cabinet" onClose={onClose}><form className="form-stack inventory-setup" onSubmit={submit}>
    <p className="muted">Rename sections and choose where each part belongs. Printed bin codes stay the same.</p>
    <fieldset disabled={busy}><legend>Cabinet sections</legend><label>Cabinet name<input required maxLength={80} value={map.name} onChange={event => setMap(current => ({ ...current, name: event.target.value }))} /></label><div className="setup-names">{map.drawers.map((drawer, index) => <div key={drawer.id} className="setup-name-row"><label>Section {index + 1}<input required maxLength={80} value={drawer.label} onChange={event => setMap(current => ({ ...current, drawers: current.drawers.map(value => value.id === drawer.id ? { ...value, label: event.target.value } : value) }))} /></label><button type="button" className="icon-button" aria-label={`Remove section ${drawer.label || index + 1}`} onClick={() => setMap(current => ({ ...current, drawers: current.drawers.filter(value => value.id !== drawer.id) }))}><Trash2 size={16} /></button></div>)}</div>
    <button type="button" className="text-button" disabled={map.drawers.length >= 30 || map.drawers.flatMap(drawer => drawer.compartments).length >= 100} onClick={() => setMap(current => ({ ...current, drawers: [...current.drawers, { id: crypto.randomUUID(), label: '', compartments: [{ id: crypto.randomUUID(), label: 'Parts', locations: [] }] }] }))}><Plus size={16} />Add section</button></fieldset>
    {!!state.parts.length && <fieldset disabled={busy}><legend>Place parts</legend><div className="setup-assignments">{state.parts.map(part => <label key={part.id}><span>{part.name}<small>{part.location}</small></span><select aria-label={`Section for ${part.name}`} value={map.drawers.find(drawer => drawer.compartments.some(compartment => compartment.locations.includes(part.location)))?.id ?? ''} onChange={event => assign(part.location, event.target.value)}><option value="">Unplaced</option>{map.drawers.map(drawer => <option key={drawer.id} value={drawer.id}>{drawer.label.trim() || 'New section'}</option>)}</select></label>)}</div></fieldset>}
    {error && <p role="alert" className="inline-error">{error}</p>}<div className="form-actions"><button type="button" className="button secondary" onClick={onClose}>Cancel</button><button className="button primary" disabled={busy}>{busy ? 'Saving…' : 'Save cabinet'}</button></div>
  </form></Dialog>;
}
