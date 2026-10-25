import { useEffect, useRef, useState } from 'react';
import type { Command, InventoryState } from '../../shared/types';
import { ApiError, accountFence, getState, newCommand, persistPendingCommand, readPendingCommand, sendCommand, prepareSound, playSavedSound } from '../api';
import { TeamLogo } from './TeamLogo';

const destinationKey = 'racing-phone-scan-bin';
// Remember the scanned destination across Google OAuth; consume it after the save is confirmed.
export function readPhoneScan(): string | null {
  const query = new URLSearchParams(window.location.search).get('scan');
  try {
    if (query !== null) window.sessionStorage.setItem(destinationKey, query.slice(0, 200));
    return query === null ? window.sessionStorage.getItem(destinationKey) : query.slice(0, 200);
  } catch { return query; }
}
export function clearPhoneScan() {
  try { window.sessionStorage.removeItem(destinationKey); } catch { /* Navigation still works. */ }
  const url = new URL(window.location.href); url.searchParams.delete('scan');
  window.history.replaceState(null, '', url.pathname + url.search + url.hash);
}

export function PhoneScan({ binId, onClose, completed, onComplete }: { binId: string; onClose: () => void; completed: boolean; onComplete: () => void }) {
  const [state, setState] = useState<InventoryState | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [earlierSave, setEarlierSave] = useState(false);
  const [pending, setPending] = useState<Command | null>(readPendingCommand);
  const inFlight = useRef(false);
  const autoStarted = useRef(false);
  useEffect(() => { let active = true; void getState().then(next => { if (active) setState(next); }).catch(e => { if (active) setError(e.message); }); return () => { active = false; }; }, [binId]);
  async function reload() {
    setError(''); setBusy(true);
    try { const next = await getState(); autoStarted.current = false; setState(next); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const part = state?.parts.find(p => p.bins.some(b => b.id === binId));
  const bin = part?.bins.find(b => b.id === binId);
  const other = part?.bins.find(b => b.id !== binId);
  const ownPending = pending?.action.type === 'scan' && pending.action.binId === binId && pending.provenance?.source === 'phone';
  useEffect(() => {
    if (!state || autoStarted.current || completed) return;
    autoStarted.current = true;
    if (!bin || (pending && !ownPending)) return;
    if (bin.status === 'empty' && !pending) { clearPhoneScan(); onComplete(); return; }
    void save();
  }, [state, completed]);
  async function save() {
    if (inFlight.current || !bin || (pending && !ownPending)) return;
    const fence = accountFence();
    const command = pending ?? { ...newCommand({ type: 'scan', binId, cycle: bin.cycle }), provenance: { source: 'phone' as const } };
    inFlight.current = true; setBusy(true); setError(''); prepareSound();
    persistPendingCommand(command); setPending(command);
    try {
      const result = await sendCommand(command);
      const currentBin = result.state.parts.flatMap(p => p.bins).find(b => b.id === binId);
      const sameCycle = command.action.type === 'scan' && currentBin?.cycle === command.action.cycle;
      setState(result.state); persistPendingCommand(null); setPending(null);
      clearPhoneScan(); onComplete();
      setSaved(sameCycle && currentBin?.status === 'empty'); setEarlierSave(!sameCycle || currentBin?.status !== 'empty'); playSavedSound();
    } catch (e) {
      try { fence(); } catch { return; }
      setError((e as Error).message);
      if (e instanceof ApiError && e.status < 500) { persistPendingCommand(null); setPending(null); }
    } finally { inFlight.current = false; setBusy(false); }
  }
  const practice = part && (part.sample || part.practice !== false);
  return <main className="phone-scan"><section className="phone-scan-card" aria-label="Empty-bin scan">
    <TeamLogo /><p className="eyebrow">BYU RACING / BIN SCAN</p>
    {!state ? <><h1>Opening the bin…</h1><p>Checking the latest supply status.</p></> : !bin || !part ? <><h1>Bin not found</h1><p>This label may have been retired. Ask a buyer to print a new label.</p></> : <>
      <h1>{saved ? 'Bin marked empty' : earlierSave ? 'Earlier scan confirmed' : bin.status === 'empty' && !pending ? 'This bin is already empty' : completed ? 'Scan already handled' : error ? 'Scan not confirmed' : 'Saving your scan…'}</h1>
      <div className="phone-scan-part"><h2>{part.name}</h2><p>{part.specification}</p><strong>Bin {part.bins[0].id === bin.id ? 'A' : 'B'} · {part.location}</strong><code>{bin.id}</code></div>
      {practice && <p className="phone-scan-note">Sample / practice inventory. No buyer email will be sent.</p>}
      {earlierSave && <p role="status">Your earlier scan was saved, and this bin has changed since then. Its current status is {bin.status === 'empty' ? 'empty' : bin.status === 'ready' ? 'ready' : 'in use'}. No new empty-bin scan was recorded.</p>}
      {completed && !saved && !earlierSave && bin.status !== 'empty' && <p>This scan has already been handled. Scan the QR label again only when the bin is empty.</p>}
      {saved || (bin.status === 'empty' && !pending) ? <div role="status" className="phone-scan-result"><strong>{other?.status === 'empty' ? 'Both bins are empty.' : 'Switch to the other bin.'}</strong><p>{saved ? 'Supply status is saved. You can close this page. The shared dashboard will refresh automatically.' : 'The dashboard already shows this bin as empty. No duplicate request is needed.'}</p></div> : !completed && !earlierSave && !error && <p>Marking this bin empty and requesting a refill automatically.</p>}
      {pending && !ownPending && <p role="alert">Another change is waiting to be saved. Return to inventory to resolve it first.</p>}
      {ownPending && error && <button className="button primary" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Retry save safely'}</button>}
    </>}
    {error && <p className="inline-error" role="alert">{error}{ownPending && ' The save may have reached the server. Retry safely to confirm.'}</p>}
    {error && !pending && <button className="button primary" disabled={busy} onClick={() => void reload()}>Reload and retry</button>}
    <button className="button secondary" disabled={busy} onClick={onClose}>Back to inventory</button>
  </section></main>;
}
