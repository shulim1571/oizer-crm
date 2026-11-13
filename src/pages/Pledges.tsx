import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, X } from 'lucide-react';
import DataTable, { type Column } from '../components/DataTable';
import DateNote from '../components/DateNote';
import RecordForm from '../components/RecordForm';
import SearchSelect from '../components/SearchSelect';
import { StatusPill } from '../components/Pill';
import { useAuth } from '../lib/auth';
import { localToday, dateTime, download, money, toCsv } from '../lib/format';
import { clearLookups, paymentMethodOptions, type Option } from '../lib/lookups';
import { pledgeEditFields, pledgeFields, recurringPledgeEditFields, recurringPledgeFields } from '../lib/schemas';
import { fetchAll, supabase, type Row } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';

export const PLEDGE_STATUS: Record<string, string> = {
  open: 'Open', partial: 'Partially fulfilled', fulfilled: 'Fulfilled', overdue: 'Overdue', cancelled: 'Cancelled',
};
const INSTALLMENT_STATUS: Record<string, string> = { ...PLEDGE_STATUS, skipped: 'Skipped' };
const FREQUENCIES = ['weekly', 'monthly', 'quarterly', 'annually'];
const label = (s: string) => s[0].toUpperCase() + s.slice(1);

export const pledgeColumns = (hideCampaign = false): Column[] => [
  { key: 'reference', label: 'Pledge', width: 150 },
  { key: 'donor_name', label: 'Donor', width: 180 },
  ...(hideCampaign ? [] : [{ key: 'campaign', label: 'Campaign', campaignLink: (r: Row) => r.campaign_id, value: (r: Row) => `${r.campaign_internal || r.campaign_external || ''} - ${r.campaign_id}`, width: 200 }]),
  { key: 'amount', label: 'Pledged', render: (r: Row) => money(r.amount), align: 'right' as const },
  { key: 'received', label: 'Received', render: (r: Row) => money(r.received), align: 'right' as const },
  { key: 'balance', label: 'Remaining', render: (r: Row) => money(r.balance), align: 'right' as const },
  { key: 'status', label: 'Status', value: (r: Row) => PLEDGE_STATUS[r.status], render: (r: Row) => <StatusPill value={PLEDGE_STATUS[r.status]} /> },
  { key: 'kind', label: 'Kind', optional: true, value: (r: Row) => (r.is_recurring ? `Recurring, ${r.frequency}` : 'One time') },
  { key: 'date_pledged', label: 'Pledged on' },
  { key: 'due', label: 'Next due', value: (r: Row) => (r.is_recurring ? r.next_due_date : r.expected_date) ?? '' },
  { key: 'days_outstanding', label: 'Days outstanding', optional: true, value: (r: Row) => (r.status === 'fulfilled' || r.status === 'cancelled' ? '' : r.days_outstanding), align: 'right' as const },
  { key: 'notes', label: 'Notes', long: true, optional: true },
];

/** Add buttons for a one-time or recurring pledge, and the form that goes with them. */
export function NewPledgeButtons({ campaignId, donorId, onSaved, startOpen, onDone }:
  { campaignId?: string; donorId?: string; onSaved: () => void; startOpen?: boolean; onDone?: () => void }) {
  const [form, setForm] = useState<'one' | 'recurring' | null>(startOpen ? 'one' : null);
  const defaults = { campaign_id: campaignId, donor_id: donorId, date_pledged: localToday() };
  return (
    <>
      <button className="btn" onClick={() => setForm('recurring')}><Plus size={16} /> Recurring pledge</button>
      <button className="btn primary" onClick={() => setForm('one')}><Plus size={16} /> Add pledge</button>
      {form && (
        <RecordForm
          table="pledges"
          title={form === 'one' ? 'New pledge' : 'New recurring pledge'}
          fields={form === 'one' ? pledgeFields : recurringPledgeFields}
          defaults={form === 'one' ? defaults : { ...defaults, is_recurring: true, frequency: 'monthly', start_date: defaults.date_pledged }}
          onClose={() => { setForm(null); onDone?.(); }}
          onSaved={() => { setForm(null); onSaved(); onDone?.(); }}
        />
      )}
    </>
  );
}

/** The Pledges list. With startNew (New Donation · New pledge) the new-pledge form opens right away. */
export function PledgesPage({ startNew = false }: { startNew?: boolean }) {
  const { canWork } = useAuth();
  const nav = useNavigate();
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const q = useQuery(
    () => fetchAll((a, b) => supabase.from('pledge_list').select('*').order('date_pledged', { ascending: false }).range(a, b) as never),
    [version],
  );
  const rows = ((q.data as Row[]) ?? []).filter(r => !status || r.status === status);
  return (
    <section className="view">
      <DataTable
        title="Pledges"
        rows={rows}
        loading={q.loading}
        error={q.error}
        columns={pledgeColumns()}
        exportName="pledges"
        onOpen={r => setOpen(r.id)}
        actions={
          <>
            <select aria-label="Status" value={status} onChange={e => setStatus(e.target.value)}>
              <option value="">All statuses</option>
              {Object.entries(PLEDGE_STATUS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            {canWork && <NewPledgeButtons key={String(startNew)} startOpen={startNew} onDone={startNew ? () => nav('/donations/pledges') : undefined} onSaved={() => setVersion(v => v + 1)} />}
          </>
        }
      />
      {open && <PledgeDialog id={open} onClose={() => setOpen(null)} onChanged={() => setVersion(v => v + 1)} />}
    </section>
  );
}

export function PledgeDialog({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { isAdmin } = useAuth();
  const [version, setVersion] = useState(0);
  const [panel, setPanel] = useState<'pay' | 'match' | 'reschedule' | 'edit' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [canPay, setCanPay] = useState(isAdmin);

  const q = useQuery(async () => {
    const [p, s, l] = await Promise.all([
      supabase.from('pledge_list').select('*').eq('id', id).maybeSingle(),
      supabase.from('installment_list').select('*').eq('pledge_id', id).order('seq'),
      supabase.from('pledge_payments').select('*, donations(id, amount, status, payment_method, created_at)').eq('pledge_id', id).order('created_at'),
    ]);
    const bad = p.error ?? s.error ?? l.error;
    if (bad) throw new Error(bad.message);
    return { pledge: p.data as Row | null, schedule: (s.data ?? []) as Row[], links: (l.data ?? []) as Row[] };
  }, [id, version]);
  const p = q.data?.pledge;

  useEffect(() => {
    if (isAdmin || !p?.campaign_id) return;
    supabase.rpc('has_override', { p_permission: 'enter_manual_payments', p_campaign: p.campaign_id }).then(({ data }) => setCanPay(!!data));
  }, [isAdmin, p?.campaign_id]);

  const changed = (message?: string) => {
    setPanel(null);
    setNotice(message ?? null);
    clearLookups();
    setVersion(v => v + 1);
    onChanged();
  };
  async function run(call: PromiseLike<{ error: { message: string } | null }>, message?: string) {
    setError(null);
    const { error: e } = await call;
    if (e) return setError(e.message);
    changed(message);
  }
  function ask(question: string, then: (answer: string) => void, required = true) {
    const a = prompt(question);
    if (a === null) return;
    if (required && !a.trim()) return setError('That needs an answer.');
    then(a);
  }

  const body = !p ? <p className="muted">{q.loading ? 'Loading…' : q.error ?? 'Pledge not found.'}</p> : (
    <>
      <div className="form-head">
        <h2>{p.reference} <StatusPill value={PLEDGE_STATUS[p.status]} /></h2>
        <button type="button" className="icon-btn" title="Close" onClick={onClose}><X size={18} /></button>
      </div>
      <dl className="record-facts">
        <dt>Donor</dt><dd>{p.donor_id ? <Link to={`/donors/${encodeURIComponent(p.donor_id)}`}>{p.donor_name}</Link> : p.donor_name || '—'}</dd>
        <dt>Campaign</dt><dd><Link to={`/campaigns/${encodeURIComponent(p.campaign_id)}`}>{p.campaign_internal || p.campaign_external} - {p.campaign_id}</Link></dd>
        <dt>Pledged</dt><dd>{money(p.amount)} on {p.date_pledged}</dd>
        <dt>Received</dt><dd>{money(p.received)}</dd>
        <dt>Remaining</dt><dd><b>{money(p.balance)}</b></dd>
        {p.is_recurring
          ? <><dt>Schedule</dt><dd>{money(p.installment_amount)} {p.frequency}{p.installment_count ? `, ${p.installment_count} times` : ', open-ended'}{p.next_due_date && ` · next ${money(p.next_due_amount)} on ${p.next_due_date}`}</dd></>
          : p.expected_date && <><dt>Expected</dt><dd>{p.expected_date}</dd></>}
        {p.cancel_reason && <><dt>Cancelled</dt><dd>{p.cancel_reason}</dd></>}
        {p.notes && <><dt>Notes</dt><dd className="pre-line">{p.notes}</dd></>}
      </dl>

      {notice && <div className="notice">{notice}</div>}
      {error && <div className="error">{error}</div>}

      {!p.cancelled_at && (
        <div className="donation-actions">
          {canPay && p.status !== 'fulfilled' && <button type="button" className="btn primary" onClick={() => setPanel('pay')}>Pay pledge</button>}
          {p.status !== 'fulfilled' && <button type="button" className="btn" onClick={() => setPanel('match')}>Match a payment</button>}
          <button type="button" className="btn" onClick={() => ask('Add a note:', n => run(supabase.rpc('add_pledge_note', { p_pledge: p.id, p_note: n })))}>Add note</button>
          {p.status !== 'fulfilled' && <button type="button" className="btn" onClick={() => run(supabase.rpc('pledge_to_task', { p_pledge: p.id }), 'Task created.')}>Make a task</button>}
          {isAdmin && <button type="button" className="btn" onClick={() => setPanel('edit')}>Edit</button>}
          {isAdmin && p.is_recurring && <button type="button" className="btn" onClick={() => setPanel('reschedule')}>Change schedule</button>}
          {isAdmin && (
            <button type="button" className="btn danger" onClick={() => ask('Cancel this pledge? What was paid stays. A reason is required:', r => run(supabase.rpc('cancel_pledge', { p_pledge: p.id, p_reason: r })))}>Cancel pledge</button>
          )}
        </div>
      )}

      {panel === 'pay' && <PayPanel pledge={p} onDone={changed} onCancel={() => setPanel(null)} />}
      {panel === 'match' && <MatchPanel pledge={p} schedule={q.data!.schedule} onDone={changed} onCancel={() => setPanel(null)} />}
      {panel === 'reschedule' && <ReschedulePanel pledge={p} onDone={changed} onCancel={() => setPanel(null)} />}

      {p.is_recurring && (
        <>
          <div className="dialog-section">
            <h3>Schedule</h3>
            <button type="button" className="link" onClick={() => download(`${p.reference}-schedule.csv`, toCsv(
              q.data!.schedule.map(i => ({ ...i, status: INSTALLMENT_STATUS[i.status] })),
              [{ key: 'seq', label: '#' }, { key: 'due_date', label: 'Due' }, { key: 'amount', label: 'Amount' }, { key: 'paid', label: 'Paid' }, { key: 'remaining', label: 'Remaining' }, { key: 'status', label: 'Status' }, { key: 'skip_note', label: 'Note' }],
            ))}>Export schedule</button>
          </div>
          <div className="table-wrap dialog-table"><table className="grid">
            <thead><tr><th>#</th><th>Due</th><th>Amount</th><th>Paid</th><th>Status</th><th /></tr></thead>
            <tbody>
              {q.data!.schedule.filter(i => i.status !== 'cancelled' || Number(i.paid) > 0).map(i => (
                <tr key={i.id}>
                  <td>{i.seq}</td>
                  <td>{i.due_date}</td>
                  <td>{money(i.amount)}</td>
                  <td>{money(i.paid)}</td>
                  <td><StatusPill value={INSTALLMENT_STATUS[i.status]} />{i.skip_note && <div className="muted small">{i.skip_note}</div>}</td>
                  <td>
                    {!p.cancelled_at && Number(i.paid) === 0 && ['open', 'overdue'].includes(i.status) && (
                      <button type="button" className="link" onClick={() => ask('Skip this installment? A note is required:', n => run(supabase.rpc('skip_installment', { p_installment: i.id, p_note: n })))}>Skip</button>
                    )}
                    {isAdmin && !p.cancelled_at && !['cancelled', 'skipped'].includes(i.status) && (
                      <> <button type="button" className="link" onClick={() => {
                        const a = prompt('New amount:', String(i.amount));
                        if (a === null) return;
                        const due = prompt('New due date (YYYY-MM-DD):', i.due_date);
                        if (due !== null) run(supabase.rpc('edit_installment', { p_installment: i.id, p_due: due, p_amount: Number(a) }));
                      }}>Edit</button></>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </>
      )}

      <h3 className="dialog-section">Linked payments</h3>
      {q.data!.links.length === 0 ? <p className="muted">None yet.</p> : (
        <div className="table-wrap dialog-table"><table className="grid">
          <thead><tr><th>Date</th><th>Payment</th><th>Applied</th><th>Method</th><th>How</th><th /></tr></thead>
          <tbody>
            {q.data!.links.map(l => (
              <tr key={l.id}>
                <td>{dateTime(l.donations?.created_at)}</td>
                <td>{money(l.donations?.amount)}{l.donations?.status !== 'completed' && <> <StatusPill value={label(l.donations?.status ?? '')} /></>}</td>
                <td>{money(l.amount)}</td>
                <td>{l.donations?.payment_method}</td>
                <td>{l.matched_by === 'auto' ? 'Automatic' : l.matched_by === 'manual' ? 'By hand' : 'Pay pledge'}</td>
                <td>{isAdmin && (
                  <button type="button" className="link" onClick={() => confirm('Unmatch this payment from the pledge? The payment itself stays.') && run(supabase.rpc('unmatch_pledge_payment', { p_pledge: p.id, p_donation: l.donation_id }))}>Unmatch</button>
                )}</td>
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
      {panel === 'edit' && p && (
        <RecordForm
          table="pledges"
          title={`Edit ${p.reference}`}
          fields={p.is_recurring ? recurringPledgeEditFields : pledgeEditFields}
          record={p}
          allowDelete={isAdmin}
          onClose={() => setPanel(null)}
          onSaved={row => { if (row._deleted) { onChanged(); onClose(); } else changed(); }}
        />
      )}
    </>
  );
}

/** A dialog over the page. `size` narrows it for small forms (the default is wide). */
export function Overlay({ onClose, children, size = 'wide' }: { onClose: () => void; children: ReactNode; size?: 'wide' | 'medium' }) {
  return createPortal(
    <div className="modal-back" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className={`modal modal-${size}`}><div className="record-form">{children}<div className="dialog-foot" /></div></div>
    </div>,
    document.body,
  );
}

function PayPanel({ pledge: p, onDone, onCancel }: { pledge: Row; onDone: (m?: string) => void; onCancel: () => void }) {
  const { isAdmin } = useAuth();
  const [methods, setMethods] = useState<Option[]>([]);
  const [amount, setAmount] = useState(String(p.is_recurring ? p.next_due_amount ?? p.balance : p.balance));
  const [method, setMethod] = useState('');
  const [check, setCheck] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { paymentMethodOptions().then(setMethods); }, []);

  async function pay() {
    setBusy(true);
    setError(null);
    const { error: e } = await supabase.rpc('pay_pledge', { p_pledge: p.id, p_amount: Number(amount), p_method: method, p_check_number: check || null });
    setBusy(false);
    if (e) return setError(e.message);
    onDone(isAdmin ? `Payment of ${money(amount)} recorded.` : `Payment of ${money(amount)} is waiting for an admin to approve it. The pledge updates then.`);
  }

  return (
    <div className="panel-box">
      <div className="fields">
        <label className="field"><span>Amount *</span><input type="number" step="0.01" min="0" value={amount} onChange={e => setAmount(e.target.value)} /></label>
        <label className="field"><span>Method *</span>
          <select value={method} onChange={e => setMethod(e.target.value)}>
            <option value="">—</option>
            {methods.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </label>
        {/check/i.test(method) && <label className="field"><span>Check #</span><input value={check} onChange={e => setCheck(e.target.value)} /></label>}
      </div>
      {error && <div className="error">{error}</div>}
      <div className="form-actions">
        <div className="spacer" />
        <button type="button" className="btn" onClick={onCancel}>Back</button>
        <button type="button" className="btn primary" disabled={busy || !method || !(Number(amount) > 0)} onClick={pay}>Record payment</button>
      </div>
    </div>
  );
}

function MatchPanel({ pledge: p, schedule, onDone, onCancel }: { pledge: Row; schedule: Row[]; onDone: (m?: string) => void; onCancel: () => void }) {
  const [options, setOptions] = useState<Option[]>([]);
  const [donation, setDonation] = useState<string | null>(null);
  const [installment, setInstallment] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase.from('transaction_list').select('id, amount, donor_name, payment_method, created_at')
      .eq('campaign_id', p.campaign_id).eq('status', 'completed').eq('type', 'Payment').order('created_at', { ascending: false }).limit(500)
      .then(({ data, error: e }) => {
        if (e) return setError(e.message);
        setOptions((data ?? []).map(d => ({ value: d.id, label: `${money(d.amount)} · ${d.donor_name || 'Anonymous'} · ${d.payment_method ?? ''} · ${dateTime(d.created_at)}` })));
      });
  }, [p.campaign_id]);

  async function match() {
    setError(null);
    const { data, error: e } = await supabase.rpc('match_pledge_payment', { p_pledge: p.id, p_donation: donation, p_installment: installment || null });
    if (e) return setError(e.message);
    onDone(`${money(data)} applied to this pledge.`);
  }

  return (
    <div className="panel-box">
      <label className="field"><span>Payment on this campaign *</span>
        <SearchSelect value={donation} options={options} onChange={setDonation} placeholder="Search payments…" keepOrder />
      </label>
      {p.is_recurring && (
        <label className="field"><span>Installment</span>
          <select value={installment} onChange={e => setInstallment(e.target.value)}>
            <option value="">The next one due</option>
            {schedule.filter(i => Number(i.remaining) > 0 && !['cancelled', 'skipped'].includes(i.status)).map(i => (
              <option key={i.id} value={i.id}>#{i.seq} · {i.due_date} · {money(i.remaining)}</option>
            ))}
          </select>
        </label>
      )}
      {error && <div className="error">{error}</div>}
      <div className="form-actions">
        <div className="spacer" />
        <button type="button" className="btn" onClick={onCancel}>Back</button>
        <button type="button" className="btn primary" disabled={!donation} onClick={match}>Match</button>
      </div>
    </div>
  );
}

function ReschedulePanel({ pledge: p, onDone, onCancel }: { pledge: Row; onDone: (m?: string) => void; onCancel: () => void }) {
  const [amount, setAmount] = useState(String(p.installment_amount));
  const [frequency, setFrequency] = useState<string>(p.frequency);
  const [start, setStart] = useState<string>(p.next_due_date ?? localToday());
  const [count, setCount] = useState(p.installment_count ? String(p.installments_upcoming + p.installments_overdue) : '');
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setError(null);
    const { error: e } = await supabase.rpc('reschedule_pledge', { p_pledge: p.id, p_amount: Number(amount), p_frequency: frequency, p_start: start, p_count: count ? Number(count) : null });
    if (e) return setError(e.message);
    onDone('Schedule changed.');
  }

  return (
    <div className="panel-box">
      <p className="muted">Replaces every installment with no payment yet. Anything already paid stays.</p>
      <div className="fields">
        <label className="field"><span>Installment amount *</span><input type="number" step="0.01" min="0" value={amount} onChange={e => setAmount(e.target.value)} /></label>
        <label className="field"><span>Frequency *</span>
          <select value={frequency} onChange={e => setFrequency(e.target.value)}>
            {FREQUENCIES.map(f => <option key={f} value={f}>{label(f)}</option>)}
          </select>
        </label>
        <label className="field"><span>First new date *</span><input type="date" value={start} onChange={e => setStart(e.target.value)} /><DateNote date={start} /></label>
        <label className="field"><span>Installments left</span><input type="number" min="1" placeholder="Open-ended" value={count} onChange={e => setCount(e.target.value)} /></label>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="form-actions">
        <div className="spacer" />
        <button type="button" className="btn" onClick={onCancel}>Back</button>
        <button type="button" className="btn primary" onClick={save}>Change schedule</button>
      </div>
    </div>
  );
}
