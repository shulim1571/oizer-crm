import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import DataTable, { type Column } from '../components/DataTable';
import RecordForm from '../components/RecordForm';
import { fetchAll, supabase, type Row } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';
import { useAuth } from '../lib/auth';
import { balanceClass, money, pct } from '../lib/format';
import { campaignFields } from '../lib/schemas';

export const campaignColumns: Column[] = [
  { key: 'real_name', label: 'Real Name', width: 150 },
  { key: 'friendly_name', label: 'Friendly Name', width: 150 },
  { key: 'id', label: 'Campaign ID', value: r => Number(r.id) || r.id, render: r => r.id },
  { key: 'pin', label: 'Pin' },
  { key: 'manager_name', label: 'Manager', width: 140 },
  { key: 'raised', label: 'Raised', render: r => money(r.raised), align: 'right' },
  { key: 'fees', label: 'Fees', render: r => money(r.fees), align: 'right' },
  { key: 'fee_percent', label: 'Fee Percent', render: r => pct(r.fee_percent), align: 'right' },
  { key: 'expenses', label: 'Expenses', render: r => money(r.expenses), align: 'right' },
  { key: 'balance', label: 'Balance', render: r => <b className={balanceClass(r.balance)}>{money(r.balance)}</b>, align: 'right' },
  { key: 'pending_balance', label: 'Pending Balance', render: r => money(r.pending_balance), align: 'right' },
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
    ? [...campaignColumns, { key: 'archived_at', label: 'Status', value: (r: Row) => (r.archived_at ? 'Archived' : 'Active') }]
    : campaignColumns;

  return (
    <>
      <DataTable
        title={TITLES[mode]}
        rows={data ?? []}
        loading={loading}
        error={error}
        columns={columns}
        groupBy={{ value: r => r.manager_name ?? '' }}
        onOpen={r => nav(`/campaigns/${encodeURIComponent(r.id)}`)}
        footer={data && <Totals rows={data} />}
        actions={isAdmin && (
          <button className="btn primary" onClick={() => setAdding(true)}><Plus size={18} /> Add</button>
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
  return (
    <div className="totals">
      <span>Raised <b>{money(sum('raised'))}</b></span>
      <span>Fees <b>{money(sum('fees'))}</b></span>
      <span>Expenses <b>{money(sum('expenses'))}</b></span>
      <span>Balance <b className={balanceClass(sum('balance'))}>{money(sum('balance'))}</b></span>
      <span>Pending <b>{money(sum('pending_balance'))}</b></span>
    </div>
  );
}
