import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Printer, Search } from 'lucide-react';
import type { Part } from '../../shared/types';
import { labelRows, labelsForParts, makeLabelCode, mmToPx, paginateLabelRows, paperSizes, type BinLabel, type LabelFormat, type PaperSize } from '../labels';

function PrintedLabel({ label, format }: { label: BinLabel; format: LabelFormat }) {
  const code = useMemo(() => makeLabelCode(label.bin.id, format), [label.bin.id, format]);
  return <article className={`printed-bin-label ${format}`} aria-label={`Printed bin ${label.letter}: ${label.bin.id}`}>
    <div className="printed-label-top"><strong>BIN {label.letter}<small>Bin {label.number}</small></strong><span>{label.part.location}{label.part.sample && <b>SAMPLE</b>}</span></div>
    <h3>{label.part.name}</h3><p className="printed-spec">{label.part.specification || 'Specification not recorded'}</p>
    <div className="printed-code"><img src={code.src} width={mmToPx(code.widthMm)} height={mmToPx(code.heightMm)} alt={`${format === 'qr' ? 'QR' : 'Code 128'} for ${label.bin.id}`} /><div><code>{label.bin.id}</code><strong>Scan when empty</strong></div></div>
  </article>;
}

export function BinLabels({ parts }: { parts: Part[] }) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [search, setSearch] = useState(''); const [format, setFormat] = useState<LabelFormat>('qr');
  const [paper, setPaper] = useState<PaperSize>('letter');
  const [heights, setHeights] = useState<number[]>([]); const [ready, setReady] = useState(false);
  const [layoutError, setLayoutError] = useState(''); const [scale, setScale] = useState(1);
  const measureRef = useRef<HTMLDivElement>(null); const previewRef = useRef<HTMLDivElement>(null);
  const labels = labelsForParts(parts, selected); const rows = labelRows(labels, format);
  const contentKey = JSON.stringify([format, labels.map(l => [l.bin.id, l.part.name, l.part.specification, l.part.location, l.part.sample])]);
  const size = paperSizes[paper];
  const visible = parts.filter(p => `${p.name} ${p.specification} ${p.location} ${p.bins.map(b => b.id).join(' ')}`.toLowerCase().includes(search.trim().toLowerCase()));
  const partCount = new Set(labels.map(l => l.part.id)).size;
  useEffect(() => { document.body.classList.add('printing-bin-labels'); return () => { document.body.classList.remove('printing-bin-labels'); }; }, []);
  useLayoutEffect(() => {
    let cancelled = false; setReady(false);
    const measure = () => {
      if (cancelled) return;
      const measured = Array.from(measureRef.current?.children ?? []).map(el => el.getBoundingClientRect().height / mmToPx(1));
      // jsdom has no layout; real browsers use the exact physical row measurements.
      const actual = measured.map(height => height || 51);
      try { paginateLabelRows(actual, size.height - 20, 6); setHeights(actual); setLayoutError(''); setReady(true); }
      catch (error) { setLayoutError(error instanceof Error ? error.message : 'Could not lay out labels.'); setReady(false); }
    };
    measure();
    const fonts = document.fonts;
    if (fonts && fonts.status !== 'loaded') { setReady(false); void fonts.ready.then(measure); }
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    if (measureRef.current) observer?.observe(measureRef.current);
    return () => { cancelled = true; observer?.disconnect(); };
  }, [contentKey, paper]);
  useLayoutEffect(() => {
    const resize = () => { const width = previewRef.current?.clientWidth; setScale(width ? Math.min(1, width / mmToPx(size.width)) : 1); };
    resize(); const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
    if (previewRef.current) observer?.observe(previewRef.current);
    window.addEventListener('resize', resize); return () => { observer?.disconnect(); window.removeEventListener('resize', resize); };
  }, [paper]);
  let pages: number[][] = [];
  try { pages = paginateLabelRows(rows.map((_, i) => heights[i] || 51), size.height - 20, 6); } catch { /* Error is shown and printing is disabled. */ }
  function toggle(id: string) { setSelected(old => { const next = new Set(old); if (next.has(id)) next.delete(id); else next.add(id); return next; }); }
  function selectVisible() { setSelected(old => new Set([...old, ...visible.flatMap(p => p.bins.map(b => b.id))])); }
  const rowMarkup = (row: BinLabel[], i: number) => <div className={`printed-label-row ${format}`} key={i}>{row.map(label => <PrintedLabel key={label.bin.id} label={label} format={format} />)}</div>;
  return <section className="labels-view" aria-label="Bin labels">
    <style>{`@page { size: ${paper === 'letter' ? 'Letter' : 'A4'} portrait; margin: 0; }`}</style>
    <div className="labels-controls">
      <div className="labels-settings"><label>Paper size<select aria-label="Paper size" value={paper} onChange={e => setPaper(e.target.value as PaperSize)}><option value="letter">Letter · 8.5 × 11 in</option><option value="a4">A4 · 210 × 297 mm</option></select></label><label>Code format<select aria-label="Code format" value={format} onChange={e => setFormat(e.target.value as LabelFormat)}><option value="qr">QR code</option><option value="code128">Code 128</option></select></label></div>
      <div className="label-selector-heading"><div><h2>Choose the bins to label.</h2><p className="muted">A and B stay with the physical bins as their roles change.</p></div><label className="search-field"><Search size={18} /><input aria-label="Find labels" placeholder="Find a part or bin…" value={search} onChange={e => setSearch(e.target.value)} /></label></div>
      <div className="label-selection-actions"><span aria-live="polite">{labels.length} {labels.length === 1 ? 'label' : 'labels'} selected · {partCount} {partCount === 1 ? 'part' : 'parts'}</span><div><button className="text-button" disabled={!visible.length} onClick={selectVisible}>Select shown</button><button className="text-button" disabled={!labels.length} onClick={() => setSelected(new Set())}>Clear selection</button></div></div>
      <div className="label-part-list">{visible.map(part => <div className="label-part-row" key={part.id}><div><strong>{part.name}</strong><span>{part.location} {part.sample && '· Sample'}</span></div><div className="label-bin-choices">{part.bins.map((bin, i) => <label key={bin.id}><input type="checkbox" checked={selected.has(bin.id)} onChange={() => toggle(bin.id)} aria-label={`Bin ${i === 0 ? 'A' : 'B'} for ${part.name}, ${bin.id}`} /><span><b>Bin {i === 0 ? 'A' : 'B'}</b><small>Bin {i + 1}</small></span></label>)}</div></div>)}</div>
      {!visible.length && <p className="label-no-results">No matching parts. Your previous selections are kept.</p>}
    </div>
    <div className="label-preview-heading"><div><h2>Paper preview</h2><p className="muted">{format === 'qr' ? '89 mm wide · labels grow to fit the full specification' : '184 mm wide · more room for the linear barcode'}</p></div><button className="button primary" disabled={!labels.length || !ready || !!layoutError} onClick={() => window.print()}><Printer size={17} />Print labels</button></div>
    <p className="label-preview-note">Print at 100% scale on {size.title} paper. Turn off browser headers and footers. Cut along the outlines.</p>
    {layoutError && <p className="inline-error" role="alert">{layoutError}</p>}
    <div className="label-measure" aria-hidden="true" ref={measureRef}>{rows.map(rowMarkup)}</div>
    <section aria-label="Paper preview" className="label-preview" ref={previewRef}>
      {!labels.length ? <div className="label-empty"><Printer size={30} /><h3>Select a bin to preview its label.</h3><p>Each label encodes its permanent bin ID.</p></div> : <div className="label-paper-list">{pages.map((page, index) => <div className="label-sheet-wrapper" key={index}>
        <p className="label-sheet-caption">{size.title} · Page {index + 1} of {pages.length}</p>
        <div className="label-paper-frame" style={{ width: mmToPx(size.width) * scale, height: mmToPx(size.height) * scale }}>
          <div className="label-paper" data-paper={paper} data-page={index + 1} style={{ '--paper-width': `${size.width}mm`, '--paper-height': `${size.height}mm`, '--preview-scale': scale } as CSSProperties}>{page.map(i => rowMarkup(rows[i], i))}</div>
        </div>
      </div>)}</div>}
    </section>
  </section>;
}
