import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import SearchSelect from '../components/SearchSelect';
import { money } from '../lib/format';
import { campaignOptions, clearLookups, type Option } from '../lib/lookups';
import { supabase, type Row } from '../lib/supabase';

const RETURN_REASONS = ['NSF', 'Account Closed', 'Stop Payment', 'Other'];
const today = () => new Date().toISOString().slice(0, 10);

/** What an admin can do to a saved transaction, beyond editing its fields. */
export default function DonationActions({ record, onDone }: { record: Row; onDone: (row: Row) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [splitting, setSplitting] = useState(false);
  const done = record.status === 'completed' || record.status === 'collect';
  const isCheck = /check/i.test(record.payment_method ?? '');

  async function run(p: PromiseLike<{ error: { message: string } | null }>) {
    const { error: e } = await p;
    if (e) return setError(e.message);
    clearLookups();
    const { data } = await supabase.from('donations').select('*').eq('id', record.id).maybeSingle();
    onDone(data ?? { ...record, _deleted: true });
  }

  function refund() {
    const notes = prompt(`Mark ${money(record.amount)} as refunded? The net comes off the campaign; the fee stays spent. Notes (optional):`);
    if (notes !== null) run(supabase.rpc('refund_donation', { p_id: record.id, p_date: today(), p_method: null, p_notes: notes || null }));
  }

  function returned() {
    const reason = prompt(`Mark this check as returned? Its amount comes off the campaign${record.split_group_id ? ', along with every other part of this split,' : ''} and a follow-up task is created. Bank reason (${RETURN_REASONS.join(', ')}):`, 'NSF');
    if (reason) run(supabase.rpc('return_check', { p_id: record.id, p_date: today(), p_reason: reason, p_notes: null }));
  }

  function remove() {
    const reason = prompt('Delete this transaction? It disappears from every list and total but stays on file. A reason is required:');
    if (reason === null) return;
    if (!reason.trim()) return setError('A reason is required to delete a transaction.');
    run(supabase.rpc('delete_donation', { p_id: record.id, p_reason: reason }));
  }

  function reject() {
    const note = prompt('Reject this entry? A reason is required:');
    if (note === null) return;
    if (!note.trim()) return setError('A reason is required to reject an entry.');
    run(supabase.rpc('review_donation', { p_id: record.id, p_approve: false, p_note: note }));
  }

  return (
    <div className="donation-actions">
      {record.status === 'pending' && (
        <>
          <button type="button" className="btn primary" onClick={() => run(supabase.rpc('review_donation', { p_id: record.id, p_approve: true }))}>Approve</button>
          <button type="button" className="btn danger" onClick={reject}>Reject</button>
        </>
      )}
      {record.possible_duplicate && (
        <button type="button" className="btn" onClick={() => run(supabase.rpc('mark_duplicate_reviewed', { p_id: record.id }))}>Not a duplicate</button>
      )}
      {done && !record.split_group_id && <button type="button" className="btn" onClick={() => setSplitting(true)}>Split</button>}
      {done && <button type="button" className="btn" onClick={refund}>Refund</button>}
      {done && isCheck && <button type="button" className="btn" onClick={returned}>Returned check</button>}
      <button type="button" className="btn danger" onClick={remove}>Delete</button>
      {error && <div className="error">{error}</div>}
      {splitting && <SplitDialog record={record} onClose={() => setSplitting(false)} onSplit={run} />}
    </div>
  );
}

/** Rendered outside the edit form, so its inputs can't submit that form. */
function SplitDialog({ record, onClose, onSplit }: {
  record: Row;
  onClose: () => void;
  onSplit: (p: PromiseLike<{ error: { message: string } | null }>) => void;
}) {
  const [campaigns, setCampaigns] = useState<Option[]>([]);
  const [legs, setLegs] = useState<{ campaign_id: string | null; amount: string }[]>([
    { campaign_id: record.campaign_id, amount: '' }, { campaign_id: null, amount: '' },
  ]);
  const [reason, setReason] = useState('');

  useEffect(() => { campaignOptions().then(setCampaigns); }, []);

  const total = Number(record.amount);
  const cents = (n: number) => Math.round(n * 100);
  const allocated = legs.reduce((s, l) => s + (Number(l.amount) || 0), 0);
  const remaining = (cents(total) - cents(allocated)) / 100;
  const ready = remaining === 0 && legs.every(l => l.campaign_id && Number(l.amount) > 0);
  const update = (i: number, patch: Partial<(typeof legs)[number]>) => setLegs(ls => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  return createPortal(
    <div className="modal-back" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="record-form">
          <div className="form-head"><h2>Split {money(total)}</h2></div>
          <p className="muted">The fee is shared in proportion. Each part goes to its campaign's balance.</p>
          {legs.map((l, i) => (
            <div className="split-row" key={i}>
              <SearchSelect value={l.campaign_id} options={campaigns} onChange={v => update(i, { campaign_id: v })} placeholder="Campaign…" />
              <input type="number" step="0.01" min="0" aria-label="Amount" placeholder="Amount" value={l.amount} onChange={e => update(i, { amount: e.target.value })} />
              {legs.length > 2 && <button type="button" className="btn ghost" onClick={() => setLegs(ls => ls.filter((_, j) => j !== i))}>Remove</button>}
            </div>
          ))}
          <button type="button" className="link" onClick={() => setLegs(ls => [...ls, { campaign_id: null, amount: '' }])}>+ Add a campaign</button>
          <p className={remaining === 0 ? 'muted' : 'amount-neg'}>{remaining === 0 ? 'Fully allocated.' : `${money(Math.abs(remaining))} ${remaining > 0 ? 'left to allocate' : 'too much'}`}</p>
          <label className="field"><span>Reason (optional)</span>
            <input value={reason} onChange={e => setReason(e.target.value)} />
          </label>
          <div className="form-actions">
            <div className="spacer" />
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="button" className="btn primary" disabled={!ready} onClick={() => {
              onClose();
              onSplit(supabase.rpc('split_donation', {
                p_id: record.id,
                p_legs: legs.map(l => ({ campaign_id: l.campaign_id, amount: Number(l.amount) })),
                p_reason: reason || null,
              }));
            }}>Split</button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
