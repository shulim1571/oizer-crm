import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, Clock, ExternalLink, Mail, Pencil, Percent, Phone, Plus, Receipt, Scale, StickyNote, TrendingUp,
} from 'lucide-react';
import DataTable from '../components/DataTable';
import RecordForm, { type Field } from '../components/RecordForm';
import { campLabel } from '../components/CrudPage';
import Kpi from '../components/Kpi';
import AdminLink from '../components/AdminLink';
import { Balance, Pill, StatusPill } from '../components/Pill';
import { fetchAll, supabase, type Row } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';
import { useAuth } from '../lib/auth';
import { date, dateTime, money, pct, yn } from '../lib/format';
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
        { key: 'direction', label: 'Direction', value: (r: Row) => (r.to_campaign_id === id ? 'In' : 'Out'), render: (r: Row) => (r.to_campaign_id === id ? <Pill tone="green">In</Pill> : <Pill tone="amber">Out</Pill>) },
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
        { key: 'status', label: 'Status', render: (r: Row) => <StatusPill value={r.status} /> },
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
        <button className="icon-btn outlined" onClick={() => nav(-1)} title="Back"><ArrowLeft size={18} /></button>
        <div className="hero-avatar">{(c.real_name || c.campaign_name || '#')[0]}</div>
        <div>
          <h1>
            {c.real_name || c.campaign_name}
            <span className="id-tag">#{c.id}</span>
            <StatusPill value={c.archived_at ? 'Archived' : 'Active'} />
          </h1>
          <div className="sub">
            {c.friendly_name && <span>{c.friendly_name}</span>}
            {c.manager_name && <span>· Managed by <b><AdminLink to={`/managers/${encodeURIComponent(c.manager_id)}`}>{c.manager_name}</AdminLink></b></span>}
            {c.sub_managers.length > 0 && <span>· with {c.sub_managers.map((m: Row) => m.full_name).join(', ')}</span>}
            {c.archived_at && <span>· archived {date(c.archived_at)}</span>}
          </div>
        </div>
        <div className="spacer" />
        {c.payment_link && (
          <a className="btn" href={c.payment_link} target="_blank" rel="noreferrer"><ExternalLink size={16} /> Payment page</a>
        )}
        {isAdmin && (
          <button className="btn" onClick={() => setForm({ table: 'campaigns', title: 'Edit campaign', fields: campaignFields, record: c })}>
            <Pencil size={16} /> Edit
          </button>
        )}
      </div>

      <div className="kpis">
        <Kpi label="Raised" value={money(c.raised)} icon={<TrendingUp size={18} />} tone="green"
             sub={`${Number(c.donation_count).toLocaleString()} donations`} />
        <Kpi label="Fees" value={money(c.fees)} icon={<Percent size={18} />} tone="violet" sub={`${pct(c.fee_percent)} of raised`} />
        <Kpi label="Expenses" value={money(c.expenses)} icon={<Receipt size={18} />} tone="amber" />
        <Kpi label="Balance" value={<Balance value={c.balance} />} icon={<Scale size={18} />} tone={Number(c.balance) < 0 ? 'red' : 'green'} />
        <Kpi label="Pending" value={money(c.pending_balance)} icon={<Clock size={18} />} tone="blue"
             sub={c.last_donation_at ? `last gift ${date(c.last_donation_at)}` : undefined} />
      </div>

      {(c.email || c.phone || c.notes) && (
        <div className="info">
          {c.email && <span><Mail size={14} /> {c.email}</span>}
          {c.phone && <span><Phone size={14} /> {c.phone}</span>}
          {c.notes && <span><StickyNote size={14} /> {c.notes}</span>}
        </div>
      )}

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
            <Plus size={16} /> Add
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
