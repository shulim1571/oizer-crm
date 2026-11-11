import { useState } from 'react';
import RecordForm from '../components/RecordForm';
import { money } from '../lib/format';
import { clearLookups } from '../lib/lookups';
import { newDonationFields } from '../lib/schemas';
import { supabase, type Row } from '../lib/supabase';

// The New Donation form's fields only: no Type, Fee or Collector (Moshe Henig, 2026-11-11). A manual fee set here
// replaces each transaction's fee, as on the form.
const BULK_FIELDS = ['campaign_id', 'status', 'amount', 'manual_fee', 'payment_method', 'donor_id', 'source', 'account_id', 'created_at', 'notes'];
const fields = BULK_FIELDS.map(n => ({ ...newDonationFields.find(f => f.name === n)!, required: false, help: undefined, section: undefined, showIf: undefined }));

const plural = (n: number) => `${n.toLocaleString()} transaction${n === 1 ? '' : 's'}`;

export default function TransactionBulk({ selected, onClear, onDone, onSelectAll, matching }: {
  /** Selected ids with their amounts, so the warning can state the total. */
  selected: Map<string, number>;
  onClear: () => void;
  onDone: (message: string) => void;
  onSelectAll: () => void;
  matching: number;
}) {
  const [action, setAction] = useState<'edit' | 'void' | 'delete' | null>(null);
  const [word, setWord] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const ids = [...selected.keys()];
  const total = [...selected.values()].reduce((s, n) => s + n, 0);
  const count = plural(ids.length);

  async function applyEdit(patch: Row) {
    const names = Object.keys(patch).map(k => fields.find(f => f.name === k)?.label ?? k).join(', ');
    if (!Object.keys(patch).length) return setError('Fill in at least one field to change.');
    if (!confirm(`Change ${names} on ${count} totaling ${money(total)}?`)) return;
    const { data, error: e } = await supabase.rpc('bulk_update_donations', { p_ids: ids, p_patch: patch });
    if (e) return setError(e.message);
    clearLookups();
    setAction(null);
    onDone(`Updated ${plural(Number(data))}.`);
  }

  async function applyDanger() {
    setBusy(true);
    const { data, error: e } = action === 'void'
      ? await supabase.rpc('bulk_update_donations', { p_ids: ids, p_patch: { status: 'voided' } })
      : await supabase.rpc('bulk_delete_donations', { p_ids: ids });
    setBusy(false);
    if (e) return setError(e.message);
    const done = action === 'void' ? 'Voided' : 'Deleted';
    setAction(null);
    setWord('');
    onDone(`${done} ${plural(Number(data))}.`);
  }

  if (!ids.length) return null;

  return (
    <div className="bulk-bar">
      <b>{count} selected</b> · {money(total)}
      {ids.length < matching && <button className="link" onClick={onSelectAll}>Select all {matching.toLocaleString()} matching</button>}
      <span className="spacer" />
      <button className="btn" onClick={() => { setError(null); setAction('edit'); }}>Bulk edit</button>
      <button className="btn" onClick={() => { setError(null); setAction('void'); }}>Void</button>
      <button className="btn danger" onClick={() => { setError(null); setAction('delete'); }}>Delete</button>
      <button className="btn ghost" onClick={onClear}>Clear</button>

      {action === 'edit' && (
        <RecordForm
          table="donations"
          title={`Bulk edit ${count}`}
          fields={fields}
          onClose={() => setAction(null)}
          onSaved={() => undefined}
          onBulk={applyEdit}
          bulkError={error}
        />
      )}

      {(action === 'void' || action === 'delete') && (
        <div className="modal-back" onMouseDown={e => e.target === e.currentTarget && setAction(null)}>
          <div className="modal">
            <form className="record-form" onSubmit={e => { e.preventDefault(); if (word === 'CONFIRM') void applyDanger(); }}>
              <div className="form-head"><h2>{action === 'void' ? 'Void' : 'Delete'} {count}?</h2></div>
              <p>
                You are about to {action} <b>{count}</b> totaling <b>{money(total)}</b>.{' '}
                {action === 'void'
                  ? 'This reverses their amounts and fees on the campaign. It records the void here only: it does not contact any card processor.'
                  : 'They disappear from every list and total.'}
              </p>
              <label className="field"><span>Type CONFIRM to proceed</span>
                <input autoFocus value={word} onChange={e => setWord(e.target.value)} />
              </label>
              {error && <div className="error">{error}</div>}
              <div className="form-actions">
                <div className="spacer" />
                <button type="button" className="btn" onClick={() => setAction(null)}>Cancel</button>
                <button className="btn danger" disabled={word !== 'CONFIRM' || busy}>{busy ? 'Working…' : action === 'void' ? 'Void' : 'Delete'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
