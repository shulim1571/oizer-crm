import { useEffect, useState } from 'react';
import { localToday, money } from '../lib/format';
import { bankAccountOptions, clearLookups, type Option } from '../lib/lookups';
import { supabase, type Row } from '../lib/supabase';
import { Overlay } from './Pledges';

/**
 * Paying a credit card's bill (Moshe, 2026-11-20): one transfer from a bank account to the card account. It lowers the
 * bank's book balance and what's owed on the card; no campaign changes (the card payouts already came off them).
 */
export function PayCardBill({ card, onClose, onDone }: { card: Row; onClose: () => void; onDone: () => void }) {
  const [banks, setBanks] = useState<Option[]>([]);
  const [from, setFrom] = useState<string>(card.pays_from_account_id ?? '');
  const [amount, setAmount] = useState<string>(Number(card.card_owed) > 0 ? String(Number(card.card_owed).toFixed(2)) : '');
  const [date, setDate] = useState(localToday());
  const [ref, setRef] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void bankAccountOptions().then(setBanks); }, []);
  async function save() {
    setBusy(true); setError(null);
    const { error: e } = await supabase.rpc('pay_card_bill', { p_card: card.id, p_from: from, p_amount: Number(amount), p_date: date, p_reference: ref || null });
    setBusy(false);
    if (e) return setError(e.message);
    clearLookups();
    onDone();
  }
  return (
    <Overlay onClose={onClose} size="medium">
      <div className="form-head"><h2>Pay the bill: {card.name}{card.card_last4 ? ` ···${card.card_last4}` : ''}</h2></div>
      <p className="muted small">Owed on the card now: <b>{money(card.card_owed)}</b>. Recording the payment moves it from the bank account to the card in one transfer; campaign balances don't change.</p>
      <label className="field"><span>Paid from</span>
        <select value={from} onChange={e => setFrom(e.target.value)} aria-label="Paid from">
          <option value="">Choose the bank account…</option>
          {banks.map(b => <option key={b.value} value={b.value}>{b.label}</option>)}
        </select></label>
      <label className="field"><span>Amount</span><input inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} /></label>
      <label className="field"><span>Paid on</span><input type="date" value={date} onChange={e => setDate(e.target.value)} /></label>
      <label className="field"><span>Reference (optional)</span><input value={ref} onChange={e => setRef(e.target.value)} placeholder="Confirmation number" /></label>
      {error && <div className="error">{error}</div>}
      <div className="form-actions">
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <div className="spacer" />
        <button type="button" className="btn primary" disabled={busy || !from || !(Number(amount) > 0)} onClick={() => void save()}>{busy ? 'Saving…' : 'Record payment'}</button>
      </div>
    </Overlay>
  );
}
