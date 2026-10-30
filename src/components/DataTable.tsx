import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Download, X } from 'lucide-react';
import type { Row } from '../lib/supabase';
import { download, money, toCsv } from '../lib/format';
import { useSearch } from './Layout';

export interface Column {
  key: string;
  label: string;
  render?: (row: Row) => ReactNode;
  /** Plain value used for sorting, search and CSV; defaults to row[key]. */
  value?: (row: Row) => unknown;
  align?: 'right';
  width?: number;
}

export interface GroupBy {
  /** Filter name, e.g. "Manager". */
  label: string;
  value: (row: Row) => string;
  /** Optional per-group badge; defaults to the row count. */
  badge?: (rows: Row[]) => string;
}

interface Props {
  title: string;
  subtitle?: ReactNode;
  rows: Row[];
  columns: Column[];
  loading?: boolean;
  error?: string | null;
  groupBy?: GroupBy;
  onOpen?: (row: Row) => void;
  actions?: ReactNode;
  initialSort?: { key: string; dir: 'asc' | 'desc' };
  exportName?: string;
  /** Skip the global search filter (when the page searches server-side). */
  serverSearch?: boolean;
  footer?: ReactNode;
  /** KPI cards or other content shown between the header and the table. */
  summary?: ReactNode;
}

const PAGE = 200;
const EMPTY = '(none)';

export default function DataTable(p: Props) {
  const { q } = useSearch();
  const [sort, setSort] = useState(p.initialSort ?? null);
  const [group, setGroup] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE);

  const val = (c: Column, r: Row) => (c.value ? c.value(r) : r[c.key]);

  const searched = useMemo(() => {
    if (!q || p.serverSearch) return p.rows;
    const needle = q.toLowerCase();
    return p.rows.filter(r => p.columns.some(c => String(val(c, r) ?? '').toLowerCase().includes(needle)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.rows, q, p.columns, p.serverSearch]);

  const groups = useMemo(() => {
    if (!p.groupBy) return null;
    const m = new Map<string, Row[]>();
    for (const r of searched) {
      const g = p.groupBy.value(r) || EMPTY;
      if (!m.has(g)) m.set(g, []);
      m.get(g)!.push(r);
    }
    return [...m.entries()].sort((a, b) => (a[0] === EMPTY ? 1 : b[0] === EMPTY ? -1 : a[0].localeCompare(b[0])));
  }, [searched, p.groupBy]);

  const visible = useMemo(() => {
    let rows = group && p.groupBy ? searched.filter(r => (p.groupBy!.value(r) || EMPTY) === group) : searched;
    if (sort) {
      const col = p.columns.find(c => c.key === sort.key);
      if (col) {
        const dir = sort.dir === 'asc' ? 1 : -1;
        rows = [...rows].sort((a, b) => {
          const x = val(col, a), y = val(col, b);
          if (x == null || x === '') return 1;
          if (y == null || y === '') return -1;
          const nx = Number(x), ny = Number(y);
          if (!isNaN(nx) && !isNaN(ny) && typeof x !== 'boolean') return (nx - ny) * dir;
          return String(x).localeCompare(String(y)) * dir;
        });
      }
    }
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searched, group, sort, p.columns, p.groupBy]);

  const toggleSort = (key: string) =>
    setSort(s => (s?.key === key ? (s.dir === 'asc' ? { key, dir: 'desc' } : null) : { key, dir: 'asc' }));

  const exportCsv = () => {
    const cols = p.columns.map(c => ({ key: c.key, label: c.label }));
    const data = visible.map(r => Object.fromEntries(p.columns.map(c => [c.key, val(c, r)])));
    download(`${p.exportName ?? p.title}.csv`, toCsv(data, cols));
  };

  const pick = (g: string | null) => { setGroup(g); setLimit(PAGE); };
  const badge = (rows: Row[]) => (p.groupBy!.badge ? p.groupBy!.badge(rows) : rows.length.toLocaleString());

  return (
    <section className="view">
      <div className="view-head">
        <div className="view-title">
          <h1>{p.title}</h1>
          <span className="count">
            {p.loading ? 'Loading…' : p.subtitle ?? `${visible.length.toLocaleString()} ${visible.length === 1 ? 'record' : 'records'}`}
          </span>
        </div>
        <div className="view-actions">
          {p.actions}
          <button className="btn" title="Download CSV" onClick={exportCsv}><Download size={16} /> Export</button>
        </div>
      </div>

      {p.summary}

      {groups && groups.length > 1 && (
        groups.length <= 8 ? (
          <div className="filters">
            <button className={`chip-btn ${group === null ? 'active' : ''}`} onClick={() => pick(null)}>
              All <span className="badge">{p.groupBy!.badge ? p.groupBy!.badge(searched) : searched.length.toLocaleString()}</span>
            </button>
            {groups.map(([g, rows]) => (
              <button key={g} className={`chip-btn ${group === g ? 'active' : ''}`} onClick={() => pick(g)}>
                {g} <span className="badge">{badge(rows)}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="filters">
            <GroupPicker label={p.groupBy!.label} groups={groups} value={group} onChange={pick} badge={badge} />
          </div>
        )
      )}

      {p.error && <div className="error">{p.error}</div>}

      <div className="table-card">
        <div className="table-wrap">
          <table className="grid">
            <thead>
              <tr>
                {p.columns.map(c => (
                  <th key={c.key} style={{ minWidth: c.width }} className={c.align} onClick={() => toggleSort(c.key)}>
                    {c.label}
                    {sort?.key === c.key && (sort.dir === 'asc' ? <ArrowUp size={13} /> : <ArrowDown size={13} />)}
                  </th>
                ))}
                {p.onOpen && <th className="chev" />}
              </tr>
            </thead>
            <tbody>
              {p.loading && Array.from({ length: 8 }, (_, i) => (
                <tr key={i} className="skeleton">
                  {p.columns.map(c => <td key={c.key}><span style={{ width: `${40 + ((i * 7 + c.key.length * 13) % 50)}%` }} /></td>)}
                  {p.onOpen && <td />}
                </tr>
              ))}
              {!p.loading && visible.length === 0 && (
                <tr><td colSpan={p.columns.length + 1} className="empty">Nothing here yet{q && !p.serverSearch ? ` matching “${q}”` : ''}.</td></tr>
              )}
              {!p.loading && visible.slice(0, limit).map((r, i) => (
                <tr key={r.id ?? i} onClick={() => p.onOpen?.(r)} className={p.onOpen ? 'clickable' : ''}>
                  {p.columns.map(c => (
                    <td key={c.key} className={c.align}>{c.render ? c.render(r) : String(val(c, r) ?? '')}</td>
                  ))}
                  {p.onOpen && <td className="chev"><ChevronRight size={16} /></td>}
                </tr>
              ))}
            </tbody>
          </table>
          {!p.loading && visible.length > limit && (
            <div className="table-foot">
              <span>Showing {limit.toLocaleString()} of {visible.length.toLocaleString()}</span>
              <button className="btn" onClick={() => setLimit(l => l + PAGE * 5)}>Show more</button>
            </div>
          )}
        </div>
        {p.footer && <div className="table-foot">{p.footer}</div>}
      </div>
    </section>
  );
}

function GroupPicker({ label, groups, value, onChange, badge }: {
  label: string;
  groups: [string, Row[]][];
  value: string | null;
  onChange: (v: string | null) => void;
  badge: (rows: Row[]) => string;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const shown = groups.filter(([g]) => g.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="popover-wrap" ref={ref}>
      <button className={`chip-btn ${value ? 'active' : ''}`} onClick={() => setOpen(o => !o)}>
        {label}: {value ?? 'All'}
        {value
          ? <X size={14} onClick={e => { e.stopPropagation(); onChange(null); }} />
          : <ChevronDown size={14} />}
      </button>
      {open && (
        <div className="popover">
          <input autoFocus placeholder={`Find ${label.toLowerCase()}…`} value={filter} onChange={e => setFilter(e.target.value)} />
          <ul>
            <li className={value === null ? 'sel' : ''} onClick={() => { onChange(null); setOpen(false); }}>
              <span className="g-name">All</span>
            </li>
            {shown.map(([g, rows]) => (
              <li key={g} className={value === g ? 'sel' : ''} onClick={() => { onChange(g); setOpen(false); }}>
                <span className="g-name">{g}</span><span className="badge">{badge(rows)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Group badge that shows a dollar total instead of a count. */
export const sumBadge = (key: string) => (rows: Row[]) => money(rows.reduce((s, r) => s + Number(r[key] ?? 0), 0));
