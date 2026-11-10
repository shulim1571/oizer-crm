import { useMemo, useState } from 'react';
import { Printer, X } from 'lucide-react';
import DataTable, { type Column } from '../components/DataTable';
import { useAuth } from '../lib/auth';
import { dateTime, download, localToday, money, toCsv } from '../lib/format';
import { printReport, type ReportColumn } from '../lib/printReport';
import { XLSX_TYPE, downloadBytes, sheetValue, toXlsx } from '../lib/sheets';
import { fetchAll, supabase, type Row } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';
import { Overlay } from './Pledges';

// ---------------------------------------------------------------------------
// Date ranges, as the spec lists them
// ---------------------------------------------------------------------------
type Range = 'today' | 'yesterday' | 'week' | 'month' | 'year' | 'custom';
const shiftDay = (iso: string, n: number) => { const [y, m, d] = iso.split('-').map(Number); const t = new Date(y, m - 1, d + n); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`; };
function rangeOf(r: Range, from: string, to: string): [string, string] {
  const today = localToday();
  const [y, m, d] = today.split('-').map(Number);
  switch (r) {
    case 'today': return [today, today];
    case 'yesterday': return [shiftDay(today, -1), shiftDay(today, -1)];
    case 'week': return [shiftDay(today, -new Date(y, m - 1, d).getDay()), today];
    case 'month': return [today.slice(0, 8) + '01', today];
    case 'year': return [today.slice(0, 5) + '01-01', today];
    default: return [from, to];
  }
}
/** Start and end of the days on this computer, which is where the office is. */
const bounds = (from: string, to: string) => [new Date(`${from}T00:00:00`).toISOString(), new Date(`${shiftDay(to, 1)}T00:00:00`).toISOString()];

function RangePicker({ range, setRange, from, setFrom, to, setTo }: { range: Range; setRange: (r: Range) => void; from: string; setFrom: (s: string) => void; to: string; setTo: (s: string) => void }) {
  return (
    <div className="filter-bar">
      <select aria-label="Period" value={range} onChange={e => setRange(e.target.value as Range)}>
        <option value="today">Today</option><option value="yesterday">Yesterday</option><option value="week">This week</option>
        <option value="month">This month</option><option value="year">This year</option><option value="custom">Custom range</option>
      </select>
      {range === 'custom' && <>
        <input type="date" aria-label="From" value={from} onChange={e => setFrom(e.target.value)} />
        <input type="date" aria-label="To" value={to} onChange={e => setTo(e.target.value)} />
      </>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Transaction reporting by source
// ---------------------------------------------------------------------------
const CATEGORIES = ['Online', 'Phone', 'Donary Machines', 'DAF', 'Manual', 'Imported', 'Other'];

export function SourceReportPage() {
  const [range, setRange] = useState<Range>('month');
  const [from, setFrom] = useState(localToday().slice(0, 8) + '01');
  const [to, setTo] = useState(localToday());
  const [category, setCategory] = useState('');
  const [campaign, setCampaign] = useState('');
  const [start, end] = rangeOf(range, from, to);
  const q = useQuery(async () => {
    const [a, b] = bounds(start, end);
    return fetchAll((x, y) => {
      let s = supabase.from('source_lines').select('*').gte('created_at', a).lt('created_at', b).order('created_at', { ascending: false });
      if (campaign.trim()) s = s.eq('campaign_id', campaign.trim());
      return s.range(x, y) as never;
    }) as Promise<Row[]>;
  }, [start, end, campaign]);
  const lines = ((q.data as Row[]) ?? []).filter(l => !category || l.source_category === category);
  const bySource = useMemo(() => {
    const m = new Map<string, Row>();
    for (const l of lines) {
      const s = m.get(l.source_tag) ?? { id: l.source_tag, source_tag: l.source_tag, source_category: l.source_category, count: 0, gross: 0, fees: 0, net: 0 };
      s.count += 1; s.gross += Number(l.amount); s.fees += Number(l.fee); s.net += Number(l.net);
      m.set(l.source_tag, s);
    }
    return [...m.values()].sort((a, b) => b.gross - a.gross);
  }, [lines]);
  const total = bySource.reduce((t, s) => ({ gross: t.gross + s.gross, fees: t.fees + s.fees, net: t.net + s.net, count: t.count + s.count }), { gross: 0, fees: 0, net: 0, count: 0 });
  const period = start === end ? start : `${start} to ${end}`;

  return (
    <section className="view">
      <div className="filter-bar">
        <RangePicker range={range} setRange={setRange} from={from} setFrom={setFrom} to={to} setTo={setTo} />
        <select aria-label="Source category" value={category} onChange={e => setCategory(e.target.value)}>
          <option value="">All sources</option>{CATEGORIES.map(c => <option key={c}>{c}</option>)}
        </select>
        <input aria-label="Campaign ID" placeholder="Campaign ID (all if empty)" value={campaign} onChange={e => setCampaign(e.target.value)} />
      </div>
      <div className="kpis">
        <div className="kpi"><div><div className="kpi-label">Received · {period}</div><div className="kpi-value">{money(total.gross)}</div></div></div>
        <div className="kpi"><div><div className="kpi-label">Fees</div><div className="kpi-value">{money(total.fees)}</div></div></div>
        <div className="kpi"><div><div className="kpi-label">Net</div><div className="kpi-value">{money(total.net)}</div></div></div>
        <div className="kpi"><div><div className="kpi-label">Payments</div><div className="kpi-value">{total.count.toLocaleString()}</div></div></div>
      </div>
      <DataTable
        title="By source"
        subtitle={`Completed payments, ${period}. Fundraisers see their own campaigns only.`}
        rows={bySource}
        loading={q.loading}
        error={q.error}
        exportName={`sources-${start}-${end}`}
        columns={[
          { key: 'source_tag', label: 'Source', width: 220 },
          { key: 'source_category', label: 'Category' },
          { key: 'count', label: 'Payments', align: 'right' },
          { key: 'gross', label: 'Gross', render: r => money(r.gross), value: r => r.gross.toFixed(2), align: 'right' },
          { key: 'fees', label: 'Fees', render: r => money(r.fees), value: r => r.fees.toFixed(2), align: 'right' },
          { key: 'net', label: 'Net', render: r => money(r.net), value: r => r.net.toFixed(2), align: 'right' },
        ]}
      />
      <details className="help report-detail">
        <summary>Show every payment ({lines.length.toLocaleString()})</summary>
      <DataTable
        title="Payments"
        rows={lines}
        loading={q.loading}
        exportName={`source-payments-${start}-${end}`}
        columns={[
          { key: 'created_at', label: 'Date', render: r => dateTime(r.created_at), value: r => dateTime(r.created_at) },
          { key: 'donor_name', label: 'Donor', width: 180 },
          { key: 'campaign_id', label: 'Campaign' },
          { key: 'amount', label: 'Amount', render: r => money(r.amount), align: 'right' },
          { key: 'source_tag', label: 'Source', width: 200 },
        ]}
      />
      </details>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Campaign report and donor list, from the campaign's page
// ---------------------------------------------------------------------------
const REPORT_COLUMNS: (ReportColumn & { get: (r: Row) => string })[] = [
  { key: 'date', label: 'Date', get: r => dateTime(r.created_at) },
  { key: 'donor', label: 'Donor', get: r => (r.anonymous ? 'Anonymous' : r.donor_name ?? r.name ?? '') },
  { key: 'campaign', label: 'Campaign', get: r => r.campaign_id },
  { key: 'amount', label: 'Amount', align: 'right', get: r => money(r.amount) },
  { key: 'method', label: 'Payment method', get: r => r.payment_method ?? '' },
  { key: 'source', label: 'Source', get: r => r.source_name ?? r.source ?? '' },
  // A failed charge took no money: no fee, no net.
  { key: 'fee', label: 'Fee', align: 'right', get: r => (r.status === 'failed' ? '' : money(r.fee ?? 0)) },
  { key: 'net', label: 'Net', align: 'right', get: r => (r.status === 'failed' ? '' : money(Number(r.amount) - Number(r.fee ?? 0))) },
  { key: 'status', label: 'Status', get: r => r.status },
  { key: 'split', label: 'Split', get: r => (r.split_group_id ? 'Part of a split' : '') },
  { key: 'notes', label: 'Notes', get: r => r.notes ?? '' },
];

async function campaignFamily(id: string, withSubs: boolean) {
  if (!withSubs) return [id];
  const all = ((await supabase.from('campaigns').select('id, parent_campaign_id')).data ?? []) as Row[];
  const ids = [id];
  for (let i = 0; i < ids.length; i++) all.filter(c => c.parent_campaign_id === ids[i]).forEach(c => ids.push(c.id));
  return ids;
}

function exportRows(kind: 'csv' | 'xlsx', name: string, cols: ReportColumn[], rows: Record<string, unknown>[]) {
  if (kind === 'csv') download(`${name}.csv`, toCsv(rows, cols));
  else downloadBytes(`${name}.xlsx`, toXlsx(rows.map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, sheetValue(v)]))), cols, name), XLSX_TYPE);
}

export function CampaignReportDialog({ campaign, onClose }: { campaign: Row; onClose: () => void }) {
  const [range, setRange] = useState<Range>('year');
  const [from, setFrom] = useState(localToday().slice(0, 5) + '01-01');
  const [to, setTo] = useState(localToday());
  const [all, setAll] = useState(true);
  const [subs, setSubs] = useState(Number(campaign.sub_count) > 0);
  const [cols, setCols] = useState<string[]>(['date', 'donor', 'amount', 'method', 'fee', 'net']);
  const [status, setStatus] = useState('completed');
  const [error, setError] = useState<string | null>(null);
  const [start, end] = rangeOf(range, from, to);
  const q = useQuery(async () => {
    const ids = await campaignFamily(campaign.id, subs);
    const [a, b] = bounds(start, end);
    const rows = await fetchAll((x, y) => {
      let s = supabase.from('donations').select('*, donors(display_name), sources(name)').in('campaign_id', ids).order('created_at').range(x, y);
      if (!all) s = s.gte('created_at', a).lt('created_at', b);
      if (status) s = s.eq('status', status);
      return s as never;
    }) as Row[];
    return rows.map(r => ({ ...r, donor_name: r.donors?.display_name, source_name: r.sources?.name }));
  }, [campaign.id, subs, all, start, end, status]);
  const rows = (q.data as Row[]) ?? [];
  const chosen = REPORT_COLUMNS.filter(c => cols.includes(c.key) || (c.key === 'campaign' && subs && cols.includes('campaign')));
  const data = rows.map(r => Object.fromEntries(chosen.map(c => [c.key, c.get(r)])));
  // Totals count money that came in: failed, voided and refunded rows can be listed but add nothing.
  const counted = rows.filter(r => r.status === 'completed' || r.status === 'collect');
  const raised = counted.reduce((t, r) => t + Number(r.amount), 0);
  const fees = counted.reduce((t, r) => t + Number(r.fee ?? 0), 0);
  const summary: [string, string][] = [
    ['Total raised', money(raised)], ['Fees', money(fees)], ['Net', money(raised - fees)],
    ['Balance now', money(campaign.balance)], ['Open pledges', money(campaign.pledged_open)], ['Pledges due in 90 days', money(campaign.pledge_scheduled_90)],
  ];
  const byCampaign = subs ? Object.values(rows.reduce<Record<string, Row>>((m, r) => {
    const s = m[r.campaign_id] ?? { campaign: r.campaign_id, count: 0, total: 0 };
    s.count += 1; s.total += Number(r.amount);
    m[r.campaign_id] = s;
    return m;
  }, {})).map(s => ({ ...s, total: money(s.total) })) : [];
  const name = `campaign-${campaign.id}-report`;
  const title = `${campaign.internal_name || campaign.external_name} (${campaign.id})`;

  return (
    <Overlay onClose={onClose}>
      <div className="form-head"><h2>Campaign report</h2><button type="button" className="icon-btn" title="Close" onClick={onClose}><X size={18} /></button></div>
      <div className="filter-bar">
        <label className="inline-check"><input type="checkbox" checked={all} onChange={e => setAll(e.target.checked)} /> All time</label>
        {!all && <RangePicker range={range} setRange={setRange} from={from} setFrom={setFrom} to={to} setTo={setTo} />}
        <select aria-label="Status" value={status} onChange={e => setStatus(e.target.value)}>
          <option value="completed">Completed</option><option value="">Every status</option><option value="refunded">Refunded</option><option value="returned">Returned</option><option value="voided">Voided</option>
        </select>
        {Number(campaign.sub_count) > 0 && <label className="inline-check"><input type="checkbox" checked={subs} onChange={e => setSubs(e.target.checked)} /> Include sub-campaigns</label>}
      </div>
      <p className="muted small">Columns</p>
      <div className="check-row">
        {REPORT_COLUMNS.map(c => (
          <label key={c.key} className="inline-check"><input type="checkbox" checked={cols.includes(c.key)} onChange={e => setCols(x => (e.target.checked ? [...x, c.key] : x.filter(k => k !== c.key)))} /> {c.label}</label>
        ))}
      </div>
      <div className="summary-grid">{summary.map(([k, v]) => <div key={k}><span className="muted small">{k}</span><b>{v}</b></div>)}</div>
      <p className="muted small">{q.loading ? 'Loading…' : `${rows.length.toLocaleString()} transactions`}</p>
      {error && <div className="error">{error}</div>}
      <div className="form-actions">
        <button type="button" className="btn" onClick={() => exportRows('csv', name, chosen, data)}>CSV</button>
        <button type="button" className="btn" onClick={() => exportRows('xlsx', name, chosen, data)}>Excel</button>
        <div className="spacer" />
        <button type="button" className="btn primary" disabled={q.loading} onClick={() => printReport(`Campaign report · ${title}`, chosen, data, {
          subtitle: all ? 'All time' : `${start} to ${end}`, summary, landscape: chosen.length > 6,
          before: subs ? [{ title: 'By campaign', columns: [{ key: 'campaign', label: 'Campaign' }, { key: 'count', label: 'Gifts', align: 'right' }, { key: 'total', label: 'Total', align: 'right' }], rows: byCampaign }] : [],
        }).catch(e => setError(e.message))}><Printer size={15} /> Print or save as PDF</button>
      </div>
    </Overlay>
  );
}

export function DonorListDialog({ campaign, onClose }: { campaign: Row; onClose: () => void }) {
  const [subs, setSubs] = useState(Number(campaign.sub_count) > 0);
  const [sort, setSort] = useState<'name' | 'total' | 'last'>('total');
  const [min, setMin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const q = useQuery(async () => {
    const ids = await campaignFamily(campaign.id, subs);
    const [gifts, pledges] = await Promise.all([
      // An opening balance brought in at launch isn't anyone's gift.
      fetchAll((x, y) => supabase.from('donations').select('donor_id, name, anonymous, amount, created_at, donors(display_name, phone, email)').in('campaign_id', ids).eq('status', 'completed')
        .or('payment_method.is.null,payment_method.neq.Opening Balance').range(x, y) as never) as Promise<Row[]>,
      fetchAll((x, y) => supabase.from('pledge_list').select('donor_id, status').in('campaign_id', ids).range(x, y) as never) as Promise<Row[]>,
    ]);
    const m = new Map<string, Row>();
    for (const g of gifts) {
      const key = g.donor_id ?? `name:${g.name ?? 'Unknown'}`;
      const d = m.get(key) ?? { id: key, name: g.donors?.display_name ?? g.name ?? 'Unknown', phone: g.donors?.phone ?? '', email: g.donors?.email ?? '', total: 0, gifts: 0, last: '', anonymous: true };
      d.total += Number(g.amount); d.gifts += 1;
      if (!d.last || g.created_at > d.last) d.last = g.created_at;
      d.anonymous = d.anonymous && !!g.anonymous;
      m.set(key, d);
    }
    for (const p of pledges) {
      const d = m.get(p.donor_id);
      if (d) d.pledge = d.pledge && d.pledge !== 'open' ? d.pledge : p.status;
    }
    return [...m.values()];
  }, [campaign.id, subs]);
  const rows = ((q.data as Row[]) ?? [])
    .filter(d => !min || d.total >= Number(min))
    .sort((a, b) => (sort === 'name' ? a.name.localeCompare(b.name) : sort === 'last' ? String(b.last).localeCompare(String(a.last)) : b.total - a.total));
  const cols: ReportColumn[] = [
    { key: 'name', label: 'Donor' }, { key: 'phone', label: 'Phone' }, { key: 'email', label: 'Email' },
    { key: 'total', label: 'Total given', align: 'right' }, { key: 'gifts', label: 'Gifts', align: 'right' }, { key: 'last', label: 'Last donation' }, { key: 'pledge', label: 'Pledge' },
  ];
  // Anonymous givers stay anonymous on paper.
  const data = rows.map(d => ({
    name: d.anonymous ? 'Anonymous' : d.name, phone: d.anonymous ? '' : d.phone, email: d.anonymous ? '' : d.email,
    total: money(d.total), gifts: d.gifts, last: d.last ? dateTime(d.last) : '', pledge: d.pledge ?? '',
  }));
  const name = `campaign-${campaign.id}-donors`;
  return (
    <Overlay onClose={onClose}>
      <div className="form-head"><h2>Donor list</h2><button type="button" className="icon-btn" title="Close" onClick={onClose}><X size={18} /></button></div>
      <div className="filter-bar">
        <select aria-label="Sort" value={sort} onChange={e => setSort(e.target.value as typeof sort)}>
          <option value="total">Most given first</option><option value="name">By name</option><option value="last">Latest donation first</option>
        </select>
        <input type="number" min="0" aria-label="Given at least" placeholder="Given at least $" value={min} onChange={e => setMin(e.target.value)} />
        {Number(campaign.sub_count) > 0 && <label className="inline-check"><input type="checkbox" checked={subs} onChange={e => setSubs(e.target.checked)} /> Include sub-campaigns</label>}
      </div>
      <p className="muted small">{q.loading ? 'Loading…' : `${rows.length.toLocaleString()} donor${rows.length === 1 ? '' : 's'}`}. Donors who gave anonymously print as "Anonymous".</p>
      {error && <div className="error">{error}</div>}
      <div className="form-actions">
        <button type="button" className="btn" onClick={() => exportRows('csv', name, cols, data)}>CSV</button>
        <button type="button" className="btn" onClick={() => exportRows('xlsx', name, cols, data)}>Excel</button>
        <div className="spacer" />
        <button type="button" className="btn primary" disabled={q.loading} onClick={() => printReport(`Donors · ${campaign.external_name || campaign.internal_name} (${campaign.id})`, cols, data)
          .catch(e => setError(e.message))}><Printer size={15} /> Print or save as PDF</button>
      </div>
    </Overlay>
  );
}

// ---------------------------------------------------------------------------
// Fundraiser directory (admins)
// ---------------------------------------------------------------------------
export function FundraiserDirectoryPage() {
  const { isAdmin } = useAuth();
  const [status, setStatus] = useState('active');
  const q = useQuery(async () => {
    const { data, error } = await supabase.rpc('fundraiser_directory');
    if (error) throw new Error(error.message);
    return (data ?? []) as Row[];
  }, []);
  const rows = ((q.data as Row[]) ?? []).filter(r => !status || r.status === status);
  const columns: Column[] = [
    { key: 'full_name', label: 'Fundraiser', width: 180 },
    { key: 'phone', label: 'Phone' },
    { key: 'email', label: 'Email' },
    { key: 'status', label: 'Status' },
    { key: 'last_login', label: 'Last sign-in', render: r => dateTime(r.last_login), value: r => dateTime(r.last_login) },
    { key: 'campaigns', label: 'Campaigns', width: 360, long: true, value: r => (r.campaigns as Row[]).map(c => `${c.id} ${c.name} (${c.role})`).join('; '),
      render: r => `${(r.campaigns as Row[]).length} campaign${(r.campaigns as Row[]).length === 1 ? '' : 's'}: ${(r.campaigns as Row[]).map(c => `${c.id} ${c.name} (${c.role})`).join('; ')}` },
  ];
  if (!isAdmin) return null;
  return (
    <section className="view">
      <DataTable
        title="Fundraiser directory"
        rows={rows}
        loading={q.loading}
        error={q.error}
        columns={columns}
        exportName="fundraiser-directory"
        actions={
          <select aria-label="Status" value={status} onChange={e => setStatus(e.target.value)}>
            <option value="active">Active only</option><option value="suspended">Suspended</option><option value="deactivated">Deactivated</option><option value="">Everyone</option>
          </select>
        }
      />
    </section>
  );
}
