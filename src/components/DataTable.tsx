import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Download, Filter, SlidersHorizontal, X } from 'lucide-react';
import { logActivity, type Row } from '../lib/supabase';
import { dateTime, download, money, toCsv } from '../lib/format';
import { useAuth } from '../lib/auth';
import { useSearch } from './Layout';
import TableCustomize, { useSavedViews } from './TableCustomize';

export interface Column {
  key: string;
  label: string;
  render?: (row: Row) => ReactNode;
  /** Plain value used for sorting, search and CSV; defaults to row[key]. */
  value?: (row: Row) => unknown;
  align?: 'right';
  width?: number;
  /** For tables filtered on the server: the column to filter and sort on, and how. */
  filter?: { column: string; type: 'text' | 'number' | 'date' };
}

export interface GroupBy {
  /** Filter name, e.g. "Fundraiser". */
  label: string;
  value: (row: Row) => string;
  /** Optional per-group badge; defaults to the row count. */
  badge?: (rows: Row[]) => string;
}

/** What a server-filtered table needs to fetch its rows. */
export interface ServerQuery {
  filters: Record<string, string>;
  sort: { key: string; dir: 'asc' | 'desc' } | null;
  pageSize: number;
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
  /** Saved views are kept under this name; defaults to the title. */
  viewKey?: string;
  /** Hide filters, column choices and saved views, for simple read-only lists. */
  plain?: boolean;
  /** The page fetches rows itself and is told what filters, sort and page size to apply. */
  onServerQuery?: (q: ServerQuery) => void;
  /** Fetches every row matching the current filters, for export when only a page is loaded. */
  exportAll?: () => Promise<Row[]>;
  /** Row checkboxes. */
  selected?: ReadonlySet<string>;
  onSelect?: (rows: Row[], on: boolean) => void;
}

const EMPTY = '(none)';
const DEFAULT_PAGE_SIZE = 100;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T/;

const display = (v: unknown) => {
  if (v == null) return '';
  return typeof v === 'string' && ISO_DATE.test(v) ? dateTime(v) : String(v);
};

/** ">100", "<=5", "10-20" or a plain number, as bounds. Returns null when it isn't numeric. */
export function parseNumberFilter(text: string): { min?: number; max?: number; minOpen?: boolean; maxOpen?: boolean } | null {
  const t = text.trim();
  const op = t.match(/^(>=|<=|>|<|=)\s*(-?[\d,.]+)$/);
  const num = (s: string) => Number(s.replace(/,/g, ''));
  if (op) {
    const n = num(op[2]);
    if (isNaN(n)) return null;
    if (op[1] === '>') return { min: n, minOpen: true };
    if (op[1] === '>=') return { min: n };
    if (op[1] === '<') return { max: n, maxOpen: true };
    if (op[1] === '<=') return { max: n };
    return { min: n, max: n };
  }
  const range = t.match(/^(-?[\d,.]+)\s*-\s*(-?[\d,.]+)$/);
  if (range) return { min: num(range[1]), max: num(range[2]) };
  const n = num(t);
  return t && !isNaN(n) ? { min: n, max: n } : null;
}

function matches(filter: string, value: unknown) {
  const bounds = parseNumberFilter(filter);
  const n = typeof value === 'number' ? value : Number(value);
  if (bounds && /^[<>=]/.test(filter.trim()) || (bounds && /\d\s*-\s*\d/.test(filter) && !isNaN(n) && value !== '' && value != null)) {
    if (value == null || value === '' || isNaN(n)) return false;
    if (bounds!.min != null && (bounds!.minOpen ? n <= bounds!.min : n < bounds!.min)) return false;
    if (bounds!.max != null && (bounds!.maxOpen ? n >= bounds!.max : n > bounds!.max)) return false;
    return true;
  }
  return display(value).toLowerCase().includes(filter.trim().toLowerCase());
}

export default function DataTable(p: Props) {
  const { q } = useSearch();
  const { inPlatformSession } = useAuth();
  const server = !!p.onServerQuery;
  const saved = useSavedViews(p.viewKey ?? p.title, !p.plain);
  const config = saved.config;
  const setConfig = saved.setConfig;

  const sort = config.sort === undefined ? p.initialSort ?? null : config.sort;
  const filters = config.filters ?? {};
  const pageSize = config.pageSize ?? DEFAULT_PAGE_SIZE;
  const activeFilters = Object.values(filters).filter(v => v.trim()).length;

  const [showFilters, setShowFilters] = useState(false);
  const [showCustomize, setShowCustomize] = useState(false);
  const [group, setGroup] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [exporting, setExporting] = useState(false);

  useEffect(() => { if (activeFilters) setShowFilters(true); }, [activeFilters]);

  const val = (c: Column, r: Row) => (c.value ? c.value(r) : r[c.key]);

  // Saved layouts name columns by key: keep their order, drop any that no longer exist.
  const columns = useMemo(() => {
    if (!config.columns) return p.columns;
    const byKey = new Map(p.columns.map(c => [c.key, c]));
    return config.columns.flatMap(k => byKey.get(k) ?? []);
  }, [config.columns, p.columns]);

  // Tell the page what to fetch, once any saved default has been applied.
  const onServerQuery = p.onServerQuery;
  const queryKey = JSON.stringify({ filters, sort, pageSize });
  useEffect(() => {
    if (onServerQuery && saved.ready) onServerQuery({ filters, sort, pageSize });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey, saved.ready]);

  const searched = useMemo(() => {
    let rows = p.rows;
    if (q && !p.serverSearch) {
      const needle = q.toLowerCase();
      rows = rows.filter(r => p.columns.some(c => display(val(c, r)).toLowerCase().includes(needle)));
    }
    if (!server && activeFilters) {
      const active = p.columns.filter(c => filters[c.key]?.trim());
      rows = rows.filter(r => active.every(c => matches(filters[c.key], val(c, r))));
    }
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.rows, q, p.columns, p.serverSearch, server, queryKey]);

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
    if (sort && !server) {
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
  }, [searched, group, queryKey, p.columns, p.groupBy, server]);

  const pages = server ? 1 : Math.max(1, Math.ceil(visible.length / pageSize));
  const currentPage = Math.min(page, pages - 1);
  const shown = server ? visible : visible.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  useEffect(() => setPage(0), [queryKey, group, q]);

  const toggleSort = (c: Column) => {
    if (server && !c.filter) return;
    const key = c.key;
    setConfig({ ...config, sort: sort?.key === key ? (sort.dir === 'asc' ? { key, dir: 'desc' } : null) : { key, dir: 'asc' } });
  };

  const setFilter = (key: string, value: string) => setConfig({ ...config, filters: { ...filters, [key]: value } });

  async function exportCsv() {
    setExporting(true);
    try {
      const rows = p.exportAll ? await p.exportAll() : visible;
      const cols = columns.map(c => ({ key: c.key, label: c.label }));
      const data = rows.map(r => Object.fromEntries(columns.map(c => [c.key, val(c, r)])));
      download(`${p.exportName ?? p.title}.csv`, toCsv(data, cols));
      void logActivity('export', { table: p.exportName ?? p.title, rows: data.length });
    } finally {
      setExporting(false);
    }
  }

  // Frozen columns stay put while scrolling sideways, so each needs the width of those before it.
  const freeze = Math.min(config.freeze ?? 0, columns.length);
  const headRow = useRef<HTMLTableRowElement>(null);
  const [offsets, setOffsets] = useState<number[]>([]);
  const selectable = !!p.onSelect;
  useLayoutEffect(() => {
    if (!freeze || !headRow.current) return setOffsets([]);
    const cells = [...headRow.current.children] as HTMLElement[];
    const next: number[] = [];
    let left = selectable ? cells[0].offsetWidth : 0;
    for (let i = 0; i < freeze; i++) {
      next.push(left);
      left += cells[i + (selectable ? 1 : 0)]?.offsetWidth ?? 0;
    }
    setOffsets(next);
  }, [freeze, selectable, columns, config.widths, shown.length]);
  const stick = (i: number) => (i < freeze && offsets[i] != null ? { position: 'sticky' as const, left: offsets[i] } : {});
  const frozenClass = (i: number) => (i < freeze ? 'frozen' : '');

  function startResize(e: React.MouseEvent, key: string) {
    e.preventDefault();
    e.stopPropagation();
    const th = (e.target as HTMLElement).parentElement!;
    const startX = e.clientX;
    const startWidth = th.offsetWidth;
    let width = startWidth;
    const move = (m: MouseEvent) => {
      width = Math.max(60, startWidth + m.clientX - startX);
      th.style.minWidth = `${width}px`;
      th.style.width = `${width}px`;
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      setConfig({ ...config, widths: { ...config.widths, [key]: width } });
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }

  const pick = (g: string | null) => setGroup(g);
  const badge = (rows: Row[]) => (p.groupBy!.badge ? p.groupBy!.badge(rows) : rows.length.toLocaleString());
  const pageRowsSelected = selectable && shown.length > 0 && shown.every(r => p.selected?.has(String(r.id)));
  const extraCols = (selectable ? 1 : 0) + (p.onOpen ? 1 : 0);

  return (
    <section className={`view ${config.compact ? 'compact' : ''}`}>
      <div className="view-head">
        <div className="view-title">
          <h1>{p.title}</h1>
          <span className="count">
            {p.loading ? 'Loading…' : p.subtitle ?? `${visible.length.toLocaleString()} ${visible.length === 1 ? 'record' : 'records'}`}
          </span>
        </div>
        <div className="view-actions">
          {p.actions}
          {!p.plain && (
            <>
              <button className={`btn ${activeFilters ? 'on' : ''}`} onClick={() => setShowFilters(s => !s)} title="Filter on any column">
                <Filter size={16} /> Filter{activeFilters ? ` (${activeFilters})` : ''}
              </button>
              <div className="popover-wrap">
                <button className={`btn ${saved.activeName ? 'on' : ''}`} onClick={() => setShowCustomize(s => !s)} title="Customize view">
                  <SlidersHorizontal size={16} /> {saved.activeName ?? 'View'}
                </button>
                {showCustomize && (
                  <TableCustomize
                    columns={p.columns}
                    visibleKeys={columns.map(c => c.key)}
                    saved={saved}
                    onClose={() => setShowCustomize(false)}
                  />
                )}
              </div>
            </>
          )}
          {!inPlatformSession && (
            <button className="btn" title="Download CSV" onClick={exportCsv} disabled={exporting}>
              <Download size={16} /> {exporting ? 'Exporting…' : 'Export'}
            </button>
          )}
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
              <tr ref={headRow}>
                {selectable && (
                  <th className="pick frozen" style={{ position: 'sticky', left: 0 }}>
                    <input type="checkbox" aria-label="Select this page" checked={!!pageRowsSelected}
                           onChange={e => p.onSelect!(shown, e.target.checked)} />
                  </th>
                )}
                {columns.map((c, i) => {
                  const width = config.widths?.[c.key];
                  return (
                    <th key={c.key} style={{ minWidth: width ?? c.width, width, ...stick(i) }}
                        className={`${c.align ?? ''} ${frozenClass(i)} ${server && !c.filter ? 'nosort' : ''}`} onClick={() => toggleSort(c)}>
                      {c.label}
                      {sort?.key === c.key && (sort.dir === 'asc' ? <ArrowUp size={13} /> : <ArrowDown size={13} />)}
                      {!p.plain && <span className="resize" onMouseDown={e => startResize(e, c.key)} onClick={e => e.stopPropagation()} />}
                    </th>
                  );
                })}
                {p.onOpen && <th className="chev" />}
              </tr>
              {showFilters && !p.plain && (
                <tr className="filter-row">
                  {selectable && <th className="pick frozen" style={{ position: 'sticky', left: 0 }} />}
                  {columns.map((c, i) => (
                    <th key={c.key} className={frozenClass(i)} style={stick(i)}>
                      {(!server || c.filter) && (
                        <input aria-label={`Filter ${c.label}`} placeholder={c.filter?.type === 'number' || c.align === 'right' ? '>100' : c.filter?.type === 'date' ? 'YYYY-MM-DD' : 'Contains…'}
                               value={filters[c.key] ?? ''} onChange={e => setFilter(c.key, e.target.value)} />
                      )}
                    </th>
                  ))}
                  {p.onOpen && (
                    <th className="chev">
                      {activeFilters > 0 && (
                        <button className="icon-btn" title="Clear filters" onClick={() => setConfig({ ...config, filters: {} })}><X size={14} /></button>
                      )}
                    </th>
                  )}
                </tr>
              )}
            </thead>
            <tbody>
              {p.loading && Array.from({ length: 8 }, (_, i) => (
                <tr key={i} className="skeleton">
                  {selectable && <td />}
                  {columns.map(c => <td key={c.key}><span style={{ width: `${40 + ((i * 7 + c.key.length * 13) % 50)}%` }} /></td>)}
                  {p.onOpen && <td />}
                </tr>
              ))}
              {!p.loading && shown.length === 0 && (
                <tr><td colSpan={columns.length + extraCols} className="empty">
                  {activeFilters ? 'Nothing matches these filters.' : `Nothing here yet${q && !p.serverSearch ? ` matching “${q}”` : ''}.`}
                </td></tr>
              )}
              {!p.loading && shown.map((r, i) => (
                <tr key={r.id ?? i} onClick={() => p.onOpen?.(r)} className={p.onOpen ? 'clickable' : ''}>
                  {selectable && (
                    <td className="pick frozen" style={{ position: 'sticky', left: 0 }} onClick={e => e.stopPropagation()}>
                      <input type="checkbox" aria-label="Select row" checked={!!p.selected?.has(String(r.id))}
                             onChange={e => p.onSelect!([r], e.target.checked)} />
                    </td>
                  )}
                  {columns.map((c, ci) => (
                    <td key={c.key} className={`${c.align ?? ''} ${frozenClass(ci)}`} style={stick(ci)}>{c.render ? c.render(r) : display(val(c, r))}</td>
                  ))}
                  {p.onOpen && <td className="chev"><ChevronRight size={16} /></td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!server && !p.loading && pages > 1 && (
          <div className="table-foot">
            <span>Page {currentPage + 1} of {pages} · {visible.length.toLocaleString()} records</span>
            <div className="pager">
              <button className="btn" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</button>
              <button className="btn" disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>Next</button>
            </div>
          </div>
        )}
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

