import { CircleAlert, CircleCheck, ScanLine, X } from 'lucide-react';

export interface Toast { id: string; text: string; tone: 'ok' | 'error' | 'alert'; undo?: () => Promise<void> }

export function Toasts({ toasts, dismiss }: { toasts: Toast[]; dismiss: (id: string) => void }) {
  return <div className="toasts" role="status" aria-live="polite">
    {toasts.map(t => <div key={t.id} className={`toast toast-${t.tone}`}>
      {t.tone === 'ok' ? <CircleCheck aria-hidden /> : t.tone === 'alert' ? <ScanLine aria-hidden /> : <CircleAlert aria-hidden />}
      <span>{t.text}</span>
      {t.undo && <button className="toast-undo" onClick={async () => { dismiss(t.id); await t.undo!().catch(() => {}); }}>Undo</button>}
      <button className="toast-x" onClick={() => dismiss(t.id)} aria-label="Dismiss"><X /></button>
    </div>)}
  </div>;
}
