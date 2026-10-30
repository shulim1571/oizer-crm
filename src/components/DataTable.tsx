import { useMemo, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, CloudDownload, ExternalLink } from 'lucide-react';
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
  value: (row: Row) => string;
  /** Optional per-group badge; defaults to the row count. */
  badge?: (rows: Row[]) => string;
}

interface Props {
  title: string;
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
}

const PAGE = 200;

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
      const g = p.groupBy.value(r) || '(empty)';
      if (!m.has(g)) m.set(g, []);
      m.get(g)!.push(r);
    }
    return [...m.entries()].sort((a, b) => (a[0] === '(empty)' ? -1 : b[0] === '(empty)' ? 1 : a[0].localeCompare(b[0])));
  }, [searched, p.groupBy]);

  const visible = useMemo(() => {
    let rows = group && p.groupBy ? searched.filter(r => (p.groupBy!.value(r) || '(empty)') === group) : searched;
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

  return (
    <section className="view">
      <div className="view-head">
        <h1>{p.title}</h1>
        <span className="count">{visible.length.toLocaleString()} rows</span>
        <div className="spacer" />
        <button className="icon-btn outlined" title="Download CSV" onClick={exportCsv}><CloudDownload size={20} /></button>
        {p.actions}
      </div>
      {p.error && <div className="error">{p.error}</div>}
      <div className={`view-body ${groups ? 'with-groups' : ''}`}>
        {groups && (
          <aside className="groups">
            <button className={group === null ? 'active' : ''} onClick={() => setGroup(null)}>All</button>
            {groups.map(([g, rows]) => (
              <button key={g} className={group === g ? 'active' : ''} onClick={() => { setGroup(g); setLimit(PAGE); }}>
                <span className="g-name">{g}</span>
                <span className="badge">{p.groupBy!.badge ? p.groupBy!.badge(rows) : rows.length}</span>
              </button>
            ))}
          </aside>
        )}
        <div className="table-wrap">
          <table className="grid">
            <thead>
              <tr>
                {p.onOpen && <th className="open-col" />}
                {p.columns.map(c => (
                  <th key={c.key} style={{ minWidth: c.width }} className={c.align} onClick={() => toggleSort(c.key)}>
                    {c.label}
                    {sort?.key === c.key && (sort.dir === 'asc' ? <ArrowUp size={14} /> : <ArrowDown size={14} />)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {p.loading && (
                <tr><td colSpan={p.columns.length + 1} className="muted">Loading…</td></tr>
              )}
              {!p.loading && visible.length === 0 && (
                <tr><td colSpan={p.columns.length + 1} className="muted">No rows</td></tr>
              )}
              {!p.loading && visible.slice(0, limit).map((r, i) => (
                <tr key={r.id ?? i} onClick={() => p.onOpen?.(r)} className={p.onOpen ? 'clickable' : ''}>
                  {p.onOpen && <td className="open-col"><ExternalLink size={16} /></td>}
                  {p.columns.map(c => (
                    <td key={c.key} className={c.align}>{c.render ? c.render(r) : String(val(c, r) ?? '')}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {visible.length > limit && (
            <button className="more" onClick={() => setLimit(l => l + PAGE * 5)}>
              Showing {limit.toLocaleString()} of {visible.length.toLocaleString()} — show more
            </button>
          )}
          {p.footer}
        </div>
      </div>
    </section>
  );
}

/** Group badge that shows a dollar total instead of a count. */
export const sumBadge = (key: string) => (rows: Row[]) => money(rows.reduce((s, r) => s + Number(r[key] ?? 0), 0));
