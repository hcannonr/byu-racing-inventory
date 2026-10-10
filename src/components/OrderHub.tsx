import { useState, type CSSProperties } from 'react';
import { ArrowUpRight, Search } from 'lucide-react';
import { activeRequest, availableReceived, quantityToBuy, requestOrders, type InventoryState, type Part, type PurchaseOrder } from '../../shared/types';
import { dateLabel } from './Visuals';
import { TrackingSummary } from './OrderDialogs';
import { purchaseEstimate, supplierShoppingLists, usd, type SupplierShoppingList } from '../../shared/purchasing';
import { InvoicePrices } from './OrderImportDialog';
import { Dialog } from './Dialog';
import type { PartDetailAction } from './PartDetail';

export function OrderHub({ state, busy, onPurchase, onSupplier, onManage, onUndo, onTracking, onCheckout, onImport }: {
  state: InventoryState; busy: boolean; onPurchase: (part: Part) => void;
  onSupplier: (part: Part) => void; onManage: (partId: string, action?: PartDetailAction) => void;
  onUndo: (order: PurchaseOrder, part: Part) => void; onTracking: (order: PurchaseOrder, part: Part) => void;
  onCheckout: (group: SupplierShoppingList) => void; onImport?: () => void;
}) {
  const [search, setSearch] = useState('');
  const [shoppingKey, setShoppingKey] = useState<string | null>(null);
  const matches = (part: Part, extra = '') => `${part.name} ${part.specification} ${part.supplier} ${part.location} ${extra}`.toLowerCase().includes(search.toLowerCase());
  const toBuy = state.parts.filter(part => quantityToBuy(state, part) > 0);
  const toRefill = state.parts.filter(part => {
    const request = activeRequest(state, part.id);
    return request && part.bins.some(bin => bin.status === 'empty') && availableReceived(state, request.id) >= part.binQuantity;
  });
  const purchases = state.orders.filter(order => !order.voidedAt).slice().reverse().flatMap(order => {
    const part = state.parts.find(part => part.id === state.requests.find(r => r.id === order.requestId)?.partId);
    return part ? [{ order, part }] : [];
  });
  const undone = state.orders.filter(order => order.voidedAt).slice().reverse();
  const supplierGroups = supplierShoppingLists(state, toBuy.filter(part => matches(part)));
  const shopping = supplierShoppingLists(state, toBuy).find(group => group.key === shoppingKey);
  const visibleRefill = toRefill.filter(part => matches(part));
  const visiblePurchases = purchases.filter(({ part, order }) => matches(part, `${order.reference} ${order.supplier} ${order.tracking?.number ?? ''}`));
  const partName = (part: Part) => <><button className="stage-part-name" onClick={() => onManage(part.id)}>{part.name}</button><p className="stage-spec">{part.specification.replace(' · example specification', '')}</p></>;
  const productLink = (part: Part, label = 'Buy Here') => part.supplierUrl
    ? <a className="button secondary" href={part.supplierUrl} target="_blank" rel="noopener noreferrer">{label}<ArrowUpRight size={13} /></a>
    : <button className="button secondary" disabled={busy} onClick={() => { setShoppingKey(null); onSupplier(part); }}>Add supplier link</button>;

  return <section className="order-hub stage-hub" aria-label="Order hub">
    <div className="stage-hub-heading"><h1>Order Hub</h1>{onImport && <button className="button secondary" disabled={busy} onClick={onImport}>Import order</button>}</div>
    <div className="stage-hub-tools"><span className="stage-all">All stages</span><label className="search-field"><Search size={18} /><input type="search" aria-label="Search orders" placeholder="Part, supplier, or order number" value={search} onChange={e => setSearch(e.target.value)} /></label></div>
    <div className="stage-scroll" role="region" aria-label="Order stages" tabIndex={0}>
      <div className="stage-board" style={{ '--suppliers': Math.max(1, supplierGroups.length) } as CSSProperties}>
        <section className="stage-lane stage-buy" aria-label="To buy"><header><h2>To buy</h2><span>{supplierGroups.reduce((n, group) => n + group.parts.length, 0)}</span></header>
          <div className="stage-suppliers">{supplierGroups.map(group => <section className="stage-supplier" aria-label={`Shopping list for ${group.supplier}`} key={group.key}>
            <header><h3>{group.supplier}</h3><button className="text-button" onClick={() => setShoppingKey(group.key)}>Shop supplier <ArrowUpRight size={12} /></button></header>
            {group.parts.map(part => {
              const request = activeRequest(state, part.id)!;
              const received = availableReceived(state, request.id);
              const incoming = requestOrders(state, request.id).reduce((sum, order) => sum + order.quantity - order.received, 0);
              const urgent = part.bins.every(bin => bin.status === 'empty');
              const needed = quantityToBuy(state, part);
              const estimate = purchaseEstimate(needed, part.purchasePack);
              return <article className={`stage-card ${urgent ? 'urgent' : ''}`} aria-label={`Buy ${part.name}`} key={part.id}>
                {partName(part)}<div className="stage-meta"><span>{part.location.replace('BLUE-', '')}</span>{urgent && <span className="badge danger">Both bins empty</span>}</div>
                <div className="stage-quantity"><strong>{needed} {part.unit}</strong>{(received > 0 || incoming > 0) && <small>{received} ready · {incoming} on order</small>}<small>{part.purchasePack ? `${estimate.packs} × ${part.purchasePack.size}-pack` : 'Pack size unknown'} · {estimate.totalCents !== undefined ? usd(estimate.totalCents) : 'Price needed'}</small></div>
                <div className="stage-actions">{productLink(part)}<button className="button primary" disabled={busy} onClick={() => onPurchase(part)}>Mark purchased</button></div>
              </article>;
            })}<footer><button className="text-button" disabled={busy} onClick={() => onCheckout(group)}>Confirm checkout <span aria-hidden="true">→</span></button></footer>
          </section>)}{!supplierGroups.length && <p className="stage-empty">{search ? 'No matching parts' : 'Nothing to buy'}</p>}</div>
        </section>
        <section className="stage-lane" aria-label="Purchased"><header><h2>Purchased</h2><span>{visiblePurchases.length}</span></header>
          {visiblePurchases.map(({ order, part }) => <article className="stage-card" aria-label={`Purchase for ${part.name}`} key={order.id}>
            {partName(part)}<div className="stage-meta"><span>{part.location.replace('BLUE-', '')}</span><span>{order.reference || order.supplier}</span><span className={`badge ${order.received === order.quantity ? 'arrived' : order.status}`}>{order.received === order.quantity ? 'Received' : order.received ? 'Part received' : order.status === 'in_transit' ? 'In transit' : 'Purchased'}</span></div>
            <div className="stage-quantity"><strong>{order.received} / {order.quantity} {part.unit} received</strong><small>{order.eta ? `Due ${dateLabel(order.eta)}` : 'No ETA'}</small><div className="receipt-progress" aria-label={`${order.received} of ${order.quantity} received`}><span style={{ width: `${order.received / order.quantity * 100}%` }} /></div></div>
            <div className="stage-actions"><button className={`button ${order.received < order.quantity ? 'primary' : 'secondary'}`} disabled={busy} onClick={() => onManage(part.id, order.received < order.quantity ? {kind:'receive',orderId:order.id} : undefined)}>{order.received < order.quantity ? 'Record receipt' : 'View part'}</button><button className="button secondary" disabled={busy} onClick={() => onTracking(order, part)}>{order.tracking ? 'Edit tracking' : 'Add tracking'}</button></div>
            {order.tracking && <TrackingSummary order={order} />}
            <details className="stage-order-more"><summary>Order details</summary><p>{order.supplier} · {order.reference || 'No order number'}</p>{order.purchasePack && <p>{order.purchasePack.packs !== undefined ? `${order.purchasePack.packs} packs · ` : ''}{order.purchasePack.size} units per pack{order.purchasePack.priceCents !== undefined ? ` · ${usd(order.purchasePack.priceCents)} per pack` : ''}</p>}{order.orderImport && <InvoicePrices prices={order.orderImport.prices} />}<button className="text-button undo-action" disabled={busy || order.received > 0} title={order.received > 0 ? 'Received parts cannot be undone.' : undefined} onClick={() => onUndo(order, part)}>Undo purchase</button><button className="text-button" onClick={() => onManage(part.id)}>View part</button></details>
          </article>)}{!visiblePurchases.length && <p className="stage-empty">{search ? 'No matching purchases' : 'No purchases yet'}</p>}
        </section>
        <section className="stage-lane" aria-label="To refill"><header><h2>To refill</h2><span>{visibleRefill.length}</span></header>
          {visibleRefill.map(part => <article className="stage-card" aria-label={`Refill ${part.name}`} key={part.id}>
            {partName(part)}<div className="stage-meta"><span>{part.location.replace('BLUE-', '')}</span><span className="badge arrived">Ready to refill</span></div><div className="stage-quantity"><strong>{availableReceived(state, activeRequest(state, part.id)!.id)} {part.unit}</strong><small>{part.binQuantity} per bin</small></div>
            <div className="stage-actions"><button className="button primary" disabled={busy} onClick={() => { const bin = part.bins.find(bin => bin.status === 'empty')!; onManage(part.id,{kind:'refill',binId:bin.id,cycle:bin.cycle}); }}>Refill bin</button><button className="button secondary" onClick={() => onManage(part.id)}>Details</button></div>
          </article>)}{!visibleRefill.length && <p className="stage-empty">{search ? 'No matching parts' : 'No bins ready to refill'}</p>}
        </section>
      </div>
    </div>
    {undone.length > 0 && <details className="detail-more"><summary>Undone purchases ({undone.length})</summary><div className="undone-list">{undone.map(order => {
      const part = state.parts.find(p => p.id === state.requests.find(r => r.id === order.requestId)?.partId);
      return <div key={order.id}><strong>{part?.name ?? 'Part'}</strong><span>{order.quantity} {part?.unit} · {order.supplier} · {order.reference || 'No order number'}</span><span className="badge neutral">Undone</span></div>;
    })}</div></details>}
    {shoppingKey !== null && <Dialog title={shopping?.supplier ?? 'Supplier shopping list'} onClose={() => setShoppingKey(null)}><div className="stage-shopping"><p className="muted small">Open each product, add the quantities to the supplier’s cart, then check out on their website.</p>{shopping?.parts.map(part => { const estimate = purchaseEstimate(quantityToBuy(state,part),part.purchasePack); return <article key={part.id}><div><strong>{part.name}</strong><small>{part.purchasePack ? `${estimate.packs} × ${part.purchasePack.size}-pack` : `${estimate.quantity} ${part.unit}`}</small></div>{productLink(part,'Open product')}<button className="text-button" disabled={busy} onClick={() => {setShoppingKey(null);onSupplier(part);}}>Edit link</button></article>; })}{shopping ? <button className="text-button" disabled={busy} onClick={() => {setShoppingKey(null);onCheckout(shopping);}}>Record purchase →</button> : <p>Nothing left to buy from this supplier.</p>}</div></Dialog>}
  </section>;
}
