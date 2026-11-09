import { useEffect, useRef, useState, type ReactNode } from 'react';
import { MoreHorizontal } from 'lucide-react';

// A row's actions behind one "⋯" button instead of a row of inline buttons.

export interface RowAction { label: string; onClick: () => void; danger?: boolean; hidden?: boolean; disabled?: boolean; icon?: ReactNode }

export default function RowMenu({ items, label = 'Actions', text }: { items: RowAction[]; label?: string; /** Shows a labeled button (e.g. "More") instead of the bare ⋯. */ text?: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const shown = items.filter(i => !i.hidden);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  if (!shown.length) return null;
  return (
    <div className="row-menu" ref={box} onClick={e => e.stopPropagation()}>
      <button type="button" className={text ? 'btn' : 'icon-btn'} aria-label={label} aria-haspopup="menu" aria-expanded={open} title={label} onClick={() => setOpen(o => !o)}>
        <MoreHorizontal size={16} />{text && ` ${text}`}
      </button>
      {open && (
        <div className="menu-pop" role="menu">
          {shown.map(i => (
            <button key={i.label} type="button" role="menuitem" disabled={i.disabled} className={i.danger ? 'danger' : ''}
              onClick={() => { setOpen(false); i.onClick(); }}>{i.icon}{i.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}
