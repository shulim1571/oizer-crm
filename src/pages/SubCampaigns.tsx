import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import DataTable, { type Column } from '../components/DataTable';
import SearchSelect from '../components/SearchSelect';
import { Balance, Pill, StatusPill } from '../components/Pill';
import { dateTime, money } from '../lib/format';
import { clearLookups, managerOptions, type Option } from '../lib/lookups';
import { fetchAll, supabase, type Row } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';
import { STATUS_LABEL } from './Campaigns';

const MODES = [
  { value: 'shared', label: 'Shared balance', help: 'Everything counts in the parent’s balance. This one only tracks what it raised, and has no payouts of its own.' },
  { value: 'independent', label: 'Independent balance', help: 'Its own real balance and payouts, like a separate campaign. It just displays under the parent.' },
];
export const modeLabel = (mode: string) => (mode === 'shared' ? 'Shared balance' : 'Independent balance');

const columns: Column[] = [
  { key: 'internal_name', label: 'Sub-campaign', width: 220 },
  { key: 'id', label: 'ID', render: r => <span className="id-tag">{r.id}</span> },
  { key: 'mode', label: 'Mode', value: r => modeLabel(r.balance_mode), render: r => <Pill tone={r.balance_mode === 'shared' ? 'blue' : 'violet'}>{modeLabel(r.balance_mode)}</Pill> },
  { key: 'manager_name', label: 'Fundraiser' },
  { key: 'raised', label: 'Total raised', render: r => money(r.raised), align: 'right' },
  { key: 'donation_count', label: 'Donations', align: 'right' },
  { key: 'balance', label: 'Balance', value: r => (r.balance_mode === 'shared' ? 'Shared' : r.balance), render: r => (r.balance_mode === 'shared' ? <span className="muted">— (shared with parent)</span> : <Balance value={r.balance} />), align: 'right' },
  { key: 'goal', label: 'Goal', render: r => r.goal != null && money(r.goal), align: 'right' },
  { key: 'status', label: 'Status', value: r => STATUS_LABEL[r.status], render: r => <StatusPill value={STATUS_LABEL[r.status]} /> },
];

/** The breakdown under a parent: its numbers are visible here without clicking into each one. */
export function SubCampaignsTab({ parent, canAdd, onChanged }: { parent: Row; canAdd: boolean; onChanged: () => void }) {
  const nav = useNavigate();
  const [adding, setAdding] = useState(false);
  const [version, setVersion] = useState(0);
  const q = useQuery(
    () => fetchAll((a, b) => supabase.from('campaign_summary').select('*').eq('parent_campaign_id', parent.id).order('internal_name').range(a, b) as never),
    [parent.id, version],
  );
  return (
    <>
      <DataTable
        title="Sub-campaigns"
        exportName={`${parent.id}-sub-campaigns`}
        rows={(q.data as Row[]) ?? []}
        loading={q.loading}
        error={q.error}
        columns={columns}
        onOpen={r => nav(`/campaigns/${encodeURIComponent(r.id)}`)}
        actions={canAdd && <button className="btn primary" onClick={() => setAdding(true)}><Plus size={16} /> Add sub-campaign</button>}
      />
      {adding && <AddSubDialog parent={parent} onClose={() => setAdding(false)} onDone={() => { setAdding(false); setVersion(v => v + 1); onChanged(); }} />}
    </>
  );
}

function AddSubDialog({ parent, onClose, onDone }: { parent: Row; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState('');
  const [mode, setMode] = useState('shared');
  const [goal, setGoal] = useState('');
  const [manager, setManager] = useState<string | null>(null);
  const [managers, setManagers] = useState<Option[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { managerOptions().then(setManagers); }, []);

  async function save() {
    setBusy(true);
    setError(null);
    const { error: e } = await supabase.rpc('add_sub_campaign', { p_parent: parent.id, p_name: name, p_mode: mode, p_goal: goal ? Number(goal) : null, p_manager: manager });
    setBusy(false);
    if (e) return setError(e.message);
    clearLookups();
    onDone();
  }

  return createPortal(
    <div className="modal-back" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="modal"><div className="record-form">
        <div className="form-head"><h2>New sub-campaign of {parent.internal_name || parent.id}</h2></div>
        <label className="field"><span>Name *</span><input value={name} onChange={e => setName(e.target.value)} placeholder="Table 12 — Goldstein Family" /></label>
        <label className="field"><span>Balance mode *</span>
          <select value={mode} onChange={e => setMode(e.target.value)}>{MODES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}</select>
        </label>
        <p className="muted small">{MODES.find(m => m.value === mode)?.help}</p>
        <label className="field"><span>Goal</span><input type="number" step="0.01" min="0" value={goal} onChange={e => setGoal(e.target.value)} /></label>
        <label className="field"><span>Fundraiser</span><SearchSelect value={manager} options={managers} onChange={setManager} placeholder="Optional…" /></label>
        <p className="muted small">Fees and the bank account follow the parent unless you set them on the sub-campaign later.</p>
        {error && <div className="error">{error}</div>}
        <div className="form-actions">
          <div className="spacer" />
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy || !name.trim()} onClick={save}>Add sub-campaign</button>
        </div>
      </div></div>
    </div>,
    document.body,
  );
}

/** Shows the money that moves and asks for it to be confirmed before the mode changes. */
export function ChangeModeDialog({ campaign: c, onClose, onDone }: { campaign: Row; onClose: () => void; onDone: () => void }) {
  const [amount, setAmount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const target = c.balance_mode === 'shared' ? 'independent' : 'shared';
  const history = useQuery(
    async () => (await supabase.from('campaign_mode_changes').select('*').eq('campaign_id', c.id).order('created_at', { ascending: false })).data ?? [],
    [c.id],
  );

  useEffect(() => {
    supabase.rpc('balance_mode_amount', { p_campaign: c.id }).then(({ data, error: e }) => {
      if (e) setError(e.message);
      else setAmount(Number(data));
    });
  }, [c.id]);

  async function save() {
    setBusy(true);
    setError(null);
    const { error: e } = await supabase.rpc('set_balance_mode', { p_campaign: c.id, p_mode: target, p_confirmed: amount });
    setBusy(false);
    if (e) return setError(e.message);
    clearLookups();
    onDone();
  }

  return createPortal(
    <div className="modal-back" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="modal"><div className="record-form">
        <div className="form-head"><h2>Change to {modeLabel(target).toLowerCase()}</h2></div>
        {amount === null ? <p className="muted">Working it out…</p> : target === 'independent' ? (
          <p>This sub-campaign's <b>{money(amount)}</b> (what it raised, less fees and anything spent) becomes its own starting balance and leaves the parent's balance. New donations then credit it directly. If the parent has already spent this money, its balance can go negative.</p>
        ) : (
          <p>This sub-campaign's balance of <b>{money(amount)}</b> is absorbed into the parent's balance, and from now on it only tracks what it raises. New donations then credit the parent.</p>
        )}
        <p className="muted small">Past transactions aren't altered. This is logged with your name and the amount.</p>
        {(history.data as Row[] | null)?.length ? (
          <>
            <h3 className="dialog-section">Earlier changes</h3>
            {(history.data as Row[]).map(h => (
              <p className="muted small" key={h.id}>{dateTime(h.created_at)} · {h.changed_by} · {modeLabel(h.old_mode)} to {modeLabel(h.new_mode)} · {money(h.amount)}</p>
            ))}
          </>
        ) : null}
        {error && <div className="error">{error}</div>}
        <div className="form-actions">
          <div className="spacer" />
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy || amount === null} onClick={save}>Confirm {money(amount ?? 0)}</button>
        </div>
      </div></div>
    </div>,
    document.body,
  );
}
