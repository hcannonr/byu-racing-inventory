import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowDown, ArrowUp, ArrowLeft, ArrowRight, MapPin, Pencil, Plus, Trash2 } from 'lucide-react';
import type { CabinetMap as MapData, InventoryState } from '../../shared/types';
import { Dialog } from './Dialog';
import { PartIcon, PartStatus } from './Visuals';

const blankMap = (): MapData => ({ name: 'Blue cabinet', drawers: [] });
export function CabinetMap({ state, focusedLocation, busy, onPart, onSave }: {
  state: InventoryState; focusedLocation: string | null; busy: boolean; onPart: (id: string) => void; onSave: (map: MapData, revision: number) => Promise<boolean>;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [unplacedFocus, setUnplacedFocus] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ map: MapData; revision: number } | null>(null);
  const results = useRef<HTMLElement | null>(null);
  const diagram = useRef<HTMLDivElement | null>(null);
  const map = state.cabinetMap;
  const compartments = map?.drawers.flatMap(drawer => drawer.compartments) ?? [];
  const placed = new Set(compartments.flatMap(compartment => compartment.locations));
  const unplaced = state.parts.filter(part => !placed.has(part.location));
  useEffect(() => {
    const match = compartments.find(compartment => compartment.locations.includes(focusedLocation ?? ''));
    setSelected(match?.id ?? null); setUnplacedFocus(match ? null : focusedLocation);
    // Navigation supplies focus once. Polling returns fresh objects every 2.5 seconds.
    // Subsequent manual selections must survive those equivalent snapshots.
  }, [focusedLocation]);
  useEffect(() => {
    if (selected && !compartments.some(c => c.id === selected)) setSelected(null);
    const newlyPlaced = compartments.find(c => c.locations.includes(unplacedFocus ?? ''));
    if (newlyPlaced) { setSelected(newlyPlaced.id); setUnplacedFocus(null); }
  }, [map]);
  const compartment = compartments.find(item => item.id === selected);
  const drawer = map?.drawers.find(item => item.compartments.some(c => c.id === selected));
  const parts = compartment ? state.parts.filter(part => compartment.locations.includes(part.location)) : unplacedFocus ? unplaced.filter(part => part.location === unplacedFocus) : [];
  function focusResults() {
    if (window.innerWidth > 680) return;
    window.requestAnimationFrame(() => { results.current?.focus({ preventScroll: true }); results.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' }); });
  }
  useEffect(() => { if (selected || unplacedFocus) focusResults(); }, [selected, unplacedFocus]);
  return <section className="cabinet-map-view" aria-label="Cabinet diagram">
    <div className="cabinet-map-toolbar"><div><h2>{map?.name ?? 'Blue cabinet'}</h2><p className="muted">Choose a compartment to find its parts.</p></div><button className="button secondary" disabled={busy} onClick={() => setEditor({ map: structuredClone(map ?? blankMap()), revision: state.revision })}><Pencil size={16} />{map?.drawers.length ? 'Edit diagram' : 'Configure diagram'}</button></div>
    <p className="cabinet-map-note">An editable schematic. Drawer order and labels are entered by your team. Location codes and bin labels stay permanent.</p>
    <div className="cabinet-map-layout"><div className="cabinet-drawers" ref={diagram}>
      {!map?.drawers.length && <div className="map-empty"><MapPin size={30} /><h3>No cabinet layout yet.</h3><p>Add the actual drawers and compartments when you inspect the cabinet.</p></div>}
      {map?.drawers.map(d => <section className={`cabinet-drawer ${drawer?.id === d.id ? 'highlighted' : ''}`} key={d.id} aria-label={d.label}><h3>{d.label}</h3><div className="cabinet-compartments">{d.compartments.map(c => <button key={c.id} className={`cabinet-compartment ${selected === c.id ? 'selected' : ''}`} aria-pressed={selected === c.id} onClick={() => { setSelected(c.id); setUnplacedFocus(null); focusResults(); }}><strong>{c.label}</strong><span>{c.locations.length ? c.locations.join(' · ') : 'No locations assigned'}</span><small>{state.parts.filter(p => c.locations.includes(p.location)).length} {state.parts.filter(p => c.locations.includes(p.location)).length === 1 ? "part" : "parts"}</small></button>)}</div>{!d.compartments.length && <p className="small muted">No compartments added.</p>}</section>)}
      <section className="map-unplaced"><h3>Unplaced locations <span>{unplaced.length}</span></h3><p className="small muted">Still in the catalog. Assign them in Edit diagram after confirming their position.</p><div className="map-location-chips">{unplaced.map(p => <button key={p.id} className={`location-tag ${p.location === unplacedFocus ? 'selected' : ''}`} aria-pressed={p.location === unplacedFocus} onClick={() => { setSelected(null); setUnplacedFocus(p.location); focusResults(); }}>{p.location}</button>)}</div>{!unplaced.length && <p className="small muted">Every catalog location is assigned.</p>}</section>
    </div><aside className="map-parts-panel" aria-live="polite" ref={results} tabIndex={-1}><span className="eyebrow">{compartment ? 'SELECTED COMPARTMENT' : unplacedFocus ? 'UNPLACED LOCATION' : 'FIND A PART'}</span><h3>{compartment?.label ?? unplacedFocus ?? 'Select a compartment'}</h3>{drawer && <p className="small muted">{drawer.label}</p>}{unplacedFocus && <p className="map-selection-note">Location not placed yet.</p>}
      {parts.map(p => <article className="map-part-row" key={p.id}><div className="map-part-title"><PartIcon part={p} /><div><strong>{p.name}</strong><p>{p.location}{p.sample ? ' · Sample part' : ''}</p></div></div><PartStatus part={p} state={state} /><button className="text-button" onClick={() => onPart(p.id)}>Open {p.name}<ArrowRight size={14} /></button></article>)}
      {!parts.length && <p className="small muted">{compartment ? 'No parts assigned to this compartment.' : 'Click a drawer compartment or an unplaced location.'}</p>}
      {(selected || unplacedFocus) && <button className="text-button map-back-link" onClick={() => { const target = diagram.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]'); target?.focus({ preventScroll: true }); target?.scrollIntoView?.({ block: 'center', behavior: 'smooth' }); }}><ArrowUp size={14} />Back to diagram</button>}
    </aside></div>
    {editor && <CabinetEditor initial={editor.map} state={state} busy={busy} onClose={() => setEditor(null)} onSave={async value => { const saved = await onSave(value, editor.revision); if (saved) setEditor(null); return saved; }} />}
  </section>;
}

function CabinetEditor({ initial, state, busy, onClose, onSave }: { initial: MapData; state: InventoryState; busy: boolean; onClose: () => void; onSave: (map: MapData) => Promise<boolean> }) {
  const [map, setMap] = useState(initial); const [error, setError] = useState('');
  const assigned = new Set(map.drawers.flatMap(d => d.compartments).flatMap(c => c.locations));
  const compartmentCount = map.drawers.reduce((sum, drawer) => sum + drawer.compartments.length, 0);
  function change(update: (draft: MapData) => void) { setMap(current => { const draft = structuredClone(current); update(draft); return draft; }); }
  async function submit(e: FormEvent) { e.preventDefault(); setError(''); if (!await onSave(map)) setError('Diagram not saved. If another window changed inventory, close and reopen the editor.'); }
  return <Dialog title="Edit cabinet diagram" wide onClose={onClose}><form className="form-stack cabinet-editor" onSubmit={submit}>
    <h2>Match the real cabinet.</h2><p className="muted">Add drawers from top to bottom. Locations moved or removed here keep their permanent bin labels and stock records.</p><label>Cabinet name<input required maxLength={80} value={map.name} onChange={e => change(draft => { draft.name = e.target.value; })} /></label>
    {map.drawers.map((drawer, d) => <fieldset className="drawer-editor" key={drawer.id}><legend>Drawer {d + 1}</legend><div className="drawer-edit-heading"><label>Drawer label<input required maxLength={80} value={drawer.label} onChange={e => change(draft => { draft.drawers[d].label = e.target.value; })} /></label><div className="map-edit-actions"><button type="button" className="icon-button" aria-label={`Move ${drawer.label} up`} disabled={busy || d === 0} onClick={() => change(draft => { [draft.drawers[d - 1], draft.drawers[d]] = [draft.drawers[d], draft.drawers[d - 1]]; })}><ArrowUp size={16} /></button><button type="button" className="icon-button" aria-label={`Move ${drawer.label} down`} disabled={busy || d === map.drawers.length - 1} onClick={() => change(draft => { [draft.drawers[d + 1], draft.drawers[d]] = [draft.drawers[d], draft.drawers[d + 1]]; })}><ArrowDown size={16} /></button><button type="button" className="icon-button" aria-label={`Remove ${drawer.label}`} disabled={busy} onClick={() => change(draft => { draft.drawers.splice(d, 1); })}><Trash2 size={16} /></button></div></div>
      {drawer.compartments.map((compartment, c) => <div className="compartment-editor" key={compartment.id}><div className="drawer-edit-heading"><label>Compartment label<input required maxLength={80} value={compartment.label} onChange={e => change(draft => { draft.drawers[d].compartments[c].label = e.target.value; })} /></label><div className="map-edit-actions"><button type="button" className="icon-button" aria-label={`Move ${compartment.label} left`} disabled={busy || c === 0} onClick={() => change(draft => { const values = draft.drawers[d].compartments; [values[c - 1], values[c]] = [values[c], values[c - 1]]; })}><ArrowLeft size={15} /></button><button type="button" className="icon-button" aria-label={`Move ${compartment.label} right`} disabled={busy || c === drawer.compartments.length - 1} onClick={() => change(draft => { const values = draft.drawers[d].compartments; [values[c + 1], values[c]] = [values[c], values[c + 1]]; })}><ArrowRight size={15} /></button><button type="button" className="icon-button" aria-label={`Remove ${compartment.label}`} disabled={busy} onClick={() => change(draft => { draft.drawers[d].compartments.splice(c, 1); })}><Trash2 size={15} /></button></div></div>
        <div className="map-location-chips">{compartment.locations.map(location => <button key={location} type="button" className="location-tag" aria-label={`Unplace ${location}`} disabled={busy} onClick={() => change(draft => { draft.drawers[d].compartments[c].locations = compartment.locations.filter(value => value !== location); })}>{location} ×</button>)}</div>
        <label>Add location to {compartment.label || `compartment ${c + 1}`}<select value="" disabled={busy || assigned.size >= 200} onChange={e => { if (e.target.value) change(draft => { draft.drawers[d].compartments[c].locations.push(e.target.value); }); }}><option value="">Choose an unplaced location…</option>{state.parts.filter(p => !assigned.has(p.location)).map(p => <option key={p.id} value={p.location}>{p.location} · {p.name}{p.sample ? ' (sample)' : ''}</option>)}</select></label>
      </div>)}
      <button type="button" className="text-button" disabled={busy || drawer.compartments.length >= 20 || compartmentCount >= 100} onClick={() => change(draft => { draft.drawers[d].compartments.push({ id: crypto.randomUUID(), label: `Compartment ${drawer.compartments.length + 1}`, locations: [] }); })}><Plus size={15} />Add compartment</button>
    </fieldset>)}
    <button type="button" className="button secondary add-drawer" disabled={busy || map.drawers.length >= 30 || compartmentCount >= 100} onClick={() => change(draft => { draft.drawers.push({ id: crypto.randomUUID(), label: `Drawer ${map.drawers.length + 1}`, compartments: [{ id: crypto.randomUUID(), label: 'Compartment 1', locations: [] }] }); })}><Plus size={16} />Add drawer</button>
    <p className="small muted">Removing a drawer or compartment unplaces its locations. This schematic describes arrangement, not physical dimensions.</p>{error && <p className="inline-error" role="alert">{error}</p>}<div className="form-actions"><button type="button" className="button secondary" onClick={onClose}>Cancel</button><button className="button primary" disabled={busy}>{busy ? 'Saving…' : 'Save diagram'}</button></div>
  </form></Dialog>;
}
