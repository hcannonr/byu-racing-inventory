import { useEffect, useState } from 'react';
import { ArrowRight, Pencil } from 'lucide-react';
import type { CabinetMap as MapData, InventoryState } from '../../shared/types';
import { CabinetSetup } from './InventorySetup';
import { PartStatus } from './Visuals';
export function CabinetMap({ state, focusedLocation, busy, onPart, onSave }: {
  state: InventoryState; focusedLocation: string | null; busy: boolean;
  onPart: (id: string) => void; onSave: (map: MapData, revision: number) => Promise<boolean>;
}) {
  const [editor, setEditor] = useState<InventoryState | null>(null);
  const sections = state.cabinetMap?.drawers ?? [];
  const placed = new Set(sections.flatMap(section => section.compartments.flatMap(c => c.locations)));
  const groups = sections.map(section => ({ id: section.id, label: section.label, parts: state.parts.filter(part => section.compartments.some(c => c.locations.includes(part.location))) }));
  const unplaced = state.parts.filter(part => !placed.has(part.location));
  if (unplaced.length) groups.push({ id: 'unplaced', label: 'Not assigned to a section', parts: unplaced });
  useEffect(() => { if (focusedLocation) document.getElementById(`cabinet-${focusedLocation}`)?.scrollIntoView?.({ block: 'center' }); }, [focusedLocation]);
  return <section className="cabinet-map-view simple-cabinet" aria-label="Cabinet sections">
    <div className="cabinet-map-toolbar"><div><h2>{state.cabinetMap?.name ?? 'Blue cabinet'}</h2><p className="muted">Find a part by its section.</p></div><button className="button secondary" disabled={busy} onClick={() => setEditor(structuredClone(state))}><Pencil size={16} />Set up cabinet</button></div>
    {!groups.length && <p className="empty-state">Add cabinet sections, then place your parts.</p>}
    <div className="simple-cabinet-sections">{groups.map(group => <section className="simple-cabinet-section" key={group.id} aria-label={group.label}>
      <header><h3>{group.label}</h3><span>{group.parts.length} {group.parts.length === 1 ? 'part' : 'parts'}</span></header>
      {!group.parts.length && <p className="muted">No parts yet.</p>}
      {group.parts.map(part => <button id={`cabinet-${part.location}`} key={part.id} className={`cabinet-part-link ${part.location === focusedLocation ? 'focused' : ''}`} onClick={() => onPart(part.id)}><span><strong>{part.name}</strong><small>{part.location}</small></span><PartStatus part={part} state={state} /><ArrowRight size={16} /></button>)}
    </section>)}</div>
    {editor && <CabinetSetup state={editor} busy={busy} onClose={() => setEditor(null)} onSave={action => action.type === 'save_cabinet_map' ? onSave(action.map, editor.revision) : Promise.resolve(false)} />}
  </section>;
}
