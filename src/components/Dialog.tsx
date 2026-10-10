import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
export const DialogErrorContext = createContext<{ error: string | null; onRetry?: () => void }>({ error: null });
export function Dialog({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const feedback = useContext(DialogErrorContext);
  useEffect(() => {
    const dialog = ref.current!; dialog.showModal();
    const previous = document.body.style.overflow; document.body.style.overflow = 'hidden';
    return () => { dialog.close(); document.body.style.overflow = previous; };
  }, []);
  return <dialog ref={ref} className={`dialog ${wide ? 'dialog-wide' : ''}`} aria-label={title} onCancel={e => { e.preventDefault(); onClose(); }} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="dialog-inner"><div className="dialog-top"><span>{title}</span><button className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={20} /></button></div>{feedback.error && <div className="dialog-error inline-error" role="alert">{feedback.error}{feedback.onRetry && <button className="button secondary small-button" onClick={feedback.onRetry}>Retry safely</button>}</div>}{children}</div>
  </dialog>;
}
