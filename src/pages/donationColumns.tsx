import { Link } from 'react-router-dom';
import type { Column } from '../components/DataTable';
import { campLabel } from '../components/CrudPage';
import { StatusPill } from '../components/Pill';
import AdminLink from '../components/AdminLink';
import { dateTime, money, yn } from '../lib/format';
import type { Row } from '../lib/supabase';

export const DONATION_SELECT =
  '*, campaigns(id, internal_name, campaign_name, external_name), donors(id, display_name), collectors(full_name), sources(name), accounts(name)';

const STATUS_LABELS: Record<string, string> = {
  pending: 'Pending', collect: 'Collect', voided: 'Voided', refunded: 'Refunded', returned: 'Returned', failed: 'Failed',
};

/** One word for a donation: its type once completed, otherwise what happened to it. */
export const donationKind = (r: Row): string => (r.status === 'completed' ? r.type : STATUS_LABELS[r.status] ?? r.status);

/** The same words as filters. */
export const DONATION_KINDS: Record<string, { type?: string; status: string }> = {
  Payment: { type: 'Payment', status: 'completed' },
  Batch: { type: 'Batch', status: 'completed' },
  ...Object.fromEntries(Object.entries(STATUS_LABELS).map(([status, label]) => [label, { status }])),
};

/** Counts toward totals, as opposed to voided, refunded and the like. */
export const isLive = (r: Row) => r.status === 'completed' || r.status === 'collect';

export const donorName = (r: Row) => r.donors?.display_name ?? r.donor_label?.replace(/\s*-\s*$/, '') ?? '';

export const donationColumns = (opts: { hideCampaign?: boolean } = {}): Column[] => [
  {
    key: 'donor', label: 'Donor', width: 180, value: r => donorName(r) || r.name,
    render: r => {
      const main = donorName(r) || r.name || <span className="muted">Anonymous</span>;
      return (
        <div>
          <div>{r.donors ? <Link to={`/donors/${r.donors.id}`} onClick={e => e.stopPropagation()}>{main}</Link> : main}</div>
          {r.name && donorName(r) && r.name !== donorName(r) && <div className="muted small">{r.name}</div>}
        </div>
      );
    },
  },
  { key: 'amount', label: 'Amount', render: r => <b className="num">{money(r.amount)}</b>, align: 'right' },
  { key: 'type', label: 'Type', value: donationKind, render: r => <StatusPill value={donationKind(r)} /> },
  ...(opts.hideCampaign ? [] : [{ key: 'campaign', label: 'Campaign', width: 180, value: (r: Row) => campLabel(r.campaigns) }]),
  { key: 'payment_method', label: 'Method' },
  { key: 'created_at', label: 'Date', render: r => dateTime(r.created_at), width: 170 },
  { key: 'fee', label: 'Fee', render: r => money(r.fee ?? r.manual_fee), value: r => r.fee ?? r.manual_fee, align: 'right' },
  { key: 'net_donation', label: 'Net', render: r => money(r.net_donation), align: 'right' },
  { key: 'collector', label: 'Collector', value: r => r.collectors?.full_name ?? r.collector_label },
  {
    key: 'source', label: 'Source', value: r => r.sources?.name ?? r.source,
    render: r => r.source && <AdminLink to={`/sources/${encodeURIComponent(r.source)}`}>{r.sources?.name ?? r.source}</AdminLink>,
  },
  {
    key: 'account', label: 'Account', value: r => r.accounts?.name,
    render: r => r.account_id && <AdminLink to={`/accounts/${encodeURIComponent(r.account_id)}`}>{r.accounts?.name ?? r.account_id}</AdminLink>,
  },
  { key: 'delivered', label: 'Delivered', render: r => yn(r.delivered) },
  { key: 'batch_id', label: 'Batch ID' },
  { key: 'notes', label: 'Notes' },
  { key: 'updated_at', label: 'Last Update', render: r => dateTime(r.updated_at), width: 170 },
];
