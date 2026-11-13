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
import { NEW_TEMPLATE, NEW_TEMPLATE_LABEL } from '../lib/templatePick';
import { useAuth } from '../lib/auth';
import { TemplateDialog } from './Templates';

import { KIND, kindOf, modeLabel, type ChildKind } from '../lib/childCampaigns';
export { KIND, kindOf, modeLabel };

const columnsFor = (kind: ChildKind, toggle?: (r: Row, on: boolean) => void): Column[] => [
  { key: 'internal_name', label: KIND[kind].one, width: 220 },
  { key: 'id', label: 'ID', render: r => <span className="id-tag">{r.id}</span> },
  { key: 'manager_name', label: 'Fundraiser' },
  { key: 'raised', label: 'Total raised', render: r => money(r.raised), align: 'right' },
  { key: 'donation_count', label: 'Donations', align: 'right' },
  ...(kind === 'sub' ? [{ key: 'balance', label: 'Balance', render: (r: Row) => <Balance value={r.balance} />, align: 'right' as const }] : []),
  { key: 'goal', label: 'Goal', render: r => r.goal != null && money(r.goal), align: 'right' },
  { key: 'status', label: 'Status', value: r => STATUS_LABEL[r.status], render: r => <StatusPill value={STATUS_LABEL[r.status]} /> },
  ...(kind === 'team' ? [{
    key: 'show_on_parent_page', label: 'On parent’s payment page', value: (r: Row) => (r.show_on_parent_page ? 'Shown' : 'Not shown'),
    render: (r: Row) => (toggle
      ? <label className="inline-check" onClick={e => e.stopPropagation()}><input type="checkbox" aria-label={`Show ${r.internal_name} on the parent's payment page`} checked={!!r.show_on_parent_page} onChange={e => toggle(r, e.target.checked)} /> {r.show_on_parent_page ? 'Shown' : 'Not shown'}</label>
      : r.show_on_parent_page ? <Pill tone="green">Shown</Pill> : <span className="muted">Not shown</span>),
  }] : []),
];

/** A parent's teams or sub-campaigns: their numbers are visible here without clicking into each one. */
export function SubCampaignsTab({ parent, kind, canAdd, onChanged }: { parent: Row; kind: ChildKind; canAdd: boolean; onChanged: () => void }) {
  const nav = useNavigate();
  const [adding, setAdding] = useState(false);
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const k = KIND[kind];
  const q = useQuery(async () => {
    const list = await fetchAll((a, b) => supabase.from('campaign_summary').select('*').eq('parent_campaign_id', parent.id).eq('balance_mode', k.mode).order('id').range(a, b) as never) as Row[];
    if (kind !== 'team' || !list.length) return list;
    // Whether each team is listed on the parent's payment page (off unless turned on).
    const { data } = await supabase.from('campaigns').select('id, show_on_parent_page').in('id', list.map(r => r.id));
    const on = new Map(((data ?? []) as Row[]).map(r => [r.id, !!r.show_on_parent_page]));
    return list.map(r => ({ ...r, show_on_parent_page: on.get(r.id) ?? false }));
  }, [parent.id, kind, version]);
  const toggle = async (r: Row, on: boolean) => {
    setError(null);
    const { error: e } = await supabase.rpc('set_team_on_parent_page', { p_campaign: r.id, p_on: on });
    if (e) setError(e.message);
    setVersion(v => v + 1);
  };
  return (
    <>
      {error && <div className="error">{error}</div>}
      <DataTable
        title={k.many}
        exportName={`${parent.id}-${kind === 'team' ? 'teams' : 'sub-campaigns'}`}
        rows={(q.data as Row[]) ?? []}
        loading={q.loading}
        error={q.error}
        columns={columnsFor(kind, canAdd ? toggle : undefined)}
        onOpen={r => nav(`/campaigns/${encodeURIComponent(r.id)}`)}
        actions={canAdd && <button className="btn primary" onClick={() => setAdding(true)}><Plus size={16} /> Add {k.one.toLowerCase()}</button>}
      />
      {adding && <AddSubDialog parent={parent} kind={kind} onClose={() => setAdding(false)} onDone={() => { setAdding(false); setVersion(v => v + 1); onChanged(); }} />}
    </>
  );
}

function AddSubDialog({ parent, kind, onClose, onDone }: { parent: Row; kind: ChildKind; onClose: () => void; onDone: () => void }) {
  const k = KIND[kind];
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [manager, setManager] = useState<string | null>(null);
  const [managers, setManagers] = useState<Option[]>([]);
  const [template, setTemplate] = useState('');
  const [templates, setTemplates] = useState<Row[]>([]);
  const [creating, setCreating] = useState(false);
  const { isAdmin } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    managerOptions().then(setManagers);
    supabase.from('campaign_templates').select('id, name').order('name').then(({ data }) => setTemplates((data ?? []) as Row[]));
  }, []);

  async function save() {
    setBusy(true);
    setError(null);
    const { data, error: e } = await supabase.rpc('add_sub_campaign', { p_parent: parent.id, p_name: name, p_mode: k.mode, p_goal: goal ? Number(goal) : null, p_manager: manager });
    if (!e && template) {
      const { error: t } = await supabase.rpc('save_campaign_settings', { p_campaign: data, p_settings: null, p_template: template });
      if (t) alert(`The ${k.one.toLowerCase()} was created, but the template wasn't applied: ${t.message}`);
    }
    setBusy(false);
    if (e) return setError(e.message);
    clearLookups();
    onDone();
  }

  return createPortal(
    <div className="modal-back" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="modal"><div className="record-form">
        <div className="form-head"><h2>New {k.one.toLowerCase()} of {parent.internal_name || parent.id}</h2></div>
        <label className="field"><span>Name *</span><input value={name} onChange={e => setName(e.target.value)} placeholder={kind === 'team' ? 'Table 12 — Goldstein Family' : 'Brooklyn branch'} /></label>
        <p className="muted small">{k.help} Its ID will be {parent.id} plus the next letter.</p>
        <label className="field"><span>Goal</span><input type="number" step="0.01" min="0" value={goal} onChange={e => setGoal(e.target.value)} /></label>
        {(templates.length > 0 || isAdmin) && (
          <label className="field"><span>Start from</span>
            <select value={template} onChange={e => (e.target.value === NEW_TEMPLATE ? setCreating(true) : setTemplate(e.target.value))}>
              <option value="">Parent's settings</option>
              {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              {isAdmin && <option value={NEW_TEMPLATE}>{NEW_TEMPLATE_LABEL}</option>}
            </select>
          </label>
        )}
        {creating && <TemplateDialog record={null} onClose={() => setCreating(false)} onDone={saved => {
          setCreating(false);
          if (!saved) return;
          setTemplates(list => [...list, saved].sort((a, b) => String(a.name).localeCompare(String(b.name))));
          setTemplate(saved.id);
        }} />}
        <label className="field"><span>Fundraiser</span><SearchSelect value={manager} options={managers} onChange={setManager} placeholder="Optional…" /></label>
        <p className="muted small">Fees and the bank account follow the parent unless you set them on the {k.one.toLowerCase()} later.</p>
        {error && <div className="error">{error}</div>}
        <div className="form-actions">
          <div className="spacer" />
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy || !name.trim()} onClick={save}>Add {k.one.toLowerCase()}</button>
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
        <div className="form-head"><h2>Change to a {modeLabel(target).toLowerCase()}</h2></div>
        {amount === null ? <p className="muted">Working it out…</p> : target === 'independent' ? (
          <p>This team's <b>{money(amount)}</b> (what it raised, less fees and anything spent) becomes its own starting balance and leaves the parent's balance. New donations then credit it directly. If the parent has already spent this money, its balance can go negative.</p>
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
