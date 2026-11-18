import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { statusLabel, type Part, type PartStatus } from '../../shared/types';

export function Logo() {
  return <span className="logo"><img src="/logo.png" alt="BYU Racing" /></span>;
}

export function StatusPill({ status }: { status: PartStatus }) {
  return <span className={`pill pill-${status}`}><span className="pill-dot" />{statusLabel[status]}</span>;
}

export function Dot({ color, title }: { color: string; title?: string }) {
  return <span className="dot" style={{ background: color }} title={title} aria-hidden={title ? undefined : true} />;
}

// Generated part art in public/parts/, matched by keywords in the part name. Order matters: first match wins.
const artRules: [RegExp, string][] = [
  [/nut/i, 'nut'], [/washer|grommet|spacer/i, 'washer'], [/terminal|crimp|splice/i, 'terminal'],
  [/receptacle|wedgelock|connector|plug|deutsch/i, 'connector'], [/tie|heat shrink|tubing/i, 'tie'],
  [/wire|cable/i, 'wire'], [/clamp/i, 'clamp'], [/pin|clip|fastener/i, 'pin'], [/rivet/i, 'rivet'],
  [/bolt|screw|stud/i, 'bolt'],
];
export const partArt = (name: string) => `/parts/${artRules.find(([re]) => re.test(name))?.[1] ?? 'box'}.webp`;

export function PartThumb({ part, size = 'md' }: { part: Pick<Part, 'name' | 'photo'>; size?: 'sm' | 'md' | 'lg' }) {
  if (part.photo) return <span className={`thumb thumb-${size}`}><img src={part.photo} alt="" /></span>;
  return <span className={`thumb thumb-${size} thumb-art`}><img src={partArt(part.name)} alt="" loading="lazy" /></span>;
}

export function Modal({ title, onClose, children, footer, wide, labelledBy }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean; labelledBy?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('input:not([type=file]):not([type=radio]):not([type=checkbox])')
      ?? ref.current?.querySelector<HTMLElement>('.modal-foot .btn:last-child');
    first?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    document.body.classList.add('no-scroll');
    return () => { window.removeEventListener('keydown', onKey); document.body.classList.remove('no-scroll'); prev?.focus?.(); };
  }, [onClose]);
  return <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div ref={ref} className={`modal${wide ? ' modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined} aria-labelledby={labelledBy}>
      <header className="modal-head"><h2>{title}</h2><button className="icon-btn modal-close" onClick={onClose} aria-label="Close"><X /></button></header>
      <div className="modal-body">{children}</div>
      {footer && <footer className="modal-foot">{footer}</footer>}
    </div>
  </div>;
}

export function Empty({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return <div className="empty"><span className="empty-icon">{icon}</span><strong>{title}</strong>{children && <p>{children}</p>}</div>;
}

/** Full-page card layout for the scan, sign-in, and join screens. */
export function Shell({ children }: { children: React.ReactNode }) {
  return <div className="scan">
    <header className="scan-top"><Logo />Shop Inventory</header>
    <main className="scan-main join-main">{children}</main>
    <footer className="scan-foot">BYU Racing · Shop Inventory</footer>
  </div>;
}

