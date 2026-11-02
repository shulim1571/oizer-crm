import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus, Undo2 } from 'lucide-react';
import DataTable, { type Column } from '../components/DataTable';
import { campLabel } from '../components/CrudPage';
import RecordForm from '../components/RecordForm';
import SearchSelect from '../components/SearchSelect';
import { Pill } from '../components/Pill';
import { dateTime, money } from '../lib/format';
import { clearLookups, type Option } from '../lib/lookups';
import { transferEditFields } from '../lib/schemas';
import { fetchAll, supabase, type Row } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';

const CAMP = 'id, internal_name, campaign_name, external_name';
export const TRANSFER_SELECT = `*, from:campaigns!transfers_from_campaign_id_fkey(${CAMP}), to:campaigns!transfers_to_campaign_id_fkey(${CAMP})`;

export const transferColumns = (onReverse: (r: Row) => void): Column[] => [
  { key: 'amount', label: 'Amount', render: r => money(r.amount), align: 'right' },
  { key: 'from', label: 'From', value: r => campLabel(r.from) },
  { key: 'to', label: 'To', value: r => campLabel(r.to) },
  { key: 'description', label: 'Memo' },
  { key: 'cross_account', label: 'Accounts', value: r => (r.cross_account ? 'Cross-account' : ''), render: r => r.cross_account && <Pill tone="amber">Cross-account</Pill> },
  { key: 'notes', label: 'Notes' },
  { key: 'created_by', label: 'Created By' },
  { key: 'created_at', label: 'Timestamp', render: r => dateTime(r.created_at) },
  {
    key: 'reverse', label: '', value: () => '',
    render: r => r.from_campaign_id && r.to_campaign_id && (
      <button type="button" className="link" onClick={e => { e.stopPropagation(); onReverse(r); }}><Undo2 size={13} /> Reverse</button>
    ),
  },
];

export function TransfersPage() {
  const [version, setVersion] = useState(0);
  const [start, setStart] = useState<Row | null>(null);
  const [editing, setEditing] = useState<Row | null>(null);
  const q = useQuery(
    () => fetchAll((a, b) => supabase.from('transfers').select(TRANSFER_SELECT).order('created_at', { ascending: false }).range(a, b) as never),
    [version],
  );
  return (
    <section className="view">
      <DataTable
        title="Transfers"
        rows={(q.data as Row[]) ?? []}
        loading={q.loading}
        error={q.error}
        columns={transferColumns(r => setStart({ from_campaign_id: r.to_campaign_id, to_campaign_id: r.from_campaign_id, amount: r.amount, description: `Reverses transfer ${r.id}` }))}
        exportName="transfers"
        onOpen={setEditing}
        actions={<button className="btn primary" onClick={() => setStart({})}><Plus size={16} /> New transfer</button>}
      />
      {start && <TransferDialog start={start} onClose={() => setStart(null)} onDone={() => { setStart(null); setVersion(v => v + 1); }} />}
      {editing && (
        <RecordForm
          table="transfers"
          title="Edit memo"
          fields={transferEditFields}
          record={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); setVersion(v => v + 1); }}
        />
      )}
    </section>
  );
}

/** Choose, then see the resulting balances, then confirm. Going below zero warns but never blocks. */
export function TransferDialog({ start, onClose, onDone }: { start: Row; onClose: () => void; onDone: () => void }) {
  const [campaigns, setCampaigns] = useState<Row[]>([]);
  const [from, setFrom] = useState<string | null>(start.from_campaign_id ?? null);
  const [to, setTo] = useState<string | null>(start.to_campaign_id ?? null);
  const [amount, setAmount] = useState(start.amount ? String(start.amount) : '');
  const [memo, setMemo] = useState<string>(start.description ?? '');
  const [confirming, setConfirming] = useState(false);
  const [crossNeeded, setCrossNeeded] = useState(false);
  const [cross, setCross] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetchAll((a, b) => supabase.from('campaign_summary').select('id, internal_name, campaign_name, external_name, balance')
      .eq('status', 'active').eq('balance_mode', 'independent').order('id').range(a, b) as never)
      .then(rows => setCampaigns(rows as Row[]));
  }, []);

  const options: Option[] = campaigns.map(c => ({ value: c.id, label: campLabel(c) }));
  const find = (id: string | null) => campaigns.find(c => c.id === id);
  const n = Number(amount) || 0;
  const source = find(from);
  const dest = find(to);
  const shortfall = source ? n - Number(source.balance) : 0;
  const ready = from && to && from !== to && n > 0;

  async function post() {
    setBusy(true);
    setError(null);
    const { error: e } = await supabase.from('transfers').insert({
      from_campaign_id: from, to_campaign_id: to, amount: n, description: memo || null, cross_account: cross,
    });
    setBusy(false);
    if (e) {
      if (/different bank accounts/.test(e.message)) setCrossNeeded(true);
      return setError(e.message);
    }
    clearLookups();
    onDone();
  }

  return createPortal(
    <div className="modal-back" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="record-form">
          <div className="form-head"><h2>{confirming ? 'Confirm transfer' : 'New transfer'}</h2></div>
          {!confirming ? (
            <>
              <label className="field"><span>From campaign *</span>
                <SearchSelect value={from} options={options} onChange={setFrom} placeholder="Campaign…" />
              </label>
              {source && <p className="muted small">Balance {money(source.balance)}</p>}
              <label className="field"><span>To campaign *</span>
                <SearchSelect value={to} options={options} onChange={setTo} placeholder="Campaign…" />
              </label>
              {dest && <p className="muted small">Balance {money(dest.balance)}</p>}
              <label className="field"><span>Amount *</span>
                <input type="number" step="0.01" min="0" value={amount} onChange={e => setAmount(e.target.value)} />
              </label>
              <label className="field"><span>Memo</span>
                <input value={memo} onChange={e => setMemo(e.target.value)} />
              </label>
              <p className="muted small">Shared-balance sub-campaigns, and archived or closed campaigns, aren't listed. Reactivate a campaign to use it here.</p>
              {from && from === to && <div className="error">Choose two different campaigns.</div>}
            </>
          ) : (
            <>
              <dl className="record-facts">
                <dt>From</dt><dd>{campLabel(source)}</dd>
                <dt>To</dt><dd>{campLabel(dest)}</dd>
                <dt>Amount</dt><dd><b>{money(n)}</b></dd>
                {memo && <><dt>Memo</dt><dd>{memo}</dd></>}
                <dt>Source after</dt><dd>{money(Number(source?.balance) - n)}</dd>
                <dt>Destination after</dt><dd>{money(Number(dest?.balance) + n)}</dd>
              </dl>
              {shortfall > 0 && (
                <div className="error">
                  Insufficient funds: the balance is {money(source?.balance)}, you're moving {money(n)}, a shortfall of {money(shortfall)}. You can still go ahead.
                </div>
              )}
              {crossNeeded && (
                <label className="inline-check"><input type="checkbox" checked={cross} onChange={e => { setCross(e.target.checked); setError(null); }} /> This is a cross-account transfer</label>
              )}
              {error && <div className="error">{error}</div>}
              <p className="muted small">A posted transfer can't be edited. To undo it, post a reverse transfer.</p>
            </>
          )}
          <div className="form-actions">
            <div className="spacer" />
            <button type="button" className="btn" onClick={confirming ? () => setConfirming(false) : onClose}>{confirming ? 'Back' : 'Cancel'}</button>
            {!confirming
              ? <button type="button" className="btn primary" disabled={!ready} onClick={() => setConfirming(true)}>Continue</button>
              : <button type="button" className="btn primary" disabled={busy} onClick={post}>Post transfer</button>}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
