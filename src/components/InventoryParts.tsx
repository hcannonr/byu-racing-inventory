import { ArrowRight, Columns3, LayoutGrid, List } from 'lucide-react';
import { activeRequest, availableReceived, requestStatus, type InventoryState, type Part } from '../../shared/types';
import type { InventoryLayout } from '../api';
import { BinVisual, PartIcon, PartStatus } from './Visuals';
import { inventoryCategories, locationSection } from '../../shared/organization';

export function InventoryViewSwitch({ layout, onChange }: { layout: InventoryLayout; onChange: (layout: InventoryLayout) => void }) {
  return <div className="today-view-switch inventory-view-switch" role="group" aria-label="Inventory layout">{([
    ['cards', 'Cards', LayoutGrid], ['cabinet', 'Cabinet', Columns3], ['category', 'By category', List],
  ] as const).map(([value, label, Icon]) => <button key={value} aria-pressed={layout === value} onClick={() => onChange(value)}><Icon size={16} />{label}</button>)}</div>;
}

export function InventoryParts({ parts, state, layout, showEmptyGroups = false, onPart, onLocate }: {
  parts: Part[]; state: InventoryState; layout: InventoryLayout; showEmptyGroups?: boolean; onPart: (id: string) => void; onLocate: (location: string) => void;
}) {
  function card(part: Part) {
    const request = activeRequest(state, part.id);
    const status = request ? requestStatus(state, request) : null;
    const order = request ? state.orders.filter(order => order.requestId === request.id && !order.voidedAt && order.status !== 'arrived').at(-1) : null;
    const canRefill = !!request && availableReceived(state, request.id) >= part.binQuantity && part.bins.some(bin => bin.status === 'empty');
    const action = canRefill ? 'Refill bin' : status === 'needs_order' ? 'Record order' : order ? 'Track order' : request ? 'Review request' : 'View part';
    return <article className={`inventory-part ${part.bins.every(bin => bin.status === 'empty') ? 'urgent' : ''}`} key={part.id} aria-label={part.name}>
      <div className="inventory-part-top"><button className="location-tag location-link" aria-label={`Locate ${part.name} in cabinet`} onClick={() => onLocate(part.location)}>{part.location.replace('BLUE-', '')}</button><PartStatus part={part} state={state} /></div>
      <div className="inventory-part-title"><PartIcon part={part} /><div><h2><button onClick={() => onPart(part.id)}>{part.name}</button></h2><p>{part.specification.replace(' · example specification', '')}</p></div></div>
      <div className="inventory-bin-pair">{part.bins.map((bin, index) => <BinVisual key={bin.id} bin={bin} index={index} large={layout === 'cards'} />)}</div>
      <button className={`button inventory-part-action ${request ? 'primary' : 'secondary'}`} onClick={() => onPart(part.id)} aria-label={`${request ? 'Manage' : 'View'} ${part.name}`}>{action}<ArrowRight size={16} /></button>
    </article>;
  }
  if (layout === 'cards') return <div className="inventory-cards">{parts.map(card)}</div>;
  if (layout === 'category') return <div className="inventory-categories">{(showEmptyGroups ? inventoryCategories(state) : [...new Set(parts.map(part => part.category))]).map(category => {
    const group = parts.filter(part => part.category === category);
    return <section className="inventory-category" key={category} aria-label={category}><header><h2>{category}</h2><span>{group.length} {group.length === 1 ? 'part' : 'parts'}</span></header><div className="inventory-category-rows">{group.length ? group.map(card) : <p className="inventory-group-empty">No parts yet</p>}</div></section>;
  })}</div>;
  // Respect configured drawer assignments. Without a map, group by location code,
  // not an assumed physical drawer arrangement.
  const assigned = new Set(state.cabinetMap?.drawers.flatMap(drawer => drawer.compartments.flatMap(compartment => compartment.locations)) ?? []);
  const groups = state.cabinetMap?.drawers.map(drawer => ({ id: drawer.id, label: drawer.label, parts: parts.filter(part => drawer.compartments.some(compartment => compartment.locations.includes(part.location))) })) ?? [];
  const unplaced = parts.filter(part => !assigned.has(part.location));
  if (groups.length) groups.push({ id: '__unplaced', label: 'Unplaced locations', parts: unplaced });
  else for (const prefix of [...new Set(parts.map(part => locationSection(part.location)))].sort()) {
    groups.push({ id: prefix, label: prefix === 'Other' ? 'Other locations' : `Locations ${prefix}`, parts: parts.filter(part => (locationSection(part.location)) === prefix) });
  }
  return <div className="inventory-cabinet">{groups.filter(group => group.parts.length || showEmptyGroups && group.id !== '__unplaced').map(group => <section className="inventory-cabinet-column" key={group.id} aria-label={group.label}><header><h2>{group.label}</h2><span>{group.parts.length}</span></header>{[...group.parts].sort((a, b) => a.location.localeCompare(b.location, undefined, { numeric: true })).map(card)}{!group.parts.length && <p className="inventory-group-empty">No parts yet</p>}</section>)}</div>;
}
