import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ClipboardCheck, FileUp, LoaderCircle, ScanText } from 'lucide-react';
import { activeRequest, type InventoryState, type PurchaseBatchAction, type PurchaseBatchLine } from '../../shared/types';
import { invoicePriceSchema, type OrderImportConfiguration, type OrderImportDraft, type InvoicePrice } from '../../shared/orderImport';
import { extractOrderDocument, getOrderImportConfiguration } from '../api';
import { Dialog } from './Dialog';

interface ReviewLine { id: string; included: boolean; partId: string; quantity: string; basis: string; size: string; price: string; priceBasis: InvoicePrice['basis'] }
export function InvoicePrices({ prices }: { prices: InvoicePrice[] }) {
  return <>{prices.length ? prices.map((price, index) => <small className="invoice-price" key={index}>Invoice: {price.amount} {price.currency || '(currency unknown)'} {price.basis === 'unknown' ? '(price basis unknown)' : price.basis === 'line' ? 'line total' : `per ${price.basis}`}</small>) : <small className="invoice-price">Invoice price unknown</small>}</>;
}
export function OrderImportDialog({ state, busy, pendingImportId, onClose, onRecord }: {
  state: InventoryState; busy: boolean; pendingImportId?: string; onClose: () => void; onRecord: (action: PurchaseBatchAction, revision: number) => Promise<boolean>;
}) {
  const [configuration, setConfiguration] = useState<OrderImportConfiguration | null>(null);
  const [mode, setMode] = useState<'text' | 'file'>('text'); const [text, setText] = useState(''); const [file, setFile] = useState<File | null>(null);
  const [extracting, setExtracting] = useState(false); const [error, setError] = useState(''); const [draft, setDraft] = useState<OrderImportDraft | null>(null);
  const [lines, setLines] = useState<ReviewLine[]>([]); const [supplier, setSupplier] = useState(''); const [reference, setReference] = useState(''); const [eta, setEta] = useState(''); const [currency, setCurrency] = useState('');
  const [reviewed, setReviewed] = useState(false); const [combine, setCombine] = useState(false); const [missingReference, setMissingReference] = useState(false); const [revision, setRevision] = useState(state.revision);
  const heading = useRef<HTMLHeadingElement>(null); const mounted = useRef(true);
  const body = useRef<HTMLDivElement>(null); const feedback = useRef<HTMLParagraphElement>(null);
  useEffect(() => { mounted.current = true; void getOrderImportConfiguration().then(value => { if (mounted.current) setConfiguration(value); }).catch(() => { if (mounted.current) setError('Could not load AI setup. Close and reopen the importer to try again.'); }); return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (draft) heading.current?.focus(); }, [draft]);
  useEffect(() => {
    if (!error || !feedback.current || !body.current) return;
    const viewport = body.current.getBoundingClientRect(); const message = feedback.current.getBoundingClientRect();
    if (message.bottom > viewport.bottom) body.current.scrollTop += message.bottom - viewport.bottom + 16;
    else if (message.top < viewport.top) body.current.scrollTop += message.top - viewport.top - 16;
    feedback.current.focus({ preventScroll: true });
  }, [error]);
  const alreadyRecorded = !!draft && state.orders.some(order => order.orderImport?.id === draft.importId);
  const submitted = !!draft && (pendingImportId === draft.importId || alreadyRecorded);
  const stale = !!draft && state.revision !== revision && !alreadyRecorded;
  function changeLine(index: number, patch: Partial<ReviewLine>) { setReviewed(false); setError(''); setLines(previous => previous.map((line, i) => i === index ? { ...line, ...patch } : line)); }
  async function extract() {
    setError(''); const source = mode === 'text' ? text : file;
    if (!source || typeof source === 'string' && !source.trim()) { setError('Choose a document or paste its confirmation text.'); return; }
    if (typeof source === 'string' ? source.length > (configuration?.maxText ?? 60000) : source.size > (configuration?.maxBytes ?? 10485760)) { setError('Use a document up to 10 MB or pasted text up to 60,000 characters.'); return; }
    setExtracting(true);
    try {
      const result = await extractOrderDocument(source); if (!mounted.current) return;
      setDraft(result); setRevision(result.inventoryRevision); setSupplier(result.extracted.supplier ?? ''); setReference(result.extracted.reference ?? ''); setEta(result.extracted.eta ?? ''); setCurrency(result.extracted.currency ?? '');
      setLines(result.extracted.lines.map((line, index) => ({ id: result.lines[index].id, included: true, partId: '', quantity: line.quantity === null ? '' : String(line.quantity), basis: line.quantityBasis, size: line.unitsPerPack === null ? '' : String(line.unitsPerPack), price: line.price ?? '', priceBasis: line.priceBasis })));
      setText(''); setFile(null); setReviewed(false); setCombine(false); setMissingReference(false);
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : 'Extraction failed. Try manual entry.'); }
    finally { if (mounted.current) setExtracting(false); }
  }
  function buildLines(): PurchaseBatchLine[] {
    const selected = lines.filter(line => line.included); if (!selected.length) throw new Error('Include at least one purchased line.');
    const groups = new Map<string, PurchaseBatchLine>();
    for (const line of selected) {
      const part = state.parts.find(part => part.id === line.partId); const request = part && activeRequest(state, part.id);
      if (!part || !request) throw new Error('Match each included line to a part with an open refill request, or exclude it.');
      const amount = Number(line.quantity); const size = Number(line.size);
      if (!Number.isSafeInteger(amount) || amount < 1 || amount > 1000000 || !['units', 'packs'].includes(line.basis)) throw new Error('Review each document quantity and choose units or packs.');
      if (line.size && (!Number.isSafeInteger(size) || size < 1 || size > 1000000) || line.basis === 'packs' && !line.size) throw new Error('Enter the stated units per pack before recording pack quantities.');
      const quantity = line.basis === 'packs' ? amount * size : amount;
      if (!Number.isSafeInteger(quantity) || quantity > 1000000) throw new Error('Each reviewed part supports up to 1,000,000 individual units.');
      const prices: InvoicePrice[] = [];
      if (line.price.trim()) {
        const price = invoicePriceSchema.safeParse({ amount: line.price.trim(), currency: currency.trim().toUpperCase() || null, basis: line.priceBasis });
        if (!price.success) throw new Error('Use a nonnegative decimal price with up to six decimal places and a three-letter currency, or leave unknown fields blank.');
        prices.push(price.data);
      }
      const pack = line.size ? { size, ...(quantity % size === 0 && { packs: quantity / size }) } : undefined;
      const existing = groups.get(request.id);
      if (existing) {
        if (!combine) throw new Error('Confirm combining repeated parts before recording. Review the combined individual units.');
        existing.quantity += quantity; if (existing.quantity > 1000000) throw new Error('Combined quantities exceed 1,000,000 individual units.');
        existing.importLine!.sourceLineIds.push(line.id); existing.importLine!.prices.push(...prices);
        if (!pack || pack.size !== existing.purchasePack?.size) delete existing.purchasePack;
        else existing.purchasePack = { size: pack.size, ...(existing.quantity % pack.size === 0 && { packs: existing.quantity / pack.size }) };
      } else groups.set(request.id, { requestId: request.id, quantity, ...(pack && { purchasePack: pack }), importLine: { sourceLineIds: [line.id], prices } });
    }
    return [...groups.values()];
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); setError(''); if (!draft || busy || alreadyRecorded) return;
    try {
      const checkoutLines = buildLines();
      if (!reviewed) throw new Error('Check the parts, units, prices, and order details before recording.');
      if (!reference.trim() && !missingReference) throw new Error('Confirm the missing order reference before recording.');
      if (!supplier.trim()) throw new Error('Enter the actual supplier.');
      const action: PurchaseBatchAction = { type: 'order_batch', supplier, reference, eta, lines: checkoutLines,
        orderImport: { id: draft.importId, reviewed: true, ...(!reference.trim() && { missingReferenceAcknowledged: true }) } };
      if (!await onRecord(action, revision)) setError('Purchase save needs review. Your entries are retained. Use the message above to resolve it.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Review the imported order.'); }
  }
  const selected = lines.filter(line => line.included);
  const duplicateParts = new Set(selected.filter(line => line.partId).map(line => line.partId)).size < selected.filter(line => line.partId).length;
  let summary: PurchaseBatchLine[] = []; try { summary = buildLines(); } catch { /* Validate at the explicit record attempt. */ }
  return <Dialog title="Import order" wide onClose={onClose}><form className="import-form" onSubmit={submit}>
    <div className="form-stack import-body" ref={body}>
      <div className="import-heading"><span className="eyebrow">{draft ? '02 / BUYER REVIEW' : '01 / EXTRACT A DRAFT'}</span><h2 ref={heading} tabIndex={-1}>{draft ? 'Review your order.' : 'Bring in your confirmation.'}</h2><p className="muted">{submitted ? 'Your reviewed purchase was submitted.' : draft ? 'Choose the exact parts and confirm what you bought. Nothing is recorded yet.' : 'Use a PDF, photo, screenshot, or confirmation text after buying from your supplier.'}</p></div>
      {!draft ? <>
        {configuration && !configuration.configured && <div className="import-setup"><strong>AI extraction needs server setup.</strong><p>Add OPENAI_API_KEY to the server environment and restart. Manual supplier checkout remains available.</p></div>}
        <div className="filter-tabs import-modes" aria-label="Import source"><button type="button" aria-pressed={mode === 'text'} className={mode === 'text' ? 'active' : ''} onClick={() => { setMode('text'); setError(''); }}>Paste text</button><button type="button" aria-pressed={mode === 'file'} className={mode === 'file' ? 'active' : ''} onClick={() => { setMode('file'); setError(''); }}>Upload file</button></div>
        {mode === 'text' ? <label>Order confirmation text<textarea value={text} onChange={e => setText(e.target.value)} maxLength={configuration?.maxText ?? 60000} rows={8} placeholder="Paste the supplier, order number, items, quantities, pack sizes, and prices…" /></label>
          : <label className="import-file"><FileUp size={25} /><span>Order confirmation file</span><input type="file" accept="application/pdf,image/jpeg,image/png,image/webp" onChange={e => { setFile(e.target.files?.[0] ?? null); setError(''); }} /><small>{file ? file.name : 'PDF up to 10 MB. JPEG, PNG, or WebP up to 5 MB.'}</small></label>}
        <p className="import-privacy">Clicking Extract sends this source to OpenAI. This app does not retain the original file or pasted text. Reviewed purchase fields are saved only after your confirmation.</p>
        {configuration && <p className="small muted">OpenAI · {configuration.model}. Check every extracted field.</p>}
      </> : <>
        {draft.issues.length > 0 && <div className="import-issues"><strong>Review needed</strong><ul>{draft.issues.map(issue => <li key={issue}>{issue}</li>)}</ul></div>}
        {alreadyRecorded && <div className="import-issues" role="status">This import is already recorded. If the save response was lost, use Retry safely to confirm it.</div>}
        {stale && <div className="import-issues"><strong>Inventory changed during this review.</strong><p>Check your matched parts and combined quantities again. Your entries are retained.</p><button type="button" className="button secondary small-button" disabled={busy} onClick={() => { setRevision(state.revision); setReviewed(false); setError(''); }}>Review current inventory</button></div>}
        <label>Actual supplier<input required maxLength={200} value={supplier} onChange={e => { setSupplier(e.target.value); setReviewed(false); }} /></label>
        <div className="form-grid"><label>Order reference<input maxLength={200} value={reference} onChange={e => { setReference(e.target.value); setReviewed(false); setMissingReference(false); }} placeholder="Unknown" /></label><label>Expected arrival<input type="date" value={eta} onChange={e => { setEta(e.target.value); setReviewed(false); }} /></label></div>
        <label>Invoice currency<input maxLength={3} value={currency} onChange={e => { setCurrency(e.target.value.toUpperCase()); setReviewed(false); }} placeholder="Unknown, e.g. USD or CAD" /><small>Leave blank when unknown. No exchange rate or currency conversion is applied.</small></label>
        <div className="import-lines">{lines.map((line, index) => {
          const source = draft.extracted.lines[index]; const part = state.parts.find(p => p.id === line.partId); const candidates = draft.lines[index].candidates;
          const parts = state.parts.filter(p => activeRequest(state, p.id)); const ordered = [...parts].sort((a, b) => Number(candidates.includes(b.id)) - Number(candidates.includes(a.id)));
          const units = line.basis === 'packs' && line.size ? Number(line.quantity) * Number(line.size) : line.basis === 'units' ? Number(line.quantity) : null;
          return <fieldset className={`checkout-line ${line.included ? '' : 'excluded'}`} key={line.id}>
            <legend className="sr-only">Source line {index + 1}</legend><label className="checkout-include"><input type="checkbox" aria-label={`Include source line ${index + 1}`} checked={line.included} onChange={e => changeLine(index, { included: e.target.checked })} /><strong>{index + 1}. {source.description}</strong></label>
            {source.supplierSku && <p className="small muted">Supplier item: {source.supplierSku}</p>}
            <label>Match part for line {index + 1}<select disabled={!line.included} value={line.partId} onChange={e => changeLine(index, { partId: e.target.value })}><option value="">Choose an exact catalog part…</option>{ordered.map(p => <option key={p.id} value={p.id}>{candidates.includes(p.id) ? 'Suggested: ' : ''}{p.name} · {p.location}</option>)}</select></label>
            <p className="small muted">{part ? `${part.specification} · inventory unit: ${part.unit}` : 'Suggestions are unverified. Select an exact match or exclude this line.'}</p>
            <div className="form-grid"><label>Document quantity for line {index + 1}<input disabled={!line.included} type="number" min="1" max="1000000" step="1" value={line.quantity} onChange={e => changeLine(index, { quantity: e.target.value })} placeholder="Unknown" /></label><label>Quantity basis for line {index + 1}<select disabled={!line.included} value={line.basis} onChange={e => changeLine(index, { basis: e.target.value })}><option value="unknown">Unknown</option><option value="units">Individual units</option><option value="packs">Packs</option></select></label></div>
            <label>Units per pack for line {index + 1}<input disabled={!line.included} type="number" min="1" max="1000000" step="1" value={line.size} onChange={e => changeLine(index, { size: e.target.value })} placeholder="Unknown; needed for packs" /></label>
            <p className="import-unit-total">{units !== null && Number.isSafeInteger(units) && units > 0 ? `${units} individual ${part?.unit ?? 'units'}${line.basis === 'packs' ? ` = ${line.quantity} ${Number(line.quantity) === 1 ? 'pack' : 'packs'} × ${line.size}` : ''}` : 'Individual quantity needs review'}</p>
            <div className="form-grid"><label>Invoice price for line {index + 1}<input disabled={!line.included} inputMode="decimal" maxLength={19} value={line.price} onChange={e => changeLine(index, { price: e.target.value })} placeholder="Unknown" /></label><label>Price basis for line {index + 1}<select disabled={!line.included} value={line.priceBasis} onChange={e => changeLine(index, { priceBasis: e.target.value as InvoicePrice['basis'] })}><option value="unknown">Unknown</option><option value="unit">Per unit</option><option value="pack">Per pack</option><option value="line">Line total</option></select></label></div>
            {source.evidence && <details className="import-evidence"><summary>Source excerpt</summary><p>{source.evidence}</p></details>}
          </fieldset>;
        })}</div>
        {duplicateParts && <label className="check-label"><input type="checkbox" checked={combine} onChange={e => { setCombine(e.target.checked); setReviewed(false); setError(''); }} />Combine selected lines that match the same part.</label>}
        {summary.length > 0 && <div className="checkout-total"><strong>{summary.length} {summary.length === 1 ? 'part' : 'parts'} to record</strong>{summary.map(line => <p key={line.requestId}>{state.parts.find(p => p.id === state.requests.find(r => r.id === line.requestId)?.partId)?.name}: <b>{line.quantity} individual units</b>{line.importLine!.sourceLineIds.length > 1 && ` · ${line.importLine!.sourceLineIds.length} source lines combined`}{line.importLine!.sourceLineIds.length > 1 && !line.purchasePack && ' · mixed/unknown packs'}</p>)}</div>}
        <p className="import-privacy">Excluded or unmatched lines are not recorded. Purchases without an open refill request must be handled outside this prototype. This source can be imported once; review all intended lines now. Original files/text are not retained.</p>
        {!reference.trim() && <label className="check-label"><input type="checkbox" checked={missingReference} onChange={e => { setMissingReference(e.target.checked); setReviewed(false); }} />No order reference is available. I checked for an existing purchase; duplicate checking is limited.</label>}
        <label className="check-label"><input type="checkbox" checked={reviewed} onChange={e => setReviewed(e.target.checked)} />I checked the parts, units, prices, and order details.</label>
        <p className="small muted">This records your completed purchase. Arrival and physical refill remain separate confirmations.</p>
        {submitted && <p className="small muted" role="status">Closing this review does not cancel a submitted purchase. Use Retry safely if its save is not confirmed.</p>}
      </>}
      {error && <p role="alert" className="inline-error" tabIndex={-1} ref={feedback}>{error}</p>}
    </div>
    <div className="form-actions import-actions"><button type="button" className="button secondary" onClick={onClose}>{submitted ? 'Close review' : draft ? 'Discard draft' : 'Cancel'}</button>{draft ? <button className="button primary" disabled={busy || alreadyRecorded}><ClipboardCheck size={16} />{busy ? 'Saving…' : 'Record reviewed purchase'}</button> : <button type="button" className="button primary" disabled={busy || extracting || !configuration?.configured} onClick={() => void extract()}>{extracting ? <LoaderCircle className="spin" size={16} /> : <ScanText size={16} />}{extracting ? 'Extracting…' : 'Extract order'}</button>}</div>
  </form></Dialog>;
}
