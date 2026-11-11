import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { MoreHorizontal } from 'lucide-react';

// A row's actions behind one "⋯" button instead of a row of inline buttons.

export interface RowAction { label: string; onClick: () => void; danger?: boolean; hidden?: boolean; disabled?: boolean; icon?: ReactNode }

export default function RowMenu({ items, label = 'Actions', text }: { items: RowAction[]; label?: string; /** Shows a labeled button (e.g. "More") instead of the bare ⋯. */ text?: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<CSSProperties>({ visibility: 'hidden' });
  const shown = items.filter(i => !i.hidden);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node) && !pop.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    // The menu follows its button when the page or the list scrolls, or the window is resized.
    const follow = () => position();
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    window.addEventListener('scroll', follow, true);
    window.addEventListener('resize', follow);
    return () => {
      document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc);
      window.removeEventListener('scroll', follow, true); window.removeEventListener('resize', follow);
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  // Drawn over the page, next to its button, so a list's scrolling box can't cut it off (Moshe Henig, 2026-11-11:
  // the check register's More did nothing on the last rows). Opens upward when there's no room below.
  function position() {
    if (!box.current || !pop.current) return;
    const b = box.current.getBoundingClientRect();
    const h = pop.current.offsetHeight;
    const w = pop.current.offsetWidth;
    const below = window.innerHeight - b.bottom - 8;
    const top = below >= h || b.top < h ? b.bottom + 4 : b.top - h - 4;
    const left = Math.min(Math.max(8, b.right - w), window.innerWidth - w - 8);
    setPlace({ position: 'fixed', top: Math.max(8, top), left, right: 'auto' });
  }
  useLayoutEffect(() => { if (open) position(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!shown.length) return null;
  return (
    <div className="row-menu" ref={box} onClick={e => e.stopPropagation()} onKeyDown={e => { if (open && e.key === 'Tab') setOpen(false); }}>
      <button type="button" className={text ? 'btn' : 'icon-btn'} aria-label={label} aria-haspopup="menu" aria-expanded={open} title={label} onClick={() => setOpen(o => !o)}>
        <MoreHorizontal size={16} />{text && ` ${text}`}
      </button>
      {open && createPortal(
        <div className="menu-pop row-menu-pop" role="menu" ref={pop} style={place} onClick={e => e.stopPropagation()}>
          {shown.map(i => (
            <button key={i.label} type="button" role="menuitem" disabled={i.disabled} className={i.danger ? 'danger' : ''}
              onClick={() => { setOpen(false); i.onClick(); }}>{i.icon}{i.label}</button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}
