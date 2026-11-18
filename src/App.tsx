import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BellRing, Boxes, ClipboardList, Plus, Printer, Settings2, Users } from 'lucide-react';
import { roleLabel, type Part, type PartStatus, type Role, type ViewState } from '../shared/types';
import { api, switchUser } from './api';
import { Logo } from './components/ui';
import { RestockBoard } from './components/RestockBoard';
import { PartsPage } from './components/PartsPage';
import { PartPanel } from './components/PartPanel';
import { PartForm } from './components/PartForm';
import { LabelsPage } from './components/LabelsPage';
import { SetupPage } from './components/SetupPage';
import { OrderDialog } from './components/OrderDialog';
import { PhoneDemo } from './components/PhoneDemo';
import { Toasts, type Toast } from './components/Toasts';
import { PeoplePage } from './components/PeoplePage';
import { AlertsPage } from './components/AlertsPage';
import { UserMenu } from './components/UserMenu';

export type Page = 'restock' | 'parts' | 'labels' | 'people' | 'alerts' | 'setup';
/** Which tabs each role gets. Members do day-to-day parts work; leads also handle their team's people. */
const pages: { id: Page; label: string; icon: typeof Boxes; roles: Role[] }[] = [
  { id: 'restock', label: 'Restock', icon: ClipboardList, roles: ['admin', 'lead', 'member'] },
  { id: 'parts', label: 'Parts', icon: Boxes, roles: ['admin', 'lead', 'member'] },
  { id: 'labels', label: 'Labels', icon: Printer, roles: ['admin', 'lead', 'member'] },
  { id: 'people', label: 'People', icon: Users, roles: ['admin', 'lead'] },
  { id: 'alerts', label: 'Alerts', icon: BellRing, roles: ['admin'] },
  { id: 'setup', label: 'Setup', icon: Settings2, roles: ['admin'] },
];
const pageFromHash = (): Page => (pages.find(p => `#/${p.id}` === location.hash)?.id ?? 'restock');

export interface Ctx {
  state: ViewState;
  teamFilter: string;
  setTeamFilter: (id: string) => void;
  openPart: (id: string) => void;
  addPart: () => void;
  editPart: (part: Part) => void;
  advance: (part: Part, to: PartStatus) => void;
  run: <T>(work: () => Promise<T>, success?: string | ((r: T) => string)) => Promise<T | undefined>;
  printLabels: (ids: string[]) => void;
  phoneDemo: (part: Part) => void;
  refresh: () => Promise<void>;
  notify: (text: string) => void;
  go: (page: Page) => void;
}

export default function App() {
  const [state, setState] = useState<ViewState | null>(null);
  const [loadError, setLoadError] = useState('');
  const [page, setPage] = useState<Page>(pageFromHash);
  const [teamFilter, setTeamFilter] = useState(() => { try { return localStorage.getItem('team') || 'all'; } catch { return 'all'; } });
  const [openId, setOpenId] = useState<string | null>(null);
  const [form, setForm] = useState<{ part?: Part } | null>(null);
  const [ordering, setOrdering] = useState<Part | null>(null);
  const [phone, setPhone] = useState<Part | null>(null);
  const [labelIds, setLabelIds] = useState<string[] | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seenEvents = useRef<Set<string> | null>(null);

  const toast = useCallback((t: Omit<Toast, 'id'>) => {
    const id = Math.random().toString(36).slice(2);
    setToasts(list => [...list.slice(-2), { ...t, id }]);
    setTimeout(() => setToasts(list => list.filter(x => x.id !== id)), t.undo ? 7000 : 4000);
  }, []);

  const refresh = useCallback(async () => {
    const next = await api.state();
    // Announce scans that arrived from a phone since the last look.
    if (seenEvents.current) {
      for (const e of next.events) if (!seenEvents.current.has(e.id) && e.kind === 'scanned') toast({ text: `${e.partName} scanned low`, tone: 'alert' });
    }
    seenEvents.current = new Set(next.events.map(e => e.id));
    setState(next); setLoadError('');
  }, [toast]);

  useEffect(() => {
    refresh().catch(e => setLoadError(e.message));
    const timer = setInterval(() => { if (!document.hidden) refresh().catch(() => {}); }, 2500);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    const onHash = () => { setPage(pageFromHash()); setOpenId(null); setPhone(null); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => { try { localStorage.setItem('team', teamFilter); } catch { /* private mode */ } }, [teamFilter]);

  const go = useCallback((p: Page) => { location.hash = `/${p}`; setPage(p); setOpenId(null); setPhone(null); window.scrollTo(0, 0); }, []);

  const run = useCallback(async <T,>(work: () => Promise<T>, success?: string | ((r: T) => string)) => {
    try {
      const result = await work();
      await refresh();
      if (success) toast({ text: typeof success === 'string' ? success : success(result), tone: 'ok' });
      return result;
    } catch (e) { toast({ text: (e as Error).message, tone: 'error' }); return undefined; }
  }, [refresh, toast]);

  const advance = useCallback((part: Part, to: PartStatus) => {
    if (to === 'ordered') { setOrdering(part); return; }
    void (async () => {
      try {
        const r = await api.setStatus(part.id, to);
        await refresh();
        const text = to === 'stocked' ? `${part.name} restocked` : `${part.name} marked low`;
        toast({ text, tone: 'ok', undo: r.event ? async () => { await api.undo(r.event!.id); await refresh(); } : undefined });
      } catch (e) { toast({ text: (e as Error).message, tone: 'error' }); }
    })();
  }, [refresh, toast]);

  if (!state) return <div className="boot">{loadError ? <div className="boot-error"><Logo /><h1>Can't load inventory</h1><p>{loadError}</p><button className="btn primary" onClick={() => refresh().catch(e => setLoadError(e.message))}>Try again</button></div> : <div className="spinner" aria-label="Loading" />}</div>;

  const myPages = pages.filter(p => p.roles.includes(state.me.role));
  const shown: Page = myPages.some(p => p.id === page) ? page : 'restock';
  const filter = teamFilter === 'all' || state.teams.some(t => t.id === teamFilter) ? teamFilter : 'all';
  const ctx: Ctx = {
    state, teamFilter: filter, setTeamFilter, refresh, go, run,
    notify: text => toast({ text, tone: 'ok' }),
    openPart: setOpenId,
    addPart: () => setForm({}),
    editPart: part => setForm({ part }),
    advance,
    printLabels: ids => { setLabelIds(ids); go('labels'); },
    phoneDemo: part => { setOpenId(null); setPhone(part); },
  };
  const open = openId ? state.parts.find(p => p.id === openId) : undefined;
  const lowCount = state.parts.filter(p => p.status === 'low').length;
  const pendingCount = state.users.filter(u => u.status === 'pending').length;
  const badge = (id: Page) => id === 'restock' ? lowCount : id === 'people' ? pendingCount : 0;

  return <div className="shell">
    <header className="topbar">
      <div className="topbar-inner">
        <a className="brand" href="#/restock" onClick={e => { e.preventDefault(); go('restock'); }} aria-label="BYU Racing shop inventory, home">
          <Logo /><span className="brand-text"><b>Shop Inventory</b><small>BYU Racing</small></span>
        </a>
        <nav className="tabs" aria-label="Main">
          {myPages.map(p => <a key={p.id} href={`#/${p.id}`} className={shown === p.id ? 'active' : ''} aria-current={shown === p.id ? 'page' : undefined} onClick={e => { e.preventDefault(); go(p.id); }}>
            <p.icon aria-hidden /><span>{p.label}</span>{badge(p.id) > 0 && <em className="badge">{badge(p.id)}</em>}
          </a>)}
        </nav>
        <button className="btn accent add-top" onClick={() => setForm({})}><Plus aria-hidden />Add part</button>
        <UserMenu ctx={ctx} onSwitch={(a, teamName) => {
          switchUser(a.id); setTeamFilter('all'); setOpenId(null); setForm(null);
          seenEvents.current = null;
          void refresh().then(() => toast({ text: `Now viewing as ${a.name}, ${a.role === 'admin' ? 'Admin' : `${roleLabel[a.role]} for ${teamName}`}`, tone: 'ok' }));
        }} />
      </div>
    </header>
    <main className="main">
      {shown === 'restock' && <RestockBoard ctx={ctx} />}
      {shown === 'parts' && <PartsPage ctx={ctx} />}
      {shown === 'labels' && <LabelsPage ctx={ctx} preset={labelIds} clearPreset={() => setLabelIds(null)} />}
      {shown === 'people' && <PeoplePage ctx={ctx} />}
      {shown === 'alerts' && <AlertsPage ctx={ctx} />}
      {shown === 'setup' && <SetupPage ctx={ctx} />}
    </main>
    {open && <PartPanel ctx={ctx} part={open} onClose={() => setOpenId(null)} />}
    {form && <PartForm ctx={ctx} part={form.part} onClose={() => setForm(null)} onSaved={id => { setForm(null); if (!form.part) setOpenId(id); }} />}
    {ordering && <OrderDialog part={ordering} onClose={() => setOrdering(null)} onDone={async note => {
      const part = ordering; setOrdering(null);
      try {
        const r = await api.setStatus(part.id, 'ordered', note);
        await refresh();
        toast({ text: `${part.name} marked ordered`, tone: 'ok', undo: r.event ? async () => { await api.undo(r.event!.id); await refresh(); } : undefined });
      } catch (e) { toast({ text: (e as Error).message, tone: 'error' }); }
    }} />}
    {phone && <PhoneDemo part={phone} onClose={() => setPhone(null)} />}
    <Toasts toasts={toasts} dismiss={id => setToasts(list => list.filter(t => t.id !== id))} />
  </div>;
}
