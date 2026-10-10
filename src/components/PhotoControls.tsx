import { useState } from 'react';
import { Camera, Trash2 } from 'lucide-react';
import type { Part } from '../../shared/types';
import type { RunAction } from './PartForm';
export interface PhotoUploadOutcome { saved: boolean; error?: string; uncertain?: boolean }

export function PhotoControls({ part, busy, mutationBusy, run, upload }: { part: Part; busy: boolean; mutationBusy?: boolean; run: RunAction; upload: (partId: string, file: File) => Promise<PhotoUploadOutcome> }) {
  const [error, setError] = useState('');
  const [missing, setMissing] = useState<string | null>(null);
  return <section className="detail-section part-photo-section"><div className="split"><h3>Part photo</h3><Camera size={18} /></div>
    {part.photoId && missing !== part.photoId ? <img className="part-photo-large" src={`/api/media/${encodeURIComponent(part.photoId)}`} alt={`${part.name} uploaded photo`} onError={() => setMissing(part.photoId!)} /> : <div className="photo-empty"><Camera size={26} /><p>{part.photoId ? 'Photo unavailable. Replace it with a saved photo.' : 'No part photo yet.'}</p></div>}
    <div className="photo-controls"><label className="photo-file-label">{part.photoId ? 'Replace photo' : 'Choose a photo'}<input type="file" aria-label="Upload part photo" accept="image/jpeg,image/png,image/webp" disabled={busy} onChange={async e => {
      const file = e.target.files?.[0]; e.target.value = ''; setError('');
      if (!file) return;
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) { setError('Choose a JPEG, PNG or WebP photo.'); return; }
      if (file.size > 5 * 1024 * 1024) { setError('Photos must be 5 MB or smaller.'); return; }
      const result = await upload(part.id, file);
      if (!result.saved) setError(result.error ?? 'Photo not saved. Please try again.');
    }} /></label>
      {part.photoId && <button className="text-button remove-photo" disabled={mutationBusy ?? busy} onClick={async () => { setError(''); if (!await run({ type: 'remove_photo', partId: part.id })) setError('Photo removal was not confirmed.'); }}><Trash2 size={15} />Remove photo</button>}
    </div>
    <p className="small muted">Your actual part photo. JPEG, PNG or WebP, up to 5 MB and 24 megapixels. Photo uploads do not verify engineering specifications.</p>
    {error && <p role="alert" className="inline-error">{error}</p>}
  </section>;
}
