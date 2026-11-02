import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, X } from 'lucide-react';
import DataTable, { type Column } from '../components/DataTable';
import RecordForm from '../components/RecordForm';
import { Pill, StatusPill } from '../components/Pill';
import { useAuth } from '../lib/auth';
import { localToday, dateTime, money } from '../lib/format';
import { clearLookups } from '../lib/lookups';
import { voucherFields } from '../lib/schemas';
import { fetchAll, supabase, type Row } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';
import { Overlay } from './Pledges';

export const VOUCHER_STATUS: Record<string, string> = {
  pending: 'Pending funding', partial: 'Partially funded', funded: 'Fully funded', cancelled: 'Cancelled', overage_review: 'Overage review',
};
const issuerName = (issuer: string) => issuer?.replace(/^Voucher\s*—\s*/, '');
const feeText = (r: Row) => {
  switch (r.fee_type) {
    case 'flat': return `$${Number(r.fee_flat).toFixed(2)} each funding`;
    case 'percent': return `${Number(r.fee_percent)}%`;
    case 'percent_flat': return `${Number(r.fee_percent)}% + $${Number(r.fee_flat).toFixed(2)}`;
    default: return 'None';
  }
};
const feeOn = (r: Row, amount: number) => {
  const pctPart = amount * Number(r.fee_percent) / 100;
  switch (r.fee_type) {
    case 'flat': return Number(r.fee_flat);
    case 'percent': return Math.round(pctPart * 100) / 100;
    case 'percent_flat': return Math.round((pctPart + Number(r.fee_flat)) * 100) / 100;
    default: return 0;
  }
};

export const voucherColumns = (hideCampaign = false): Column[] => [
  { key: 'id', label: 'Ref', width: 150 },
  { key: 'issuer', label: 'Issuer', value: (r: Row) => issuerName(r.issuer) },
  { key: 'issuer_number', label: 'Issuer #' },
  { key: 'account_number', label: 'Account #' },
  { key: 'donor_name', label: 'Donor', width: 170 },
  ...(hideCampaign ? [] : [{ key: 'campaign', label: 'Campaign', value: (r: Row) => `${r.campaign_internal || r.campaign_external || ''} - ${r.campaign_id}`, width: 200 }]),
  { key: 'face_value', label: 'Face value', render: (r: Row) => money(r.face_value), align: 'right' as const },
  { key: 'total_funded', label: 'Funded', render: (r: Row) => money(r.total_funded), align: 'right' as const },
  { key: 'total_fees', label: 'Fees', render: (r: Row) => money(r.total_fees), align: 'right' as const },
  { key: 'total_net', label: 'Net credited', render: (r: Row) => money(r.total_net), align: 'right' as const },
  { key: 'remaining', label: 'Remaining', render: (r: Row) => money(r.remaining), align: 'right' as const },
  {
    key: 'status', label: 'Status', value: (r: Row) => VOUCHER_STATUS[r.status],
    render: (r: Row) => <><StatusPill value={VOUCHER_STATUS[r.status]} />{r.overdue && <> <Pill tone="red">Overdue</Pill></>}</>,
  },
  { key: 'submission', label: 'Submitted', value: (r: Row) => (r.submission === 'mailed' ? 'Mailed in' : 'Online') },
  { key: 'date_received', label: 'Received' },
  { key: 'expected_date', label: 'Expected' },
];

export function NewVoucherButton({ campaignId, onSaved }: { campaignId?: string; onSaved: () => void }) {
  const [adding, setAdding] = useState(false);
  return (
    <>
      <button className="btn primary" onClick={() => setAdding(true)}><Plus size={16} /> Log voucher</button>
      {adding && (
        <RecordForm
          table="vouchers"
          title="Log voucher"
          fields={voucherFields}
          defaults={{ campaign_id: campaignId, submission: 'online', date_received: localToday() }}
          onClose={() => setAdding(false)}
          onSaved={() => { setAdding(false); onSaved(); }}
        />
      )}
    </>
  );
}

export function VouchersPage() {
  const [status, setStatus] = useState('');
  const [overdue, setOverdue] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const q = useQuery(
    () => fetchAll((a, b) => supabase.from('voucher_list').select('*').order('created_at', { ascending: false }).range(a, b) as never),
    [version],
  );
  const rows = ((q.data as Row[]) ?? []).filter(r => (!status || r.status === status) && (!overdue || r.overdue));
  return (
    <section className="view">
      <DataTable
        title="Vouchers"
        rows={rows}
        loading={q.loading}
        error={q.error}
        columns={voucherColumns()}
        exportName="vouchers"
        onOpen={r => setOpen(r.id)}
        actions={
          <>
            <select aria-label="Status" value={status} onChange={e => setStatus(e.target.value)}>
              <option value="">All statuses</option>
              {Object.entries(VOUCHER_STATUS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <label className="inline-check"><input type="checkbox" checked={overdue} onChange={e => setOverdue(e.target.checked)} /> Overdue only</label>
            <NewVoucherButton onSaved={() => setVersion(v => v + 1)} />
          </>
        }
      />
      {open && <VoucherDialog id={open} onClose={() => setOpen(null)} onChanged={() => setVersion(v => v + 1)} />}
    </section>
  );
}

export function VoucherDialog({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { isAdmin } = useAuth();
  const [version, setVersion] = useState(0);
  const [panel, setPanel] = useState<'fund' | 'edit' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const q = useQuery(async () => {
    const [v, f] = await Promise.all([
      supabase.from('voucher_list').select('*').eq('id', id).maybeSingle(),
      supabase.from('donations').select('id, amount, fee, net_donation, status, bank_reference, campaign_id, created_at').eq('voucher_id', id).order('created_at'),
    ]);
    const bad = v.error ?? f.error;
    if (bad) throw new Error(bad.message);
    return { voucher: v.data as Row | null, funding: (f.data ?? []) as Row[] };
  }, [id, version]);
  const v = q.data?.voucher;

  const changed = () => {
    setPanel(null);
    clearLookups();
    setVersion(n => n + 1);
    onChanged();
  };
  async function run(call: PromiseLike<{ error: { message: string } | null }>) {
    setError(null);
    const { error: e } = await call;
    if (e) return setError(e.message);
    changed();
  }

  const body = !v ? <p className="muted">{q.loading ? 'Loading…' : q.error ?? 'Voucher not found.'}</p> : (
    <>
      <div className="form-head">
        <h2>{v.id} <StatusPill value={VOUCHER_STATUS[v.status]} />{v.overdue && <> <Pill tone="red">Overdue</Pill></>}</h2>
        <button type="button" className="icon-btn" title="Close" onClick={onClose}><X size={18} /></button>
      </div>
      <dl className="record-facts">
        <dt>Issuer</dt><dd>{issuerName(v.issuer)}{v.issuer_number && ` · #${v.issuer_number}`}</dd>
        <dt>Submitted</dt><dd>{v.submission === 'mailed' ? `Mailed in · account ${v.account_number ?? 'not recorded'}` : 'Online'}</dd>
        <dt>Donor</dt><dd>{v.donor_id ? <Link to={`/donors/${encodeURIComponent(v.donor_id)}`}>{v.donor_name}</Link> : v.donor_name || '—'}</dd>
        <dt>Campaign</dt><dd><Link to={`/campaigns/${encodeURIComponent(v.campaign_id)}`}>{v.campaign_internal || v.campaign_external} - {v.campaign_id}</Link></dd>
        <dt>Face value</dt><dd>{money(v.face_value)}</dd>
        <dt>Fee</dt><dd>{feeText(v)}</dd>
        <dt>Received</dt><dd>{v.date_received}{v.expected_date && ` · funding expected ${v.expected_date}`}</dd>
        {v.cancel_reason && <><dt>Cancelled</dt><dd>{v.cancel_reason}</dd></>}
        {v.notes && <><dt>Notes</dt><dd className="pre-line">{v.notes}</dd></>}
      </dl>

      <div className="progress" title={`${v.percent_funded}% funded`}><div style={{ width: `${Math.min(Number(v.percent_funded), 100)}%` }} /></div>
      <p className="muted">
        {v.percent_funded}% funded · {money(v.total_funded)} received · {money(v.total_fees)} fees · <b>{money(v.total_net)} credited</b> · {money(v.remaining)} remaining
      </p>

      {v.status === 'overage_review' && <div className="error">Someone tried to record more than the {money(v.remaining)} left on this voucher. Check it with the issuer.</div>}
      {error && <div className="error">{error}</div>}

      {isAdmin && !v.cancelled_at && (
        <div className="donation-actions">
          {Number(v.remaining) > 0 && <button type="button" className="btn primary" onClick={() => setPanel('fund')}>Add funding</button>}
          {v.overage_flag && <button type="button" className="btn" onClick={() => run(supabase.rpc('clear_voucher_overage', { p_voucher: v.id }))}>Reviewed</button>}
          <button type="button" className="btn" onClick={() => setPanel('edit')}>Edit</button>
          <button type="button" className="btn danger" onClick={() => {
            const r = prompt('Cancel this voucher? It leaves the awaiting total, and anything already funded stays. A reason is required:');
            if (r === null) return;
            run(supabase.rpc('cancel_voucher', { p_voucher: v.id, p_reason: r }));
          }}>Cancel voucher</button>
        </div>
      )}

      {panel === 'fund' && <FundPanel voucher={v} onDone={changed} onCancel={() => setPanel(null)} onOverage={() => setVersion(n => n + 1)} />}

      <h3 className="dialog-section">Funding</h3>
      {q.data!.funding.length === 0 ? <p className="muted">Nothing received yet. No money counts toward the balance until it arrives.</p> : (
        <div className="table-wrap dialog-table"><table className="grid">
          <thead><tr><th>Date</th><th>Received</th><th>Fee</th><th>Net credited</th><th>Bank ref</th><th /></tr></thead>
          <tbody>
            {q.data!.funding.map(f => (
              <tr key={f.id}>
                <td>{dateTime(f.created_at)}</td>
                <td>{money(f.amount)}</td>
                <td>{money(f.fee)}</td>
                <td>{money(f.net_donation)}</td>
                <td>{f.bank_reference}</td>
                <td>
                  {f.status !== 'completed' && <StatusPill value={f.status[0].toUpperCase() + f.status.slice(1)} />}
                  {!f.campaign_id && <Pill tone="amber">Unattributed</Pill>}
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </>
  );

  return (
    <>
      <Overlay onClose={onClose}>{body}</Overlay>
      {panel === 'edit' && v && (
        <RecordForm
          table="vouchers"
          title={`Edit ${v.id}`}
          fields={voucherFields}
          record={v}
          allowDelete
          onClose={() => setPanel(null)}
          onSaved={row => { if (row._deleted) { onChanged(); onClose(); } else changed(); }}
        />
      )}
    </>
  );
}

function FundPanel({ voucher: v, onDone, onCancel, onOverage }: { voucher: Row; onDone: () => void; onCancel: () => void; onOverage: () => void }) {
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(localToday());
  const [bank, setBank] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const n = Number(amount) || 0;
  const fee = feeOn(v, n);
  const net = n - fee;

  async function save() {
    if (net < 0 && !confirm(`This fee exceeds the amount received. Net Credited will be -${money(-net)}. Please confirm this is correct.`)) return;
    setBusy(true);
    setError(null);
    const { data, error: e } = await supabase.rpc('add_voucher_funding', { p_voucher: v.id, p_amount: n, p_date: date, p_bank_reference: bank || null });
    setBusy(false);
    if (e) return setError(e.message);
    if (!data.ok) {
      setError(`That's more than the ${money(data.remaining)} left on this voucher, so nothing was recorded. It's flagged for review.`);
      return onOverage();
    }
    onDone();
  }

  return (
    <div className="panel-box">
      <div className="fields">
        <label className="field"><span>Amount received *</span><input type="number" step="0.01" min="0" value={amount} onChange={e => setAmount(e.target.value)} /></label>
        <label className="field"><span>Date received *</span><input type="date" value={date} onChange={e => setDate(e.target.value)} /></label>
        <label className="field"><span>Bank reference</span><input value={bank} onChange={e => setBank(e.target.value)} /></label>
      </div>
      {n > 0 && <p className={net < 0 ? 'amount-neg' : 'muted'}>Fee {money(fee)} · Net credited {money(net)}</p>}
      {error && <div className="error">{error}</div>}
      <div className="form-actions">
        <div className="spacer" />
        <button type="button" className="btn" onClick={onCancel}>Back</button>
        <button type="button" className="btn primary" disabled={busy || n <= 0 || !date} onClick={save}>Record funding</button>
      </div>
    </div>
  );
}
