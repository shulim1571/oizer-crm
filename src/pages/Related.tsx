import { useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  AlertCircle, ArrowLeft, CalendarDays, HandCoins, Landmark, Mail, Pencil, Percent, Phone, Receipt, Scale, StickyNote, TrendingUp,
} from 'lucide-react';
import DataTable from '../components/DataTable';
import Kpi from '../components/Kpi';
import RecordForm, { type Field } from '../components/RecordForm';
import { campLabel } from '../components/CrudPage';
import { Balance, Pill } from '../components/Pill';
import { fetchAll, supabase, type Row } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';
import { date, dateTime, money, yn } from '../lib/format';
import { accountFields, personFields, sourceFields } from '../lib/schemas';
import { campaignColumns } from './Campaigns';
import { PagedDonations } from './Donations';

/** Loads one row from a summary view; reload after edits. */
function useSummary(view: string, id: string, version: number) {
  return useQuery(async () => {
    const { data, error } = await supabase.from(view).select('*').eq('id', id).maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  }, [view, id, version]);
}

function DetailHead({ title, sub, initial, onEdit }: { title: string; sub?: ReactNode; initial: string; onEdit: () => void }) {
  const nav = useNavigate();
  return (
    <div className="detail-head">
      <button className="icon-btn outlined" onClick={() => nav(-1)} title="Back"><ArrowLeft size={18} /></button>
      <div className="hero-avatar">{initial}</div>
      <div>
        <h1>{title}</h1>
        {sub && <div className="sub">{sub}</div>}
      </div>
      <div className="spacer" />
      <button className="btn" onClick={onEdit}><Pencil size={16} /> Edit</button>
    </div>
  );
}

function Editor({ table, title, fields, record, onDone }: {
  table: string; title: string; fields: Field[]; record: Row; onDone: (row: Row) => void;
}) {
  return <RecordForm table={table} title={title} fields={fields} record={record} allowDelete onClose={() => onDone(record)} onSaved={onDone} />;
}

const Missing = () => <div className="view"><p className="pad">Not found.</p></div>;
const Loading = () => <div className="view"><p className="muted pad">Loading…</p></div>;

export function SourceDetail() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const [version, setVersion] = useState(0);
  const [editing, setEditing] = useState(false);
  const s = useSummary('source_summary', id, version);

  if (s.loading && !s.data) return <Loading />;
  if (!s.data) return <Missing />;
  const d = s.data;

  return (
    <div className="detail">
      <DetailHead title={d.name} initial={d.name[0]} onEdit={() => setEditing(true)}
                  sub={<><span className="id-tag">{d.id}</span>{d.number && <span>· #{d.number}</span>}</>} />
      <div className="kpis">
        <Kpi label="Received" value={money(d.total_amount)} icon={<TrendingUp size={18} />} tone="green" />
        <Kpi label="Donations" value={Number(d.donation_count).toLocaleString()} icon={<HandCoins size={18} />} tone="violet"
             sub={`avg ${money(d.donation_count ? d.total_amount / d.donation_count : 0)}`} />
        <Kpi label="Fees" value={money(d.total_fees)} icon={<Percent size={18} />} tone="amber" />
        <Kpi label="Last donation" value={date(d.last_donation_at) || '—'} icon={<CalendarDays size={18} />} tone="blue" small />
      </div>
      <PagedDonations title="Donations from this source" filter={{ column: 'source', value: d.id }} />
      {editing && (
        <Editor table="sources" title="Edit source" fields={sourceFields} record={d}
                onDone={r => { setEditing(false); if (r._deleted) nav('/sources'); else if (r.id !== id) nav(`/sources/${encodeURIComponent(r.id)}`); else setVersion(v => v + 1); }} />
      )}
    </div>
  );
}

export function AccountDetail() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const [version, setVersion] = useState(0);
  const [editing, setEditing] = useState(false);
  const [tab, setTab] = useState<'donations' | 'expenses'>('donations');
  const a = useSummary('account_summary', id, version);
  const expenses = useQuery(
    () => fetchAll((x, y) => supabase.from('expenses').select('*, campaigns(id, real_name, campaign_name)')
      .eq('account_id', id).order('created_at', { ascending: false }).range(x, y)),
    [id, version],
  );

  if (a.loading && !a.data) return <Loading />;
  if (!a.data) return <Missing />;
  const d = a.data;

  return (
    <div className="detail">
      <DetailHead title={d.name} initial={d.name[0]} onEdit={() => setEditing(true)}
                  sub={<>{d.filter_checks && <Pill tone="blue">Filter checks</Pill>}{d.notes && <span>{d.notes}</span>}</>} />
      <div className="kpis">
        <Kpi label="Donations in" value={money(d.donations_total)} icon={<TrendingUp size={18} />} tone="green"
             sub={`${Number(d.donation_count).toLocaleString()} donations`} />
        <Kpi label="Expenses out" value={money(d.expenses_total)} icon={<Receipt size={18} />} tone="amber"
             sub={`${Number(d.expense_count).toLocaleString()} expenses`} />
        <Kpi label="Net" value={<Balance value={d.donations_total - d.expenses_total} />} icon={<Scale size={18} />} tone="violet" />
        <Kpi label="Uncleared checks" value={money(d.uncleared_total)} icon={<AlertCircle size={18} />} tone="red" />
      </div>
      <div className="tabs">
        <button className={tab === 'donations' ? 'active' : ''} onClick={() => setTab('donations')}>Donations</button>
        <button className={tab === 'expenses' ? 'active' : ''} onClick={() => setTab('expenses')}>Expenses</button>
      </div>
      {tab === 'donations'
        ? <PagedDonations title="Donations into this account" filter={{ column: 'account_id', value: d.id }} />
        : (
          <DataTable
            title="Expenses from this account"
            exportName={`account-${d.name}-expenses`}
            rows={expenses.data ?? []}
            loading={expenses.loading}
            error={expenses.error}
            columns={[
              { key: 'campaign', label: 'Campaign', value: r => campLabel(r.campaigns), width: 200 },
              { key: 'payee', label: 'To' },
              { key: 'amount', label: 'Amount', render: r => <b className="num">{money(r.amount)}</b>, align: 'right' },
              { key: 'method', label: 'Method' },
              { key: 'check_number', label: 'Check #' },
              { key: 'cleared', label: 'Cleared', render: r => yn(r.cleared) },
              { key: 'memo', label: 'Memo' },
              { key: 'created_at', label: 'Date', render: r => dateTime(r.created_at), width: 170 },
            ]}
          />
        )}
      {editing && (
        <Editor table="accounts" title="Edit account" fields={accountFields} record={d}
                onDone={r => { setEditing(false); if (r._deleted) nav('/accounts'); else setVersion(v => v + 1); }} />
      )}
    </div>
  );
}

export function ManagerDetail() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const [version, setVersion] = useState(0);
  const [editing, setEditing] = useState(false);
  const m = useSummary('manager_summary', id, version);
  const campaigns = useQuery(
    () => fetchAll((x, y) => supabase.from('campaign_summary').select('*')
      .or(`manager_id.eq.${id},sub_manager_ids.cs.{${id}}`).order('real_name').range(x, y)),
    [id, version],
  );

  if (m.loading && !m.data) return <Loading />;
  if (!m.data) return <Missing />;
  const d = m.data;

  return (
    <div className="detail">
      <DetailHead title={d.full_name || '(no name)'} initial={(d.full_name || '?')[0]} onEdit={() => setEditing(true)}
                  sub={<span>Campaign manager</span>} />
      <div className="kpis">
        <Kpi label="Campaigns" value={d.campaign_count} icon={<Landmark size={18} />} tone="violet" sub={`${d.active_count} active`} />
        <Kpi label="Raised" value={money(d.raised)} icon={<TrendingUp size={18} />} tone="green" />
        <Kpi label="Balance" value={<Balance value={d.balance} />} icon={<Scale size={18} />} tone={Number(d.balance) < 0 ? 'red' : 'green'} />
      </div>
      {(d.email || d.phone || d.notes) && (
        <div className="info">
          {d.email && <span><Mail size={14} /> {d.email}</span>}
          {d.phone && <span><Phone size={14} /> {d.phone}</span>}
          {d.notes && <span><StickyNote size={14} /> {d.notes}</span>}
        </div>
      )}
      <DataTable
        title="Campaigns"
        exportName={`manager-${d.full_name}-campaigns`}
        rows={campaigns.data ?? []}
        loading={campaigns.loading}
        error={campaigns.error}
        onOpen={r => nav(`/campaigns/${encodeURIComponent(r.id)}`)}
        columns={[
          ...campaignColumns.filter(c => c.key !== 'manager_name'),
          {
            key: 'role', label: 'Role',
            value: r => (r.manager_id === id ? 'Manager' : 'Sub-manager'),
            render: r => (r.manager_id === id ? <Pill tone="violet">Manager</Pill> : <Pill tone="blue">Sub-manager</Pill>),
          },
          {
            key: 'status', label: 'Status',
            value: r => (r.archived_at ? 'Archived' : 'Active'),
            render: r => <Pill tone={r.archived_at ? '' : 'green'}>{r.archived_at ? 'Archived' : 'Active'}</Pill>,
          },
        ]}
      />
      {editing && (
        <Editor table="managers" title="Edit manager" fields={personFields} record={d}
                onDone={r => { setEditing(false); if (r._deleted) nav('/managers'); else setVersion(v => v + 1); }} />
      )}
    </div>
  );
}
