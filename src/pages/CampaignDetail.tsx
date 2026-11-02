import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, Clock, ExternalLink, Handshake, Target, Ticket, Mail, Pencil, Percent, Phone, Plus, Receipt, Scale, Star, StickyNote, TrendingUp,
} from 'lucide-react';
import DataTable from '../components/DataTable';
import RecordForm, { type Field } from '../components/RecordForm';
import Kpi from '../components/Kpi';
import AdminLink from '../components/AdminLink';
import { Balance, Pill, StatusPill } from '../components/Pill';
import { fetchAll, supabase, type Row } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';
import { useAuth } from '../lib/auth';
import { dateTime, money, pct, yn } from '../lib/format';
import { campaignFields, donationFields, expenseFields, fundraiserDonationFields, taskFields, transferEditFields } from '../lib/schemas';
import { clearLookups } from '../lib/lookups';
import { DONATION_SELECT, donationColumns } from './donationColumns';
import { STATUS_LABEL } from './Campaigns';
import { NewPledgeButtons, PledgeDialog, pledgeColumns } from './Pledges';
import { NewVoucherButton, VoucherDialog, voucherColumns } from './Vouchers';
import { ChangeModeDialog, SubCampaignsTab, modeLabel } from './SubCampaigns';
import { TRANSFER_SELECT, TransferDialog, transferColumns } from './Transfers';
import { RequestTeamDialog } from './Requests';

type Tab = 'donations' | 'expenses' | 'transfers' | 'tasks' | 'pledges' | 'vouchers' | 'sub-campaigns';

export default function CampaignDetail() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const { isAdmin, canWork, permissions, defaultAccountId } = useAuth();
  const [tab, setTab] = useState<Tab>('donations');
  const [form, setForm] = useState<{ table: string; title: string; fields: Field[]; record?: Row | null; defaults?: Row } | null>(null);
  const [version, setVersion] = useState(0);
  const [canEnter, setCanEnter] = useState(false);
  const [isPrimary, setIsPrimary] = useState(false);
  const [openPledge, setOpenPledge] = useState<string | null>(null);
  const [openVoucher, setOpenVoucher] = useState<string | null>(null);
  const [transferStart, setTransferStart] = useState<Row | null>(null);
  const [changingMode, setChangingMode] = useState(false);
  const [requestingTeam, setRequestingTeam] = useState(false);

  // A fundraiser with the override can enter payments here, held for approval.
  useEffect(() => {
    if (isAdmin) return setCanEnter(true);
    supabase.rpc('has_override', { p_permission: 'enter_manual_payments', p_campaign: id }).then(({ data }) => setCanEnter(!!data));
  }, [id, isAdmin]);

  useEffect(() => {
    if (isAdmin) return setIsPrimary(true);
    supabase.rpc('is_primary_on', { p_campaign: id }).then(({ data }) => setIsPrimary(!!data));
  }, [id, isAdmin]);

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
          .select(TRANSFER_SELECT)
          .or(`from_campaign_id.eq.${id},to_campaign_id.eq.${id}`).order('created_at', { ascending: false }).range(a, b));
      case 'tasks':
        return page((a, b) => supabase.from('tasks').select('*, donors(display_name)').eq('campaign_id', id).order('created_at', { ascending: false }).range(a, b));
      case 'pledges':
        return page((a, b) => supabase.from('pledge_list').select('*').eq('campaign_id', id).order('date_pledged', { ascending: false }).range(a, b));
      case 'sub-campaigns':
        return [];
      case 'vouchers':
        return page((a, b) => supabase.from('voucher_list').select('*').eq('campaign_id', id).order('created_at', { ascending: false }).range(a, b));
    }
  }, [id, tab, version]);

  const c = summary.data;
  if (summary.loading && !c) return <div className="view"><p className="muted pad">Loading…</p></div>;
  if (!c) return <div className="view"><p className="pad">Campaign not found or you don't have access. <Link to="/campaigns/active">Back</Link></p></div>;

  const saved = () => { setForm(null); setVersion(v => v + 1); };
  const combines = Number(c.combined_raised) !== Number(c.raised);
  const canAddSub = c.status !== 'closed' && isPrimary;
  // Fundraisers have no view of transfers, and a sub-campaign fundraiser's page stays on their own numbers.
  const tabs: Tab[] = ['donations', 'expenses', ...(isAdmin ? ['transfers' as Tab] : []), 'tasks', 'pledges', 'vouchers', 'sub-campaigns'];
  const canEditTasks = canWork;
  const setStatus = async (status: string, question: string) => {
    if (!confirm(question)) return;
    const { error } = await supabase.from('campaigns').update({ status }).eq('id', id);
    if (error) return alert(error.message);
    clearLookups();
    setVersion(v => v + 1);
  };

  const tabConfig = {
    donations: {
      columns: donationColumns({ hideCampaign: true }),
      add: !isAdmin && canEnter ? { table: 'donations', title: 'New payment (held for approval)', fields: fundraiserDonationFields, defaults: { campaign_id: id, source: 'Manual' } } : isAdmin && { table: 'donations', title: 'New Donation', fields: donationFields, defaults: { campaign_id: id, type: 'Payment', status: 'completed', source: 'Manual', created_at: new Date().toISOString() } },
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
      add: isAdmin && { table: 'expenses', title: 'New Expense', fields: expenseFields, defaults: { campaign_id: id, account_id: defaultAccountId, created_at: new Date().toISOString() } },
      edit: isAdmin && { table: 'expenses', title: 'Edit Expense', fields: expenseFields },
    },
    transfers: {
      columns: [
        { key: 'direction', label: 'Direction', value: (r: Row) => (r.to_campaign_id === id ? 'Transfer In' : 'Transfer Out'), render: (r: Row) => (r.to_campaign_id === id ? <Pill tone="green">Transfer In</Pill> : <Pill tone="amber">Transfer Out</Pill>) },
        ...transferColumns(r => setTransferStart({ from_campaign_id: r.to_campaign_id, to_campaign_id: r.from_campaign_id, amount: r.amount, description: `Reverses transfer ${r.id}` })),
      ],
      add: false as const,
      edit: isAdmin && { table: 'transfers', title: 'Edit memo', fields: transferEditFields },
    },
    'sub-campaigns': {
      columns: [],
      add: false as const,
      edit: false as const,
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
      columns: pledgeColumns(true),
      add: false as const,
      edit: false as const,
    },
    vouchers: {
      columns: voucherColumns(true),
      add: false as const,
      edit: false as const,
    },
  }[tab];

  return (
    <div className="detail">
      <div className="detail-head">
        <button className="icon-btn outlined" onClick={() => nav(-1)} title="Back"><ArrowLeft size={18} /></button>
        <div className="hero-avatar">{(c.internal_name || c.campaign_name || '#')[0]}</div>
        <div>
          <h1>
            {c.featured && <Star size={18} className="featured" />}
            {c.internal_name || c.campaign_name}
            <span className="id-tag">#{c.id}</span>
            <StatusPill value={STATUS_LABEL[c.status]} />
            {c.parent_campaign_id && <Pill tone={c.balance_mode === 'shared' ? 'blue' : 'violet'}>{modeLabel(c.balance_mode)}</Pill>}
          </h1>
          <div className="sub">
            {c.parent_campaign_id && <span>Sub-campaign of <Link to={`/campaigns/${encodeURIComponent(c.parent_campaign_id)}`}>#{c.parent_campaign_id}</Link> ·</span>}
            {c.external_name && <span>{c.external_name}</span>}
            {c.manager_name && <span>· Primary: <b><AdminLink to={`/managers/${encodeURIComponent(c.manager_id)}`}>{c.manager_name}</AdminLink></b></span>}
            {c.sub_managers.length > 0 && <span>· with {c.sub_managers.map((m: Row) => m.full_name).join(', ')}</span>}
            {c.archived_at && <span>· archived {dateTime(c.archived_at)}</span>}
            {c.closed_at && <span>· closed {dateTime(c.closed_at)}</span>}
          </div>
        </div>
        <div className="spacer" />
        {c.payment_link && (
          <a className="btn" href={c.payment_link} target="_blank" rel="noreferrer"><ExternalLink size={16} /> Payment page</a>
        )}
        {canEnter && c.status !== 'closed' && <Link className="btn" to={`/campaigns/${encodeURIComponent(id)}/batch`}>Batch entry</Link>}
        {isAdmin && c.status === 'draft' && (
          <button className="btn" onClick={() => setStatus('active', 'Publish this campaign?')}>Publish</button>
        )}
        {isAdmin && c.status === 'active' && (
          <button className="btn" onClick={() => setStatus('archived', 'Archive this campaign? It leaves the active list, but a new donation brings it back.')}>Archive</button>
        )}
        {isAdmin && c.status === 'archived' && (
          <button className="btn" onClick={() => setStatus('active', 'Reactivate this campaign?')}>Reactivate</button>
        )}
        {isAdmin && c.status !== 'closed' && (
          <button className="btn danger" onClick={() => setStatus('closed', 'This will lock this campaign. No new transactions can be entered. Only the Super Admin can reopen it.')}>Close</button>
        )}
        {c.status === 'closed' && permissions.includes('reopen_campaigns') && (
          <button className="btn" onClick={() => setStatus('active', 'Reopen this closed campaign?')}>Reopen</button>
        )}
        {!isAdmin && isPrimary && <button className="btn" onClick={() => setRequestingTeam(true)}>Request team member</button>}
        {isAdmin && c.parent_campaign_id && (
          <button className="btn" onClick={() => setChangingMode(true)}>Change balance mode</button>
        )}
        {isAdmin && (
          <button className="btn" onClick={() => setForm({ table: 'campaigns', title: 'Edit campaign', fields: campaignFields, record: c })}>
            <Pencil size={16} /> Edit
          </button>
        )}
      </div>

      <div className="kpis">
        <Kpi label={combines ? 'Raised, with shared sub-campaigns' : 'Raised'} value={money(c.combined_raised)} icon={<TrendingUp size={18} />} tone="green"
             sub={[combines && `${money(c.raised)} directly`, `${Number(c.combined_donations).toLocaleString()} donations`, c.goal != null && Number(c.goal) > 0 && `${pct(Number(c.combined_raised) / Number(c.goal))} of ${money(c.goal)} goal`].filter(Boolean).join(' · ')} />
        <Kpi label="Fees" value={money(c.combined_fees)} icon={<Percent size={18} />} tone="violet" sub={`${pct(Number(c.combined_raised) ? Number(c.combined_fees) / Number(c.combined_raised) : 0)} of raised`} />
        <Kpi label="Expenses" value={money(c.combined_expenses)} icon={<Receipt size={18} />} tone="amber" />
        {c.balance_mode === 'shared'
          ? <Kpi label="Balance" value={<span className="muted">Shared</span>} icon={<Scale size={18} />} tone="blue" sub="Counted in the parent's balance" />
          : <Kpi label="Balance" value={<Balance value={c.balance} />} icon={<Scale size={18} />} tone={Number(c.balance) < 0 ? 'red' : 'green'} sub={Number(c.sub_count) > 0 ? `${c.sub_count} sub-campaign${Number(c.sub_count) === 1 ? '' : 's'}; independent ones count separately` : undefined} />}
        {Number(c.post_dated_amount) > 0 && <Kpi label="Post-dated checks" value={money(c.post_dated_amount)} icon={<Clock size={18} />} tone="blue" sub="Not in the balance yet" />}
        {Number(c.awaiting_approval) > 0 && <Kpi label="Awaiting approval" value={money(c.awaiting_approval)} icon={<Clock size={18} />} tone="amber" sub="Not in the balance yet" />}
        <Kpi label="Pledged (open)" value={money(c.pledged_open)} icon={<Handshake size={18} />} tone="blue"
             sub={Number(c.pledge_scheduled_90) > 0 ? `Recurring: ${money(c.pledge_scheduled_30)} next 30 days, ${money(c.pledge_scheduled_90)} next 90` : 'Not in the balance'} />
        <Kpi label="Total potential" value={money(Number(c.raised) + Number(c.pledged_open))} icon={<Target size={18} />} tone="violet" sub="Raised + pledged" />
        {Number(c.awaiting_funds) > 0 && <Kpi label="Vouchers awaiting funds" value={money(c.awaiting_funds)} icon={<Ticket size={18} />} tone="amber" sub="Not in the balance yet" />}
        <Kpi label="Pending" value={money(c.pending_balance)} icon={<Clock size={18} />} tone="blue"
             sub={c.last_donation_at ? `last gift ${dateTime(c.last_donation_at)}` : undefined} />
      </div>

      {(c.email || c.phone || c.notes) && (
        <div className="info">
          {c.email && <span><Mail size={14} /> {c.email}</span>}
          {c.phone && <span><Phone size={14} /> {c.phone}</span>}
          {c.notes && <span><StickyNote size={14} /> {c.notes}</span>}
        </div>
      )}

      <div className="tabs">
        {tabs.map(t => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{t[0].toUpperCase() + t.slice(1)}</button>
        ))}
      </div>

      {tab === 'sub-campaigns' ? <SubCampaignsTab parent={c} canAdd={canAddSub} onChanged={() => setVersion(v => v + 1)} /> : <DataTable
        title={tab[0].toUpperCase() + tab.slice(1)}
        exportName={`${c.id}-${tab}`}
        rows={(rows.data as Row[]) ?? []}
        loading={rows.loading}
        error={rows.error}
        columns={tabConfig.columns}
        onOpen={tab === 'pledges' ? r => setOpenPledge(r.id) : tab === 'vouchers' ? r => setOpenVoucher(r.id)
          : tabConfig.edit ? r => setForm({ ...tabConfig.edit as { table: string; title: string; fields: Field[] }, record: r }) : undefined}
        actions={
          tab === 'transfers' ? isAdmin && c.status === 'active' && c.balance_mode !== 'shared' && (
            <button className="btn primary" onClick={() => setTransferStart({ from_campaign_id: id })}><Plus size={16} /> New transfer</button>
          )
          : tab === 'pledges' ? canWork && c.status !== 'closed' && <NewPledgeButtons campaignId={id} onSaved={() => setVersion(v => v + 1)} />
          : tab === 'vouchers' ? isAdmin && c.status !== 'closed' && <NewVoucherButton campaignId={id} onSaved={() => setVersion(v => v + 1)} />
          : tabConfig.add && (
            <button className="btn primary" onClick={() => setForm({ ...tabConfig.add as { table: string; title: string; fields: Field[]; defaults: Row }, record: null })}>
              <Plus size={16} /> Add
            </button>
          )
        }
      />}

      {transferStart && <TransferDialog start={transferStart} onClose={() => setTransferStart(null)} onDone={() => { setTransferStart(null); setVersion(v => v + 1); }} />}
      {requestingTeam && <RequestTeamDialog campaignId={id} onClose={() => setRequestingTeam(false)} />}
      {changingMode && <ChangeModeDialog campaign={c} onClose={() => setChangingMode(false)} onDone={() => { setChangingMode(false); setVersion(v => v + 1); }} />}
      {openPledge && <PledgeDialog id={openPledge} onClose={() => setOpenPledge(null)} onChanged={() => setVersion(v => v + 1)} />}
      {openVoucher && <VoucherDialog id={openVoucher} onClose={() => setOpenVoucher(null)} onChanged={() => setVersion(v => v + 1)} />}

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
