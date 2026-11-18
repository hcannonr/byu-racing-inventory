import { useState } from 'react';
import { ExternalLink, ShoppingCart } from 'lucide-react';
import type { Part } from '../../shared/types';
import { Modal, PartThumb } from './ui';

export function OrderDialog({ part, onClose, onDone }: { part: Part; onClose: () => void; onDone: (note: string) => void }) {
  const [note, setNote] = useState('');
  return <Modal title="Mark as ordered" onClose={onClose} footer={<>
    <button className="btn ghost" onClick={onClose}>Cancel</button>
    <button className="btn primary" type="submit" form="order-form"><ShoppingCart aria-hidden />Mark ordered</button>
  </>}>
    <form id="order-form" className="form" onSubmit={e => { e.preventDefault(); onDone(note); }}>
      <div className="order-part">
        <PartThumb part={part} />
        <div><strong>{part.name}</strong><small>{part.detail}</small></div>
        <span className="order-qty"><b>{part.orderQty}</b><small>to order</small></span>
      </div>
      {part.link && <a className="btn ghost full" href={part.link} target="_blank" rel="noreferrer"><ExternalLink aria-hidden />Open {part.supplier || 'supplier'}</a>}
      <label className="field"><span>Note <i>optional</i></span>
        <input value={note} onChange={e => setNote(e.target.value)} placeholder="Order number or when it arrives" maxLength={80} />
      </label>
    </form>
  </Modal>;
}
