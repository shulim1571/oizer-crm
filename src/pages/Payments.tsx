import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CreditCard, KeyRound, Trash2, X } from 'lucide-react';
import SearchSelect from '../components/SearchSelect';
import { Pill } from '../components/Pill';
import { useAuth } from '../lib/auth';
import { dateTime, money } from '../lib/format';
import { campaignOptions, donorOptions, type Option } from '../lib/lookups';
import { requestOrgId, supabase, type Row } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';
import { Overlay } from './Pledges';

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

export interface PaymentConfig { ifields_key: string | null; sandbox: boolean; api_key_set: boolean; pin_set: boolean; updated_at?: string; updated_by?: string }
export const usePaymentConfig = () => useQuery(async () => (((await supabase.rpc('payment_config')).data ?? []) as PaymentConfig[])[0] ?? null, []);

/** Calls the payments function for this organization. */
async function callPayments(body: Row) {
  const { data, error } = await supabase.functions.invoke('payments', { body: { ...body, org: requestOrgId() } });
  if (error) throw new Error('The payment service didn\'t answer. Check Sent transactions before trying again.');
  return data as { transaction?: Row; error?: string; pending?: boolean };
}

// ---------------------------------------------------------------------------
// Sola's card fields
// ---------------------------------------------------------------------------
/** Card number and CVV in Sola's frames. `tokens` asks Sola for single-use tokens for both. */
function CardFields({ ifieldsKey, onTokens }: { ifieldsKey: string; onTokens: (get: () => Promise<{ card: string; cvv: string }>) => void }) {
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
  if (!ready) return error ? <div className="error">{error}</div> : <p className="muted small">Loading Sola's secure card fields…</p>;
  return (
    <div ref={box} className="card-fields">
      <label className="field"><span>Card number</span>
        <iframe title="Card number" className="ifield" data-ifields-id="card-number" data-ifields-placeholder="Card number" src={`${IFIELDS}/ifield.htm`} /></label>
      <input type="hidden" data-ifields-id="card-number-token" name="xCardNum" />
      <label className="field ifield-cvv"><span>CVV</span>
        <iframe title="CVV" className="ifield" data-ifields-id="cvv" data-ifields-placeholder="CVV" src={`${IFIELDS}/ifield.htm`} /></label>
      <input type="hidden" data-ifields-id="cvv-token" name="xCVV" />
      <label data-ifields-id="card-data-error" className="error-text" />
      {error && <div className="error">{error}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Charging a card
// ---------------------------------------------------------------------------
export function CardChargeDialog({ campaignId, donorId, cardId, onClose, onDone }: {
  campaignId?: string | null; donorId?: string | null; cardId?: string | null; onClose: () => void; onDone?: (t: Row) => void;
}) {
  const config = usePaymentConfig();
  const [campaigns, setCampaigns] = useState<Option[]>([]);
  const [donors, setDonors] = useState<Option[]>([]);
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Row | null>(null);
  const tokens = useRef<() => Promise<{ card: string; cvv: string }>>();
  const setTokens = useRef((get: () => Promise<{ card: string; cvv: string }>) => { tokens.current = get; }).current;

  useEffect(() => { void campaignOptions().then(setCampaigns); void donorOptions().then(setDonors); }, []);
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
  async function charge() {
    setError(null);
    if (!campaign) return setError('Choose a campaign.');
    if (!(Number(amount) > 0)) return setError('Enter an amount.');
    if (!card && expDigits.length !== 4) return setError('Enter the expiry as MM/YY.');
    if (!confirm(`Charge ${money(Number(amount))} to ${card ? 'the saved card' : 'this card'}?`)) return;
    setBusy(true);
    try {
      const t = card ? null : await tokens.current!();
      const r = await callPayments({
        action: 'sale', campaign_id: campaign, donor_id: donor, amount: Number(amount), card_id: card || null, save_card: save && !card,
        name, email, notes, zip, card_sut: t?.card, cvv_sut: t?.cvv, exp: card ? undefined : expDigits,
      });
      if (r.error) throw new Error(r.error);
      setResult(r.transaction!);
      if (r.transaction?.status === 'approved') onDone?.(r.transaction);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Overlay onClose={onClose}>
      <div className="form-head"><h2><CreditCard size={18} /> Charge a card {cfg?.sandbox && <Pill tone="amber">Sandbox</Pill>}</h2>
        <button type="button" className="icon-btn" title="Close" onClick={onClose}><X size={18} /></button></div>
      {config.loading ? null : !cfg?.ifields_key || !cfg.api_key_set ? (
        <p>Card payments aren't set up yet. The Super Admin adds this organization's Sola keys under <Link to="/payments-settings">Settings → Payments</Link>.</p>
      ) : result ? (
        <>
          {result.status === 'approved'
            ? <div className="notice">Approved: {money(result.amount)} · {result.card_type} {String(result.masked_card ?? '').slice(-4)} · Sola ref {result.ref_num}{result.card_id ? ' · card saved' : ''}</div>
            : <div className="error">{result.status === 'declined' ? 'Declined' : 'Error'}: {result.error ?? 'no reason given'}. It's kept as a failed transaction; nothing was charged.</div>}
          <div className="form-actions"><div className="spacer" />
            {result.status !== 'approved' && <button type="button" className="btn" onClick={() => setResult(null)}>Try again</button>}
            <button type="button" className="btn primary" onClick={onClose}>Done</button></div>
        </>
      ) : (
        <>
          {cfg.sandbox && <p className="muted small">Sandbox keys: only test cards work, such as 4111 1111 1111 1111 with any future expiry. An amount of $9.91 declines.</p>}
          <div className="fields">
            <label className="field"><span>Campaign</span><SearchSelect value={campaign} options={campaigns} onChange={setCampaign} required /></label>
            <label className="field"><span>Donor</span><SearchSelect value={donor} options={donors} onChange={v => { setDonor(v); setCard(''); }} placeholder="Optional" /></label>
            <label className="field"><span>Amount</span><input type="number" min="0.01" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} /></label>
            {cards.length > 0 && (
              <label className="field"><span>Card</span>
                <select value={card} onChange={e => setCard(e.target.value)}>
                  <option value="">A new card</option>
                  {cards.map(k => <option key={k.id} value={k.id}>{k.card_type ?? 'Card'} ending {String(k.masked ?? '').slice(-4)}{k.exp ? ` · exp ${k.exp.slice(0, 2)}/${k.exp.slice(2)}` : ''}</option>)}
                </select></label>
            )}
          </div>
          {!card && (
            <>
              <CardFields ifieldsKey={cfg.ifields_key} onTokens={setTokens} />
              <div className="fields">
                <label className="field"><span>Expiry (MM/YY)</span><input inputMode="numeric" maxLength={5} placeholder="MM/YY" value={exp}
                  onChange={e => { const d = e.target.value.replace(/\D/g, '').slice(0, 4); setExp(d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d); }} /></label>
                <label className="field"><span>Name on card</span><input value={name} onChange={e => setName(e.target.value)} /></label>
                <label className="field"><span>Billing ZIP</span><input value={zip} onChange={e => setZip(e.target.value)} /></label>
              </div>
              {donor && <label className="inline-check"><input type="checkbox" checked={save} onChange={e => setSave(e.target.checked)} /> Save this card on the donor for next time</label>}
            </>
          )}
          <div className="fields">
            <label className="field"><span>Email for Sola's receipt</span><input type="email" value={email} onChange={e => setEmail(e.target.value)} /></label>
            <label className="field wide"><span>Notes</span><input value={notes} onChange={e => setNotes(e.target.value)} /></label>
          </div>
          <p className="muted small">The card number and CVV go straight to Sola; this portal never sees them. An approved charge is saved as a completed donation; a decline is kept as a failed one.</p>
          {error && <div className="error">{error}</div>}
          <div className="form-actions"><div className="spacer" /><button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="button" className="btn primary" disabled={busy} onClick={charge}>{busy ? 'Charging…' : `Charge ${Number(amount) > 0 ? money(Number(amount)) : ''}`}</button></div>
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
  async function reverse(action: 'void' | 'refund') {
    const text = action === 'void'
      ? `Void ${money(record.amount)} at Sola? A void works only before the day's batch settles; the card is never charged.`
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
        <li key={s.id}><span>{s.kind === 'sale' ? 'Charge' : s.kind === 'void' ? 'Void' : 'Refund'} {money(s.amount)}{s.masked_card ? ` · ${s.card_type ?? 'card'} ${String(s.masked_card).slice(-4)}` : ''}
          {s.ref_num ? ` · ref ${s.ref_num}` : ''} · {dateTime(s.created_at)} by {s.requested_email}</span>
          <Pill tone={s.status === 'approved' ? 'green' : s.status === 'pending' ? 'amber' : 'red'}>{s.status}{s.error ? `: ${s.error}` : ''}</Pill></li>
      ))}</ul>
      {live && (
        <div className="donation-actions">
          <button type="button" className="btn" disabled={busy} onClick={() => reverse('void')}>Void at Sola</button>
          <button type="button" className="btn" disabled={busy} onClick={() => reverse('refund')}>Refund at Sola</button>
        </div>
      )}
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
  const q = useQuery(async () => ((await supabase.rpc('donor_saved_cards', { p_donor: donor.id })).data ?? []) as Row[], [donor.id, version]);
  if (!isAdmin) return null;
  async function remove(k: Row) {
    if (!confirm(`Delete the ${k.card_type ?? 'card'} ending ${String(k.masked ?? '').slice(-4)}? It can't be charged again.`)) return;
    const { error } = await supabase.rpc('delete_donor_card', { p_id: k.id });
    if (error) return alert(error.message);
    setVersion(v => v + 1);
  }
  const list = (q.data as Row[]) ?? [];
  return (
    <div className="card">
      <div className="card-head"><h3>Cards</h3><button type="button" className="btn" onClick={() => setCharging(null)}><CreditCard size={15} /> Charge a card</button></div>
      {list.length === 0 ? <p className="muted small">No saved cards. Tick "Save this card" when charging to keep one here.</p> : (
        <ul className="plain-list">{list.map(k => (
          <li key={k.id}><span>{k.card_type ?? 'Card'} ending <b>{String(k.masked ?? '').slice(-4)}</b>{k.exp ? ` · exp ${k.exp.slice(0, 2)}/${k.exp.slice(2)}` : ''} · added {dateTime(k.created_at)}</span>
            <span><button type="button" className="link" onClick={() => setCharging(k.id)}>Charge</button>
              <button type="button" className="icon-btn" title="Delete" onClick={() => remove(k)}><Trash2 size={14} /></button></span></li>
        ))}</ul>
      )}
      {charging !== false && <CardChargeDialog donorId={donor.id} cardId={charging} onClose={() => { setCharging(false); setVersion(v => v + 1); }} />}
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
          <h2><KeyRound size={16} /> Sola keys</h2>
          <p className="muted small">In the Sola portal: Settings → Keys → Create a Key. Make one <b>iFields</b> key and one <b>API</b> key. Sandbox and live accounts have separate keys.</p>
          <div className="fields">
            <label className="field wide"><span>iFields key (public)</span><input value={ifields} onChange={e => setIfields(e.target.value)} autoComplete="off" /></label>
            <label className="field wide"><span>API key (secret)</span><input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} autoComplete="new-password"
              placeholder={cfg?.api_key_set ? 'On file. Type a new one to replace it' : 'Paste the API key'} />
              <small className="muted">Stored encrypted. Only the payment service can read it; it's never shown again.</small></label>
            <label className="inline-check"><input type="checkbox" checked={sandbox} onChange={e => setSandbox(e.target.checked)} /> These are sandbox (test) keys</label>
          </div>
          <h2>Webhook</h2>
          <p className="muted small">In the Sola portal: Settings → Gateway Settings → Webhook. Paste this Postback URL, and the PIN below. Sola then confirms every transaction here.</p>
          <div className="share-link"><code>{webhook}</code></div>
          <div className="fields">
            <label className="field wide"><span>Webhook PIN</span><input value={pin} onChange={e => setPin(e.target.value)} autoComplete="off"
              placeholder={cfg?.pin_set ? 'On file. Type a new one to replace it' : 'At least 15 letters and numbers'} />
              <small className="muted"><button type="button" className="link" onClick={() => setPin(randomPin())}>Make one up</button> and paste the same PIN into Sola.</small></label>
          </div>
          {saved && <div className="notice">Saved.</div>}
          {error && <div className="error">{error}</div>}
          <div className="form-actions"><div className="spacer" /><button type="button" className="btn primary" disabled={!ifields.trim()} onClick={save}>Save</button></div>
        </div>
      ) : <p className="muted">Only the Super Admin can change the payment keys.</p>}
    </section>
  );
}
