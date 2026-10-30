import { useEffect, useMemo, useRef, useState } from 'react';
import type { Option } from '../lib/lookups';

interface Props {
  value: string | null;
  options: Option[];
  onChange: (v: string | null) => void;
  placeholder?: string;
  required?: boolean;
}

/** Type-to-filter dropdown for long lists (campaigns, donors). */
export default function SearchSelect({ value, options, onChange, placeholder, required }: Props) {
  const selected = options.find(o => o.value === value);
  const [text, setText] = useState(selected?.label ?? '');
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => setText(selected?.label ?? ''), [selected?.label]);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setText(selected?.label ?? '');
      }
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [selected?.label]);

  const matches = useMemo(() => {
    const t = text.toLowerCase();
    const list = !t || t === selected?.label.toLowerCase() ? options : options.filter(o => o.label.toLowerCase().includes(t));
    return list.slice(0, 100);
  }, [text, options, selected?.label]);

  return (
    <div className="ss" ref={ref}>
      <input
        value={text}
        placeholder={placeholder ?? 'Type to search…'}
        required={required && !value}
        onFocus={() => setOpen(true)}
        onChange={e => { setText(e.target.value); setOpen(true); if (!e.target.value) onChange(null); }}
      />
      {open && (
        <ul className="ss-list">
          {!required && <li onMouseDown={() => { onChange(null); setText(''); setOpen(false); }} className="muted">— none —</li>}
          {matches.map(o => (
            <li key={o.value} className={o.value === value ? 'sel' : ''}
                onMouseDown={() => { onChange(o.value); setText(o.label); setOpen(false); }}>
              {o.label}
            </li>
          ))}
          {matches.length === 0 && <li className="muted">No matches</li>}
        </ul>
      )}
    </div>
  );
}
