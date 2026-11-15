import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';
import { byLabel } from '../lib/byLabel';
import type { Option } from '../lib/lookups';

interface Props {
  value: string | null;
  options: Option[];
  onChange: (v: string | null) => void;
  placeholder?: string;
  required?: boolean;
  /** Adds a "+ Create new" line that opens the full form for this kind of record. */
  onCreate?: () => void;
  createLabel?: string;
  /** Keep the list in the order given (e.g. payments by date) instead of alphabetical. */
  keepOrder?: boolean;
  /** Looks and works like a dropdown: an arrow, and the whole list opens on click (still type-to-filter). */
  dropdown?: boolean;
  /** The list opens over the page (fixed, under the box), so a scrolling table or dialog can't cut it off. */
  floating?: boolean;
}

/** Type-to-filter dropdown for long lists (campaigns, donors). */
export default function SearchSelect({ value, options: given, onChange, placeholder, required, onCreate, createLabel, keepOrder, dropdown, floating }: Props) {
  // Always alphabetical by what's shown, never by ID (Moshe Henig, 2026-11-11).
  const options = useMemo(() => (keepOrder ? given : [...given].sort(byLabel)), [given, keepOrder]);
  const selected = options.find(o => o.value === value);
  const [text, setText] = useState(selected?.label ?? '');
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Where a floating list goes: just under the box, following it if the page or table scrolls.
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);
  useLayoutEffect(() => {
    if (!open || !floating) return;
    const place = () => {
      const r = ref.current?.getBoundingClientRect();
      if (r) setPos({ left: r.left, top: r.bottom + 4, width: Math.max(r.width, 260) });
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => { window.removeEventListener('scroll', place, true); window.removeEventListener('resize', place); };
  }, [open, floating]);

  useEffect(() => setText(selected?.label ?? ''), [selected?.label]);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !listRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setText(selected?.label ?? '');
      }
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [selected?.label]);

  // In dropdown mode, a click on the box shows every option (not just the ones matching what's shown in it).
  const [showAll, setShowAll] = useState(false);
  const matches = useMemo(() => {
    const t = text.toLowerCase();
    const list = showAll || !t || t === selected?.label.toLowerCase() ? options : options.filter(o => o.label.toLowerCase().includes(t));
    return list.slice(0, dropdown ? 500 : 100);
  }, [text, options, selected?.label, showAll, dropdown]);
  const openList = () => { setShowAll(true); setOpen(true); };

  const list = open && (
    <ul ref={listRef} className={`ss-list ${floating ? 'ss-floating' : ''}`}
        style={floating && pos ? { position: 'fixed', left: pos.left, top: pos.top, width: pos.width, right: 'auto' } : undefined}>
      {onCreate && (
        <li className="ss-create" onMouseDown={e => { e.preventDefault(); setOpen(false); onCreate(); }}>+ Create new {createLabel}</li>
      )}
      {!required && <li onMouseDown={() => { onChange(null); setText(''); setOpen(false); }} className="muted">— none —</li>}
      {matches.map(o => (
        <li key={o.value} className={o.value === value ? 'sel' : ''}
            onMouseDown={() => { onChange(o.value); setText(o.label); setOpen(false); }}>
          {o.label}
        </li>
      ))}
      {matches.length === 0 && <li className="muted">No matches</li>}
    </ul>
  );
  return (
    <div className={`ss ${dropdown ? 'ss-dropdown' : ''}`} ref={ref}>
      <input
        ref={inputRef}
        value={text}
        placeholder={placeholder ?? 'Type to search…'}
        required={required && !value}
        onFocus={() => (dropdown ? openList() : setOpen(true))}
        onClick={() => { if (dropdown && !open) openList(); }}
        onChange={e => { setText(e.target.value); setShowAll(false); setOpen(true); if (!e.target.value) onChange(null); }}
      />
      {dropdown && (
        <button type="button" className="ss-arrow" tabIndex={-1} aria-label="Show the list"
          onMouseDown={e => { e.preventDefault(); if (open) setOpen(false); else { openList(); inputRef.current?.focus(); } }}>
          <ChevronDown size={16} />
        </button>
      )}
      {floating && list ? createPortal(list, document.body) : list}
    </div>
  );
}
