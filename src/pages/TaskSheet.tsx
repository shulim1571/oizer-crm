import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { X } from 'lucide-react';
import DataTable, { type Column } from '../components/DataTable';
import SearchSelect from '../components/SearchSelect';
import { Pill } from '../components/Pill';
import { dateTime, money } from '../lib/format';
import { campaignOptions, clearLookups, type Option } from '../lib/lookups';
import { fetchAll, supabase, type Row } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';
import { SplitDialog } from './DonationActions';
import { Overlay, PledgeDialog } from './Pledges';
import { RequestDecision } from './Requests';
import { VoucherDialog } from './Vouchers';

type Tone = 'green' | 'red' | 'amber' | 'blue' | 'violet' | '';
const TYPES: Record<string, { label: string; tone: Tone }> = {
  campaign_request: { label: 'Campaign Request', tone: 'violet' },
  changes_resubmitted: { label: 'Changes Resubmitted', tone: 'violet' },
  team_request: { label: 'Secondary Fundraiser Request', tone: 'violet' },
  pending_payment: { label: 'Pending Manual Payment', tone: 'amber' },
  unattributed: { label: 'Unattributed Payment', tone: 'amber' },
  returned_check: { label: 'Returned Check', tone: 'red' },
  post_dated_due: { label: 'Post-Dated Check Due', tone: 'blue' },
  voucher_overdue: { label: 'Voucher Overdue', tone: 'red' },
  pledge_overdue: { label: 'Pledge Overdue', tone: 'red' },
  stale_check: { label: 'Stale Check', tone: 'amber' },
  inactive_campaign: { label: 'Inactive Campaign', tone: '' },
  bank_reassign: { label: 'Bank Account Reassignment Needed', tone: 'red' },
};
const TypePill = ({ type }: { type: string }) => <Pill tone={TYPES[type]?.tone ?? ''}>{TYPES[type]?.label ?? type}</Pill>;

const age = (at: string) => {
  const days = Math.floor((Date.now() - new Date(at).getTime()) / 86400000);
  if (days <= 0) return 'Today';
  return days === 1 ? '1 day ago' : `${days} days ago`;
};

const columns: Column[] = [
  { key: 'task_type', label: 'Type', value: r => TYPES[r.task_type]?.label, render: r => <><TypePill type={r.task_type} />{r.held && <> <Pill>Held</Pill></>}</>, width: 210 },
  { key: 'fundraiser', label: 'Fundraiser', width: 140 },
  { key: 'campaign', label: 'Campaign', value: r => (r.campaign_id ? `${r.campaign_name ?? ''} - ${r.campaign_id}` : ''), width: 190 },
  { key: 'amount', label: 'Amount', render: r => r.amount != null && money(r.amount), align: 'right' },
  { key: 'summary', label: 'Details', width: 280 },
  { key: 'submitted_at', label: 'Date', render: r => dateTime(r.submitted_at) },
  { key: 'age', label: 'Age', value: r => age(r.submitted_at) },
];

const historyColumns: Column[] = [
  { key: 'created_at', label: 'When', render: r => dateTime(r.created_at) },
  { key: 'task_type', label: 'Type', value: r => TYPES[r.task_type]?.label, render: r => <TypePill type={r.task_type} /> },
  { key: 'summary', label: 'Details', width: 280 },
  { key: 'action', label: 'Action', value: r => r.action[0].toUpperCase() + r.action.slice(1) },
  { key: 'note', label: 'Note' },
  { key: 'acted_by', label: 'By' },
];

/** How many items wait, for the badge on the menu. Held items have been looked at, so they don't count. */
export function useTaskCount(enabled: boolean, refreshKey: unknown) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const load = () => supabase.from('admin_task_sheet').select('task_key', { count: 'exact', head: true }).eq('held', false)
      .then(({ count: n }) => setCount(n ?? 0));
    load();
    window.addEventListener('task-sheet-changed', load);
    return () => window.removeEventListener('task-sheet-changed', load);
  }, [enabled, refreshKey]);
  return count;
}

export default function TaskSheetPage() {
  const [view, setView] = useState<'pending' | 'history'>('pending');
  const [type, setType] = useState('');
  const [fundraiser, setFundraiser] = useState('');
  const [open, setOpen] = useState<Row | null>(null);
  const [version, setVersion] = useState(0);
  const q = useQuery(
    () => fetchAll((a, b) => supabase.from('admin_task_sheet').select('*').order('submitted_at').range(a, b) as never),
    [version],
  );
  const history = useQuery(
    () => (view === 'history'
      ? fetchAll((a, b) => supabase.from('task_sheet_actions').select('*').order('created_at', { ascending: false }).range(a, b) as never)
      : Promise.resolve([])),
    [view, version],
  );
  const all = (q.data as Row[]) ?? [];
  const rows = all.filter(r => (!type || r.task_type === type) && (!fundraiser || r.fundraiser === fundraiser));
  const fundraisers = [...new Set(all.map(r => r.fundraiser).filter(Boolean))].sort();
  const changed = () => { setVersion(v => v + 1); window.dispatchEvent(new Event('task-sheet-changed')); };
  const done = () => { setOpen(null); changed(); };

  return (
    <section className="view">
      <div className="tabs">
        <button className={view === 'pending' ? 'active' : ''} onClick={() => setView('pending')}>Waiting ({all.filter(r => !r.held).length})</button>
        <button className={view === 'history' ? 'active' : ''} onClick={() => setView('history')}>History</button>
      </div>
      {view === 'pending' ? (
        <DataTable
          title="Task Sheet"
          rows={rows}
          loading={q.loading}
          error={q.error}
          columns={columns}
          exportName="task-sheet"
          onOpen={setOpen}
          actions={
            <>
              <select aria-label="Type" value={type} onChange={e => setType(e.target.value)}>
                <option value="">All types</option>
                {Object.entries(TYPES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select>
              <select aria-label="Fundraiser" value={fundraiser} onChange={e => setFundraiser(e.target.value)}>
                <option value="">All fundraisers</option>
                {fundraisers.map(f => <option key={f}>{f}</option>)}
              </select>
            </>
          }
        />
      ) : (
        <DataTable title="Task history" rows={(history.data as Row[]) ?? []} loading={history.loading} error={history.error} columns={historyColumns} exportName="task-history" />
      )}
      {open && <TaskPanel item={open} onClose={() => setOpen(null)} onDone={done} onChanged={changed} />}
    </section>
  );
}

function TaskPanel({ item, onClose, onDone, onChanged }: { item: Row; onClose: () => void; onDone: () => void; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const log = (action: string, note?: string | null) =>
    supabase.rpc('log_task_action', { p_key: item.task_key, p_type: item.task_type, p_summary: item.summary, p_action: action, p_note: note ?? null });

  async function act(call: PromiseLike<{ error: { message: string } | null }>, action: string, note?: string | null) {
    setError(null);
    const { error: e } = await call;
    if (e) return setError(e.message);
    await log(action, note);
    clearLookups();
    onDone();
  }
  async function close(action: 'dismissed' | 'held', question: string) {
    const note = prompt(question);
    if (note === null) return;
    const { error: e } = await log(action, note);
    if (e) return setError(e.message);
    onDone();
  }

  // These two have full screens of their own already.
  if (item.task_type === 'pledge_overdue') {
    return <PledgeDialog id={item.record_id} onClose={onClose} onChanged={onChanged} />;
  }
  if (item.task_type === 'voucher_overdue') {
    return <VoucherDialog id={item.record_id} onClose={onClose} onChanged={onChanged} />;
  }

  const campaignLink = item.campaign_id && <Link to={`/campaigns/${encodeURIComponent(item.campaign_id)}`}>{item.campaign_name} - {item.campaign_id}</Link>;
  const dismiss = (label: string, question = 'Take this off the sheet? Add a note if useful:') => (
    <button type="button" className="btn" onClick={() => close('dismissed', question)}>{label}</button>
  );

  return (
    <Overlay onClose={onClose}>
      <div className="form-head">
        <h2><TypePill type={item.task_type} /></h2>
        <button type="button" className="icon-btn" title="Close" onClick={onClose}><X size={18} /></button>
      </div>
      <dl className="record-facts">
        {item.fundraiser && <><dt>Fundraiser</dt><dd>{item.fundraiser}</dd></>}
        {item.campaign_id && <><dt>Campaign</dt><dd>{campaignLink}</dd></>}
        {item.amount != null && <><dt>Amount</dt><dd>{money(item.amount)}</dd></>}
        <dt>Details</dt><dd>{item.summary}</dd>
        <dt>Date</dt><dd>{dateTime(item.submitted_at)} · {age(item.submitted_at)}</dd>
        {item.held_note && <><dt>Held</dt><dd>{item.held_note}</dd></>}
      </dl>
      {error && <div className="error">{error}</div>}

      {(item.task_type === 'campaign_request' || item.task_type === 'changes_resubmitted') && (
        <RequestDecision id={item.record_id} onDone={action => { void log(action).then(onDone); }} />
      )}
      {item.task_type === 'team_request' && <TeamDecision item={item} onAct={act} />}
      {item.task_type === 'pending_payment' && (
        <div className="donation-actions">
          <button type="button" className="btn primary" onClick={() => act(supabase.rpc('review_donation', { p_id: item.record_id, p_approve: true }), 'approved')}>Approve</button>
          <button type="button" className="btn danger" onClick={() => {
            const note = prompt('Reject this entry? A reason is required:');
            if (note !== null) act(supabase.rpc('review_donation', { p_id: item.record_id, p_approve: false, p_note: note }), 'rejected', note);
          }}>Reject</button>
        </div>
      )}
      {item.task_type === 'unattributed' && <UnattributedActions item={item} onAct={act} onHold={() => close('held', 'Hold this for later? It stays here, set aside. Add a note if useful:')} onSplit={onDone} log={log} />}
      {item.task_type === 'returned_check' && (
        <div className="donation-actions">{dismiss('Done', 'A follow-up task went to the fundraiser. Take this off the sheet? Add a note if useful:')}</div>
      )}
      {item.task_type === 'post_dated_due' && <div className="donation-actions">{dismiss('Deposited')}</div>}
      {item.task_type === 'stale_check' && (
        <div className="donation-actions">
          <button type="button" className="btn primary" onClick={() => act(supabase.from('expenses').update({ cleared: true }).eq('id', item.record_id), 'cleared')}>Mark cleared</button>
          {dismiss('Leave outstanding')}
        </div>
      )}
      {item.task_type === 'inactive_campaign' && (
        <div className="donation-actions">
          <button type="button" className="btn primary" onClick={() => act(supabase.from('campaigns').update({ status: 'archived' }).eq('id', item.record_id), 'archived')}>Archive campaign</button>
          {dismiss('Keep active', 'Keep it active? This comes back only if it goes quiet again after new activity. Add a note if useful:')}
        </div>
      )}
      {item.task_type === 'bank_reassign' && (
        <p className="muted">Open the campaign and choose another bank account, or clear it to use the default. This leaves the sheet once that's done.</p>
      )}
    </Overlay>
  );
}

function TeamDecision({ item, onAct }: { item: Row; onAct: (call: PromiseLike<{ error: { message: string } | null }>, action: string, note?: string | null) => void }) {
  const [role, setRole] = useState<'secondary' | 'guest'>(/ as guest$/.test(item.summary) ? 'guest' : 'secondary');
  const [note, setNote] = useState('');
  return (
    <div className="panel-box">
      <label className="field"><span>Add them as</span>
        <select value={role} onChange={e => setRole(e.target.value as 'secondary' | 'guest')}>
          <option value="secondary">Secondary fundraiser</option>
          <option value="guest">Community guest (read only)</option>
        </select>
      </label>
      <label className="field"><span>Note to the primary fundraiser</span><input value={note} onChange={e => setNote(e.target.value)} /></label>
      <div className="form-actions">
        <div className="spacer" />
        <button type="button" className="btn danger" onClick={() => onAct(supabase.rpc('decide_team_request', { p_id: item.record_id, p_approve: false, p_note: note || null }), 'rejected', note)}>Reject</button>
        <button type="button" className="btn primary" onClick={() => onAct(supabase.rpc('decide_team_request', { p_id: item.record_id, p_approve: true, p_role: role, p_note: note || null }), 'approved', note)}>Approve</button>
      </div>
    </div>
  );
}

function UnattributedActions({ item, onAct, onHold, onSplit, log }: {
  item: Row;
  onAct: (call: PromiseLike<{ error: { message: string } | null }>, action: string, note?: string | null) => void;
  onHold: () => void;
  onSplit: () => void;
  log: (action: string, note?: string | null) => PromiseLike<unknown>;
}) {
  const [options, setOptions] = useState<Option[]>([]);
  const [campaign, setCampaign] = useState<string | null>(null);
  const [fee, setFee] = useState('');
  const [splitting, setSplitting] = useState(false);
  const [record, setRecord] = useState<Row | null>(null);
  useEffect(() => {
    campaignOptions().then(setOptions);
    supabase.from('donations').select('*').eq('id', item.record_id).maybeSingle().then(({ data }) => {
      setRecord(data);
      if (data?.fee != null) setFee(String(data.fee));
    });
  }, [item.record_id]);

  return (
    <div className="panel-box">
      <label className="field"><span>Assign to campaign</span>
        <SearchSelect value={campaign} options={options} onChange={setCampaign} placeholder="Campaign, including drafts…" />
      </label>
      <label className="field"><span>Fee</span><input type="number" step="0.01" min="0" value={fee} onChange={e => setFee(e.target.value)} placeholder="Optional, can be added later" /></label>
      <div className="form-actions">
        <button type="button" className="btn" onClick={onHold}>Hold for later</button>
        {record && <button type="button" className="btn" onClick={() => setSplitting(true)}>Split across campaigns</button>}
        <div className="spacer" />
        <button type="button" className="btn primary" disabled={!campaign} onClick={() => onAct(supabase.rpc('assign_unattributed', { p_id: item.record_id, p_campaign: campaign, p_fee: fee === '' ? null : Number(fee) }), 'assigned', campaign)}>Assign</button>
      </div>
      {splitting && record && (
        <SplitDialog
          record={record}
          onClose={() => setSplitting(false)}
          onSplit={async p => {
            const { error } = await p;
            if (error) return alert(error.message);
            await log('split');
            onSplit();
          }}
        />
      )}
    </div>
  );
}
