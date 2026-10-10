import { useEffect, useState } from 'react';
import { ArrowRight, CheckCheck, CircleAlert, Columns3, ExternalLink, Focus, Link, PackageCheck, ShoppingCart, Truck } from 'lucide-react';
import type { AttentionKind, AttentionReason, AttentionTask } from '../../shared/attention';
import { persistTodayLayout, readTodayLayout, type TodayLayout } from '../api';
import { dateLabel, PartIcon } from './Visuals';

const labels: Record<AttentionKind, string> = {
  out: 'Both bins empty', receipt: 'Carrier delivered · confirm receipt',
  overdue: 'Delivery overdue', purchase: 'Needs purchase', refill: 'Ready to refill',
};
const badges: Record<AttentionKind, string> = { out: 'danger', receipt: 'in_transit', overdue: 'partial', purchase: 'needs_order', refill: 'arrived' };
function detail(reason: AttentionReason, task: AttentionTask): string {
  switch (reason.kind) {
    case 'out': return 'No stocked bin available';
    case 'receipt': return `${reason.quantity} ${task.part.unit} still to confirm${reason.orders!.length > 1 ? ` across ${reason.orders!.length} purchases` : ''}`;
    case 'overdue': return `${reason.orders!.length === 1 ? 'Purchase' : `${reason.orders!.length} purchases`} due ${dateLabel(reason.date!)}`;
    case 'purchase': return `${task.toBuy} ${task.part.unit} not covered by stock or purchases`;
    case 'refill': return `${task.received} ${task.part.unit} received · ${reason.quantity} ${reason.quantity === 1 ? 'bin' : 'bins'} ready to fill`;
  }
}

function actionLabel(task: AttentionTask) {
  return task.action.kind === 'refill' ? 'Refill bin' : task.action.kind === 'receive' ? 'Record receipt' : task.action.kind === 'purchase' ? 'Mark purchased' : task.reasons.some(reason => reason.kind === 'overdue') ? 'Review delivery' : 'Review part';
}
function Reasons({ task }: { task: AttentionTask }) {
  return <div className="attention-reasons">{task.reasons.map(reason => <div className="attention-reason" key={reason.kind}><span className={`badge ${badges[reason.kind]}`}>{labels[reason.kind]}</span><small>{detail(reason, task)}</small></div>)}</div>;
}
function Identity({ task }: { task: AttentionTask }) {
  return <div className="attention-part"><PartIcon part={task.part} /><div><span className="eyebrow">{task.part.location.replace('BLUE-', '')}</span><h2>{task.part.name}</h2><p>{task.part.specification.replace(' · example specification', '')}</p></div></div>;
}
function TaskAction({ task, busy, onAction, onSupplier }: { task: AttentionTask; busy: boolean; onAction: (task: AttentionTask) => void; onSupplier?: (task: AttentionTask) => void }) {
  const Icon = task.action.kind === 'refill' ? PackageCheck : task.action.kind === 'purchase' ? ShoppingCart : task.action.kind === 'receive' ? Truck : ArrowRight;
  const supplierUrl = /^https?:\/\//i.test(task.part.supplierUrl) ? task.part.supplierUrl : null;
  return <div className="today-task-actions">{task.action.kind === 'purchase' && (supplierUrl ? <a className="button secondary" href={supplierUrl} target="_blank" rel="noopener noreferrer"><ExternalLink size={16} />Buy Here</a> : onSupplier && <button className="button secondary" disabled={busy} onClick={() => onSupplier(task)}><Link size={16} />Add supplier link</button>)}<button className="button primary" disabled={busy} onClick={() => onAction(task)}><Icon size={16} />{actionLabel(task)}</button></div>;
}
const groups = [
  { kind: 'purchase', label: 'Buy' }, { kind: 'receive', label: 'Receive' },
  { kind: 'refill', label: 'Refill' }, { kind: 'review', label: 'Review' },
] as const;

export function AttentionHome({ tasks, busy, onAction, onInventory, onSupplier }: {
  tasks: AttentionTask[]; busy: boolean; onAction: (task: AttentionTask) => void;
  onInventory: () => void; onSupplier?: (task: AttentionTask) => void;
}) {
  const [layout, setLayout] = useState<TodayLayout>(readTodayLayout);
  const [selectedId, setSelectedId] = useState<string | undefined>(tasks[0]?.part.id);
  const selected = tasks.find(task => task.part.id === selectedId) ?? tasks[0];
  // Keep selection stable across polling, and move on if the selected task disappears.
  useEffect(() => { if (selected?.part.id !== selectedId) setSelectedId(selected?.part.id); }, [selected?.part.id, selectedId]);
  function chooseLayout(next: TodayLayout) { setLayout(next); persistTodayLayout(next); }
  const critical = tasks.filter(task => task.critical).length;
  return <section className="attention-home" aria-label="Needs attention today">
    <div className="today-toolbar"><h1>Today</h1><div className="today-view-switch" role="group" aria-label="Today layout"><button aria-pressed={layout === 'groups'} onClick={() => chooseLayout('groups')}><Columns3 size={16} />By action</button><button aria-pressed={layout === 'focus'} onClick={() => chooseLayout('focus')}><Focus size={16} />Focus</button></div></div>
    {tasks.length > 0 ? <>
      <div className="attention-summary"><p>{tasks.length} {tasks.length === 1 ? 'part needs' : 'parts need'} a next step.</p>{critical > 0 && <span className="badge danger"><CircleAlert size={13} />{critical} out of stock</span>}<button className="text-button" onClick={onInventory}>View inventory <ArrowRight size={15} /></button></div>
      {layout === 'groups' ? <div className="today-board">{groups.map(group => {
        const items = tasks.filter(task => task.action.kind === group.kind);
        return <section className="today-lane" aria-label={`${group.label} tasks`} key={group.kind}><div className="today-lane-title"><h2>{group.label}</h2><span>{items.length}</span></div>{items.length ? items.map(task => <article className={`today-task ${task.critical ? 'urgent' : ''}`} aria-label={`Attention for ${task.part.name}`} key={task.part.id}><Identity task={task} /><Reasons task={task} /><TaskAction task={task} busy={busy} onAction={onAction} onSupplier={onSupplier} /></article>) : <p className="today-lane-empty">Nothing here right now.</p>}</section>;
      })}</div> : selected && <div className="today-focus-layout">
        <article className={`today-focus-card ${selected.critical ? 'urgent' : ''}`} aria-label={`Attention for ${selected.part.name}`}>
          <div className="today-focus-heading"><strong>Your next step</strong><span>{tasks.indexOf(selected) + 1} of {tasks.length} parts</span></div>
          <div className="today-focus-body"><Identity task={selected} /><Reasons task={selected} />
            <div className="today-bin-states">{selected.part.bins.map((bin, index) => <div key={bin.id}><span>Bin {index + 1}</span><strong className={bin.status === 'empty' ? 'text-danger' : ''}>{bin.status === 'in_use' ? 'In use' : bin.status === 'ready' ? 'Ready' : 'Empty'}</strong></div>)}</div>
            <div className="today-next-action">{selected.action.kind !== 'purchase' && <p>{selected.action.kind === 'refill' ? `Physically refill the bin with ${selected.part.binQuantity} ${selected.part.unit}, then confirm.` : selected.action.kind === 'receive' ? 'Count the parts you received, then record the receipt.' : 'Open the part to review its orders and next steps.'}</p>}<TaskAction task={selected} busy={busy} onAction={onAction} onSupplier={onSupplier} /></div>
          </div>
          <div className="today-focus-footer"><button className="text-button" disabled={tasks.length < 2} onClick={() => setSelectedId(tasks[(tasks.indexOf(selected) + 1) % tasks.length].part.id)}>Next part <ArrowRight size={16} /></button></div>
        </article>
        <aside className="today-queue" aria-label="Today's task queue"><h2>The full queue <span>{tasks.length}</span></h2>{tasks.map(task => <button key={task.part.id} aria-label={`Show ${task.part.name}`} aria-pressed={selected.part.id === task.part.id} onClick={() => setSelectedId(task.part.id)}><span className="today-queue-location">{task.part.location.replace('BLUE-', '')}</span><strong>{task.part.name}</strong><small>{task.part.specification.replace(' · example specification', '')}</small><span className={`badge ${badges[task.reasons[0].kind]}`}>{labels[task.reasons[0].kind]}</span></button>)}</aside>
      </div>}
    </> : <div className="attention-empty"><div className="attention-clear-icon"><CheckCheck size={30} /></div><h2>Nothing needs attention today.</h2><p>New empty-bin scans and delivery updates will appear here.</p><div className="attention-empty-actions"><button className="button primary" onClick={onInventory}>View inventory <ArrowRight size={16} /></button></div></div>}
  </section>;
}
