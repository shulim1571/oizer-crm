import { useState } from 'react';
import DataTable from '../components/DataTable';
import { Balance, StatusPill } from '../components/Pill';
import { dateTime, money } from '../lib/format';
import { supabase, type Row } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';
import { STATUS_LABEL } from './Campaigns';

/** A Community Guest's whole portal: read-only, and limited to what these two functions return. */
export default function GuestPage() {
  const [selected, setSelected] = useState<string | null>(null);

  const campaigns = useQuery(async () => {
    const { data, error } = await supabase.rpc('guest_campaigns');
    if (error) throw new Error(error.message);
    return data as Row[];
  });
  const current = selected ?? campaigns.data?.[0]?.id ?? null;

  const donations = useQuery(async () => {
    if (!current) return [];
    const { data, error } = await supabase.rpc('guest_donations', { p_campaign: current });
    if (error) throw new Error(error.message);
    return data as Row[];
  }, [current]);

  const campaign = campaigns.data?.find(c => c.id === current);

  return (
    <DataTable
      plain
      title={campaign?.name ?? 'Your campaigns'}
      subtitle={campaign && <>Raised {money(campaign.raised)} · Balance <Balance value={campaign.balance} /> · <StatusPill value={STATUS_LABEL[campaign.status]} /></>}
      rows={donations.data ?? []}
      loading={campaigns.loading || donations.loading}
      error={campaigns.error ?? donations.error}
      actions={(campaigns.data?.length ?? 0) > 1 && (
        <select value={current ?? ''} onChange={e => setSelected(e.target.value)}>
          {campaigns.data!.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      )}
      columns={[
        { key: 'created_at', label: 'Date', render: r => dateTime(r.created_at), width: 170 },
        { key: 'donor', label: 'Donor', width: 220 },
        { key: 'amount', label: 'Amount', render: r => money(r.amount), align: 'right' },
        { key: 'payment_method', label: 'Method' },
      ]}
    />
  );
}
