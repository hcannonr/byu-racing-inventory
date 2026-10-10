import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, ArrowDownToLine, ArrowRight, Bell, CalendarDays, Check, CheckCheck, ChevronRight, CircleHelp, FlaskConical, House, LoaderCircle, Package, Plus, RotateCcw, ScanLine, Search, ShoppingCart, WifiOff, X } from 'lucide-react';
import { activeRequest, availableReceived, quantityToBuy, requestStatus, type Action, type Command, type InventoryState, type Part, type PurchaseOrder } from '../shared/types';
import { accountFence, ApiError, getState, newCommand, persistPendingCommand, readPendingCommand, sendCommand, readInventoryLayout, persistInventoryLayout, type InventoryLayout, photoHash, readPendingPhoto, persistPendingPhoto, sendPhoto, type PhotoUploadToken } from './api';
import { relativeTime } from './components/Visuals';
import { Dialog, DialogErrorContext } from './components/Dialog';
import { TeamLogo } from './components/TeamLogo';
import { PartDetail } from './components/PartDetail';
import { CorrectionControl, CorrectionDialog } from './components/CorrectionDialog';
import type { InventoryEvent } from '../shared/types';
import { correctedAlertEpisodes } from '../shared/corrections';
import { PartForm } from './components/PartForm';
import { TrackingDialog, UndoPurchaseDialog } from './components/OrderDialogs';
import { OrderHub } from './components/OrderHub';
import { OrderForm } from './components/OrderForm';
import { SupplierLinkForm } from './components/SupplierLinkForm';
import { SupplierPurchaseDialog } from './components/SupplierPurchaseDialog';
import type { SupplierShoppingList } from '../shared/purchasing';
import { attentionTasks, type AttentionTask } from '../shared/attention';
import { AttentionHome } from './components/AttentionHome';
import { InventoryParts, InventoryViewSwitch } from './components/InventoryParts';
import { CabinetSetup, CategorySetup } from './components/InventorySetup';
import { inventoryCategories } from '../shared/organization';
import type { PartDetailAction } from './components/PartDetail';
import { NotificationsView } from './components/NotificationsView';
import { CabinetMap } from './components/CabinetMap';
import { BinLabels } from './components/BinLabels';
import type { PhotoUploadOutcome } from './components/PhotoControls';
import { SizingApplyDialog } from './components/BinSizingPanel';
import type { BinSizingSuggestion } from '../shared/binSizing';
import { OrderImportDialog } from './components/OrderImportDialog';
import { MobileDashboard } from './components/MobileDashboard';

type View = 'dashboard' | 'today' | 'inventory' | 'orders' | 'activity' | 'alerts' | 'cabinet' | 'labels';
type Filter = 'all' | 'needs_order' | 'in_transit' | 'refill' | 'out';
export default function App({ deployed = false }: { deployed?: boolean } = {}) {
  const fence = useRef(accountFence()).current;
  const [importOpen, setImportOpen] = useState(false);
  const [inventorySetup, setInventorySetup] = useState<{ kind: 'cabinet' | 'category'; state: InventoryState } | null>(null);
  const [state, setState] = useState<InventoryState | null>(null);
  const [mobile, setMobile] = useState(() => window.innerWidth <= 680);
  const [view, setView] = useState<View>(() => window.innerWidth <= 680 ? 'dashboard' : 'today');
  const mainRef = useRef<HTMLElement>(null);
  const navigated = useRef(false);
  useEffect(() => {
    const resize = () => {
      const isMobile = window.innerWidth <= 680;
      setMobile(isMobile);
      if (!isMobile) setView(current => current === 'dashboard' ? 'today' : current);
    };
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  useEffect(() => {
    if (!navigated.current) return;
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    mainRef.current?.focus({ preventScroll: true });
  }, [view]);
  const [filter, setFilter] = useState<Filter>('all');
  const [inventoryLayout, setInventoryLayout] = useState<InventoryLayout>(readInventoryLayout);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [detailAction, setDetailAction] = useState<PartDetailAction | undefined>();
  const [partForm, setPartForm] = useState<{ part: Part | 'new'; revision: number } | null>(null);
  const [orderAction, setOrderAction] = useState<{ kind: 'undo' | 'tracking'; order: PurchaseOrder; part: Part; revision: number } | null>(null);
  const [correctionReview, setCorrectionReview] = useState<{ event: InventoryEvent; revision: number } | null>(null);
  const [sizingReview, setSizingReview] = useState<{ part: Part; suggestion: BinSizingSuggestion; revision: number } | null>(null);
  const [purchase, setPurchase] = useState<{ part: Part; requestId: string; quantity: number; revision: number } | null>(null);
  const [supplierForm, setSupplierForm] = useState<{ part: Part; revision: number } | null>(null);
  const [checkout, setCheckout] = useState<{ group: SupplierShoppingList; state: InventoryState; revision: number } | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [offline, setOffline] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const pending = useRef<Command | null>(readPendingCommand());
  const [retry, setRetry] = useState<Command | null>(pending.current);
  const pendingPhoto = useRef<PhotoUploadToken | null>(readPendingPhoto());
  const photoFile = useRef<File | null>(null);
  const [photoRetry, setPhotoRetry] = useState<PhotoUploadToken | null>(pendingPhoto.current);
  const [cabinetFocus, setCabinetFocus] = useState<string | null>(null);
  const working = useRef(false);
  const applyState = useCallback((next: InventoryState) => setState(old => !old || next.revision >= old.revision ? next : old), []);
  const refresh = useCallback(async () => {
    try { const next = await getState(); applyState(next); setOffline(false); }
    catch { setOffline(true); }
  }, [applyState]);
  useEffect(() => { void refresh(); const timer = setInterval(() => void refresh(), 2500); return () => clearInterval(timer); }, [refresh]);
  useEffect(() => { if (pending.current) setNotice({ text: 'A previous save was not confirmed. Retry it safely before making another change.', error: true }); }, []);
  useEffect(() => {
    if (pendingPhoto.current) setNotice({ text: 'A photo save was not confirmed. Reselect the same photo to retry safely.', error: true });
  }, []);
  useEffect(() => {
    const token = pendingPhoto.current;
    if (token && state?.parts.some(part => part.id === token.partId && part.photoId === token.eventId)) {
      pendingPhoto.current = null; photoFile.current = null; persistPendingPhoto(null); setPhotoRetry(null);
      setNotice({ text: 'Part photo save confirmed.', error: false });
    }
  }, [state]);
  useEffect(() => {
    if (!notice || notice.error) return;
    const timer = setTimeout(() => setNotice(null), 5000); return () => clearTimeout(timer);
  }, [notice]);

  async function execute(command: Command): Promise<boolean> {
    if (working.current) return false;
    if (pendingPhoto.current) { setNotice({ text: 'Resolve the unconfirmed photo save before making another change.', error: true }); return false; }
    if (pending.current && pending.current.eventId !== command.eventId) {
      setNotice({ text: 'Resolve the previous save with Retry safely before making another change.', error: true });
      return false;
    }
    pending.current = command; persistPendingCommand(command);
    working.current = true; setBusy(true); setNotice(null); setRetry(null);
    try {
      const result = await sendCommand(command);
      pending.current = null; persistPendingCommand(null);
      if (command.action.type === 'add_part' || command.action.type === 'edit_part') { setPartForm(null); setSupplierForm(null); setSizingReview(null); }
      if (command.action.type === 'order') setPurchase(null);
      if (command.action.type === 'order_batch') { setCheckout(null); if (command.action.orderImport) setImportOpen(false); }
      if (command.action.type === 'undo_purchase' || command.action.type === 'save_tracking') setOrderAction(null);
      if (['correct_scan', 'correct_receipt', 'correct_refill'].includes(command.action.type)) setCorrectionReview(null);
      if (command.action.type === 'reset') { setResetOpen(false); }
      applyState(result.state); setOffline(false);
      setNotice({ text: result.message, error: false });
      return true;
    } catch (error) {
      try { fence(); } catch { return false; }
      const text = error instanceof Error ? error.message : 'The change could not be saved.';
      const networkError = error instanceof TypeError || error instanceof DOMException || error instanceof ApiError && error.status >= 500;
      if (networkError) { setRetry(command); setOffline(true); }
      else { pending.current = null; persistPendingCommand(null); }
      setNotice({ text: networkError ? 'Save not confirmed. Reconnect, then retry this same action safely.' : text, error: true });
      if (!networkError) void refresh();
      return false;
    } finally { working.current = false; setBusy(false); }
  }
  async function run(action: Action) { return execute(newCommand(action, action.type === 'scan' ? undefined : state?.revision)); }
  function reviewCorrection(event: InventoryEvent) {
    if (!state) return;
    setSelected(null); setDetailAction(undefined); setNotice(null);
    setCorrectionReview({ event, revision: state.revision });
  }
  async function uploadPhoto(partId: string, file: File): Promise<PhotoUploadOutcome> {
    if (working.current || pending.current) return { saved: false, error: 'Resolve the previous save before uploading a photo.' };
    const revision = state?.revision ?? 0;
    working.current = true; setBusy(true); setNotice(null);
    let token = pendingPhoto.current;
    try {
      const hash = await photoHash(file); fence();
      if (token && (token.partId !== partId || token.hash !== hash)) {
        const text = 'Reselect the exact same photo for the pending part. Its original save needs confirmation first.';
        setNotice({ text, error: true }); return { saved: false, error: text, uncertain: true };
      }
      token ??= { eventId: crypto.randomUUID(), partId, revision, hash };
      pendingPhoto.current = token; photoFile.current = file; persistPendingPhoto(token); setPhotoRetry(token);
      const result = await sendPhoto(token, file);
      pendingPhoto.current = null; photoFile.current = null; persistPendingPhoto(null); setPhotoRetry(null);
      applyState(result.state); setOffline(false); setNotice({ text: result.message, error: false }); return { saved: true };
    } catch (error) {
      try { fence(); } catch { return { saved: false, error: 'Account changed. Reload before continuing.' }; }
      // Polling may confirm this event while the original HTTP response is delayed.
      // A subsequent network failure cannot undo that independently confirmed save.
      if (token && pendingPhoto.current === null) {
        setNotice({ text: 'Part photo save confirmed.', error: false });
        return { saved: true };
      }
      const uncertain = error instanceof TypeError || error instanceof DOMException || error instanceof ApiError && (error.status >= 500 || error.status === 429);
      if (!uncertain) { pendingPhoto.current = null; photoFile.current = null; persistPendingPhoto(null); setPhotoRetry(null); void refresh(); }
      const text = uncertain && token ? 'Photo save not confirmed. Retry the same photo safely before making another change.' : error instanceof Error ? error.message : 'Photo could not be saved.';
      setNotice({ text, error: true });
      return { saved: false, error: text, uncertain };
    } finally { working.current = false; setBusy(false); }
  }
  function openOrderAction(kind: 'undo' | 'tracking', order: PurchaseOrder, part: Part) {
    if (!state) return;
    setSelected(null);
    setOrderAction({ kind, order, part, revision: state.revision });
  }
  function managePart(partId: string) { setDetailAction(undefined); setSelected(partId); }
  function openAttention(task: AttentionTask) {
    if (!state) return;
    if (task.action.kind === 'purchase' && task.requestId) {
      setPurchase({ part: task.part, requestId: task.requestId, quantity: task.toBuy, revision: state.revision });
      return;
    }
    setDetailAction(task.action.kind === 'receive' || task.action.kind === 'refill' ? task.action : undefined);
    setSelected(task.part.id);
  }
  const mutationsBlocked = busy || offline || retry !== null || photoRetry !== null;
  function locate(location: string | null) { setSelected(null); setCabinetFocus(location); changeView('cabinet'); }
  function changeView(next: View) { navigated.current = true; setMoreOpen(false); setView(next); setFilter('all'); setSearch(''); setCategory(''); }

  if (!state) return <div className="loading-screen"><TeamLogo /><h1>BYU Racing Workshop</h1>{offline ? <><p>Could not connect to the local inventory server.</p><button className="button primary" onClick={() => void refresh()}>Try again</button><p className="small muted">Start the app with npm run dev, then reload.</p></> : <><LoaderCircle className="spin" /><p>Opening the cabinet…</p></>}</div>;
  const openRequests = state.requests.filter(r => !r.closedAt);
  const todayTasks = attentionTasks(state);
  const outCount = state.parts.filter(p => p.bins.every(b => b.status === 'empty')).length;
  const readyCount = state.parts.filter(p => { const r = activeRequest(state, p.id); return r && availableReceived(state, r.id) >= p.binQuantity && p.bins.some(b => b.status === 'empty'); }).length;
  const needsOrderCount = openRequests.filter(r => requestStatus(state, r) === 'needs_order').length;
  const correctedEpisodes = correctedAlertEpisodes(state);
  const unread = state.alerts.filter(a => !a.read && !correctedEpisodes.has(a.episodeId ?? '')).length;
  const rows = state.parts.filter(p => {
    const r = activeRequest(state, p.id);
    const status = r ? requestStatus(state, r) : null;
    if (filter === 'needs_order' && status !== 'needs_order') return false;
    if (filter === 'in_transit' && status !== 'in_transit' && status !== 'ordered' && status !== 'partial') return false;
    if (filter === 'refill' && (!r || availableReceived(state, r.id) < p.binQuantity || !p.bins.some(b => b.status === 'empty'))) return false;
    if (filter === 'out' && !p.bins.every(b => b.status === 'empty')) return false;
    return (category === '' || p.category === category) && `${p.name} ${p.specification} ${p.location} ${p.supplier}`.toLowerCase().includes(search.toLowerCase());
  });
  const selectedPart = state.parts.find(p => p.id === selected);
  const titles: Record<View, [string, string]> = {
    dashboard: ['Dashboard', ''],
    today: ['Today', ''],
    inventory: ['Inventory', ''],
    cabinet: ['Find it in the cabinet.', 'A schematic tied to permanent location codes.'],
    labels: ['Give every bin a clear identity.', 'Print permanent labels. Scan the bin only when it is empty.'],
    orders: ['Order hub.', 'Shop by supplier. Confirm one checkout together.'],
    activity: ['Every change, recorded.', 'Scans, purchases, deliveries, and refills in one place.'],
    alerts: ['Buyer alerts.', 'Your cabinet updates, in one place.'],
  };

  return <DialogErrorContext.Provider value={{ error: notice?.error ? notice.text : null, onRetry: retry && !busy ? () => void execute(retry) : undefined }}><div className="app-shell">
    <header className="app-header">
      <a className="brand" href="#" aria-label="BYU Racing home" onClick={e => { e.preventDefault(); changeView(mobile ? 'dashboard' : 'today'); }}><TeamLogo /></a>
      <nav className="main-nav" aria-label="Main navigation">
        {mobile && <button className={view === 'dashboard' ? 'active' : ''} aria-current={view === 'dashboard' ? 'page' : undefined} onClick={() => changeView('dashboard')}><House size={20} aria-hidden="true" />Home</button>}
        <button className={view === 'today' ? 'active' : ''} aria-current={view === 'today' ? 'page' : undefined} onClick={() => changeView('today')}>{mobile && <CalendarDays size={20} aria-hidden="true" />}Today</button>
        <button className={view === 'inventory' ? 'active' : ''} aria-current={view === 'inventory' ? 'page' : undefined} onClick={() => changeView('inventory')}>{mobile && <Package size={20} aria-hidden="true" />}Inventory</button>
        <button className={view === 'orders' ? 'active' : ''} aria-current={view === 'orders' ? 'page' : undefined} onClick={() => changeView('orders')}>{mobile ? <><ShoppingCart size={20} aria-hidden="true" />Orders</> : <>Order hub <span>{state.parts.filter(part => quantityToBuy(state, part) > 0).length}</span></>}</button>
      </nav>
      <div className="header-tools"><span className={`connection ${offline ? 'offline' : ''}`}><i />{offline ? 'Offline' : 'Live'}</span><button className="more-toggle" aria-expanded={moreOpen} aria-controls="more-tools" onClick={() => setMoreOpen(!moreOpen)}>More <ChevronRight size={15} /></button></div>
      {moreOpen && <div className="more-menu" id="more-tools">
        <button onClick={() => locate(null)}><ScanLine size={17} />Cabinet map</button>
        <button onClick={() => changeView('labels')}><ArrowDownToLine size={17} />Print bin labels</button>
        <button onClick={() => changeView('activity')}><Activity size={17} />Activity log</button>
        <button onClick={() => changeView('alerts')}><Bell size={17} />Buyer alerts {unread > 0 && <span>{unread}</span>}</button>
        <button onClick={() => { setMoreOpen(false); setHelpOpen(true); }}><CircleHelp size={17} />How it works</button>
        <a href="/api/export" download><ArrowDownToLine size={17} />Export records</a>
        {!deployed && <button onClick={() => { setMoreOpen(false); setResetOpen(true); }}><RotateCcw size={17} />Reset demo</button>}
      </div>}
    </header>
    <div className="workspace">
      <main ref={mainRef} tabIndex={-1} className={view === 'orders' ? 'orders-page' : undefined}>
        {view !== 'dashboard' && view !== 'today' && view !== 'inventory' && view !== 'orders' && <div className="demo-banner"><FlaskConical size={15} /><span>{deployed ? 'Club inventory' : 'Local inventory'} <span className="banner-detail">· {state.notifications?.settings.enabled ? 'Operational email alerts enabled.' : 'Automatic email alerts off.'}</span></span></div>}
        {offline && <div className="offline-banner" role="alert"><WifiOff size={18} /><span>Showing the last saved inventory. Reconnect before making changes.</span><button className="text-button" onClick={() => void refresh()}>Reconnect</button></div>}
        {view !== 'dashboard' && view !== 'today' && view !== 'orders' && <div className={`page-heading ${view === 'inventory' ? 'inventory-heading' : ''}`}><div>{titles[view][0] && <h1>{titles[view][0]}</h1>}{titles[view][1] && <p>{titles[view][1]}</p>}</div>{view === 'inventory' ? <div className="inventory-heading-actions"><InventoryViewSwitch layout={inventoryLayout} onChange={next => { setInventoryLayout(next); persistInventoryLayout(next); }} /><button className="button primary" onClick={() => setPartForm({ part: 'new', revision: state.revision })}><Plus size={18} />Add part</button></div> : null}</div>}
        {view === 'dashboard' && <MobileDashboard attentionCount={todayTasks.length} partCount={state.parts.length} purchaseCount={state.parts.filter(part => quantityToBuy(state, part) > 0).length} onOpen={changeView} />}
        {view === 'today' && <AttentionHome tasks={todayTasks} busy={mutationsBlocked} onAction={openAttention} onSupplier={task => { setNotice(null); setSupplierForm({ part: task.part, revision: state.revision }); }} onInventory={() => changeView('inventory')} />}
        {view !== 'dashboard' && deployed && !state.parts.length && <section className="empty-cabinet"><h2>Your cabinet starts here.</h2><p>Add the first real workshop part. No trial inventory has been carried over.</p><button className="button primary" onClick={() => setPartForm({part:'new',revision:state.revision})}>Add first part</button></section>}

        {view === 'cabinet' && <CabinetMap state={state} focusedLocation={cabinetFocus} busy={mutationsBlocked} onPart={managePart} onSave={(map, revision) => execute(newCommand({ type: 'save_cabinet_map', map }, revision))} />}
        {view === 'labels' && <BinLabels parts={state.parts} />}
        {view === 'orders' && <OrderHub onImport={() => { setNotice(null); setImportOpen(true); }} onCheckout={group => setCheckout({ group, state, revision: state.revision })} onUndo={(order, part) => openOrderAction('undo', order, part)} onTracking={(order, part) => openOrderAction('tracking', order, part)} state={state} busy={mutationsBlocked} onManage={(partId, action) => { setDetailAction(action); setSelected(partId); }} onSupplier={part => setSupplierForm({ part, revision: state.revision })} onPurchase={part => { const request = activeRequest(state, part.id); if (request) setPurchase({ part, requestId: request.id, quantity: quantityToBuy(state, part), revision: state.revision }); }} />}
        {view === 'inventory' && <>
          <section aria-label="Parts inventory" className="inventory-panel">
            <div className="inventory-setup-tools"><button className="text-button" disabled={mutationsBlocked} onClick={() => setInventorySetup({ kind: 'cabinet', state: structuredClone(state) })}>Set up cabinet</button><button className="text-button" disabled={mutationsBlocked} onClick={() => setInventorySetup({ kind: 'category', state: structuredClone(state) })}>Manage categories</button></div>
            <div className="inventory-controls">
              <div className="filter-tabs" aria-label="Inventory filters">{([
                ['all', 'All parts', state.parts.length],
                ['needs_order', 'To order', needsOrderCount],
                ['in_transit', 'On the way', openRequests.filter(r => ['ordered', 'in_transit', 'partial'].includes(requestStatus(state, r))).length],
                ['refill', 'To refill', readyCount], ['out', 'Empty', outCount],
              ] as const).map(([id, label, count]) => <button key={id} className={filter === id ? 'active' : ''} aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}<span>{count}</span></button>)}</div>
              <div className="table-toolbar"><label className="search-field"><Search size={18} /><input aria-label="Search parts" placeholder="Find a part…" value={search} onChange={e => setSearch(e.target.value)} />{search && <button className="icon-button" aria-label="Clear search" onClick={() => setSearch('')}><X size={16} /></button>}</label><select className="category-field" aria-label="Filter category" value={category} onChange={e => setCategory(e.target.value)}><option value="">All categories</option>{inventoryCategories(state).map(name => <option key={name}>{name}</option>)}</select></div>
            </div>
            <InventoryParts parts={rows} state={state} layout={inventoryLayout} showEmptyGroups={filter === 'all' && !search && category === ''} onPart={managePart} onLocate={locate} />
            {!rows.length && <div className="empty-state"><CheckCheck size={32} /><h3>No parts in this view.</h3><p>Try another filter or search term.</p><button className="button secondary" onClick={() => { setFilter('all'); setSearch(''); setCategory(''); }}>Clear filters</button></div>}
          </section>
        </>}
        {view === 'activity' && <section className="activity-panel"><div className="panel-heading"><div><h2>Workshop timeline</h2><p>{state.events.length} recorded events. Corrections preserve the original record.</p></div><Activity size={22} /></div>{!state.events.length && <div className="empty-state"><Activity size={28} /><h3>No activity yet.</h3></div>}<div className="activity-list">{state.events.map(event => <div className="activity-item" key={event.id}><span className={`event-dot ${event.kind}`} /><div><strong>{state.parts.find(p => p.id === event.partId)?.name || 'Workshop'}</strong><p>{event.message}</p><CorrectionControl event={event} state={state} busy={mutationsBlocked} onReview={reviewCorrection} /></div><time dateTime={event.at} title={new Date(event.at).toLocaleString()}>{relativeTime(event.at)}</time>{event.partId && <button className="icon-button" aria-label={`View part for ${event.message}`} onClick={() => managePart(event.partId!)}><ChevronRight size={17} /></button>}</div>)}</div></section>}
        {view === 'alerts' && <NotificationsView snapshot={state.notifications} alerts={state.alerts} events={state.events} busy={mutationsBlocked} run={run} onOpenPart={managePart} onSnapshot={notifications => setState(current => current ? { ...current, notifications } : current)} />}
        <footer className="page-footer"><span>BYU Racing · Workshop inventory</span><span>Local prototype / v0.1</span></footer>
      </main>
    </div>
    {notice && <div className={`toast ${notice.error ? 'error' : ''}`} role={notice.error ? 'alert' : 'status'}><span>{notice.error ? <WifiOff size={18} /> : <Check size={18} />}{notice.text}</span>{retry && <button onClick={() => void execute(retry)} disabled={busy}>Retry safely</button>}{photoRetry && <button disabled={busy} onClick={() => { if (photoFile.current) void uploadPhoto(photoRetry.partId, photoFile.current); else managePart(photoRetry.partId); }}>{photoFile.current ? "Retry photo safely" : "Reselect photo"}</button>}<button className="icon-button" aria-label="Dismiss message" disabled={retry !== null || photoRetry !== null} onClick={() => setNotice(null)}><X size={16} /></button></div>}
    {selectedPart && <PartDetail key={selectedPart.id} part={selectedPart} state={state} initialAction={detailAction} onLocate={() => locate(selectedPart.location)} onUpload={uploadPhoto} photoBusy={busy || offline || retry !== null} run={run} busy={mutationsBlocked} onClose={() => { setSelected(null); setDetailAction(undefined); }} onEdit={() => { setPartForm({ part: selectedPart, revision: state.revision }); setSelected(null); }} onSupplier={() => { setSupplierForm({ part: selectedPart, revision: state.revision }); setSelected(null); setDetailAction(undefined); setNotice(null); }} onUndo={order => openOrderAction('undo', order, selectedPart)} onTracking={order => openOrderAction('tracking', order, selectedPart)} onCorrect={reviewCorrection} onSizingReview={suggestion => { setSizingReview({ part: structuredClone(selectedPart), suggestion, revision: state.revision }); setSelected(null); setDetailAction(undefined); setNotice(null); }} />}
    {sizingReview && <SizingApplyDialog part={sizingReview.part} suggestion={sizingReview.suggestion} busy={mutationsBlocked} run={action => execute(newCommand(action, sizingReview.revision))} onClose={() => setSizingReview(null)} />}
    {correctionReview && <CorrectionDialog key={correctionReview.event.id} event={correctionReview.event} state={state} reviewRevision={correctionReview.revision} busy={mutationsBlocked} onClose={() => setCorrectionReview(null)} onRefresh={() => { setNotice(null); setCorrectionReview({ ...correctionReview, revision: state.revision }); }} onSave={action => execute(newCommand(action, correctionReview.revision))} />}
    {orderAction?.kind === 'tracking' && <TrackingDialog connected={state.trackingService?.configured} order={orderAction.order} part={orderAction.part} busy={mutationsBlocked} run={action => execute(newCommand(action, orderAction.revision))} onClose={() => setOrderAction(null)} />}
    {orderAction?.kind === 'undo' && <UndoPurchaseDialog order={orderAction.order} part={orderAction.part} busy={mutationsBlocked} run={action => execute(newCommand(action, orderAction.revision))} onClose={() => setOrderAction(null)} />}
    {purchase && <Dialog title="Mark purchased" onClose={() => setPurchase(null)}><OrderForm part={purchase.part} requestId={purchase.requestId} suggested={purchase.quantity} purchase busy={mutationsBlocked} run={action => execute(newCommand(action, purchase.revision))} onSaved={() => setPurchase(null)} /></Dialog>}
    {supplierForm && <SupplierLinkForm part={supplierForm.part} busy={mutationsBlocked} run={action => execute(newCommand(action, supplierForm.revision))} onClose={() => setSupplierForm(null)} />}
    {checkout && <SupplierPurchaseDialog state={checkout.state} parts={checkout.group.parts} supplier={checkout.group.key ? checkout.group.supplier : ''} busy={mutationsBlocked} run={action => execute(newCommand(action, checkout.revision))} onClose={() => setCheckout(null)} />}
    {importOpen && <OrderImportDialog state={state} busy={mutationsBlocked} pendingImportId={pending.current?.action.type === 'order_batch' ? pending.current.action.orderImport?.id : undefined} onRecord={(action, revision) => execute(newCommand(action, revision))} onClose={() => setImportOpen(false)} />}
    {inventorySetup && (inventorySetup.kind === 'cabinet' ? <CabinetSetup state={inventorySetup.state} busy={mutationsBlocked} onSave={action => execute(newCommand(action, inventorySetup.state.revision))} onClose={() => setInventorySetup(null)} /> : <CategorySetup state={inventorySetup.state} busy={mutationsBlocked} onSave={async action => { const saved = await execute(newCommand(action, inventorySetup.state.revision)); if (saved) setCategory(''); return saved; }} onClose={() => setInventorySetup(null)} />)}
    {partForm && <PartForm categories={inventoryCategories(state)} part={partForm.part === 'new' ? undefined : partForm.part} busy={mutationsBlocked} run={action => execute(newCommand(action, partForm.revision))} onClose={() => setPartForm(null)} />}
    {resetOpen && <Dialog title="Reset test inventory" onClose={() => setResetOpen(false)}><div className="form-stack"><h2>Start a fresh test.</h2><p>This clears purchases, history, alerts, and any parts you added in this local app. The eight sample parts will return with both bins stocked.</p><p className="muted">Export your records first if you want to keep this test run.</p><a href="/api/export" download className="text-button"><ArrowDownToLine size={16} />Export current records</a><div className="form-actions"><button className="button secondary" onClick={() => setResetOpen(false)}>Keep current data</button><button className="button danger-button" disabled={busy || offline} onClick={async () => { if (await run({ type: 'reset', confirmation: 'RESET DEMO' })) { setResetOpen(false); } }}>Reset demo data</button></div></div></Dialog>}
    {helpOpen && <Dialog title="How it works" onClose={() => setHelpOpen(false)}><div className="form-stack"><h2>Keep the cabinet stocked.</h2><ol className="help-list"><li>Use <strong>Today</strong> to see what needs attention.</li><li>Open <strong>Order hub</strong> to buy parts and record purchases.</li><li><strong>Record receipt</strong> when the parts arrive.</li><li><strong>Confirm refill</strong> after physically filling an empty bin.</li></ol><p className="note">“In use” means the bin has not been reported empty. The app does not count each bolt taken.</p></div></Dialog>}
  </div></DialogErrorContext.Provider>;
}
