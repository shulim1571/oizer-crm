import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, TriangleAlert, X } from 'lucide-react';
import DataTable, { type Column } from '../components/DataTable';
import DateNote from '../components/DateNote';
import SearchSelect from '../components/SearchSelect';
import { Pill } from '../components/Pill';
import { useAuth } from '../lib/auth';
import { dateTime, localToday, money } from '../lib/format';
import { accountOptions, campaignOptions, clearLookups, payeeOptions, payoutMethodOptions, type Option } from '../lib/lookups';
import { fetchAll, supabase, type Row } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';
import { Overlay } from './Pledges';

type Act = (call: PromiseLike<{ error: { message: string } | null }>, action: string, note?: string | null) => void;

/** Processed, or waiting for its date. */
export const payoutStatus = (r: Row) => (r.processed_at ? 'Processed' : r.scheduled_for ? `Scheduled for ${r.scheduled_for}` : 'Processed');
export const PayoutStatusPill = ({ row }: { row: Row }) => <Pill tone={row.processed_at ? 'green' : 'blue'}>{payoutStatus(row)}</Pill>;

const REQUEST_STATUS: Record<string, { label: string; tone: 'green' | 'red' | 'amber' | 'blue' | '' }> = {
  pending: { label: 'Waiting', tone: 'blue' },
  approved: { label: 'Approved', tone: 'green' },
  rejected: { label: 'Rejected', tone: 'red' },
  withdrawn: { label: 'Withdrawn', tone: '' },
};
const RequestPill = ({ status }: { status: string }) => <Pill tone={REQUEST_STATUS[status]?.tone ?? ''}>{REQUEST_STATUS[status]?.label ?? status}</Pill>;
const amountText = (r: Row) => (r.full_balance ? 'Full balance' : money(r.amount));

async function campaignBalance(id: string) {
  const { data } = await supabase.from('campaign_summary').select('balance').eq('id', id).maybeSingle();
  return data ? Number(data.balance) : null;
}

// ---------------------------------------------------------------------------
// Fundraisers ask; the office pays
// ---------------------------------------------------------------------------
export function RequestPayoutDialog({ campaignId, onClose, onSaved }: { campaignId?: string; onClose: () => void; onSaved: () => void }) {
  const [campaign, setCampaign] = useState<string | null>(campaignId ?? null);
  const [campaigns, setCampaigns] = useState<Option[]>([]);
  const [methods, setMethods] = useState<Option[]>([]);
  const [balance, setBalance] = useState<number | null>(null);
  const [full, setFull] = useState(false);
  const [amount, setAmount] = useState('');
  const [recipient, setRecipient] = useState('');
  const [payee, setPayee] = useState<Row | null>(null);
  const [matches, setMatches] = useState<Row[]>([]);
  const [method, setMethod] = useState('');
  const [bank, setBank] = useState('');
  const [accountType, setAccountType] = useState('checking');
  const [routing, setRouting] = useState('');
  const [account, setAccount] = useState('');
  const [zelle, setZelle] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    campaignOptions().then(setCampaigns);
    // Cash and expenses on a card are the office's own, not something to ask for.
    payoutMethodOptions().then(all => setMethods(all.filter(m => m.value !== 'Credit Card')));
  }, []);
  useEffect(() => { setBalance(null); if (campaign) campaignBalance(campaign).then(setBalance); }, [campaign]);
  useEffect(() => {
    if (payee || recipient.trim().length < 2) return setMatches([]);
    const t = setTimeout(() => supabase.rpc('lookup_payees', { p_q: recipient }).then(({ data }) => setMatches((data ?? []) as Row[])), 200);
    return () => clearTimeout(t);
  }, [recipient, payee]);

  const n = Number(amount);
  async function submit() {
    setError(null);
    setSaving(true);
    const { error: e } = await supabase.rpc('request_payout', {
      p_campaign: campaign, p_amount: full ? null : n, p_full_balance: full, p_recipient: payee?.name ?? recipient, p_method: method,
      p_payee: payee?.id ?? null, p_bank_name: bank || null, p_account_type: method === 'ACH' ? accountType : null,
      p_routing: routing || null, p_account: account || null, p_zelle: zelle || null, p_notes: notes || null,
    });
    setSaving(false);
    if (e) return setError(e.message);
    onSaved();
  }

  return (
    <Overlay onClose={onClose}>
      <div className="form-head"><h2>Request a payout</h2><button type="button" className="icon-btn" title="Close" onClick={onClose}><X size={18} /></button></div>
      <label className="field"><span>Campaign *</span>
        <SearchSelect value={campaign} options={campaigns} onChange={setCampaign} placeholder="Which campaign it's from…" required />
      </label>
      {balance != null && <p className="muted small">Balance now {money(balance)}</p>}
      <div className="fields">
        <label className="field"><span>Amount *</span>
          <input type="number" step="0.01" min="0" disabled={full} value={full ? '' : amount} onChange={e => setAmount(e.target.value)} placeholder={full ? 'The full balance when paid' : ''} />
        </label>
        <label className="field check"><input type="checkbox" checked={full} onChange={e => setFull(e.target.checked)} /><span>Full balance</span></label>
      </div>
      {!full && balance != null && n > balance && (
        <p className="date-note"><TriangleAlert size={14} /> This is more than the balance and would leave it at {money(balance - n)}. The office can still approve it.</p>
      )}
      <label className="field"><span>Recipient *</span>
        {payee ? (
          <div className="chosen">{payee.name} <button type="button" className="link" onClick={() => { setPayee(null); setRecipient(''); }}>Change</button></div>
        ) : (
          <input value={recipient} onChange={e => setRecipient(e.target.value)} placeholder="Search payees, or type a new name" />
        )}
      </label>
      {!payee && matches.length > 0 && (
        <div className="lookup-results">
          {matches.map(m => <button type="button" key={m.id} onClick={() => { setPayee(m); setMatches([]); }}><b>{m.name}</b> <span className="muted small">#{m.id}</span></button>)}
        </div>
      )}
      <label className="field"><span>Preferred payout method *</span>
        <select value={method} onChange={e => setMethod(e.target.value)}>
          <option value="">Choose…</option>
          {methods.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
      </label>
      {method === 'ACH' && (
        <div className="panel-box">
          <div className="fields">
            <label className="field"><span>Bank name *</span><input value={bank} onChange={e => setBank(e.target.value)} /></label>
            <label className="field"><span>Account type *</span>
              <select value={accountType} onChange={e => setAccountType(e.target.value)}><option value="checking">Checking</option><option value="savings">Savings</option></select>
            </label>
            <label className="field"><span>Routing number *</span><input inputMode="numeric" autoComplete="off" value={routing} onChange={e => setRouting(e.target.value)} /></label>
            <label className="field"><span>Account number *</span><input inputMode="numeric" autoComplete="off" value={account} onChange={e => setAccount(e.target.value)} /></label>
          </div>
          <p className="muted small">Stored encrypted. Only the office can see the full numbers.</p>
        </div>
      )}
      {method === 'Zelle' && (
        <label className="field"><span>Recipient's Zelle phone or email *</span><input autoComplete="off" value={zelle} onChange={e => setZelle(e.target.value)} /></label>
      )}
      <label className="field"><span>Notes or reason</span><textarea rows={2} value={notes} onChange={e => setNotes(e.target.value)} /></label>
      {error && <div className="error">{error}</div>}
      <div className="form-actions">
        <div className="spacer" />
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" disabled={saving || !campaign || !method || !(payee || recipient.trim()) || (!full && !(n > 0))} onClick={submit}>Submit request</button>
      </div>
    </Overlay>
  );
}

// ---------------------------------------------------------------------------
// Approving: used from the requests page and the Task Sheet
// ---------------------------------------------------------------------------
export function ApprovePayout({ requestId, onAct }: { requestId: string; onAct: Act }) {
  const q = useQuery(async () => {
    const { data, error } = await supabase.from('payout_requests').select('*, campaigns(internal_name, external_name, campaign_name)').eq('id', requestId).maybeSingle();
    if (error) throw new Error(error.message);
    return data as Row | null;
  }, [requestId]);
  const r = q.data as Row | null;
  const [payees, setPayees] = useState<Option[]>([]);
  const [methods, setMethods] = useState<Option[]>([]);
  const [accounts, setAccounts] = useState<Option[]>([]);
  const [payee, setPayee] = useState<string | null>(null);
  const [method, setMethod] = useState('');
  const [amount, setAmount] = useState('');
  const [account, setAccount] = useState('');
  const [date, setDate] = useState(localToday());
  const [reference, setReference] = useState('');
  const [checkNumber, setCheckNumber] = useState('');
  const [memo, setMemo] = useState('');
  const [balance, setBalance] = useState<number | null>(null);
  const [flag, setFlag] = useState<Row | null>(null);
  const [details, setDetails] = useState<Row | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { defaultAccountId } = useAuth();

  useEffect(() => {
    payeeOptions().then(setPayees);
    payoutMethodOptions().then(setMethods);
    accountOptions().then(setAccounts);
  }, []);
  useEffect(() => {
    if (!r) return;
    setPayee(r.payee_id);
    setMethod(r.method);
    setAmount(r.amount ?? '');
    setAccount(defaultAccountId ?? '');
    setMemo(r.campaign_id ?? '');   // the check memo defaults to the campaign ID (Moshe Henig, 2026-11-11); editable
    campaignBalance(r.campaign_id).then(b => { setBalance(b); if (r.full_balance && b != null) setAmount(b.toFixed(2)); });
  }, [r, defaultAccountId]);
  // Opening a request shows the full payee and bank details to the organization's admins (Moshe Henig, 2026-11-11).
  // The database decides who may see them and logs every reveal; anyone else keeps the masked view below.
  useEffect(() => {
    setDetails(null);
    if (!r || !(r.method === 'ACH' || r.method === 'Zelle')) return;
    let live = true;
    supabase.rpc('payout_request_details', { p_request: requestId }).then(({ data, error: e }) => {
      if (!live) return;
      setDetails(e ? { _denied: true } : (((data ?? []) as Row[])[0] ?? {}));
    });
    return () => { live = false; };
  }, [r?.id, r?.method, requestId]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setFlag(null);
    if (payee) supabase.from('payee_flags').select('*').eq('payee_id', payee).maybeSingle().then(({ data }) => setFlag(data));
  }, [payee]);

  if (!r) return null;
  const n = Number(amount);
  const full = !!details && !details._denied;
  const later = date > localToday();

  return (
    <div className="panel-box">
      <dl className="record-facts">
        <dt>Asked for</dt><dd>{amountText(r)}{r.full_balance && balance != null && ` (now ${money(balance)})`}</dd>
        <dt>Payee</dt><dd><b>{r.recipient_name}</b>{details?.payee_name && details.payee_name !== r.recipient_name && <span className="muted"> (payee on file: {details.payee_name})</span>}</dd>
        <dt>Method</dt><dd>{r.method}</dd>
        {r.method === 'ACH' && (full ? <>
          <dt>Bank</dt><dd>{details!.bank_name ?? r.bank_name}{(details!.account_type ?? r.account_type) && ` · ${details!.account_type ?? r.account_type}`}</dd>
          <dt>Routing number</dt><dd className="num">{details!.routing ?? '—'}</dd>
          <dt>Account number</dt><dd className="num">{details!.account ?? '—'}</dd>
        </> : <><dt>Bank</dt><dd>{r.bank_name} · {r.account_type} · routing ending {r.routing_last4} · account ending {r.account_last4}</dd></>)}
        {r.method === 'Zelle' && <><dt>Zelle</dt><dd>{full ? (details!.zelle ?? '—') : r.zelle_hint}</dd></>}
        {full && <><dt /><dd className="muted small">Full details are shown to admins only, and each view is recorded in the activity log.</dd></>}
        {r.notes && <><dt>Notes</dt><dd className="pre-line">{r.notes}</dd></>}
        {balance != null && <><dt>Balance</dt><dd>{money(balance)}</dd></>}
      </dl>
      {flag && <div className="error"><b>Do Not Pay.</b> {flag.reason ?? 'No reason given.'} You can still approve this if it's right.</div>}
      {balance != null && n > balance && <p className="date-note"><TriangleAlert size={14} /> Paying this leaves the balance at {money(balance - n)}.</p>}
      <div className="fields">
        <label className="field"><span>Payee</span>
          <SearchSelect value={payee} options={payees} onChange={setPayee} placeholder={`New payee: ${r.recipient_name}`} />
        </label>
        <label className="field"><span>Method</span>
          <select value={method} onChange={e => setMethod(e.target.value)}>{methods.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}</select>
        </label>
        <label className="field"><span>Amount</span><input type="number" step="0.01" min="0" value={amount} onChange={e => setAmount(e.target.value)} /></label>
        <label className="field"><span>Bank account</span>
          <select value={account} onChange={e => setAccount(e.target.value)}><option value="">None</option>{accounts.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}</select>
        </label>
        <label className="field"><span>Process on</span>
          <input type="date" value={date} min={localToday()} onChange={e => setDate(e.target.value)} />
          <DateNote date={date} />
        </label>
        <label className="field"><span>Reference</span><input value={reference} onChange={e => setReference(e.target.value)} placeholder="Confirmation or reference number" /></label>
        {method === 'Check' && <label className="field"><span>Check number</span><input value={checkNumber} onChange={e => setCheckNumber(e.target.value)} /></label>}
        <label className="field"><span>Memo</span><input value={memo} onChange={e => setMemo(e.target.value)} /></label>
      </div>
      {later && <p className="muted small">Scheduled: it leaves the balance now, and comes back to the Task Sheet on {date} to be paid.</p>}
      {error && <div className="error">{error}</div>}
      <div className="form-actions">
        <button type="button" className="btn danger" onClick={() => {
          const note = prompt('Reject this request? Add a note for the fundraiser if useful. It is also kept on the payee\'s profile:');
          if (note !== null) onAct(supabase.rpc('reject_payout_request', { p_request: requestId, p_note: note || null }), 'rejected', note);
        }}>Reject</button>
        <div className="spacer" />
        <button type="button" className="btn primary" disabled={!(n > 0)} onClick={() => onAct(supabase.rpc('approve_payout_request', {
          p_request: requestId, p_payee: payee, p_method: method, p_amount: n, p_account: account || null,
          p_scheduled_for: later ? date : null, p_reference: reference || null, p_memo: memo || null, p_check_number: checkNumber || null,
        }), later ? 'scheduled' : 'approved')}>{later ? 'Approve and schedule' : 'Approve, paid now'}</button>
      </div>
    </div>
  );
}

/** A scheduled payout whose day has come. */
export function ProcessScheduled({ payoutId, onAct }: { payoutId: string; onAct: Act }) {
  const [reference, setReference] = useState('');
  return (
    <div className="panel-box">
      <label className="field"><span>Reference</span><input value={reference} onChange={e => setReference(e.target.value)} placeholder="Confirmation or reference number, if any" /></label>
      <p className="muted small">To change the date or cancel it, open the payout from <Link to="/expenses">Payouts</Link>. Cancelling gives the balance back.</p>
      <div className="form-actions"><div className="spacer" />
        <button type="button" className="btn primary" onClick={() => onAct(supabase.rpc('process_scheduled_payout', { p_payout: payoutId, p_reference: reference || null }), 'processed', reference)}>Mark as paid</button>
      </div>
    </div>
  );
}

export function PayoutRequestsPage() {
  const { isAdmin } = useAuth();
  const [version, setVersion] = useState(0);
  const [asking, setAsking] = useState(false);
  const [open, setOpen] = useState<Row | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const q = useQuery(
    () => fetchAll((a, b) => supabase.from('payout_requests').select('*, campaigns(internal_name, external_name, campaign_name)').order('created_at', { ascending: false }).range(a, b) as never),
    [version],
  );
  const rows = ((q.data as Row[]) ?? []).filter(r => showAll || r.status === 'pending');
  const refresh = () => { setVersion(v => v + 1); clearLookups(); window.dispatchEvent(new Event('task-sheet-changed')); };

  async function withdraw(r: Row) {
    if (!confirm(`Withdraw this request for ${amountText(r)} to ${r.recipient_name}?`)) return;
    const { error: e } = await supabase.rpc('withdraw_payout_request', { p_request: r.id });
    if (e) return setError(e.message);
    refresh();
  }

  const columns: Column[] = [
    { key: 'created_at', label: 'Requested', render: r => dateTime(r.created_at) },
    { key: 'status', label: 'Status', value: r => REQUEST_STATUS[r.status]?.label, render: r => <RequestPill status={r.status} /> },
    { key: 'campaign', label: 'Campaign', campaignLink: (r: Row) => r.campaign_id, value: r => `${r.campaigns?.internal_name || r.campaigns?.external_name || ''} - ${r.campaign_id}`, width: 200 },
    { key: 'amount', label: 'Amount', value: amountText, align: 'right' },
    { key: 'recipient_name', label: 'Recipient' },
    { key: 'method', label: 'Method' },
    { key: 'requested_by', label: 'By' },
    { key: 'decision_note', label: 'Office note', width: 200 },
    { key: 'withdraw', label: '', render: r => !isAdmin && r.status === 'pending' && <button type="button" className="link" onClick={e => { e.stopPropagation(); withdraw(r); }}>Withdraw</button> },
  ];

  return (
    <section className="view">
      {error && <div className="error">{error}</div>}
      <DataTable
        title="Payout requests"
        rows={rows}
        loading={q.loading}
        error={q.error}
        columns={columns}
        exportName="payout-requests"
        onOpen={isAdmin ? r => setOpen(r) : undefined}
        actions={
          <>
            <label className="inline-check"><input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)} /> Show finished</label>
            {!isAdmin && <button type="button" className="btn primary" onClick={() => setAsking(true)}><Plus size={15} /> Request a payout</button>}
          </>
        }
      />
      {asking && <RequestPayoutDialog onClose={() => setAsking(false)} onSaved={() => { setAsking(false); refresh(); }} />}
      {open && (
        <Overlay onClose={() => setOpen(null)}>
          <div className="form-head"><h2>Payout request <RequestPill status={open.status} /></h2><button type="button" className="icon-btn" title="Close" onClick={() => setOpen(null)}><X size={18} /></button></div>
          <p className="muted small">{open.campaigns?.internal_name} - {open.campaign_id} · from {open.requested_by} · {dateTime(open.created_at)}</p>
          {open.status === 'pending'
            ? <ApprovePayout requestId={open.id} onAct={async (call, action, note) => {
              const { error: e } = await call;
              if (e) return alert(e.message);
              await supabase.rpc('log_task_action', { p_key: `payout_request:${open.id}`, p_type: 'payout_request', p_summary: `To ${open.recipient_name} by ${open.method}`, p_action: action, p_note: note ?? null });
              setOpen(null);
              refresh();
            }} />
            : <p>{REQUEST_STATUS[open.status]?.label} by {open.decided_by} on {dateTime(open.decided_at)}{open.decision_note ? `: ${open.decision_note}` : ''}</p>}
        </Overlay>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Settings: payout methods
// ---------------------------------------------------------------------------
export function PayoutMethodsPage() {
  const { isSuperAdmin } = useAuth();
  const [version, setVersion] = useState(0);
  const [editing, setEditing] = useState<Row | null>(null);
  const q = useQuery(async () => (await supabase.from('payout_methods').select('*').order('is_custom').order('name')).data as Row[], [version]);
  return (
    <section className="view">
      <DataTable
        title="Payout methods"
        subtitle="The standard methods are always there. The Super Admin can add others."
        rows={q.data ?? []}
        loading={q.loading}
        exportName="payout-methods"
        onOpen={isSuperAdmin ? r => r.is_custom && setEditing(r) : undefined}
        columns={[
          { key: 'name', label: 'Method' },
          { key: 'is_custom', label: 'Kind', value: r => (r.is_custom ? 'Custom' : 'Standard'), render: r => (r.is_custom ? <Pill tone="violet">Custom</Pill> : 'Standard') },
          { key: 'active', label: 'Status', value: r => (r.active ? 'Active' : 'Deactivated') },
          { key: 'description', label: 'Description' },
          { key: 'notes', label: 'Notes' },
        ]}
        actions={isSuperAdmin && <button type="button" className="btn primary" onClick={() => setEditing({ active: true })}><Plus size={15} /> Add custom method</button>}
      />
      {editing && <MethodDialog row={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); clearLookups(); setVersion(v => v + 1); }} />}
    </section>
  );
}

function MethodDialog({ row, onClose, onSaved }: { row: Row; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(row.name ?? '');
  const [description, setDescription] = useState(row.description ?? '');
  const [notes, setNotes] = useState(row.notes ?? '');
  const [active, setActive] = useState(row.active !== false);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    const { error: e } = await supabase.rpc('save_payout_method', { p_id: row.id ?? null, p_name: name, p_description: description || null, p_notes: notes || null, p_active: active });
    if (e) return setError(e.message);
    onSaved();
  }
  return (
    <Overlay onClose={onClose}>
      <div className="form-head"><h2>{row.id ? 'Edit payout method' : 'New payout method'}</h2><button type="button" className="icon-btn" title="Close" onClick={onClose}><X size={18} /></button></div>
      <label className="field"><span>Name *</span><input value={name} onChange={e => setName(e.target.value)} placeholder="Like Crypto or Money Order" /></label>
      <label className="field"><span>Description</span><input value={description} onChange={e => setDescription(e.target.value)} /></label>
      <label className="field"><span>Notes for admins</span><textarea rows={2} value={notes} onChange={e => setNotes(e.target.value)} /></label>
      {row.id && <label className="field check"><input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} /><span>Active</span><small className="muted">Deactivated methods leave the list; past payouts keep showing them.</small></label>}
      {error && <div className="error">{error}</div>}
      <div className="form-actions"><div className="spacer" /><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" disabled={!name.trim()} onClick={save}>Save</button></div>
    </Overlay>
  );
}
