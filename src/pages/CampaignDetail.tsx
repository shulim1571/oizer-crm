import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Pencil, Plus } from 'lucide-react';
import DataTable from '../components/DataTable';
import RecordForm, { type Field } from '../components/RecordForm';
import { campLabel } from '../components/CrudPage';
import { fetchAll, supabase, type Row } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';
import { useAuth } from '../lib/auth';
import { balanceClass, dateTime, money, pct, yn } from '../lib/format';
import { campaignFields, donationFields, expenseFields, taskFields, transferFields } from '../lib/schemas';
import { DONATION_SELECT, donationColumns } from './donationColumns';

type Tab = 'donations' | 'expenses' | 'transfers' | 'tasks' | 'pledges';
const CAMP = 'id, real_name, campaign_name, friendly_name';

export default function CampaignDetail() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const { isAdmin, role } = useAuth();
  const [tab, setTab] = useState<Tab>('donations');
  const [form, setForm] = useState<{ table: string; title: string; fields: Field[]; record?: Row | null; defaults?: Row } | null>(null);
  const [version, setVersion] = useState(0);

  const summary = useQuery(
    async () => {
      const { data, error } = await supabase.from('campaign_summary').select('*').eq('id', id).maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return null;
      const subs = data.sub_manager_ids?.length
        ? (await supabase.from('managers').select('id, full_name').in('id', data.sub_manager_ids)).data ?? []
        : [];
      return { ...data, sub_managers: subs };
    },
    [id, version],
  );

  const rows = useQuery(async () => {
    const page = <T,>(q: (a: number, b: number) => PromiseLike<T>) => fetchAll(q as never);
    switch (tab) {
      case 'donations':
        return page((a, b) => supabase.from('donations').select(DONATION_SELECT).eq('campaign_id', id).order('created_at', { ascending: false }).range(a, b));
      case 'expenses':
        return page((a, b) => supabase.from('expenses').select('*, accounts(name)').eq('campaign_id', id).order('created_at', { ascending: false }).range(a, b));
      case 'transfers':
        return page((a, b) => supabase.from('transfers')
          .select(`*, from:campaigns!transfers_from_campaign_id_fkey(${CAMP}), to:campaigns!transfers_to_campaign_id_fkey(${CAMP})`)
          .or(`from_campaign_id.eq.${id},to_campaign_id.eq.${id}`).order('created_at', { ascending: false }).range(a, b));
      case 'tasks':
        return page((a, b) => supabase.from('tasks').select('*, donors(display_name)').eq('campaign_id', id).order('created_at', { ascending: false }).range(a, b));
      case 'pledges':
        return page((a, b) => supabase.from('pledges').select('*').eq('campaign_id', id).order('created_at', { ascending: false }).range(a, b));
    }
  }, [id, tab, version]);

  const c = summary.data;
  if (summary.loading && !c) return <div className="view"><p className="muted pad">Loading…</p></div>;
  if (!c) return <div className="view"><p className="pad">Campaign not found or you don't have access. <Link to="/campaigns/active">Back</Link></p></div>;

  const saved = () => { setForm(null); setVersion(v => v + 1); };
  const canEditTasks = role === 'admin' || role === 'manager';

  const tabConfig = {
    donations: {
      columns: donationColumns({ hideCampaign: true }),
      add: isAdmin && { table: 'donations', title: 'New Donation', fields: donationFields, defaults: { campaign_id: id, type: 'Payment', source: 'Manual', account_id: '8d4b5fbe', created_at: new Date().toISOString() } },
      edit: isAdmin && { table: 'donations', title: 'Edit Donation', fields: donationFields },
    },
    expenses: {
      columns: [
        { key: 'payee', label: 'To' },
        { key: 'amount', label: 'Amount', render: (r: Row) => money(r.amount), align: 'right' as const },
        { key: 'method', label: 'Method' },
        { key: 'check_number', label: 'Check #' },
        { key: 'memo', label: 'Memo' },
        { key: 'description', label: 'Description' },
        { key: 'account', label: 'Account', value: (r: Row) => r.accounts?.name },
        { key: 'cleared', label: 'Cleared', render: (r: Row) => yn(r.cleared) },
        { key: 'created_at', label: 'Timestamp', render: (r: Row) => dateTime(r.created_at) },
      ],
      add: isAdmin && { table: 'expenses', title: 'New Expense', fields: expenseFields, defaults: { campaign_id: id, account_id: '8d4b5fbe', created_at: new Date().toISOString() } },
      edit: isAdmin && { table: 'expenses', title: 'Edit Expense', fields: expenseFields },
    },
    transfers: {
      columns: [
        { key: 'direction', label: 'Direction', value: (r: Row) => (r.to_campaign_id === id ? 'In' : 'Out') },
        { key: 'amount', label: 'Amount', render: (r: Row) => money(r.amount), align: 'right' as const },
        { key: 'from', label: 'From', value: (r: Row) => campLabel(r.from) },
        { key: 'to', label: 'To', value: (r: Row) => campLabel(r.to) },
        { key: 'description', label: 'Description' },
        { key: 'created_at', label: 'Timestamp', render: (r: Row) => dateTime(r.created_at) },
      ],
      add: isAdmin && { table: 'transfers', title: 'New Transfer', fields: transferFields, defaults: { from_campaign_id: id, created_at: new Date().toISOString() } },
      edit: isAdmin && { table: 'transfers', title: 'Edit Transfer', fields: transferFields },
    },
    tasks: {
      columns: [
        { key: 'title', label: 'Task' },
        { key: 'status', label: 'Status' },
        { key: 'assigned_to', label: 'Assigned to' },
        { key: 'donor', label: 'Donor', value: (r: Row) => r.donors?.display_name },
        { key: 'due_date', label: 'Due' },
        { key: 'description', label: 'Description' },
      ],
      add: canEditTasks && { table: 'tasks', title: 'New Task', fields: taskFields, defaults: { campaign_id: id, status: 'Pending' } },
      edit: canEditTasks && { table: 'tasks', title: 'Edit Task', fields: taskFields },
    },
    pledges: {
      columns: [
        { key: 'donor_label', label: 'Donor', value: (r: Row) => r.donor_label || r.name },
        { key: 'amount', label: 'Amount', render: (r: Row) => money(r.amount), align: 'right' as const },
        { key: 'source', label: 'Source' },
        { key: 'phone', label: 'Phone' },
        { key: 'notes', label: 'Notes' },
        { key: 'created_at', label: 'Timestamp', render: (r: Row) => dateTime(r.created_at) },
      ],
      add: false as const,
      edit: false as const,
    },
  }[tab];

  return (
    <div className="detail">
      <div className="detail-head">
        <button className="icon-btn" onClick={() => nav(-1)} title="Back"><ArrowLeft size={20} /></button>
        <div>
          <h1>{c.real_name || c.campaign_name} <span className="muted">#{c.id}</span></h1>
          <div className="muted">
            {c.friendly_name}
            {c.manager_name && <> · Manager: {c.manager_name}</>}
            {c.sub_managers.length > 0 && <> · Sub: {c.sub_managers.map((m: Row) => m.full_name).join(', ')}</>}
            {c.archived_at && <> · <span className="tag">Archived {dateTime(c.archived_at)}</span></>}
          </div>
        </div>
        <div className="spacer" />
        {isAdmin && (
          <button className="btn" onClick={() => setForm({ table: 'campaigns', title: 'Edit Campaign', fields: campaignFields, record: c })}>
            <Pencil size={16} /> Edit
          </button>
        )}
      </div>

      <div className="kpis">
        <Kpi label="Raised" value={money(c.raised)} />
        <Kpi label="Fees" value={`${money(c.fees)} · ${pct(c.fee_percent)}`} />
        <Kpi label="Expenses" value={money(c.expenses)} />
        <Kpi label="Balance" value={money(c.balance)} cls={balanceClass(c.balance)} />
        <Kpi label="Pending Balance" value={money(c.pending_balance)} />
        <Kpi label="Donations" value={Number(c.donation_count).toLocaleString()} />
      </div>

      <div className="info">
        {c.email && <span>✉ {c.email}</span>}
        {c.phone && <span>☎ {c.phone}</span>}
        {c.payment_link && <a href={c.payment_link} target="_blank" rel="noreferrer">Payment page ↗</a>}
        {c.notes && <span>{c.notes}</span>}
      </div>

      <div className="tabs">
        {(['donations', 'expenses', 'transfers', 'tasks', 'pledges'] as Tab[]).map(t => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{t[0].toUpperCase() + t.slice(1)}</button>
        ))}
      </div>

      <DataTable
        title={tab[0].toUpperCase() + tab.slice(1)}
        exportName={`${c.id}-${tab}`}
        rows={(rows.data as Row[]) ?? []}
        loading={rows.loading}
        error={rows.error}
        columns={tabConfig.columns}
        onOpen={tabConfig.edit ? r => setForm({ ...tabConfig.edit as { table: string; title: string; fields: Field[] }, record: r }) : undefined}
        actions={tabConfig.add && (
          <button className="btn primary" onClick={() => setForm({ ...tabConfig.add as { table: string; title: string; fields: Field[]; defaults: Row }, record: null })}>
            <Plus size={18} /> Add
          </button>
        )}
      />

      {form && (
        <RecordForm
          table={form.table}
          title={form.title}
          fields={form.fields}
          record={form.record}
          defaults={form.defaults}
          allowDelete={isAdmin}
          onClose={() => setForm(null)}
          onSaved={row => (form.table === 'campaigns' && row.id !== id ? nav(`/campaigns/${encodeURIComponent(row.id)}`) : saved())}
        />
      )}
    </div>
  );
}

function Kpi({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className={`kpi-value ${cls ?? ''}`}>{value}</div>
    </div>
  );
}
