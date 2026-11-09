import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarClock, CreditCard, Repeat, X } from 'lucide-react';
import DataTable, { type Column } from '../components/DataTable';
import Kpi from '../components/Kpi';
import SearchSelect from '../components/SearchSelect';
import { Pill } from '../components/Pill';
import { useAuth } from '../lib/auth';
import { dateTime, money } from '../lib/format';
import { campaignOptions, type Option } from '../lib/lookups';
import { fetchAll, supabase, type Row } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';
import { CardFields, OFFICE_PAY, callPayments, usePaymentConfig, type PaymentConfig } from './Payments';
import { BankFields, bankBody, bankProblem, emptyBank, savedLabel, type BankValue } from './PayMethods';
import { Overlay } from './Pledges';

// Recurring donations: set up on the payment page or by the office on a saved card, charged on their dates by
// the recurring-charges function, retried after 3 and 7 days, paused after the third failure.

export const FREQUENCIES: [string, string][] = [['weekly', 'Weekly'], ['monthly', 'Monthly'], ['quarterly', 'Quarterly'], ['annually', 'Yearly']];
const freqLabel = (f: string) => FREQUENCIES.find(x => x[0] === f)?.[1] ?? f;
const day = (d?: string | null) => (d ? new Date(`${String(d).slice(0, 10)}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—');
const STATUS: Record<string, [string, 'green' | 'amber' | 'red' | 'blue' | '']> = {
  active: ['Active', 'green'], paused: ['Paused', 'amber'], cancelled: ['Cancelled', ''], completed: ['Completed', 'blue'],
};
const RecurringPill = ({ r }: { r: Row }) => <Pill tone={r.status === 'active' && r.failures > 0 ? 'amber' : STATUS[r.status]?.[1] ?? ''}>
  {r.status === 'active' && r.failures > 0 ? `Retrying (${r.failures} failed)` : STATUS[r.status]?.[0] ?? r.status}</Pill>;
const progress = (r: Row) => (r.total_payments ? `${r.payments_made} of ${r.total_payments}` : `${r.payments_made} so far`);
const cardText = (r: Row) => (r.card_masked ? `${r.card_type ?? 'Card'} ${String(r.card_masked).slice(-4)}` : '—');

// ---------------------------------------------------------------------------
// Saving a card without charging it
// ---------------------------------------------------------------------------
export function SaveCardDialog({ donorId, onClose, onSaved }: { donorId: string; onClose: () => void; onSaved: () => void }) {
  const config = usePaymentConfig();
  const cfg = config.data as PaymentConfig | null;
  const [exp, setExp] = useState('');
  const [name, setName] = useState('');
  const [zip, setZip] = useState('');
  const [kind, setKind] = useState<'card' | 'ach'>('card');
  const [bank, setBank] = useState<BankValue>(emptyBank());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tokens = useRef<() => Promise<{ card: string; cvv: string }>>();
  const setTokens = useRef((get: () => Promise<{ card: string; cvv: string }>) => { tokens.current = get; }).current;
  async function save() {
    setError(null);
    if (kind === 'ach') { const p = bankProblem(bank, OFFICE_PAY); if (p) return setError(p); }
    setBusy(true);
    try {
      const pay = kind === 'ach' ? { ...bankBody(bank), ach_authorized: bank.agreed, name: bank.account_name }
        : await tokens.current!().then(t => ({ method: 'card', name, zip, card_sut: t.card, cvv_sut: t.cvv, exp: exp.replace(/\D/g, '') }));
      const r = await callPayments({ action: 'save', donor_id: donorId, ...pay });
      if (r.error) throw new Error(r.error);
      if (r.transaction?.status !== 'approved') throw new Error(`Sola didn't accept it: ${r.transaction?.error ?? 'no reason given'}`);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Overlay onClose={onClose}>
      <div className="form-head"><h2><CreditCard size={18} /> Save a card or account</h2><button type="button" className="icon-btn" title="Close" onClick={onClose}><X size={18} /></button></div>
      {!cfg?.ifields_key ? <p>Card payments aren't set up yet.</p> : (
        <>
          <p className="muted small">Saved with Sola for later payments and recurring donations. Nothing is charged now. A DAF card is saved by ticking "Save" on its first grant.</p>
          {cfg.ach_enabled && (
            <div className="pay-methods">
              <button type="button" className={kind === 'card' ? 'on' : ''} onClick={() => setKind('card')}>Credit Card</button>
              <button type="button" className={kind === 'ach' ? 'on' : ''} onClick={() => setKind('ach')}>Bank account</button>
            </div>
          )}
          {kind === 'ach' ? <BankFields value={bank} onChange={setBank} L={OFFICE_PAY} authorization={cfg.ach_authorization_text} /> : (
            <>
              <CardFields ifieldsKey={cfg.ifields_key} onTokens={setTokens} />
              <div className="fields">
                <label className="field"><span>Expiry (MM/YY)</span><input inputMode="numeric" maxLength={5} placeholder="MM/YY" value={exp}
                  onChange={e => { const d = e.target.value.replace(/\D/g, '').slice(0, 4); setExp(d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d); }} /></label>
                <label className="field"><span>Name on card</span><input value={name} onChange={e => setName(e.target.value)} /></label>
                <label className="field"><span>Billing ZIP</span><input value={zip} onChange={e => setZip(e.target.value)} /></label>
              </div>
            </>
          )}
          {error && <div className="error">{error}</div>}
          <div className="form-actions"><div className="spacer" /><button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="button" className="btn primary" disabled={busy || (kind === 'card' && exp.replace(/\D/g, '').length !== 4)} onClick={save}>{busy ? 'Saving…' : 'Save'}</button></div>
        </>
      )}
    </Overlay>
  );
}

// ---------------------------------------------------------------------------
// Setting one up on a saved card
// ---------------------------------------------------------------------------
export function SetupRecurringDialog({ donor, cards, cardId, onClose, onDone }: { donor: Row; cards: Row[]; cardId?: string; onClose: () => void; onDone: () => void }) {
  const [campaigns, setCampaigns] = useState<Option[]>([]);
  const [f, setF] = useState({
    campaign: null as string | null, card: cardId ?? cards[0]?.id ?? '', amount: '', frequency: 'monthly', start: new Date().toLocaleDateString('en-CA'),
    fixed: false, count: '12', email: donor.email ?? '', phone: '',
  });
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void campaignOptions().then(setCampaigns); }, []);
  const set = (k: keyof typeof f, v: unknown) => setF(x => ({ ...x, [k]: v }));
  async function save() {
    setError(null);
    const { error: e } = await supabase.rpc('create_recurring', {
      p_donor: donor.id, p_campaign: f.campaign, p_card: f.card, p_amount: Number(f.amount), p_frequency: f.frequency, p_start: f.start,
      p_count: f.fixed ? Number(f.count) : null, p_notify_email: f.email || null, p_notify_phone: f.phone || null,
    });
    if (e) return setError(e.message);
    onDone();
  }
  const n = f.fixed ? Number(f.count) : 0;
  return (
    <Overlay onClose={onClose}>
      <div className="form-head"><h2><Repeat size={18} /> Recurring donation for {donor.display_name}</h2><button type="button" className="icon-btn" title="Close" onClick={onClose}><X size={18} /></button></div>
      <div className="fields">
        <label className="field"><span>Campaign</span><SearchSelect value={f.campaign} options={campaigns} onChange={v => set('campaign', v)} required /></label>
        <label className="field"><span>Card</span>
          <select value={f.card} onChange={e => set('card', e.target.value)}>
            {cards.map(k => <option key={k.id} value={k.id}>{savedLabel(k)}</option>)}
          </select></label>
        <label className="field"><span>Amount each time</span><input type="number" min="0.01" step="0.01" value={f.amount} onChange={e => set('amount', e.target.value)} /></label>
        <label className="field"><span>How often</span>
          <select value={f.frequency} onChange={e => set('frequency', e.target.value)}>{FREQUENCIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        <label className="field"><span>First charge</span><input type="date" value={f.start} onChange={e => set('start', e.target.value)} /></label>
        <label className="field"><span>Payments</span>
          <select value={f.fixed ? 'n' : 'until'} onChange={e => set('fixed', e.target.value === 'n')}><option value="until">Until cancelled</option><option value="n">A set number</option></select></label>
        {f.fixed && <label className="field"><span>Number of payments</span><input type="number" min={1} max={520} value={f.count} onChange={e => set('count', e.target.value)} /></label>}
        <label className="field"><span>Email the donor at</span><input type="email" value={f.email} onChange={e => set('email', e.target.value)} /></label>
        <label className="field"><span>Text the donor at</span><input type="tel" value={f.phone} onChange={e => set('phone', e.target.value)} placeholder="Optional" /></label>
      </div>
      {n > 0 && Number(f.amount) > 0 && <p><b>{n} payments of {money(Number(f.amount))}: {money(Number(f.amount) * n)} in total</b></p>}
      <p className="muted small">The donor is told the terms. A first charge dated today goes through within minutes.</p>
      {error && <div className="error">{error}</div>}
      <div className="form-actions"><div className="spacer" /><button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" disabled={!f.campaign || !f.card || !(Number(f.amount) > 0)} onClick={save}>Set up</button></div>
    </Overlay>
  );
}

// ---------------------------------------------------------------------------
// One recurring donation
// ---------------------------------------------------------------------------
export function RecurringDialog({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { isAdmin } = useAuth();
  const [version, setVersion] = useState(0);
  const q = useQuery(async () => {
    const r = (await supabase.from('recurring_list').select('*').eq('id', id).maybeSingle()).data as Row | null;
    const [cards, charges] = r ? await Promise.all([
      isAdmin ? supabase.rpc('donor_saved_cards', { p_donor: r.donor_id }) : Promise.resolve({ data: [] }),
      supabase.from('gateway_transactions').select('id, recurring_seq, status, amount, error, created_at, donation_id').eq('recurring_id', id).order('created_at', { ascending: false }),
    ]) : [{ data: [] }, { data: [] }];
    return { r, cards: (cards.data ?? []) as Row[], charges: (charges.data ?? []) as Row[] };
  }, [id, version]);
  const [edit, setEdit] = useState<Row | null>(null);
  const [savingCard, setSavingCard] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const data = q.data as { r: Row | null; cards: Row[]; charges: Row[] } | null;
  const r = data?.r;
  useEffect(() => { if (r) setEdit({ amount: String(r.amount), frequency: r.frequency, card: r.card_id ?? '', next: r.next_charge ?? '' }); }, [r]);
  if (!r) return null;
  const ended = r.status === 'cancelled' || r.status === 'completed';
  const refresh = () => { setVersion(v => v + 1); onChanged(); };
  async function act(action: string, question?: string) {
    let reason: string | null = null;
    if (question) { reason = prompt(question); if (reason === null) return; }
    setError(null);
    const { error: e } = await supabase.rpc('set_recurring_status', { p_id: id, p_action: action, p_reason: reason });
    if (e) return setError(e.message);
    window.dispatchEvent(new Event('task-sheet-changed'));
    refresh();
  }
  async function saveChanges() {
    setError(null);
    const { error: e } = await supabase.rpc('update_recurring', {
      p_id: id, p_amount: Number(edit!.amount), p_frequency: edit!.frequency, p_card: edit!.card, p_next: edit!.next && edit!.next !== r!.next_charge ? edit!.next : null,
    });
    if (e) return setError(e.message);
    refresh();
  }
  return (
    <Overlay onClose={onClose}>
      <div className="form-head"><h2><Repeat size={18} /> {r.donor_name} · {money(r.amount)} {freqLabel(r.frequency).toLowerCase()} <RecurringPill r={r} /></h2>
        <button type="button" className="icon-btn" title="Close" onClick={onClose}><X size={18} /></button></div>
      <dl className="record-facts">
        <dt>Donor</dt><dd><Link to={`/donors/${encodeURIComponent(r.donor_id)}`}>{r.donor_name}</Link></dd>
        <dt>Campaign</dt><dd><Link to={`/campaigns/${encodeURIComponent(r.campaign_id)}`}>{r.campaign_label}</Link></dd>
        <dt>Payments</dt><dd>{progress(r)}{r.final_charge && ` · last on ${day(r.final_charge)}`}</dd>
        <dt>Next charge</dt><dd>{r.status === 'active' ? day(r.retry_on ?? r.next_charge) : '—'}{r.retry_on && r.status === 'active' && ' (retry)'}</dd>
        <dt>Card</dt><dd>{cardText(r)}{r.card_exp && ` · exp ${r.card_exp.slice(0, 2)}/${r.card_exp.slice(2)}`}</dd>
        {r.cover_fee && <><dt>Fee</dt><dd>Donor covers it</dd></>}
        {r.last_error && <><dt>Last problem</dt><dd>{r.last_error}</dd></>}
        {r.pause_reason && r.status === 'paused' && <><dt>Paused</dt><dd>{r.pause_reason}</dd></>}
        {r.status === 'cancelled' && <><dt>Cancelled</dt><dd>{dateTime(r.cancelled_at)} by {r.cancelled_by}{r.cancel_reason ? `: ${r.cancel_reason}` : ''}</dd></>}
        <dt>Set up</dt><dd>{dateTime(r.created_at)} {r.source === 'page' ? 'on the payment page' : `by ${r.created_by}`}</dd>
      </dl>
      {isAdmin && !ended && (
        <>
          <div className="donation-actions">
            {r.status === 'active' && <button type="button" className="btn" onClick={() => act('pause', 'Pause this recurring donation? Reason (optional):')}>Pause</button>}
            {r.status === 'paused' && <button type="button" className="btn primary" onClick={() => act('resume')}>Resume</button>}
            {(r.failures > 0 || r.status === 'paused') && <button type="button" className="btn" onClick={() => act('retry')}>Retry now</button>}
            <button type="button" className="btn danger" onClick={() => act('cancel', 'Cancel this recurring donation? The donor is told. Reason (optional):')}>Cancel</button>
          </div>
          {edit && (
            <div className="panel-box">
              <h3>Change</h3>
              <div className="fields">
                <label className="field"><span>Amount</span><input type="number" min="0.01" step="0.01" value={edit.amount} onChange={e => setEdit({ ...edit, amount: e.target.value })} /></label>
                <label className="field"><span>How often</span>
                  <select value={edit.frequency} onChange={e => setEdit({ ...edit, frequency: e.target.value })}>{FREQUENCIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
                <label className="field"><span>Card</span>
                  <select value={edit.card} onChange={e => setEdit({ ...edit, card: e.target.value })}>
                    {data!.cards.map(k => <option key={k.id} value={k.id}>{savedLabel(k)}</option>)}
                  </select>
                  <small><button type="button" className="link" onClick={() => setSavingCard(true)}>Add a new card</button></small></label>
                <label className="field"><span>Next charge</span><input type="date" value={String(edit.next ?? '').slice(0, 10)} onChange={e => setEdit({ ...edit, next: e.target.value })} /></label>
              </div>
              <p className="muted small">The donor is told about a new amount or frequency. A new card clears the failed count.</p>
              <div className="form-actions"><div className="spacer" /><button type="button" className="btn primary" onClick={saveChanges}>Save changes</button></div>
            </div>
          )}
        </>
      )}
      {error && <div className="error">{error}</div>}
      {data!.charges.length > 0 && (
        <div className="table-wrap dialog-table"><table className="grid">
          <thead><tr><th>When</th><th>Payment</th><th>Amount</th><th>Result</th></tr></thead>
          <tbody>{data!.charges.map(c => (
            <tr key={c.id}><td>{dateTime(c.created_at)}</td><td>{c.recurring_seq ?? 1}</td><td>{money(c.amount)}</td>
              <td><Pill tone={c.status === 'approved' ? 'green' : c.status === 'pending' ? 'amber' : 'red'}>{c.status}</Pill>{c.error && <span className="muted small"> {c.error}</span>}</td></tr>
          ))}</tbody>
        </table></div>
      )}
      {savingCard && <SaveCardDialog donorId={r.donor_id} onClose={() => setSavingCard(false)} onSaved={() => { setSavingCard(false); setVersion(v => v + 1); }} />}
    </Overlay>
  );
}

// ---------------------------------------------------------------------------
// The Recurring page
// ---------------------------------------------------------------------------
export function RecurringPage() {
  const [version, setVersion] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const [show, setShow] = useState<'live' | 'all'>('live');
  const q = useQuery(() => fetchAll((a, b) => supabase.from('recurring_list').select('*').order('next_charge', { ascending: true, nullsFirst: false }).range(a, b) as never), [version]);
  const all = (q.data as Row[]) ?? [];
  const rows = show === 'live' ? all.filter(r => r.status === 'active' || r.status === 'paused') : all;
  const active = all.filter(r => r.status === 'active');
  const sum = (k: string) => active.reduce((t, r) => t + Number(r.amount) * Number(r[k] ?? 0), 0);
  const columns: Column[] = [
    { key: 'donor_name', label: 'Donor', width: 170 },
    { key: 'campaign_label', label: 'Campaign', width: 200 },
    { key: 'amount', label: 'Amount', align: 'right', render: r => money(r.amount), value: r => Number(r.amount) },
    { key: 'frequency', label: 'How often', value: r => freqLabel(r.frequency) },
    { key: 'payments', label: 'Payments', value: progress },
    { key: 'next_charge', label: 'Next charge', render: r => (r.status === 'active' ? day(r.retry_on ?? r.next_charge) : '—'), value: r => r.retry_on ?? r.next_charge ?? '' },
    { key: 'status', label: 'Status', render: r => <RecurringPill r={r} />, value: r => r.status },
    { key: 'card', label: 'Card', value: cardText },
    { key: 'last_error', label: 'Last problem', width: 200 },
  ];
  return (
    <section className="view">
      <div className="kpis">
        <Kpi label="Active" value={active.length} icon={<Repeat size={18} />} />
        <Kpi label="Due in 30 days" value={money(sum('due_30'))} icon={<CalendarClock size={18} />} tone="green" />
        <Kpi label="Due in 90 days" value={money(sum('due_90'))} icon={<CalendarClock size={18} />} tone="blue" />
        <Kpi label="Paused or retrying" value={all.filter(r => r.status === 'paused' || (r.status === 'active' && r.failures > 0)).length} icon={<Repeat size={18} />} tone="amber" />
      </div>
      <DataTable title="Recurring Donations" subtitle="Charged on their dates with the donor's saved card. A failed charge is retried after 3 days, then 7."
        rows={rows} loading={q.loading} error={q.error} columns={columns} exportName="recurring" onOpen={r => setOpen(r.id)}
        actions={<select value={show} onChange={e => setShow(e.target.value as 'live' | 'all')}><option value="live">Active and paused</option><option value="all">All, including ended</option></select>} />
      {open && <RecurringDialog id={open} onClose={() => setOpen(null)} onChanged={() => setVersion(v => v + 1)} />}
    </section>
  );
}

/** On the Task Sheet: a recurring donation that failed three times. */
export function RecurringFailed({ id, onDone }: { id: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="donation-actions">
      <button type="button" className="btn primary" onClick={() => setOpen(true)}>Update card, retry or cancel</button>
      {open && <RecurringDialog id={id} onClose={() => { setOpen(false); onDone(); }} onChanged={() => {}} />}
    </div>
  );
}
