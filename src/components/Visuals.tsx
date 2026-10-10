import { Check, Minus, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { activeRequest, requestStatus, statusLabels, type Bin, type InventoryState, type Part } from '../../shared/types';

export function BinVisual({ bin, index, large = false }: { bin: Bin; index: number; large?: boolean }) {
  const empty = bin.status === 'empty';
  const label = empty ? 'Empty' : bin.status === 'in_use' ? 'In use' : 'Reserve';
  return <div className={`bin-unit ${bin.status} ${large ? 'large' : ''}`} aria-label={`Bin ${index + 1}: ${label}`}>
    <div className="bin-art">
      <div className={`inventory-art art-${empty ? 'empty' : bin.status === 'in_use' ? 'active' : 'reserve'}`} aria-hidden="true" />
      <small className="bin-number" aria-hidden="true">{index + 1}</small>
    </div>
    <span>{empty ? <Minus size={10} /> : bin.status === 'ready' ? <Check size={10} /> : <i />}{label}</span>
  </div>;
}

export function PartIcon({ part }: { part: Part }) {
  const [failedPhoto, setFailedPhoto] = useState<string | null>(null);
  const category = part.category === 'Electrical' ? 'electrical' : part.category === 'Workshop' ? 'workshop' : 'fastener';
  if (part.photoId && failedPhoto !== part.photoId) return <div className="part-icon uploaded-photo"><img src={`/api/media/${encodeURIComponent(part.photoId)}`} alt={`${part.name} photo`} loading="lazy" onError={() => setFailedPhoto(part.photoId!)} /></div>;
  return <div className={`part-icon ${category}`} aria-hidden="true"><div className={`inventory-art art-${category}`} /></div>;
}

export function PartStatus({ part, state }: { part: Part; state: InventoryState }) {
  const r = activeRequest(state, part.id);
  if (part.bins.every(b => b.status === 'empty')) return <span className="badge danger"><TriangleAlert size={12} />Out of stock</span>;
  if (!r) return <span className="badge good"><Check size={12} />Stocked</span>;
  const status = requestStatus(state, r);
  return <span className={`badge ${status}`}>{statusLabels[status]}</span>;
}

export function relativeTime(value: string) {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
export function dateLabel(value: string) {
  return value ? new Date(`${value}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : 'No ETA';
}
