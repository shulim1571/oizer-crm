import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Clock, Plus, Receipt, Scale, TrendingUp } from 'lucide-react';
import DataTable, { type Column } from '../components/DataTable';
import RecordForm from '../components/RecordForm';
import Kpi from '../components/Kpi';
import { Balance, StatusPill } from '../components/Pill';
import { fetchAll, supabase, type Row } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';
import { useAuth } from '../lib/auth';
import { money, pct } from '../lib/format';
import { campaignFields } from '../lib/schemas';

export const campaignColumns: Column[] = [
  {
    key: 'real_name', label: 'Campaign', width: 200,
    render: r => (
      <div>
        <div>{r.real_name || r.campaign_name}</div>
        {r.friendly_name && r.friendly_name !== r.real_name && <div className="muted small">{r.friendly_name}</div>}
      </div>
    ),
  },
  { key: 'id', label: 'ID', value: r => Number(r.id) || r.id, render: r => <span className="id-tag">{r.id}</span> },
  { key: 'manager_name', label: 'Manager', width: 140 },
  { key: 'raised', label: 'Raised', render: r => money(r.raised), align: 'right' },
  { key: 'fees', label: 'Fees', render: r => money(r.fees), align: 'right' },
  { key: 'fee_percent', label: 'Fee %', render: r => pct(r.fee_percent), align: 'right' },
  { key: 'expenses', label: 'Expenses', render: r => money(r.expenses), align: 'right' },
  { key: 'balance', label: 'Balance', render: r => <Balance value={r.balance} />, align: 'right' },
  { key: 'pending_balance', label: 'Pending', render: r => money(r.pending_balance), align: 'right' },
  { key: 'pin', label: 'Pin' },
];

type Mode = 'active' | 'all' | 'exchange';
const TITLES: Record<Mode, string> = { active: 'Active Campaigns', all: 'All Campaigns', exchange: 'Exchange' };

export default function Campaigns({ mode }: { mode: Mode }) {
  const { isAdmin } = useAuth();
  const nav = useNavigate();
  const [adding, setAdding] = useState(false);

  const { data, error, loading } = useQuery(
    () => fetchAll((a, b) => {
      let q = supabase.from('campaign_summary').select('*').order('real_name');
      if (mode === 'active') q = q.is('archived_at', null);
      if (mode === 'exchange') q = q.eq('exchange', true);
      return q.range(a, b);
    }),
    [mode],
  );

  const columns = mode === 'all'
    ? [...campaignColumns, {
        key: 'status', label: 'Status',
        value: (r: Row) => (r.archived_at ? 'Archived' : 'Active'),
        render: (r: Row) => <StatusPill value={r.archived_at ? 'Archived' : 'Active'} />,
      }]
    : campaignColumns;

  return (
    <>
      <DataTable
        title={TITLES[mode]}
        rows={data ?? []}
        loading={loading}
        error={error}
        columns={columns}
        groupBy={{ label: 'Manager', value: r => r.manager_name ?? '' }}
        onOpen={r => nav(`/campaigns/${encodeURIComponent(r.id)}`)}
        summary={data && <Totals rows={data} />}
        actions={isAdmin && (
          <button className="btn primary" onClick={() => setAdding(true)}><Plus size={16} /> New campaign</button>
        )}
      />
      {adding && (
        <RecordForm
          table="campaigns"
          title="New Campaign"
          fields={campaignFields}
          onClose={() => setAdding(false)}
          onSaved={r => nav(`/campaigns/${encodeURIComponent(r.id)}`)}
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
