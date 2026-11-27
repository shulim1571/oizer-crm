import { FundraiserPhones } from './PhoneLookup';
import { PayCardBill } from './CardBills';
import { useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  AlertCircle, ArrowLeft, CalendarDays, HandCoins, Landmark, Mail, Pencil, Percent, Phone, Receipt, Scale, StickyNote, TrendingUp,
} from 'lucide-react';
import DataTable from '../components/DataTable';
import Kpi from '../components/Kpi';
import RecordForm, { type Field } from '../components/RecordForm';
import { campLabel } from '../components/CrudPage';
import { Balance, Pill, StatusPill } from '../components/Pill';
import { fetchAll, supabase, type Row } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';
import { ALL_TOPICS } from '../lib/live';
import { CheckSettingsCard } from './Checks';
import { dateTime, money, yn, formatPhone } from '../lib/format';
import { accountFields, personFields, sourceFields } from '../lib/schemas';
import { STATUS_LABEL, campaignColumns } from './Campaigns';
import FundraiserControls from './FundraiserControls';
import { PagedDonations } from './Donations';

/** Loads one row from a summary view; reload after edits. */
function useSummary(view: string, id: string, version: number) {
  return useQuery(async () => {
    const { data, error } = await supabase.from(view).select('*').eq('id', id).maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  }, [view, id, version], { live: ALL_TOPICS });
}

function DetailHead({ title, sub, initial, onEdit }: { title: string; sub?: ReactNode; initial: string; onEdit: () => void }) {
  const nav = useNavigate();
  return (
    <div className="detail-head">
      <button className="icon-btn outlined" onClick={() => nav(-1)} title="Back"><ArrowLeft size={20} /></button>
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
        <Kpi label="Received" value={money(d.total_amount)} icon={<TrendingUp size={16} />} tone="green" />
        <Kpi label="Donations" value={Number(d.donation_count).toLocaleString()} icon={<HandCoins size={16} />} tone="violet"
             sub={`avg ${money(d.donation_count ? d.total_amount / d.donation_count : 0)}`} />
        <Kpi label="Fees" value={money(d.total_fees)} icon={<Percent size={16} />} tone="amber" />
        <Kpi label="Last donation" value={dateTime(d.last_donation_at) || '—'} icon={<CalendarDays size={16} />} tone="blue" small />
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
  const [tab, setTab] = useState<'donations' | 'expenses' | 'bills'>('donations');
  const [paying, setPaying] = useState(false);
  const a = useSummary('account_summary', id, version);
  // Card bill payments into this card, or out of this bank account (Moshe, 2026-11-20).
  const bills = useQuery(async () => ((await supabase.from('account_transfers').select('*').is('deleted_at', null)
    .or(`to_account_id.eq.${id},from_account_id.eq.${id}`).order('paid_on', { ascending: false })).data ?? []) as Row[], [id, version]);
  const expenses = useQuery(
    () => fetchAll((x, y) => supabase.from('expenses').select('*, campaigns(id, internal_name, campaign_name)')
      .eq('account_id', id).order('created_at', { ascending: false }).range(x, y)),
    [id, version], { live: ['payouts'] },
  );

  if (a.loading && !a.data) return <Loading />;
  if (!a.data) return <Missing />;
  const d = a.data;

  return (
    <div className="detail">
      <DetailHead title={d.name} initial={d.name[0]} onEdit={() => setEditing(true)}
                  sub={<>{d.notes && <span>{d.notes}</span>}</>} />
      {d.kind === 'credit_card' ? (
        <div className="kpis">
          <Kpi label="Owed on the card" value={money(d.card_owed)} icon={<Scale size={16} />} tone="amber"
               sub={d.bill_due_day ? `Bill due on day ${d.bill_due_day}` : 'Charged payouts, less bills paid'} />
          <Kpi label="Charged" value={money(d.expenses_total)} icon={<Receipt size={16} />} tone="violet" sub={`${Number(d.expense_count).toLocaleString()} card payouts`} />
          <Kpi label="Bills paid" value={money(d.transfers_in)} icon={<TrendingUp size={16} />} tone="green" />
        </div>
      ) : Number(d.earmarked_for_cards) > 0 || Number(d.transfers_out) > 0 ? (
        <div className="kpis">
          <Kpi label="Book balance" value={<Balance value={d.book_balance} />} icon={<Scale size={16} />} tone="blue" sub="Gifts in, less payouts and card bills paid" />
          <Kpi label="Earmarked for card bills" value={money(d.earmarked_for_cards)} icon={<Receipt size={16} />} tone="amber" />
          <Kpi label="After card bills" value={<Balance value={d.available_after_cards} />} icon={<Scale size={16} />} tone="green" />
        </div>
      ) : null}
      {d.kind === 'credit_card' && (
        <div className="donation-actions">
          <button type="button" className="btn primary" onClick={() => setPaying(true)}>Pay the bill</button>
        </div>
      )}
      {paying && <PayCardBill card={d} onClose={() => setPaying(false)} onDone={() => { setPaying(false); setVersion(v => v + 1); }} />}
      <div className="kpis">
        <Kpi label="Donations in" value={money(d.donations_total)} icon={<TrendingUp size={16} />} tone="green"
             sub={`${Number(d.donation_count).toLocaleString()} donations`} />
        <Kpi label="Payouts out" value={money(d.payouts_out)} icon={<Receipt size={16} />} tone="amber"
             sub={`${Number(d.expense_count).toLocaleString()} payouts${Number(d.returned_in) ? ` · ${money(d.returned_in)} came back` : ''}`} />
        <Kpi label="Net" value={<Balance value={d.donations_total - d.expenses_total} />} icon={<Scale size={16} />} tone="violet" />
        <Kpi label="Uncleared checks" value={money(d.uncleared_total)} icon={<AlertCircle size={16} />} tone="red" />
      </div>
      <CheckSettingsCard accountId={d.id} />
      <div className="tabs">
        <button className={tab === 'donations' ? 'active' : ''} onClick={() => setTab('donations')}>Donations</button>
        <button className={tab === 'expenses' ? 'active' : ''} onClick={() => setTab('expenses')}>Payouts</button>
        {((bills.data as Row[]) ?? []).length > 0 && <button className={tab === 'bills' ? 'active' : ''} onClick={() => setTab('bills')}>Card bill payments</button>}
      </div>
      {tab === 'bills' && (
        <DataTable title="Card bill payments" rows={(bills.data as Row[]) ?? []} loading={bills.loading} error={bills.error} exportName={`account-${d.name}-card-bills`}
          columns={[
            { key: 'paid_on', label: 'Paid on' },
            { key: 'direction', label: '', value: r => (r.to_account_id === d.id ? 'Paid to this card' : 'Paid from this account') },
            { key: 'amount', label: 'Amount', align: 'right', render: r => money(r.amount) },
            { key: 'reference', label: 'Reference' },
            { key: 'created_by', label: 'By' },
            { key: 'undo', label: '', render: r => <button type="button" className="link" onClick={async e => {
              e.stopPropagation();
              if (!confirm(`Remove this ${money(r.amount)} bill payment? The card owes it again.`)) return;
              const { error } = await supabase.rpc('delete_account_transfer', { p_id: r.id });
              if (error) alert(error.message); else setVersion(v => v + 1);
            }}>Remove</button> },
          ]} />
      )}
      {tab === 'bills' ? null : tab === 'donations'
        ? <PagedDonations title="Donations into this account" filter={{ column: 'account_id', value: d.id }} />
        : (
          <DataTable
            title="Expenses from this account"
            exportName={`account-${d.name}-expenses`}
            rows={expenses.data ?? []}
            loading={expenses.loading}
            error={expenses.error}
            columns={[
              { key: 'campaign', label: 'Campaign', campaignLink: (r: Row) => r.campaign_id, value: r => campLabel(r.campaigns), width: 200 },
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

const STATUS: Record<string, string> = { active: 'Active', suspended: 'Suspended', deactivated: 'Deactivated' };

export function ManagerDetail() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const [version, setVersion] = useState(0);
  const [editing, setEditing] = useState(false);
  const m = useSummary('manager_summary', id, version);
  const campaigns = useQuery(
    () => fetchAll((x, y) => supabase.from('campaign_summary').select('*')
      .or(`manager_id.eq.${id},sub_manager_ids.cs.{${id}}`).order('internal_name').range(x, y)),
    [id, version], { live: ['gifts', 'payouts', 'transfers', 'campaigns'] },
  );

  if (m.loading && !m.data) return <Loading />;
  if (!m.data) return <Missing />;
  const d = m.data;

  return (
    <div className="detail">
      <DetailHead title={d.full_name || '(no name)'} initial={(d.full_name || '?')[0]} onEdit={() => setEditing(true)}
                  sub={<span>Fundraiser <StatusPill value={STATUS[d.status]} />{d.status !== 'active' && d.status_reason && <> · {d.status_reason}</>}</span>} />
      <FundraiserControls manager={d} onChange={() => setVersion(v => v + 1)} />
      <div className="kpis">
        <Kpi label="Campaigns" value={d.campaign_count} icon={<Landmark size={16} />} tone="violet" sub={`${d.active_count} active`} />
        <Kpi label="Raised" value={money(d.raised)} icon={<TrendingUp size={16} />} tone="green" />
        <Kpi label="Balance" value={<Balance value={d.balance} />} icon={<Scale size={16} />} tone={Number(d.balance) < 0 ? 'red' : 'green'} />
      </div>
      {(d.email || d.phone || d.notes) && (
        <div className="info">
          {d.email && <span><Mail size={16} /> {d.email}</span>}
          {d.phone && <span><Phone size={16} /> {formatPhone(d.phone)}</span>}
          {d.notes && <span><StickyNote size={16} /> {d.notes}</span>}
        </div>
      )}
      <FundraiserPhones managerId={d.id} />
      <DataTable
        title="Campaigns"
        exportName={`fundraiser-${d.full_name}-campaigns`}
        rows={campaigns.data ?? []}
        loading={campaigns.loading}
        error={campaigns.error}
        onOpen={r => nav(`/campaigns/${encodeURIComponent(r.id)}`)}
        columns={[
          ...campaignColumns.filter(c => c.key !== 'manager_name'),
          {
            key: 'role', label: 'Role',
            value: r => (r.manager_id === id ? 'Primary' : 'Secondary'),
            render: r => (r.manager_id === id ? <Pill tone="violet">Primary</Pill> : <Pill tone="blue">Secondary</Pill>),
          },
          {
            key: 'status', label: 'Status',
            value: r => STATUS_LABEL[r.status],
            render: r => <StatusPill value={STATUS_LABEL[r.status]} />,
          },
        ]}
      />
      {editing && (
        <Editor table="managers" title="Edit fundraiser" fields={personFields} record={d}
                onDone={r => { setEditing(false); if (r._deleted) nav('/managers'); else setVersion(v => v + 1); }} />
      )}
    </div>
  );
}
