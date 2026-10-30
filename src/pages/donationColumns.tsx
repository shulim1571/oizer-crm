import { Link } from 'react-router-dom';
import type { Column } from '../components/DataTable';
import { campLabel } from '../components/CrudPage';
import { dateTime, money, yn } from '../lib/format';
import type { Row } from '../lib/supabase';

export const DONATION_SELECT =
  '*, campaigns(id, real_name, campaign_name, friendly_name), donors(id, display_name), collectors(full_name), sources(name), accounts(name)';

export const donorName = (r: Row) => r.donors?.display_name ?? r.donor_label?.replace(/\s*-\s*$/, '') ?? '';

export const donationColumns = (opts: { hideCampaign?: boolean } = {}): Column[] => [
  {
    key: 'donor', label: 'Donor', width: 160, value: donorName,
    render: r => (r.donors ? <Link to={`/donors/${r.donors.id}`} onClick={e => e.stopPropagation()}>{donorName(r)}</Link> : donorName(r)),
  },
  { key: 'name', label: 'Name' },
  { key: 'amount', label: 'Amount', render: r => money(r.amount), align: 'right' },
  { key: 'fee', label: 'Fee', render: r => money(r.fee ?? r.manual_fee), value: r => r.fee ?? r.manual_fee, align: 'right' },
  { key: 'net_donation', label: 'Net Donation', render: r => money(r.net_donation), align: 'right' },
  ...(opts.hideCampaign ? [] : [{ key: 'campaign', label: 'Campaign', width: 180, value: (r: Row) => campLabel(r.campaigns) }]),
  { key: 'collector', label: 'Collector', value: r => r.collectors?.full_name ?? r.collector_label },
  { key: 'created_at', label: 'Timestamp', render: r => dateTime(r.created_at), width: 170 },
  { key: 'updated_at', label: 'Last Update', render: r => dateTime(r.updated_at), width: 170 },
  { key: 'payment_method', label: 'Payment Method' },
  { key: 'delivered', label: 'Delivered', render: r => yn(r.delivered) },
  { key: 'source', label: 'Source', value: r => r.sources?.name ?? r.source },
  { key: 'type', label: 'Type' },
  { key: 'batch_id', label: 'Batch ID' },
  { key: 'notes', label: 'Notes' },
];
