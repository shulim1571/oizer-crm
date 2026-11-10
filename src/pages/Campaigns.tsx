import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Clock, ExternalLink, Plus, Receipt, Scale, Star, TrendingUp } from 'lucide-react';
import DataTable, { type Column } from '../components/DataTable';
import RecordForm from '../components/RecordForm';
import Kpi from '../components/Kpi';
import AdminLink from '../components/AdminLink';
import { Balance, StatusPill } from '../components/Pill';
import { fetchAll, supabase, type Row } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';
import { useAuth } from '../lib/auth';
import { money, pct } from '../lib/format';
import { newCampaignFields } from '../lib/schemas';
import { TemplateStep } from './Templates';
import { paymentUrl } from './Outreach';

export const campaignColumns: Column[] = [
  {
    key: 'internal_name', label: 'Campaign', width: 200,
    render: r => (
      <div>
        <div>{r.featured && <Star size={14} className="featured" />} {r.internal_name || r.campaign_name}</div>
        {r.external_name && r.external_name !== r.internal_name && <div className="muted small">{r.external_name}</div>}
      </div>
    ),
  },
  { key: 'id', label: 'ID', value: r => Number(r.id) || r.id, render: r => <span className="id-tag">{r.id}</span> },
  {
    key: 'manager_name', label: 'Primary Fundraiser', width: 140,
    render: r => r.manager_id && <AdminLink to={`/managers/${encodeURIComponent(r.manager_id)}`}>{r.manager_name}</AdminLink>,
  },
  { key: 'raised', label: 'Raised', render: r => money(r.raised), align: 'right' },
  { key: 'fees', label: 'Fees', optional: true, render: r => money(r.fees), align: 'right' },
  { key: 'fee_percent', label: 'Fee %', optional: true, render: r => pct(r.fee_percent), align: 'right' },
  { key: 'expenses', label: 'Expenses', render: r => money(r.expenses), align: 'right' },
  { key: 'balance', label: 'Balance', render: r => (r.balance_mode === 'shared' ? <span className="muted">Shared</span> : <Balance value={r.balance} />), align: 'right' },
  { key: 'pending_balance', label: 'Pending', render: r => money(r.pending_balance), align: 'right' },
  { key: 'pin', label: 'Pin', optional: true },
  { key: 'parent_campaign_id', label: 'Under', optional: true, render: r => r.parent_campaign_id && <span className="id-tag">{r.parent_campaign_id}</span> },
];

export const STATUS_LABEL: Record<string, string> = { draft: 'Draft', active: 'Active', archived: 'Archived', closed: 'Closed' };

type Mode = 'active' | 'all' | 'archived' | 'closed' | 'exchange';
const TITLES: Record<Mode, string> = { active: 'Active Campaigns', all: 'All Campaigns', archived: 'Archived Campaigns', closed: 'Closed Campaigns', exchange: 'Exchange' };

export default function Campaigns({ mode }: { mode: Mode }) {
  const { isAdmin } = useAuth();
  const nav = useNavigate();
  const [adding, setAdding] = useState(false);
  const [choice, setChoice] = useState<{ template: Row | null; settings: Row | null } | null>(null);

  const { data, error, loading } = useQuery(
    () => fetchAll((a, b) => {
      let q = supabase.from('campaign_summary').select('*').order('featured', { ascending: false }).order('internal_name');
      if (mode === 'active' || mode === 'archived' || mode === 'closed') q = q.eq('status', mode);
      if (mode === 'exchange') q = q.eq('exchange', true);
      return q.range(a, b);
    }),
    [mode],
  );

  // Every campaign gets a button to its payment page (Moshe Henig). Closed campaigns take no gifts, so none there.
  const payColumn: Column = {
    key: 'payment_page', label: 'Payment page', value: () => '',
    render: (r: Row) => r.status === 'closed' ? null : (
      <a className="btn small" href={paymentUrl(r)} target="_blank" rel="noopener noreferrer" title="Open this campaign's payment page"
        onClick={e => e.stopPropagation()}><ExternalLink size={14} /> Payment page</a>
    ),
  };
  const columns = mode === 'all'
    ? [...campaignColumns, {
        key: 'status', label: 'Status',
        value: (r: Row) => STATUS_LABEL[r.status],
        render: (r: Row) => <StatusPill value={STATUS_LABEL[r.status]} />,
      }, payColumn]
    : [...campaignColumns, payColumn];

  return (
    <>
      <DataTable
        title={TITLES[mode]}
        rows={data ?? []}
        loading={loading}
        error={error}
        columns={columns}
        groupBy={{ label: 'Fundraiser', value: r => r.manager_name ?? '' }}
        onOpen={r => nav(`/campaigns/${encodeURIComponent(r.id)}`)}
        summary={data && <Totals rows={data} />}
        actions={isAdmin && (
          <button className="btn primary" onClick={() => setAdding(true)}><Plus size={16} /> New campaign</button>
        )}
      />
      {adding && !choice && <TemplateStep onClose={() => setAdding(false)} onNext={setChoice} />}
      {adding && choice && (
        <RecordForm
          table="campaigns"
          title={choice.template ? `New campaign from ${choice.template.name}` : 'New Campaign'}
          fields={newCampaignFields}
          defaults={{ status: 'active', account_id: choice.template?.account_id ?? undefined }}
          onClose={() => { setAdding(false); setChoice(null); }}
          onSaved={async r => {
            const { error: e } = await supabase.rpc('save_campaign_settings', { p_campaign: r.id, p_settings: choice.settings, p_template: choice.template?.id ?? null });
            if (e) alert(`The campaign was created, but its page settings weren't saved: ${e.message}`);
            nav(`/campaigns/${encodeURIComponent(r.id)}`);
          }}
        />
      )}
    </>
  );
}

function Totals({ rows }: { rows: Row[] }) {
  const sum = (k: string) => rows.reduce((s, r) => s + Number(r[k] ?? 0), 0);
  const raised = sum('raised');
  const fees = sum('fees');
  const negative = rows.filter(r => Number(r.balance) < 0).length;
  return (
    <div className="kpis">
      <Kpi label="Raised" value={money(raised)} icon={<TrendingUp size={18} />} tone="green"
           sub={`${pct(raised ? fees / raised : 0)} in fees`} />
      <Kpi label="Expenses" value={money(sum('expenses'))} icon={<Receipt size={18} />} tone="amber" />
      <Kpi label="Balance" value={<Balance value={sum('balance')} />} icon={<Scale size={18} />} tone="violet"
           sub={negative ? `${negative} campaign${negative === 1 ? '' : 's'} below zero` : 'All campaigns positive'} />
      <Kpi label="Pending" value={money(sum('pending_balance'))} icon={<Clock size={18} />} tone="blue" />
    </div>
  );
}
