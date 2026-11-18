import { useRef, useState } from 'react';
import { Check, ImagePlus, Plus, Printer, Trash2 } from 'lucide-react';
import type { Ctx } from '../App';
import type { Part, PartInput } from '../../shared/types';
import { api, shrinkPhoto } from '../api';
import { Dot, Modal } from './ui';
import { LabelCard } from './LabelsPage';

export function PartForm({ ctx, part, onClose, onSaved }: { ctx: Ctx; part?: Part; onClose: () => void; onSaved: (id: string) => void }) {
  const { teams, cabinets } = ctx.state;
  const blank = (keep?: Partial<PartInput>): PartInput => ({
    name: '', detail: '', spot: '', orderQty: 50, supplier: '', link: '',
    teamId: keep?.teamId ?? (ctx.teamFilter !== 'all' ? ctx.teamFilter : ctx.state.me.teamId || teams[0]?.id || ''),
    cabinetId: keep?.cabinetId ?? cabinets[0]?.id ?? '',
  });
  const [v, setV] = useState<PartInput>(() => part ? { name: part.name, detail: part.detail, teamId: part.teamId, cabinetId: part.cabinetId, spot: part.spot, orderQty: part.orderQty, supplier: part.supplier, link: part.link, photo: part.photo } : blank());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<Part | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const set = <K extends keyof PartInput>(k: K, val: PartInput[K]) => setV(prev => ({ ...prev, [k]: val }));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!v.name.trim()) { setError('Give the part a name.'); nameRef.current?.focus(); return; }
    setBusy(true); setError('');
    try {
      if (part) { await api.editPart(part.id, v); await ctx.refresh(); ctx.notify('Changes saved'); onSaved(part.id); }
      else { const created = await api.addPart(v); await ctx.refresh(); setSaved(created); }
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }

  if (saved) return <Modal title="Part added" onClose={() => onSaved(saved.id)} footer={<>
    <button className="btn ghost" onClick={() => { setSaved(null); setV(blank(v)); }}><Plus aria-hidden />Add another</button>
    <button className="btn primary" onClick={() => { onClose(); ctx.printLabels([saved.id]); }}><Printer aria-hidden />Print label</button>
  </>}>
    <div className="saved">
      <p className="saved-msg"><span className="saved-check"><Check aria-hidden /></span><span><b>{saved.name}</b> is in the system. Print its label and stick it on the bin, right at the low line.</span></p>
      <div className="saved-label"><LabelCard ctx={ctx} part={saved} /></div>
    </div>
  </Modal>;

  return <Modal title={part ? 'Edit part' : 'Add a part'} onClose={onClose} wide footer={<>
    <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
    <button type="submit" form="part-form" className="btn primary" disabled={busy}>{busy ? 'Saving…' : part ? 'Save changes' : 'Save part'}</button>
  </>}>
    <form id="part-form" className="form" onSubmit={save} noValidate>
      <div className="form-top">
        <div className="photo-pick">
          {v.photo ? <>
            <img src={v.photo} alt="Part photo" />
            <button type="button" className="photo-remove" onClick={() => set('photo', undefined)} aria-label="Remove photo"><Trash2 /></button>
          </> : <button type="button" className="photo-add" onClick={() => fileRef.current?.click()}><ImagePlus aria-hidden /><span>Add photo</span><small>Optional</small></button>}
          <input ref={fileRef} type="file" accept="image/*" capture="environment" hidden onChange={async e => {
            const file = e.target.files?.[0]; e.target.value = '';
            if (file) try { set('photo', await shrinkPhoto(file)); } catch (err) { setError((err as Error).message); }
          }} />
        </div>
        <div className="form-fields">
          <label className="field"><span>Part name</span>
            <input ref={nameRef} value={v.name} onChange={e => set('name', e.target.value)} placeholder="e.g. Hex bolts" maxLength={120} required aria-invalid={error === 'Give the part a name.'} />
          </label>
          <label className="field"><span>Size or spec <i>optional</i></span>
            <input value={v.detail} onChange={e => set('detail', e.target.value)} placeholder="e.g. M6 x 20 mm" maxLength={120} />
          </label>
        </div>
      </div>

      <fieldset className="field">
        <legend>Team</legend>
        <div className="choice-row">
          {teams.map(t => <label key={t.id} className={`choice${v.teamId === t.id ? ' on' : ''}`}>
            <input type="radio" name="team" checked={v.teamId === t.id} onChange={() => set('teamId', t.id)} /><Dot color={t.color} />{t.name}
          </label>)}
        </div>
      </fieldset>

      <fieldset className="field">
        <legend>Where it's stored</legend>
        <div className="choice-row">
          {cabinets.map(c => <label key={c.id} className={`choice${v.cabinetId === c.id ? ' on' : ''}`}>
            <input type="radio" name="cabinet" checked={v.cabinetId === c.id} onChange={() => set('cabinetId', c.id)} /><Dot color={c.color} />{c.name}
          </label>)}
        </div>
        <input className="spot-input" value={v.spot} onChange={e => set('spot', e.target.value)} placeholder="Drawer or shelf (optional), e.g. Drawer 3" maxLength={40} aria-label="Drawer or shelf" />
      </fieldset>

      <div className="form-grid">
        <label className="field"><span>Order this many when low</span>
          <input type="number" inputMode="numeric" min={1} value={v.orderQty || ''} onChange={e => set('orderQty', Number(e.target.value))} />
        </label>
        <label className="field"><span>Supplier <i>optional</i></span>
          <input value={v.supplier} onChange={e => set('supplier', e.target.value)} placeholder="e.g. McMaster-Carr" maxLength={80} />
        </label>
        <label className="field span-2"><span>Product link <i>optional</i></span>
          <input type="url" value={v.link} onChange={e => set('link', e.target.value)} placeholder="Paste the page you buy it from" maxLength={500} />
        </label>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
    </form>
  </Modal>;
}
