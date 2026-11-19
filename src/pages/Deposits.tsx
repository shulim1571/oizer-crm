import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Printer } from 'lucide-react';
import DataTable, { type Column } from '../components/DataTable';
import PageTabs, { usePageTab } from '../components/PageTabs';
import { Pill } from '../components/Pill';
import SearchSelect from '../components/SearchSelect';
import { useAuth } from '../lib/auth';
import { dateTime, money } from '../lib/format';
import { activeCampaignOptions, paymentMethodNameOptions, type Option } from '../lib/lookups';
import { fetchAll, supabase, type Row } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';
import { Overlay } from './Pledges';

/*
 * Deposits (Shulim, 2026-11-19): what the inbox's readers found in deposit emails (OJC and Pledger ACH, certificate
 * submissions, bank check deposits), with suggested matches; deposit slips that group checks; and the fee review list.
 * Nothing here posts by itself: each line is matched, created or skipped by a person, then the deposit is confirmed.
 */

const KIND: Record<string, string> = { ojc_ach: 'ACH deposit', pledger_ach: 'ACH deposit', ojc_submission: 'Certificate submission',
  pledger_batch: 'Batch submission', bank_check_deposit: 'Check deposit' };
const STATUS: Record<string, [string, 'green' | 'amber' | 'red' | 'blue' | '']> = {
  to_review: ['To review', 'blue'], possible_duplicate: ['Possible duplicate', 'amber'], confirmed: ['Confirmed', 'green'], dismissed: ['Dismissed', ''],
  open: ['Open', 'blue'], matched: ['Matched', 'green'], created: ['Gift created', 'green'], skipped: ['Skipped', ''],
  deposited: ['Deposited', 'green'], applied: ['Applied', 'green'],
};
const S = ({ s }: { s: string }) => <Pill tone={STATUS[s]?.[1] ?? ''}>{STATUS[s]?.[0] ?? s}</Pill>;
const day = (d?: string | null) => (d ? new Date(`${String(d).slice(0, 10)}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—');

const TABS = [['email', 'From email'], ['slips', 'Deposit slips'], ['fees', 'Fee reviews']] as const;

export default function DepositsPage() {
  const [tab, setTab] = usePageTab(TABS.map(([k]) => k));
  return (
    <section className="view">
      <PageTabs tabs={TABS} value={tab} onChange={setTab} />
      {tab === 'email' && <FromEmail />}
      {tab === 'slips' && <Slips />}
      {tab === 'fees' && <FeeReviews />}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Deposits read from email
// ---------------------------------------------------------------------------------------------------------------
function FromEmail() {
  const [params, setParams] = useSearchParams();
  const [show, setShow] = useState<'review' | 'all'>('review');
  const [version, setVersion] = useState(0);
  const q = useQuery(() => fetchAll((a, b) => supabase.from('deposits').select('*').order('created_at', { ascending: false }).order('id').range(a, b) as never), [version]);
  const all = (q.data as Row[]) ?? [];
  const rows = useMemo(() => (show === 'all' ? all : all.filter(r => ['to_review', 'possible_duplicate'].includes(r.status))), [all, show]);
  const columns: Column[] = [
    { key: 'created_at', label: 'Read', render: r => dateTime(r.created_at) },
    { key: 'issuer', label: 'From', value: r => `${r.issuer} · ${KIND[r.kind] ?? r.kind}` },
    { key: 'issuer_ref', label: 'Reference' },
    { key: 'deposit_date', label: 'Date', render: r => day(r.deposit_date), value: r => r.deposit_date ?? '' },
    { key: 'net', label: 'Amount', align: 'right', render: r => (r.net != null ? money(r.net) : r.gross != null ? money(r.gross) : '—'), value: r => Number(r.net ?? r.gross ?? 0) },
    { key: 'status', label: 'Status', render: r => <S s={r.status} />, value: r => r.status },
  ];
  const id = params.get('deposit');
  return (
    <>
      <DataTable title="Deposits from email" rows={rows} loading={q.loading} error={q.error} columns={columns} exportName="deposits"
        initialSort={{ key: 'created_at', dir: 'desc' }} onOpen={r => setParams(p => { p.set('deposit', String(r.id)); return p; })}
        subtitle="Read from deposit emails in the Email Inbox. Each line is matched, created or skipped by you; nothing is recorded until you confirm."
        actions={<select aria-label="Show" value={show} onChange={e => setShow(e.target.value as typeof show)}>
          <option value="review">To review</option><option value="all">All</option></select>} />
      {id && <DepositView id={id} onClose={() => setParams(p => { p.delete('deposit'); return p; })} onChanged={() => setVersion(v => v + 1)} />}
    </>
  );
}

export function DepositView({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const [version, setVersion] = useState(0);
  const q = useQuery(async () => {
    const d = (await supabase.from('deposits').select('*').eq('id', id).maybeSingle()).data as Row | null;
    if (!d) return null;
    const [lines, slip, bank, voucher] = await Promise.all([
      supabase.from('deposit_lines').select('*').eq('deposit_id', id).order('line_no'),
      d.suggested_slip ? supabase.from('deposit_slips').select('*').eq('id', d.suggested_slip).maybeSingle() : Promise.resolve({ data: null }),
      d.suggested_bank_line ? supabase.from('bank_lines').select('id, posted_date, amount, description').eq('id', d.suggested_bank_line).maybeSingle() : Promise.resolve({ data: null }),
      d.suggested_voucher ? supabase.from('vouchers').select('id, issuer, issuer_number, face_value').eq('id', d.suggested_voucher).maybeSingle() : Promise.resolve({ data: null }),
    ]);
    const ls = (lines.data ?? []) as Row[];
    const vlIds = ls.map(l => l.suggested_voucher_line).filter(Boolean);
    const donIds = ls.map(l => l.suggested_donation).concat(ls.map(l => l.donation_id)).filter(Boolean);
    const [vls, dons] = await Promise.all([
      vlIds.length ? supabase.from('voucher_lines').select('id, voucher_id, cert_number, amount, status').in('id', vlIds) : Promise.resolve({ data: [] }),
      donIds.length ? supabase.from('donations').select('id, amount, fee, payment_method, campaign_id, created_at, card_last4').in('id', donIds) : Promise.resolve({ data: [] }),
    ]);
    return { d, lines: ls, slip: slip.data as Row | null, bank: bank.data as Row | null, voucher: voucher.data as Row | null,
             vls: new Map(((vls.data ?? []) as Row[]).map(r => [String(r.id), r])), dons: new Map(((dons.data ?? []) as Row[]).map(r => [String(r.id), r])) };
  }, [id, version]);
  const [error, setError] = useState<string | null>(null);
  const [campaigns, setCampaigns] = useState<Option[]>([]);
  const [methods, setMethods] = useState<Option[]>([]);
  useEffect(() => { void activeCampaignOptions().then(setCampaigns); void paymentMethodNameOptions().then(setMethods); }, []);
  const refresh = () => { setVersion(v => v + 1); onChanged(); window.dispatchEvent(new Event('task-sheet-changed')); };
  async function call(fn: string, args: Row) {
    setError(null);
    const { error: e } = await supabase.rpc(fn, args);
    if (e) { setError(e.message); return false; }
    refresh();
    return true;
  }
  const data = q.data;
  if (q.loading && !data) return <Overlay onClose={onClose}><p className="muted">Loading…</p></Overlay>;
  if (!data) return <Overlay onClose={onClose}><p className="muted">This deposit isn't here.</p></Overlay>;
  const { d, lines } = data;
  const open = ['to_review', 'possible_duplicate'].includes(d.status);
  const submission = ['ojc_submission', 'pledger_batch'].includes(d.kind);
  return (
    <Overlay onClose={onClose}>
      <div className="form-head"><h2>{d.issuer} {KIND[d.kind] ?? d.kind}{d.issuer_ref ? ` ${d.issuer_ref}` : ''}</h2></div>
      <dl className="record-facts">
        <dt>Status</dt><dd><S s={d.status} />{d.duplicate_of ? <span className="muted small"> · looks like a deposit read before</span> : null}</dd>
        <dt>Date</dt><dd>{day(d.deposit_date)}</dd>
        {d.gross != null && <><dt>Gross</dt><dd>{money(d.gross)}</dd></>}
        {d.fees != null && <><dt>Fees</dt><dd>{money(d.fees)}</dd></>}
        {d.net != null && <><dt>Net</dt><dd>{money(d.net)}</dd></>}
        {d.account_last4 && <><dt>Bank account</dt><dd>ending {d.account_last4}</dd></>}
        {d.read_notes && <><dt>Couldn't read</dt><dd>{d.read_notes}</dd></>}
        {d.email_id && <><dt>Email</dt><dd><Link to={`/email-inbox?email=${encodeURIComponent(d.email_id)}`}>Open the email</Link></dd></>}
      </dl>
      {d.kind === 'bank_check_deposit' && (
        <p className="small">{data.slip
          ? <>Suggested deposit slip: <b>{day(data.slip.slip_date)}</b> · {data.slip.check_count} checks · {money(data.slip.total)} {data.slip.status === 'deposited' ? '(already deposited)' : ''}</>
          : <>No open deposit slip with this total. Make one on Transactions (tick the checks, then "Make deposit slip"), or confirm without one.</>}</p>
      )}
      {data.bank && <p className="small">Suggested bank line: {day(data.bank.posted_date)} · {money(data.bank.amount)} · {data.bank.description}. Match it on <Link to="/reconciliation">Bank Reconciliation</Link>.</p>}
      {submission && (
        <div className="donation-actions">
          <span className="small">Voucher batch: {data.voucher ? <b>{data.voucher.issuer} {data.voucher.issuer_number ?? ''} · {money(data.voucher.face_value)}</b> : <span className="muted">none found with this batch number</span>}</span>
          {open && <VoucherPicker onPick={v => void call('deposit_set_voucher', { p_deposit: id, p_voucher: v })} />}
        </div>
      )}
      {lines.length > 0 && (
        <table className="mini deposit-lines">
          <thead><tr><th>#</th><th>Kind</th><th>Reference</th><th>Date</th><th>Donor</th><th className="right">Amount</th><th className="right">Fee</th><th>Suggestion</th><th>Status</th><th /></tr></thead>
          <tbody>
            {lines.map(l => {
              const vl = l.suggested_voucher_line ? data.vls.get(String(l.suggested_voucher_line)) : null;
              const don = data.dons.get(String(l.donation_id ?? l.suggested_donation ?? ''));
              return (
                <tr key={l.id}>
                  <td>{l.line_no}</td>
                  <td>{l.kind}{l.card_last4 ? ` ···${l.card_last4}` : ''}{l.trans_type ? <div className="muted small">{l.trans_type}</div> : null}</td>
                  <td>{l.ref ?? '—'}</td>
                  <td>{day(l.line_date)}</td>
                  <td>{l.donor_name ?? (l.donor_account ? `Acct ${l.donor_account}` : '—')}</td>
                  <td className="right">{l.amount != null ? money(l.amount) : '—'}</td>
                  <td className="right">{l.fee != null ? money(l.fee) : '—'}</td>
                  <td className="small">
                    {submission ? (l.cert_status ?? '—')
                      : vl ? <>Certificate {vl.cert_number} · {money(vl.amount)}{vl.status === 'funded' ? ' (already funded)' : ''}</>
                      : don ? <>Gift {don.id} · {money(don.amount)} · {day(don.created_at)}{don.fee != null && l.fee != null && Number(don.fee) !== Number(l.fee) ? <div className="muted">fee differs: {money(don.fee)} recorded</div> : null}</>
                      : l.candidates > 1 ? <span className="muted">{l.candidates} gifts could fit; pick one</span>
                      : <span className="muted">No match found</span>}
                  </td>
                  <td><S s={l.outcome} /></td>
                  <td>{open && <LineActions line={l} hasSuggestion={!!(vl || l.suggested_donation)} submission={submission} campaigns={campaigns} methods={methods}
                    defaultMethod={d.issuer} onAct={(action, extra) => void call('deposit_line_decide', { p_line: l.id, p_action: action, ...extra })} />}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {error && <div className="error">{error}</div>}
      {open && (
        <div className="donation-actions">
          <button type="button" className="btn primary" onClick={() => {
            const what = d.kind === 'bank_check_deposit' ? (data.slip ? 'mark the suggested slip deposited' : 'record it as reviewed')
              : submission ? 'record these certificates under the voucher batch'
              : 'fund the matched certificates through their voucher batches and keep the matches';
            if (confirm(`Confirm this deposit? This will ${what}. Fee differences stay on the fee review list until someone decides them.`)) void call('deposit_decide', { p_deposit: id, p_action: 'confirm' });
          }}>Confirm deposit</button>
          {d.status === 'possible_duplicate' && <button type="button" className="btn" onClick={() => void call('deposit_decide', { p_deposit: id, p_action: 'not_duplicate' })}>Not a duplicate</button>}
          <button type="button" className="btn" onClick={() => { if (confirm('Dismiss this deposit? Nothing is recorded from it.')) void call('deposit_decide', { p_deposit: id, p_action: 'dismiss' }); }}>Dismiss</button>
        </div>
      )}
      <p className="muted small">Nothing is recorded until you confirm. A fee in the report that differs from a gift's fee goes to Fee reviews; the method's fee stays until someone applies it.</p>
    </Overlay>
  );
}

function LineActions({ line, hasSuggestion, submission, campaigns, methods, defaultMethod, onAct }: {
  line: Row; hasSuggestion: boolean; submission: boolean; campaigns: Option[]; methods: Option[]; defaultMethod: string;
  onAct: (action: string, extra?: Row) => void;
}) {
  const [mode, setMode] = useState<'none' | 'pick' | 'create'>('none');
  const [target, setTarget] = useState('');
  const [campaign, setCampaign] = useState<string | null>(null);
  const [method, setMethod] = useState<string>(methods.some(m => m.value === defaultMethod) ? defaultMethod : '');
  if (line.outcome !== 'open') return <button type="button" className="link" onClick={() => onAct('reopen')}>Undo</button>;
  if (submission) return <button type="button" className="link" onClick={() => onAct('skip')}>Leave out</button>;
  return (
    <div className="line-actions">
      {hasSuggestion && <button type="button" className="btn small" onClick={() => onAct('match')}>Match</button>}
      <button type="button" className="link" onClick={() => setMode(mode === 'pick' ? 'none' : 'pick')}>{line.kind === 'certificate' ? 'Other certificate' : 'Other gift'}</button>
      {line.kind !== 'certificate' && <button type="button" className="link" onClick={() => setMode(mode === 'create' ? 'none' : 'create')}>Create gift</button>}
      <button type="button" className="link" onClick={() => onAct('skip')}>Skip</button>
      {mode === 'pick' && (
        <div className="line-form">
          <input value={target} onChange={e => setTarget(e.target.value)} placeholder={line.kind === 'certificate' ? 'Certificate line ID' : 'Transaction ID'} aria-label="ID to match" />
          <button type="button" className="btn small" disabled={!target.trim()} onClick={() => onAct('match', { p_target: target.trim() })}>Match</button>
        </div>
      )}
      {mode === 'create' && (
        <div className="line-form">
          <div className="pick"><SearchSelect value={campaign} options={campaigns} placeholder="Campaign" onChange={setCampaign} /></div>
          <select aria-label="Payment method" value={method} onChange={e => setMethod(e.target.value)}>
            <option value="">Method: {defaultMethod}</option>
            {methods.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
          <button type="button" className="btn small" disabled={!campaign} onClick={() => onAct('create', { p_campaign: campaign, p_method: method || null })}>Create</button>
          <span className="muted small">With the donor from the report (found by their account number or name, or added).</span>
        </div>
      )}
    </div>
  );
}

function VoucherPicker({ onPick }: { onPick: (id: string) => void }) {
  const q = useQuery(async () => ((await supabase.from('vouchers').select('id, issuer, issuer_number, face_value').is('deleted_at', null).is('cancelled_at', null)
    .order('created_at', { ascending: false }).limit(200)).data ?? []) as Row[], []);
  const options = ((q.data as Row[]) ?? []).map(v => ({ value: String(v.id), label: `${v.issuer} ${v.issuer_number ?? ''} · ${money(v.face_value)}` }));
  return <div className="pick"><SearchSelect value={null} options={options} placeholder="Choose the voucher batch" onChange={v => v && onPick(v)} /></div>;
}

// ---------------------------------------------------------------------------------------------------------------
// Deposit slips
// ---------------------------------------------------------------------------------------------------------------
function Slips() {
  const [open, setOpen] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const q = useQuery(() => fetchAll((a, b) => supabase.from('deposit_slips').select('*').order('slip_date', { ascending: false }).order('id').range(a, b) as never), [version]);
  const columns: Column[] = [
    { key: 'slip_date', label: 'Date', render: r => day(r.slip_date), value: r => r.slip_date },
    { key: 'check_count', label: 'Checks', align: 'right' },
    { key: 'total', label: 'Total', align: 'right', render: r => money(r.total), value: r => Number(r.total) },
    { key: 'status', label: 'Status', render: r => <S s={r.status} />, value: r => r.status },
    { key: 'created_by', label: 'Made by' },
  ];
  return (
    <>
      <DataTable title="Deposit slips" rows={(q.data as Row[]) ?? []} loading={q.loading} error={q.error} columns={columns} exportName="deposit-slips"
        subtitle={'Make a slip on Transactions: tick the checks you\'re depositing, then "Make deposit slip". A bank\'s check-deposit email is then matched to the slip with the same total.'}
        onOpen={r => setOpen(String(r.id))} />
      {open && <SlipView id={open} onClose={() => setOpen(null)} onChanged={() => setVersion(v => v + 1)} />}
    </>
  );
}

function SlipView({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const [version, setVersion] = useState(0);
  const { org } = useAuth();
  const q = useQuery(async () => {
    const [s, d] = await Promise.all([
      supabase.from('deposit_slips').select('*').eq('id', id).maybeSingle(),
      supabase.from('donations').select('id, amount, check_number, name, donor_id, created_at, donors(display_name)').eq('deposit_slip_id', id).order('created_at'),
    ]);
    return { slip: s.data as Row | null, checks: (d.data ?? []) as Row[] };
  }, [id, version]);
  const [error, setError] = useState<string | null>(null);
  const slip = q.data?.slip;
  async function remove(donation: string) {
    if (!confirm('Take this check off the slip?')) return;
    const { error: e } = await supabase.rpc('remove_from_deposit_slip', { p_donation: donation });
    if (e) return setError(e.message);
    setVersion(v => v + 1); onChanged();
  }
  function print() {
    const rows = (q.data?.checks ?? []).map((c, i) => `<tr><td>${i + 1}</td><td>${esc(c.check_number ?? '')}</td><td>${esc(c.donors?.display_name ?? c.name ?? '')}</td><td style="text-align:right">${money(c.amount)}</td></tr>`).join('');
    const w = window.open('', '_blank');
    if (!w) return;
    w.document.write(`<!doctype html><title>Deposit slip</title><style>body{font-family:Arial;margin:32px}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ccc;padding:6px;text-align:left}</style>
      <h2>${esc(org?.name ?? '')} · Deposit slip</h2><p>${day(slip?.slip_date)} · ${slip?.check_count} checks · <b>${money(slip?.total)}</b></p>
      <table><tr><th>#</th><th>Check #</th><th>From</th><th style="text-align:right">Amount</th></tr>${rows}
      <tr><td colspan="3"><b>Total</b></td><td style="text-align:right"><b>${money(slip?.total)}</b></td></tr></table>`);
    w.document.close(); w.focus(); w.print();
  }
  return (
    <Overlay onClose={onClose} size="medium">
      {!slip ? <p className="muted">Loading…</p> : (
        <>
          <div className="form-head"><h2>Deposit slip · {day(slip.slip_date)}</h2></div>
          <p>{slip.check_count} checks · <b>{money(slip.total)}</b> · <S s={slip.status} /></p>
          <table className="mini">
            <thead><tr><th>Check #</th><th>From</th><th className="right">Amount</th><th /></tr></thead>
            <tbody>{(q.data?.checks ?? []).map(c => (
              <tr key={c.id}><td>{c.check_number ?? '—'}</td><td>{c.donors?.display_name ?? c.name ?? '—'}</td><td className="right">{money(c.amount)}</td>
                <td>{slip.status === 'open' && <button type="button" className="link" onClick={() => void remove(String(c.id))}>Take off</button>}</td></tr>
            ))}</tbody>
          </table>
          {error && <div className="error">{error}</div>}
          <div className="donation-actions"><button type="button" className="btn" onClick={print}><Printer size={15} /> Print slip</button></div>
        </>
      )}
    </Overlay>
  );
}
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

// ---------------------------------------------------------------------------------------------------------------
// Fee reviews
// ---------------------------------------------------------------------------------------------------------------
export function FeeReviewActions({ review, onDone }: { review: Row; onDone: () => void }) {
  const { permissions } = useAuth();
  const [error, setError] = useState<string | null>(null);
  if (!permissions.includes('configure_fees')) return <span className="muted small">An admin who can change fees decides this.</span>;
  async function decide(action: 'apply' | 'dismiss') {
    const q = action === 'apply'
      ? `Use ${money(review.reported_fee)} as this gift's fee? It's kept as the gift's fee from now on.`
      : `Keep the recorded fee (${review.recorded_fee != null ? money(review.recorded_fee) : 'none'})?`;
    if (!confirm(q)) return;
    const { error: e } = await supabase.rpc('fee_review_decide', { p_review: review.id, p_action: action });
    if (e) return setError(e.message);
    window.dispatchEvent(new Event('task-sheet-changed'));
    onDone();
  }
  return (
    <span className="line-actions">
      <button type="button" className="btn small primary" onClick={() => void decide('apply')}>Use {money(review.reported_fee)}</button>
      <button type="button" className="btn small" onClick={() => void decide('dismiss')}>Keep recorded</button>
      {error && <span className="error small">{error}</span>}
    </span>
  );
}

function FeeReviews() {
  const [show, setShow] = useState<'open' | 'all'>('open');
  const [version, setVersion] = useState(0);
  const [peek, setPeek] = useState<string | null>(null);
  const q = useQuery(() => fetchAll((a, b) => supabase.from('fee_reviews').select('*').order('created_at', { ascending: false }).order('id').range(a, b) as never), [version]);
  const rows = ((q.data as Row[]) ?? []).filter(r => show === 'all' || r.status === 'open');
  const columns: Column[] = [
    { key: 'created_at', label: 'Found', render: r => dateTime(r.created_at) },
    { key: 'donation_id', label: 'Gift', render: r => <button type="button" className="link" onClick={e => { e.stopPropagation(); setPeek(String(r.donation_id)); }}>{r.donation_id}</button> },
    { key: 'recorded_fee', label: 'Recorded fee', align: 'right', render: r => (r.recorded_fee != null ? money(r.recorded_fee) : 'none') },
    { key: 'reported_fee', label: 'Report says', align: 'right', render: r => money(r.reported_fee) },
    { key: 'source', label: 'From' },
    { key: 'status', label: 'Status', render: r => (r.status === 'open' ? <FeeReviewActions review={r} onDone={() => setVersion(v => v + 1)} /> : <S s={r.status} />), value: r => r.status },
  ];
  return (
    <>
    {peek && <GiftPeek id={peek} onClose={() => setPeek(null)} />}
    <DataTable title="Fee reviews" rows={rows} loading={q.loading} error={q.error} columns={columns} exportName="fee-reviews"
      subtitle="A deposit report showed a different fee than the one recorded (the payment method's). Nothing changes until someone decides."
      actions={<select aria-label="Show" value={show} onChange={e => setShow(e.target.value as typeof show)}><option value="open">Waiting</option><option value="all">All</option></select>} />
    </>
  );
}

/** A gift's main details, to check a fee review against. */
function GiftPeek({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useQuery(async () => (await supabase.from('donations').select('id, amount, fee, payment_method, campaign_id, created_at, card_last4, status, name, donors(display_name), campaigns(internal_name, campaign_name)')
    .eq('id', id).maybeSingle()).data as Row | null, [id]);
  const g = q.data as Row | null;
  return (
    <Overlay onClose={onClose} size="medium">
      {!g ? <p className="muted">{q.loading ? 'Loading…' : 'This gift isn\'t here.'}</p> : (
        <>
          <div className="form-head"><h2>Gift {g.id}</h2></div>
          <dl className="record-facts">
            <dt>Amount</dt><dd>{money(g.amount)}</dd>
            <dt>Fee</dt><dd>{g.fee != null ? money(g.fee) : 'none'}</dd>
            <dt>Method</dt><dd>{g.payment_method ?? '—'}{g.card_last4 ? ` · card ending ${g.card_last4}` : ''}</dd>
            <dt>Campaign</dt><dd>{g.campaigns?.internal_name ?? g.campaigns?.campaign_name ?? g.campaign_id ?? '—'}</dd>
            <dt>Donor</dt><dd>{g.donors?.display_name ?? g.name ?? '—'}</dd>
            <dt>Date</dt><dd>{dateTime(g.created_at)}</dd>
            <dt>Status</dt><dd>{g.status}</dd>
          </dl>
        </>
      )}
    </Overlay>
  );
}
