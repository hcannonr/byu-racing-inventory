import { useState, type FormEvent } from 'react';
import { ArrowRight, ChartNoAxesCombined } from 'lucide-react';
import { binSizingSuggestion, type BinSizingSuggestion, type SizingExclusionReason } from '../../shared/binSizing';
import type { InventoryState, Part, PartInput } from '../../shared/types';
import { Dialog } from './Dialog';
import type { RunAction } from './PartForm';

const number = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 3 });
const date = (value: string) => new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const range = (values: number[], unit: string) => {
  if (!values.length) return 'Not measured yet';
  const minimum = Math.min(...values); const maximum = Math.max(...values);
  const label = unit === 'days' && minimum === 1 && maximum === 1 ? 'day' : unit;
  return `${minimum === maximum ? number(minimum) : `${number(minimum)}–${number(maximum)}`} ${label}`;
};
const exclusionLabels: Record<SizingExclusionReason, string> = {
  before_measurement_change: 'Records before measurements changed', legacy: 'Unstructured history', practice: 'Practice or sample records', unknown_provenance: 'Unknown record origin',
  corrected_period: 'Corrected records and affected request periods', unknown_fill: 'Empty scans with no verified active fill', incomplete_cycle: 'Fills still waiting for a complete active cycle',
  stockout_gap: 'Both-empty gaps excluded from usage timing', invalid_history: 'Incomplete or inconsistent timing and quantities', incomplete_purchase: 'Purchases without eligible complete receipts', incomplete_replenishment: 'Requests without complete usable refill timing',
};

export function BinSizingPanel({ state, part, busy, onReview }: { state: InventoryState; part: Part; busy: boolean; onReview?: (suggestion: BinSizingSuggestion) => void }) {
  const suggestion = binSizingSuggestion(state, part.id);
  const ready = suggestion.status !== 'learning';
  return <section className="bin-sizing-panel detail-section" aria-label="Bin-size suggestions">
    <div className="split sizing-heading"><h3><ChartNoAxesCombined size={17} />Bin-size suggestions</h3><span className="badge neutral">{ready ? 'Limited history' : 'Learning'}</span></div>
    {ready ? <>
      <div className="sizing-proposal"><div><span className="eyebrow">{suggestion.status === 'increase' ? 'SUGGESTED FUTURE TARGET' : 'CURRENT TARGET COVERS OBSERVED USE'}</span><p><strong>{suggestion.status === 'increase' ? number(suggestion.target!) : number(part.binQuantity)}</strong> {part.unit} per bin</p></div><span className="small muted">Current target: {number(part.binQuantity)}</span></div>
      <p className="sizing-calculation">{number(suggestion.fastestRate!)} {part.unit}/day × {number(suggestion.slowestReplenishmentDays!)} days × 1.25 buffer = {number(suggestion.target!)} {part.unit}, rounded up.</p>
      <p className="small muted">Fastest measured full-bin use and slowest complete replenishment, plus 25% extra. This estimates use across full cycles; individual withdrawals are not counted.</p>
      {suggestion.status === 'increase' && onReview && <button className="button secondary small-button" disabled={busy || !suggestion.canApply} onClick={() => onReview(suggestion)}>Review new target<ArrowRight size={15} /></button>}
      {suggestion.applyBlocked && suggestion.status === 'increase' && <p className="sizing-blocked small">{suggestion.applyBlocked}</p>}
      {suggestion.status === 'adequate' && <p className="small muted">Keep the current target. This feature does not suggest automatic decreases.</p>}
    </> : <>
      <p className="sizing-learning-title">Learning from workshop records</p>
      <p className="small muted">Need at least 3 verified active-bin cycles, 3 fully received purchases, and complete purchasing/refill timing before suggesting a target.</p>
      <ul className="sizing-missing">{suggestion.missing.map(message => <li key={message}>{message}</li>)}</ul>
      {suggestion.epochAt && <p className="small muted">Measurements changed {date(suggestion.epochAt)}. New verified refills start a fresh learning period. Existing bin contents stay unchanged.</p>}
    </>}
    <div className="sizing-counts"><div><strong>{suggestion.cycles.length}</strong><span>active cycles</span></div><div><strong>{suggestion.purchases.length}</strong><span>complete purchases</span></div><div><strong>{suggestion.replenishments.length}</strong><span>complete refill timelines</span></div></div>
    <details className="sizing-evidence"><summary>Evidence & calculation</summary>
      {suggestion.evidenceStart && suggestion.evidenceEnd && <p className="small muted">Observed {date(suggestion.evidenceStart)} to {date(suggestion.evidenceEnd)}. Limited history does not guarantee future demand or delivery times.</p>}
      <dl className="sizing-ranges">
        <div><dt>Active bin duration</dt><dd>{range(suggestion.cycles.map(c => c.days), 'days')}</dd></div>
        <div><dt>Estimated cycle use</dt><dd>{range(suggestion.cycles.map(c => c.rate), `${part.unit}/day`)}</dd></div>
        <div><dt>Purchase to final receipt</dt><dd>{range(suggestion.purchases.map(p => p.days), 'days')}</dd></div>
        <div><dt>Empty scan to purchase</dt><dd>{range(suggestion.replenishments.map(r => r.buyingDays), 'days')}</dd></div>
        <div><dt>First purchase to all receipts</dt><dd>{range(suggestion.replenishments.map(r => r.receiptDays), 'days')}</dd></div>
        <div><dt>Final receipt to physical refill</dt><dd>{range(suggestion.replenishments.map(r => r.refillDays), 'days')}</dd></div>
        <div><dt>Complete replenishment</dt><dd>{range(suggestion.replenishments.map(r => r.days), 'days')}</dd></div>
      </dl>
      <p className="small muted">A measured cycle begins when a previously verified full bin becomes in use and ends at its empty scan. Reserve waiting and time with both bins empty do not count as use.</p>
      {suggestion.exclusions.length > 0 && <><h4>Excluded evidence</h4><ul className="sizing-exclusions">{suggestion.exclusions.map(e => <li key={e.reason}><span>{exclusionLabels[e.reason]}</span><strong>{e.count}</strong></li>)}</ul><p className="small muted">Counts describe excluded records or observations. Categories can overlap.</p></>}
    </details>
  </section>;
}

export function SizingApplyDialog({ part, suggestion, busy, run, onClose }: { part: Part; suggestion: BinSizingSuggestion; busy: boolean; run: RunAction; onClose: () => void }) {
  const [error, setError] = useState('');
  const [fits, setFits] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setError('');
    if (!fits || !suggestion.canApply || suggestion.target === undefined) return;
    const details: PartInput = { name: part.name, specification: part.specification, category: part.category, location: part.location, supplier: part.supplier, supplierUrl: part.supplierUrl,
      binQuantity: suggestion.target, unit: part.unit, ...(part.purchasePack && { purchasePack: part.purchasePack }) };
    if (await run({ type: 'edit_part', partId: part.id, part: details })) onClose();
    else setError('Target was not confirmed. If inventory changed, close this review and reopen it from the latest part details.');
  }
  return <Dialog title="Review bin target" onClose={onClose}>
    <form className="sizing-review" onSubmit={submit}>
      <div className="sizing-review-body"><h2>Change the next refill target?</h2><p className="muted">{part.name} · {part.location}</p>
        <div className="sizing-target-change"><span>{number(part.binQuantity)} {part.unit} per bin</span><ArrowRight size={18} /><strong>{number(suggestion.target!)} {part.unit} per bin</strong></div>
        <p>Existing bin contents and bin states stay unchanged. Use the new amount at future physical refills.</p>
        <p className="small muted">This starts a new learning period. The estimate uses {suggestion.cycles.length} active cycles and {suggestion.purchases.length} completed purchases with a 25% extra-stock buffer.</p>
        <label className="sizing-fit-confirm"><input type="checkbox" required checked={fits} onChange={event => setFits(event.target.checked)} />I confirmed the physical bins can hold {number(suggestion.target!)} {part.unit} each.</label>
        {error && <p className="inline-error" role="alert">{error}</p>}
      </div>
      <div className="form-actions sizing-review-actions"><button className="button secondary" type="button" onClick={onClose}>Keep current target</button><button className="button primary" disabled={busy || !fits || !suggestion.canApply}>Apply future target</button></div>
    </form>
  </Dialog>;
}
