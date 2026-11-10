import DonorPicker from '../components/DonorPicker';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CreditCard, KeyRound, Trash2, X } from 'lucide-react';
import SearchSelect from '../components/SearchSelect';
import { Pill } from '../components/Pill';
import { useAuth } from '../lib/auth';
import { dateTime, localToday, money } from '../lib/format';
import { nextDate } from '../lib/recurring';
import { campaignOptions, type Option } from '../lib/lookups';
import { requestOrgId, supabase, type Row } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';
import { Overlay } from './Pledges';
import { TurnstileKeys } from './IntegrationKeys';
import { RecurringDialog, SaveCardDialog, SetupRecurringDialog } from './Recurring';
import {
  BankFields, DAF_PROGRAMS, DafFields, MethodTabs, PAY_EN, bankBody, bankProblem, dafBody, dafProblem, emptyBank, emptyDaf, savedLabel,
  type BankValue, type DafValue, type Method,
} from './PayMethods';

// In the office the donor isn't ticking the box: the admin confirms the donor authorized the debit.
export const OFFICE_PAY = { ...PAY_EN, ach_agree: 'The donor authorized this debit with the wording above, in writing or on a recorded call.',
  ach_agree_needed: 'Confirm the donor authorized the debit.' };

// Card payments through Sola Payments, each organization with its own Sola account. Card number and CVV
// are typed into Sola's iFields, frames served by Sola, and come back to us only as single-use tokens.

const IFIELDS_VERSION = '3.5.2607.1401';
const IFIELDS = `https://cdn.cardknox.com/ifields/${IFIELDS_VERSION}`;

type IfieldsWindow = Window & {
  setAccount?: (key: string, software: string, version: string) => void;
  getTokens?: (onSuccess: () => void, onError: () => void, timeout: number) => void;
  setIfieldStyle?: (field: string, style: Record<string, string>) => void;
  enableAutoFormatting?: (separator?: string) => void;
};
const w = window as IfieldsWindow;

// Sola's script listens for its frames to say they've loaded, so it runs fresh each time card fields
// appear, before the frames themselves.
function loadIfields() {
  return new Promise<void>((resolve, reject) => {
    document.querySelectorAll('script[data-ifields]').forEach(s => s.remove());
    const s = document.createElement('script');
    s.src = `${IFIELDS}/ifields.min.js`;
    s.dataset.ifields = '1';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Sola\'s card fields didn\'t load. Check the connection and try again.'));
    document.head.appendChild(s);
  });
}

export interface PaymentConfig {
  ifields_key: string | null; sandbox: boolean; api_key_set: boolean; pin_set: boolean; updated_at?: string; updated_by?: string;
  ach_enabled: boolean; daf_programs: string[]; ach_authorization: string | null; ach_authorization_text: string | null;
}
export const usePaymentConfig = () => useQuery(async () => (((await supabase.rpc('payment_config')).data ?? []) as PaymentConfig[])[0] ?? null, []);

/** Calls the payments function for this organization. */
export async function callPayments(body: Row) {
  const { data, error } = await supabase.functions.invoke('payments', { body: { ...body, org: requestOrgId() } });
  if (error) throw new Error('The payment service didn\'t answer. Check Sent transactions before trying again.');
  return data as { transaction?: Row; error?: string; pending?: boolean };
}

// ---------------------------------------------------------------------------
// Sola's card fields
// ---------------------------------------------------------------------------
/** Card number and CVV in Sola's frames. `tokens` asks Sola for single-use tokens for both. */
export function CardFields({ ifieldsKey, onTokens, labels = { card: 'Card number', cvv: 'CVV', loading: 'Loading Sola\'s secure card fields…' } }: {
  ifieldsKey: string; onTokens: (get: () => Promise<{ card: string; cvv: string }>) => void; labels?: { card: string; cvv: string; loading: string };
}) {
  const box = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    loadIfields().then(() => live && setReady(true), e => setError(e.message));
    return () => { live = false; };
  }, []);
  useEffect(() => {
    if (!ready) return;
    w.setAccount?.(ifieldsKey, 'Oizer CRM', '1.0');
    w.enableAutoFormatting?.(' ');
    const style = { border: '1px solid #d9dce3', 'border-radius': '8px', padding: '8px 10px', 'font-size': '15px', width: '100%', 'box-sizing': 'border-box', height: '38px' };
    w.setIfieldStyle?.('card-number', style);
    w.setIfieldStyle?.('cvv', style);
    onTokens(() => new Promise((resolve, reject) => {
      if (!w.getTokens) return reject(new Error('Sola\'s card fields haven\'t loaded yet.'));
      w.getTokens(() => {
        const card = box.current?.querySelector<HTMLInputElement>('[data-ifields-id="card-number-token"]')?.value ?? '';
        const cvv = box.current?.querySelector<HTMLInputElement>('[data-ifields-id="cvv-token"]')?.value ?? '';
        if (!card || !cvv) return reject(new Error('Enter the card number and CVV.'));
        resolve({ card, cvv });
      }, () => reject(new Error(box.current?.querySelector('[data-ifields-id="card-data-error"]')?.textContent || 'Check the card number and CVV.')), 30000);
    }));
  }, [ready, ifieldsKey, onTokens]);
  if (!ready) return error ? <div className="error">{error}</div> : <p className="muted small">{labels.loading}</p>;
  return (
    <div ref={box} className="card-fields">
      <label className="field"><span dir="auto">{labels.card}</span>
        <iframe title={labels.card} className="ifield" data-ifields-id="card-number" data-ifields-placeholder={labels.card} src={`${IFIELDS}/ifield.htm`} /></label>
      <input type="hidden" data-ifields-id="card-number-token" name="xCardNum" />
      <label className="field ifield-cvv"><span dir="auto">{labels.cvv}</span>
        <iframe title={labels.cvv} className="ifield" data-ifields-id="cvv" data-ifields-placeholder={labels.cvv} src={`${IFIELDS}/ifield.htm`} /></label>
      <input type="hidden" data-ifields-id="cvv-token" name="xCVV" />
      <label data-ifields-id="card-data-error" className="error-text" />
      {error && <div className="error">{error}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Charging a card
// ---------------------------------------------------------------------------
const FREQ_LABEL: Record<string, string> = { weekly: 'Weekly', monthly: 'Monthly', quarterly: 'Quarterly', annually: 'Yearly' };
const usDate = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
export function CardChargeDialog({ campaignId, donorId, cardId, onClose, onDone }: {
  campaignId?: string | null; donorId?: string | null; cardId?: string | null; onClose: () => void; onDone?: (t: Row) => void;
}) {
  const config = usePaymentConfig();
  const [campaigns, setCampaigns] = useState<Option[]>([]);
  const [campaign, setCampaign] = useState<string | null>(campaignId ?? null);
  const [donor, setDonor] = useState<string | null>(donorId ?? null);
  const [cards, setCards] = useState<Row[]>([]);
  const [card, setCard] = useState<string>(cardId ?? '');
  const [amount, setAmount] = useState('');
  const [exp, setExp] = useState('');
  const [name, setName] = useState('');
  const [zip, setZip] = useState('');
  const [email, setEmail] = useState('');
  const [notes, setNotes] = useState('');
  const [save, setSave] = useState(false);
  const [method, setMethod] = useState<Method>('card');
  const [program, setProgram] = useState<string | null>(null);
  const [bank, setBank] = useState<BankValue>(emptyBank());
  const [daf, setDaf] = useState<DafValue>(emptyDaf());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Row | null>(null);
  // Recurring: today's charge is the first payment, or nothing now and the first charge on a later date.
  const [rec, setRec] = useState({ on: false, frequency: 'monthly', when: 'today' as 'today' | 'later', later: '', fixed: false, count: '12' });
  const [schedule, setSchedule] = useState<string | null>(null);
  const tokens = useRef<() => Promise<{ card: string; cvv: string }>>();
  const setTokens = useRef((get: () => Promise<{ card: string; cvv: string }>) => { tokens.current = get; }).current;

  useEffect(() => { void campaignOptions().then(setCampaigns); }, []);
  useEffect(() => {
    setCards([]);
    if (!donor) return;
    supabase.rpc('donor_saved_cards', { p_donor: donor }).then(({ data }) => setCards((data ?? []) as Row[]));
    supabase.from('donors').select('display_name, email').eq('id', donor).maybeSingle().then(({ data }) => {
      if (data) { setName(n => n || data.display_name || ''); setEmail(e => e || data.email || ''); }
    });
  }, [donor]);

  const cfg = config.data as PaymentConfig | null;
  const expDigits = exp.replace(/\D/g, '');
  const canRepeat = !!donor && (!!card || method !== 'daf');
  const repeating = rec.on && canRepeat;
  const later = repeating && rec.when === 'later';
  const count = rec.fixed ? Number(rec.count) : null;

  /** The recurring schedule on the donor's saved card, through the usual recurring donations. */
  async function scheduleOn(cardId: string, start: string, payments: number | null) {
    const { error: e } = await supabase.rpc('create_recurring', {
      p_donor: donor, p_campaign: campaign, p_card: cardId, p_amount: Number(amount), p_frequency: rec.frequency, p_start: start,
      p_count: payments, p_notify_email: email || null, p_notify_phone: null,
    });
    if (e) throw new Error(`The payment went through, but the recurring schedule wasn't set up: ${e.message}`);
    const freq = FREQ_LABEL[rec.frequency] ?? rec.frequency;
    setSchedule(`${freq} ${money(Number(amount))} from ${usDate(start)}${payments ? `, ${payments} more payment${payments === 1 ? '' : 's'}` : ', until cancelled'}. Manage it under Recurring.`);
  }

  async function charge() {
    setError(null);
    setSchedule(null);
    if (!campaign) return setError('Choose a campaign.');
    if (!(Number(amount) > 0)) return setError('Enter an amount.');
    if (repeating && rec.fixed && !(count && count >= (later ? 1 : 2))) return setError(later ? 'Enter how many payments.' : 'Enter at least 2 payments (today counts as the first).');
    if (later && !(rec.later && rec.later > localToday())) return setError('Choose a start date after today.');
    if (later) return scheduleLater();
    const problem = card ? null : method === 'ach' ? bankProblem(bank, OFFICE_PAY) : method === 'daf' ? dafProblem(program ?? '', daf, OFFICE_PAY)
      : expDigits.length !== 4 ? 'Enter the expiry as MM/YY.' : null;
    if (problem) return setError(problem);
    const what = card ? `the saved ${savedLabel(cards.find(k => k.id === card) ?? {})}` : method === 'ach' ? 'this bank account' : method === 'daf' ? `this ${program} card` : 'this card';
    if (!confirm(`Charge ${money(Number(amount))} to ${what}${repeating ? ` now, then ${(FREQ_LABEL[rec.frequency] ?? rec.frequency).toLowerCase()}${count ? ` for ${count - 1} more payments` : ' until cancelled'}` : ''}?`)) return;
    setBusy(true);
    try {
      const pay = card ? {} : method === 'ach' ? { ...bankBody(bank), ach_authorized: bank.agreed } : method === 'daf' ? dafBody(program!, daf)
        : await tokens.current!().then(t => ({ method: 'card', card_sut: t.card, cvv_sut: t.cvv, exp: expDigits }));
      const r = await callPayments({
        action: 'sale', campaign_id: campaign, donor_id: donor, amount: Number(amount), card_id: card || null, save_card: (save || repeating) && !card,
        name, email, notes, zip, ...pay,
      });
      if (r.error) throw new Error(r.error);
      setResult(r.transaction!);
      if (r.transaction?.status === 'approved') {
        onDone?.(r.transaction);
        const cardId = card || r.transaction.card_id;
        if (repeating) {
          if (!cardId) throw new Error('The payment went through, but the card couldn\'t be saved, so no recurring schedule was set up.');
          await scheduleOn(cardId, nextDate(localToday(), rec.frequency), count ? count - 1 : null);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  /** A start date later on: save a new card without charging (or use the saved one), then schedule. */
  async function scheduleLater() {
    setBusy(true);
    try {
      let cardId = card;
      if (!cardId) {
        const pay = method === 'ach' ? { ...bankBody(bank), ach_authorized: bank.agreed, name: bank.account_name }
          : await tokens.current!().then(t => ({ method: 'card', name, zip, card_sut: t.card, cvv_sut: t.cvv, exp: expDigits }));
        const r = await callPayments({ action: 'save', donor_id: donor, ...pay });
        if (r.error) throw new Error(r.error);
        if (r.transaction?.status !== 'approved' || !r.transaction.card_id) throw new Error(`Sola didn't accept it: ${r.transaction?.error ?? 'no reason given'}`);
        cardId = r.transaction.card_id;
      }
      await scheduleOn(cardId, rec.later, count);
      setResult({ status: 'scheduled' });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Overlay onClose={onClose}>
      <div className="form-head"><h2><CreditCard size={18} /> Take a payment {cfg?.sandbox && <Pill tone="amber">Sandbox</Pill>}</h2>
        <button type="button" className="icon-btn" title="Close" onClick={onClose}><X size={18} /></button></div>
      {config.loading ? null : !cfg?.ifields_key || !cfg.api_key_set ? (
        <p>Card payments aren't set up yet. The Super Admin adds this organization's Sola keys under <Link to="/payments-settings">Settings → Payments</Link>.</p>
      ) : result ? (
        <>
          {result.status === 'scheduled' ? <div className="notice">Recurring donation set up; nothing was charged today.</div>
            : result.status === 'approved'
            ? <div className="notice">Approved: {money(result.amount)} · {savedLabel({ method: result.method, card_type: result.card_type, masked: result.masked_card, daf_program: result.daf_program })} · Sola ref {result.ref_num}
                {result.card_id ? ' · saved for next time' : ''}{result.method === 'ach' ? '. The bank debit settles in 1–3 business days; a return from the bank will show up on the Task Sheet.' : ''}</div>
            : <div className="error">{result.status === 'declined' ? 'Declined' : 'Error'}: {result.error ?? 'no reason given'}. It's kept as a failed transaction; nothing was charged.</div>}
          {schedule && <div className="notice">Recurring: {schedule}</div>}
          {error && <div className="error">{error}</div>}
          <div className="form-actions"><div className="spacer" />
            {result.status !== 'approved' && result.status !== 'scheduled' && <button type="button" className="btn" onClick={() => setResult(null)}>Try again</button>}
            <button type="button" className="btn primary" onClick={onClose}>Done</button></div>
        </>
      ) : (
        <>
          {cfg.sandbox && <p className="muted small">Sandbox keys: only test details work. Card 4111 1111 1111 1111 with any future expiry ($9.91 declines); bank account 999999999 with routing 021000021;
            OJC 6900664467242419; Pledger 6599973975864259; Donors Fund 6599992999456587 (under $5).</p>}
          <div className="fields">
            <label className="field"><span>Campaign</span><SearchSelect value={campaign} options={campaigns} onChange={setCampaign} required /></label>
            <label className="field"><span>Donor</span><DonorPicker value={donor} onChange={v => { setDonor(v); setCard(''); }} placeholder="Optional · search or add a donor" /></label>
            <label className="field"><span>Amount</span><input type="number" min="0.01" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} /></label>
            {cards.length > 0 && (
              <label className="field"><span>Card</span>
                <select value={card} onChange={e => setCard(e.target.value)}>
                  <option value="">Something new</option>
                  {cards.map(k => <option key={k.id} value={k.id}>{savedLabel(k)}{k.exp ? ` · exp ${k.exp.slice(0, 2)}/${k.exp.slice(2)}` : ''}</option>)}
                </select></label>
            )}
          </div>
          {!card && (
            <>
              <MethodTabs value={method} program={program} ach={cfg.ach_enabled} daf={cfg.daf_programs ?? []} L={OFFICE_PAY}
                onChange={(m, p) => { setMethod(m); setProgram(p); setDaf(emptyDaf()); setError(null); if (m === 'ach') setBank(b => ({ ...b, account_name: b.account_name || name })); }} />
              {method === 'card' && (
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
              {method === 'ach' && <BankFields value={bank} onChange={setBank} L={OFFICE_PAY} authorization={cfg.ach_authorization_text} />}
              {method === 'daf' && program && <DafFields program={program} value={daf} onChange={setDaf} L={OFFICE_PAY} />}
              {donor && !repeating && <label className="inline-check"><input type="checkbox" checked={save} onChange={e => setSave(e.target.checked)} />
                Save this {method === 'ach' ? 'bank account' : 'card'} on the donor for next time{method === 'daf' ? ' (if the fund allows it)' : ''}</label>}
            </>
          )}
          {canRepeat && (
            <div className="recurring-box">
              <label className="inline-check"><input type="checkbox" checked={rec.on} onChange={e => setRec(r => ({ ...r, on: e.target.checked }))} /> <b>Make this a recurring donation</b></label>
              {rec.on && (
                <>
                  <div className="fields">
                    <label className="field"><span>How often</span>
                      <select value={rec.frequency} onChange={e => setRec(r => ({ ...r, frequency: e.target.value }))}>
                        {Object.entries(FREQ_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                      </select></label>
                    <label className="field"><span>Start</span>
                      <select value={rec.when} onChange={e => setRec(r => ({ ...r, when: e.target.value as 'today' | 'later' }))}>
                        <option value="today">Today: charge now as the first payment</option>
                        <option value="later">On a later date: nothing charged now</option>
                      </select></label>
                    {rec.when === 'later' && <label className="field"><span>First charge on</span><input type="date" min={localToday()} value={rec.later} onChange={e => setRec(r => ({ ...r, later: e.target.value }))} /></label>}
                    <label className="field"><span>Payments</span>
                      <select value={rec.fixed ? 'n' : 'open'} onChange={e => setRec(r => ({ ...r, fixed: e.target.value === 'n' }))}>
                        <option value="open">No end date (until cancelled)</option><option value="n">A set number</option>
                      </select></label>
                    {rec.fixed && <label className="field"><span>How many{rec.when === 'today' ? ' (including today)' : ''}</span>
                      <input type="number" min={rec.when === 'today' ? 2 : 1} max={520} value={rec.count} onChange={e => setRec(r => ({ ...r, count: e.target.value }))} /></label>}
                  </div>
                  <p className="muted small">The {card ? 'saved card' : method === 'ach' ? 'bank account is' : 'card is'} {card ? 'is used' : 'saved on the donor'} for the later payments, which run through Recurring like any other recurring donation
                    {email ? `; ${email} is told about each one` : ''}.</p>
                </>
              )}
            </div>
          )}
          <div className="fields">
            <label className="field"><span>Email for Sola's receipt</span><input type="email" value={email} onChange={e => setEmail(e.target.value)} /></label>
            <label className="field wide"><span>Notes</span><input value={notes} onChange={e => setNotes(e.target.value)} /></label>
          </div>
          <p className="muted small">Card numbers go straight to Sola; this portal never sees them. Bank and fund numbers pass through to Sola and aren't kept.
            An approved payment is saved as a completed donation; a decline is kept as a failed one.</p>
          {error && <div className="error">{error}</div>}
          <div className="form-actions"><div className="spacer" /><button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="button" className="btn primary" disabled={busy} onClick={charge}>
              {busy ? (later ? 'Saving…' : 'Charging…') : later ? 'Save and schedule' : `Charge ${Number(amount) > 0 ? money(Number(amount)) : ''}${repeating ? ' and repeat' : ''}`}</button></div>
        </>
      )}
    </Overlay>
  );
}

// ---------------------------------------------------------------------------
// On a donation: void or refund at Sola
// ---------------------------------------------------------------------------
/** Shows the donation's trip through Sola, with void and refund when it was charged there. Returns true when it was. */
export function GatewayActions({ record, onDone, onCharged }: { record: Row; onDone: () => void; onCharged?: (viaSola: boolean) => void }) {
  const q = useQuery(async () => ((await supabase.rpc('donation_gateway', { p_donation: record.id })).data ?? []) as Row[], [record.id, record.status]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const steps = (q.data as Row[] | null) ?? [];
  const sale = steps.find(s => s.kind === 'sale' && s.status === 'approved');
  useEffect(() => { onCharged?.(!!sale); }, [sale, onCharged]);
  if (!steps.length) return null;
  const live = sale && (record.status === 'completed' || record.status === 'collect');
  const what = sale?.method === 'ach' ? 'bank account' : sale?.method === 'daf' ? `${sale.daf_program} card` : 'card';
  async function reverse(action: 'void' | 'refund') {
    const text = action === 'void'
      ? `Void ${money(record.amount)} at Sola? A void works only before the day's batch is sent; the ${what} is never charged.`
      : sale?.method === 'ach'
        ? `Refund ${money(record.amount)} to the bank account at Sola? A bank refund works only once the debit has settled, and only in full. The net comes off the campaign.`
        : `Refund ${money(record.amount)} to the card at Sola? Before the day's batch settles Sola voids the charge; after, it refunds it. The net comes off the campaign.`;
    if (!confirm(text)) return;
    setBusy(true);
    setError(null);
    try {
      const r = await callPayments({ action, donation_id: record.id });
      if (r.error) throw new Error(r.error);
      if (r.transaction?.status !== 'approved') {
        throw new Error(`Sola said no: ${r.transaction?.error ?? 'no reason given'}${action === 'void' ? '. If it has settled, refund it instead.' : ''}`);
      }
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      void q.reload();
    }
  }
  return (
    <div className="panel-box">
      <b>Sola</b>
      <ul className="plain-list">{steps.map(s => (
        <li key={s.id}><span>{s.kind === 'sale' ? (s.method === 'ach' ? 'Bank debit' : s.method === 'daf' ? 'Grant' : 'Charge') : s.kind === 'void' ? 'Void' : 'Refund'} {money(s.amount)}
          {s.masked_card ? ` · ${savedLabel({ method: s.method, card_type: s.card_type, masked: s.masked_card, daf_program: s.daf_program })}` : ''}
          {s.ref_num ? ` · ref ${s.ref_num}` : ''} · {dateTime(s.created_at)} by {s.requested_email}</span>
          <span><Pill tone={s.status === 'approved' ? 'green' : s.status === 'pending' ? 'amber' : 'red'}>{s.status}{s.error ? `: ${s.error}` : ''}</Pill>
            {s.settlement && <> <Pill tone={s.settlement === 'settled' ? 'green' : s.settlement === 'returned' ? 'red' : 'amber'}>
              {s.settlement === 'pending' ? 'not settled yet' : s.settlement}{s.return_reason ? `: ${s.return_reason}` : ''}</Pill></>}</span></li>
      ))}</ul>
      {live && (
        <div className="donation-actions">
          <button type="button" className="btn" disabled={busy} onClick={() => reverse('void')}>Void at Sola</button>
          {sale?.method !== 'daf' && <button type="button" className="btn" disabled={busy} onClick={() => reverse('refund')}>Refund at Sola</button>}
        </div>
      )}
      {live && sale?.method === 'daf' && <p className="muted small">A {sale.daf_program} grant can be voided through Sola but not refunded. Once it can't be voided, ask {sale.daf_program} to reverse it.</p>}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Saved cards on a donor
// ---------------------------------------------------------------------------
export function SavedCards({ donor }: { donor: Row }) {
  const { isAdmin } = useAuth();
  const [version, setVersion] = useState(0);
  const [charging, setCharging] = useState<string | null | false>(false);
  const [saving, setSaving] = useState(false);
  const [settingUp, setSettingUp] = useState<string | null | false>(false);
  const [openRecurring, setOpenRecurring] = useState<string | null>(null);
  const q = useQuery(async () => {
    const [cards, recurring] = await Promise.all([
      supabase.rpc('donor_saved_cards', { p_donor: donor.id }),
      supabase.from('recurring_list').select('id, card_id, amount, frequency, campaign_label, status, next_charge, failures').eq('donor_id', donor.id).in('status', ['active', 'paused']),
    ]);
    return { cards: (cards.data ?? []) as Row[], recurring: (recurring.data ?? []) as Row[] };
  }, [donor.id, version]);
  if (!isAdmin) return null;
  const data = q.data as { cards: Row[]; recurring: Row[] } | null;
  const list = data?.cards ?? [];
  const recurring = data?.recurring ?? [];
  async function remove(k: Row) {
    const powering = recurring.filter(r => r.card_id === k.id);
    const warning = powering.length
      ? `This card is being used for an active recurring donation on ${powering.map(r => r.campaign_label).join(', ')}. Deleting it will also cancel that recurring donation, and the donor is told. Delete it?`
      : `Delete the ${savedLabel(k)}? It can't be charged again.`;
    if (!confirm(warning)) return;
    const { error } = await supabase.rpc('delete_donor_card', { p_id: k.id });
    if (error) return alert(error.message);
    setVersion(v => v + 1);
  }
  return (
    <div className="card">
      <div className="card-head"><h3>Cards and accounts</h3>
        <span><button type="button" className="btn" onClick={() => setCharging(null)}><CreditCard size={15} /> Take a payment</button>
          <button type="button" className="link" onClick={() => setSaving(true)}>Save a card or account</button></span></div>
      {list.length === 0 ? <p className="muted small">Nothing saved. Save one, or tick "Save" when taking a payment.</p> : (
        <ul className="plain-list">{list.map(k => {
          const powering = recurring.filter(r => r.card_id === k.id);
          return (
            <li key={k.id}><span><b>{savedLabel(k)}</b>{k.exp ? ` · exp ${k.exp.slice(0, 2)}/${k.exp.slice(2)}` : ''} · added {dateTime(k.created_at)}
              {powering.length > 0 && <> · <Pill tone="blue">Pays a recurring donation</Pill></>}</span>
              <span><button type="button" className="link" onClick={() => setCharging(k.id)}>Charge</button>
                <button type="button" className="link" onClick={() => setSettingUp(k.id)}>Recurring</button>
                <button type="button" className="icon-btn" title="Delete" onClick={() => remove(k)}><Trash2 size={14} /></button></span></li>
          );
        })}</ul>
      )}
      {recurring.length > 0 && (
        <>
          <h3>Recurring</h3>
          <ul className="plain-list">{recurring.map(r => (
            <li key={r.id}><button type="button" className="link" onClick={() => setOpenRecurring(r.id)}>{money(r.amount)} each {({ weekly: 'week', monthly: 'month', quarterly: 'quarter', annually: 'year' } as Record<string, string>)[r.frequency]}</button>
              <span className="muted small">{r.campaign_label} · {r.status === 'paused' ? 'paused' : `next ${r.next_charge ?? '—'}`}</span></li>
          ))}</ul>
        </>
      )}
      {charging !== false && <CardChargeDialog donorId={donor.id} cardId={charging} onClose={() => { setCharging(false); setVersion(v => v + 1); }} />}
      {saving && <SaveCardDialog donorId={donor.id} onClose={() => setSaving(false)} onSaved={() => { setSaving(false); setVersion(v => v + 1); }} />}
      {settingUp !== false && <SetupRecurringDialog donor={donor} cards={list} cardId={settingUp ?? undefined}
        onClose={() => setSettingUp(false)} onDone={() => { setSettingUp(false); setVersion(v => v + 1); }} />}
      {openRecurring && <RecurringDialog id={openRecurring} onClose={() => setOpenRecurring(null)} onChanged={() => setVersion(v => v + 1)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings → Payments
// ---------------------------------------------------------------------------
const randomPin = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), b => 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'[b % 56]).join('');

export function PaymentsSettingsPage() {
  const { isSuperAdmin, org } = useAuth();
  const config = usePaymentConfig();
  const cfg = config.data as PaymentConfig | null;
  const [ifields, setIfields] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [pin, setPin] = useState('');
  const [sandbox, setSandbox] = useState(true);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (cfg) { setIfields(cfg.ifields_key ?? ''); setSandbox(cfg.sandbox); } }, [cfg]);
  const webhook = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/sola-webhook?org=${requestOrgId() ?? org?.id ?? ''}`;

  async function save() {
    setError(null);
    setSaved(false);
    const { error: e } = await supabase.rpc('save_payment_settings', { p_ifields_key: ifields, p_api_key: apiKey || null, p_webhook_pin: pin || null, p_sandbox: sandbox });
    if (e) return setError(e.message);
    setApiKey('');
    setPin('');
    setSaved(true);
    void config.reload();
  }

  return (
    <section className="view narrow">
      <div className="view-head">
        <div className="view-title"><h1>Payments</h1><span className="count">Card processing through Sola Payments</span></div>
      </div>
      <div className="panel-box">
        <h2>Status</h2>
        <dl className="record-facts">
          <dt>iFields key</dt><dd>{cfg?.ifields_key ? <Pill tone="green">Set</Pill> : <Pill tone="red">Missing</Pill>}</dd>
          <dt>API key</dt><dd>{cfg?.api_key_set ? <Pill tone="green">Set</Pill> : <Pill tone="red">Missing</Pill>}</dd>
          <dt>Webhook PIN</dt><dd>{cfg?.pin_set ? <Pill tone="green">Set</Pill> : <Pill tone="amber">Not set</Pill>}</dd>
          <dt>Mode</dt><dd>{cfg ? (cfg.sandbox ? <Pill tone="amber">Sandbox</Pill> : <Pill tone="green">Live</Pill>) : '—'}</dd>
          {cfg?.updated_at && <><dt>Last changed</dt><dd>{dateTime(cfg.updated_at)} by {cfg.updated_by}</dd></>}
        </dl>
      </div>
      {isSuperAdmin ? (
        <div className="panel-box">
          <h2><KeyRound size={16} /> Sola keys and webhook</h2>
          <p className="muted small">In the Sola portal: Settings → Keys → Create a Key. Make one <b>iFields</b> key and one <b>API</b> key. Sandbox and live accounts have separate keys.</p>
          <div className="fields">
            <label className="field wide"><span>iFields key (public)</span><input value={ifields} onChange={e => setIfields(e.target.value)} autoComplete="off" /></label>
            <label className="field wide"><span>API key (secret)</span><input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} autoComplete="new-password"
              placeholder={cfg?.api_key_set ? 'On file. Type a new one to replace it' : 'Paste the API key'} />
              <small className="muted">Stored encrypted. Only the payment service can read it; it's never shown again.</small></label>
            <label className="inline-check"><input type="checkbox" checked={sandbox} onChange={e => setSandbox(e.target.checked)} /> These are sandbox (test) keys</label>
          </div>
          <h3 className="sub-head">Webhook</h3>
          <p className="muted small">In the Sola portal: Settings → Gateway Settings → Webhook. Paste this Postback URL, and the PIN below. Sola then confirms every transaction here.</p>
          <div className="share-link"><code>{webhook}</code></div>
          <div className="fields">
            <label className="field wide"><span>Webhook PIN</span><input value={pin} onChange={e => setPin(e.target.value)} autoComplete="off"
              placeholder={cfg?.pin_set ? 'On file. Type a new one to replace it' : 'At least 15 letters and numbers'} />
              <small className="muted"><button type="button" className="link" onClick={() => setPin(randomPin())}>Make one up</button> and paste the same PIN into Sola.</small></label>
          </div>
          {saved && <div className="notice">Saved.</div>}
          {error && <div className="error">{error}</div>}
          <div className="form-actions"><div className="spacer" /><button type="button" className="btn primary" disabled={!ifields.trim()} onClick={save}>Save Sola keys</button></div>
        </div>
      ) : <p className="muted">Only the Super Admin can change the payment keys.</p>}
      {isSuperAdmin && cfg && <PaymentOptions cfg={cfg} onSaved={() => void config.reload()} />}
      <TurnstileKeys />
    </section>
  );
}

/** Bank accounts and DAF cards: which ones this organization's Sola account takes. */
function PaymentOptions({ cfg, onSaved }: { cfg: PaymentConfig; onSaved: () => void }) {
  const [ach, setAch] = useState(cfg.ach_enabled);
  const [funds, setFunds] = useState<string[]>(cfg.daf_programs ?? []);
  const [wording, setWording] = useState(cfg.ach_authorization ?? '');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    setError(null);
    setSaved(false);
    const { error: e } = await supabase.rpc('save_payment_options', { p_ach: ach, p_daf_programs: funds, p_ach_authorization: wording || null });
    if (e) return setError(e.message);
    setSaved(true);
    onSaved();
  }
  return (
    <div className="panel-box">
      <h2>Bank accounts and donor-advised funds</h2>
      <p className="muted small">Turn on only what this organization's Sola account is set up to take. Ask Sola to enable ACH and each fund first; they then appear on every payment page and in the office.</p>
      <label className="inline-check"><input type="checkbox" checked={ach} onChange={e => setAch(e.target.checked)} /> Bank accounts (ACH)</label>
      {ach && (
        <label className="field wide"><span>ACH authorization wording</span>
          <textarea rows={5} value={wording} onChange={e => setWording(e.target.value)} placeholder={cfg.ach_authorization_text ?? ''} />
          <small className="muted">Leave empty to use the standard wording shown. {'{org}'} becomes the organization's name. Each donor's agreement is kept with the exact wording they saw.</small></label>
      )}
      <div className="fields">{DAF_PROGRAMS.map(p => (
        <label key={p} className="inline-check"><input type="checkbox" checked={funds.includes(p)}
          onChange={e => setFunds(f => (e.target.checked ? [...f, p] : f.filter(x => x !== p)))} /> {p}</label>
      ))}</div>
      {saved && <div className="notice">Saved.</div>}
      {error && <div className="error">{error}</div>}
      <div className="form-actions"><div className="spacer" /><button type="button" className="btn primary" onClick={save}>Save bank &amp; DAF options</button></div>
    </div>
  );
}
