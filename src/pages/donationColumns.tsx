import { Link } from 'react-router-dom';
import type { Column } from '../components/DataTable';
import { campLabel } from '../components/CrudPage';
import { StatusPill } from '../components/Pill';
import { dateTime, money, yn } from '../lib/format';
import type { Row } from '../lib/supabase';

export const DONATION_SELECT =
  '*, campaigns(id, real_name, campaign_name, friendly_name), donors(id, display_name), collectors(full_name), sources(name), accounts(name)';

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
  { key: 'type', label: 'Type', render: r => <StatusPill value={r.type} /> },
  ...(opts.hideCampaign ? [] : [{ key: 'campaign', label: 'Campaign', width: 180, value: (r: Row) => campLabel(r.campaigns) }]),
  { key: 'payment_method', label: 'Method' },
  { key: 'created_at', label: 'Date', render: r => dateTime(r.created_at), width: 170 },
  { key: 'fee', label: 'Fee', render: r => money(r.fee ?? r.manual_fee), value: r => r.fee ?? r.manual_fee, align: 'right' },
  { key: 'net_donation', label: 'Net', render: r => money(r.net_donation), align: 'right' },
  { key: 'collector', label: 'Collector', value: r => r.collectors?.full_name ?? r.collector_label },
  { key: 'source', label: 'Source', value: r => r.sources?.name ?? r.source },
  { key: 'delivered', label: 'Delivered', render: r => yn(r.delivered) },
  { key: 'batch_id', label: 'Batch ID' },
  { key: 'notes', label: 'Notes' },
  { key: 'updated_at', label: 'Last Update', render: r => dateTime(r.updated_at), width: 170 },
];
