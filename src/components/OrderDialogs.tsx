import { accountHeaders } from '../api';
import { useState, type FormEvent } from 'react';
import { ArrowUpRight, RefreshCw, Truck } from 'lucide-react';
import { carriers, type Part, type PurchaseOrder } from '../../shared/types';
import { trackingLink } from '../../shared/tracking';
import { Dialog } from './Dialog';
import type { RunAction } from './PartForm';

export function TrackingSummary({ order }: { order: PurchaseOrder }) {
  const [checking, setChecking] = useState(false);
  const [feedback, setFeedback] = useState('');
  if (!order.tracking) return null;
  const delivery = order.delivery;
  const labels: Record<string, string> = { pending: 'Waiting for carrier', info_received: 'Label created', in_transit: 'In transit', out_for_delivery: 'Out for delivery', delivered: 'Delivered', failed_attempt: 'Delivery attempted', available_for_pickup: 'Ready for pickup', exception: 'Delivery issue', return: 'Returning to sender' };
  async function refresh() {
    setChecking(true); setFeedback('');
    try {
      const response = await fetch(`/api/tracking/${encodeURIComponent(order.id)}/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...accountHeaders() }, body: '{}', signal: AbortSignal.timeout(10_000) });
      const data = await response.json();
      setFeedback(response.ok ? data.message : data.error || 'Could not request an update.');
    } catch { setFeedback('Could not reach the server. Try again.'); }
    finally { setChecking(false); }
  }
  return <div className="tracking-summary">
    <span><Truck size={15} />{order.tracking.carrier} <code>{order.tracking.number}</code></span>
    <a className="text-button" href={trackingLink(order.tracking)} target="_blank" rel="noopener noreferrer">Track package <ArrowUpRight size={14} /></a>
    {order.tracking.live ? <div className="delivery-update">
      <strong className={`delivery-label ${delivery?.status === 'delivered' ? 'delivered' : ''}`}>{labels[delivery?.status ?? 'pending'] ?? 'Carrier update'}</strong>
      {delivery?.eta && <small>Estimated delivery {new Date(delivery.eta).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</small>}
      <small>{delivery?.checkedAt ? `Checked ${new Date(delivery.checkedAt).toLocaleString()}` : 'First check pending'} · Ship24</small>
      {delivery?.error && <p className="tracking-error" role="status">{delivery.error}</p>}
      {delivery?.status === 'delivered' && <small>Confirm received quantities before refilling bins.</small>}
      {!!delivery?.events.length && <details><summary>Delivery history</summary><ul>{delivery.events.map((event, index) => <li key={`${event.id}-${index}`}><span>{event.message}</span><small>{new Date(event.at).toLocaleString()}</small></li>)}</ul></details>}
      <button className="text-button" disabled={checking} onClick={() => void refresh()}><RefreshCw size={13} />{checking ? 'Requesting…' : 'Check for update'}</button>
      {feedback && <small role="status">{feedback}</small>}
    </div> : <small>Carrier link only · Live updates off</small>}
  </div>;
}

export function TrackingDialog({ order, part, busy, run, onClose, connected = false }: { order: PurchaseOrder; part: Part; busy: boolean; run: RunAction; onClose: () => void; connected?: boolean }) {
  const [tracking, setTracking] = useState(order.tracking ?? { carrier: 'UPS' as const, number: '', url: '' });
  const [error, setError] = useState('');
  async function save(event: FormEvent) {
    event.preventDefault(); setError('');
    if (await run({ type: 'save_tracking', orderId: order.id, tracking })) onClose();
    else setError('Tracking not saved. If inventory changed, close and reopen this form.');
  }
  return <Dialog title="Package tracking" onClose={onClose}>
    <form className="form-stack" onSubmit={save}>
      <div><h2>{part.name}</h2><p className="muted">{order.supplier} · {order.reference || 'Purchase order'}</p></div>
      <label>Carrier<select value={tracking.carrier} onChange={e => setTracking({ ...tracking, carrier: e.target.value as typeof tracking.carrier, url: '' })}>{carriers.map(carrier => <option key={carrier}>{carrier}</option>)}</select></label>
      <label>Tracking number<input autoFocus required maxLength={100} value={tracking.number} onChange={e => setTracking({ ...tracking, number: e.target.value })} placeholder="From the shipping confirmation" /></label>
      <label>Tracking link {tracking.carrier !== 'Other' && <span className="optional">optional</span>}<input type="url" required={tracking.carrier === 'Other'} maxLength={2000} value={tracking.url} onChange={e => setTracking({ ...tracking, url: e.target.value })} placeholder={tracking.carrier === 'Other' ? 'https://carrier.com/track/…' : 'Leave blank to use the carrier’s page'} /></label>
      <label className="check-label"><input type="checkbox" checked={tracking.live ?? false} disabled={!connected && !tracking.live} onChange={e => setTracking({ ...tracking, live: e.target.checked })} /><span>Enable live delivery updates<p className="muted small">{connected ? 'Uses your Ship24 shipment allowance. Checks every 5 minutes while the server is running. Leave off for practice numbers.' : 'Ship24 is not configured on this server. You can still save a carrier link.'}</p></span></label>
      {error && <p className="inline-error" role="alert">{error}</p>}
      <div className="form-actions"><button type="button" className="button secondary" onClick={onClose}>Cancel</button><button className="button primary" disabled={busy}>Save tracking</button></div>
    </form>
  </Dialog>;
}

export function UndoPurchaseDialog({ order, part, busy, run, onClose }: { order: PurchaseOrder; part: Part; busy: boolean; run: RunAction; onClose: () => void }) {
  return <Dialog title="Undo purchase" onClose={onClose}>
    <div className="form-stack"><h2>Marked purchased by mistake?</h2><p>{part.name} · {order.quantity} {part.unit} from {order.supplier}</p>
      <p>This removes the purchase from active orders and recalculates what still needs buying. It does not cancel an order with the supplier.</p>
      <p className="muted small">A record of this correction stays in the activity history.</p>
      <div className="form-actions"><button className="button secondary" onClick={onClose}>Keep purchase</button><button className="button danger-button" disabled={busy} onClick={() => void run({ type: 'undo_purchase', orderId: order.id })}>Yes, undo purchase</button></div>
    </div>
  </Dialog>;
}
