import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { X } from 'lucide-react';
import DataTable, { type Column } from '../components/DataTable';
import SearchSelect from '../components/SearchSelect';
import { Balance, Pill } from '../components/Pill';
import RecordForm from '../components/RecordForm';
import CampaignName from '../components/CampaignName';
import { dateTime, money } from '../lib/format';
import { campaignOptions, clearLookups, type Option } from '../lib/lookups';
import { fetchAll, supabase, type Row } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';
import { editDonationFields } from '../lib/schemas';
import { DONATION_SELECT } from './donationColumns';
import { SplitDialog } from './DonationActions';
import { BookingActions } from './Machines';
import { ApprovePayout, ProcessScheduled } from './Payouts';
import { printReceipts, receiptDocument } from './Receipts';
import { PayoutPrintTask, UnprintedCheckTask } from './Checks';
import { ImportConflict } from './Imports';
import { DeliveryFailed, SendDocumentDialog } from './Messaging';
import { RecurringFailed } from './Recurring';
import { Overlay, PledgeDialog } from './Pledges';
import { RequestDecision } from './Requests';
import { VoucherDialog } from './Vouchers';
import TaskBulk, { type BulkResult } from './TaskBulk';

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
  check_to_print: { label: 'Check To Print', tone: 'amber' },
  check_unprinted: { label: 'Check Not Printed', tone: 'amber' },
  inactive_campaign: { label: 'Inactive Campaign', tone: '' },
  bank_reassign: { label: 'Bank Account Reassignment Needed', tone: 'red' },
  machine_booking: { label: 'Machine Request', tone: 'blue' },
  payout_request: { label: 'Payout Request', tone: 'violet' },
  scheduled_payout: { label: 'Scheduled Payout Due', tone: 'amber' },
  receipt_text_missing: { label: 'Receipt Text Not Set Up', tone: 'amber' },
  receipt_reissue: { label: 'Corrected Receipt Needed', tone: 'red' },
  import_conflict: { label: 'Import Data Conflict', tone: 'amber' },
  delivery_failed: { label: 'Delivery Failed', tone: 'red' },
  receipt_requested: { label: 'Receipt Requested', tone: 'blue' },
  recurring_failed: { label: 'Recurring Charge Failed', tone: 'red' },
  ach_returned: { label: 'Bank Payment Returned', tone: 'red' },
  bank_move_needed: { label: 'Bank Transfer Needed', tone: 'amber' },
};
/** Tasks whose record is a transaction (donation): those can be edited or deleted from the sheet. */
const TRANSACTION_TASKS = new Set(['pending_payment', 'unattributed', 'returned_check', 'post_dated_due', 'ach_returned', 'receipt_requested']);
const TypePill = ({ type }: { type: string }) => <Pill tone={TYPES[type]?.tone ?? ''}>{TYPES[type]?.label ?? type}</Pill>;

const age = (at: string) => {
  const days = Math.floor((Date.now() - new Date(at).getTime()) / 86400000);
  if (days <= 0) return 'Today';
  return days === 1 ? '1 day ago' : `${days} days ago`;
};

/** The office's (internal) name for a task's campaign. */
const campaignLabel = (r: Row) => String(r.campaign?.internal_name || r.campaign_name || r.campaign?.campaign_name || '');

/** Adds each task's campaign details (names, featured), so the Campaign column can show it as the Campaigns list does. */
async function withCampaigns(tasks: Row[]): Promise<Row[]> {
  const ids = [...new Set(tasks.map(t => t.campaign_id).filter(Boolean))] as string[];
  if (!ids.length) return tasks;
  const found = await fetchAll((a, b) => supabase.from('campaigns').select('id, internal_name, campaign_name, external_name, featured').in('id', ids).order('id').range(a, b) as never);
  const byId = new Map(found.map(c => [String(c.id), c]));
  return tasks.map(t => (t.campaign_id && byId.has(String(t.campaign_id)) ? { ...t, campaign: byId.get(String(t.campaign_id)) } : t));
}

const columns: Column[] = [
  { key: 'task_type', label: 'Type', value: r => TYPES[r.task_type]?.label, render: r => <><TypePill type={r.task_type} />{r.held && <> <Pill>Held</Pill></>}</>, width: 210 },
  { key: 'fundraiser', label: 'Fundraiser', width: 140 },
  // As in the Campaigns list: internal name, public name under it, and the ID (Moshe Henig, 2026-11-12).
  { key: 'campaign', label: 'Campaign', campaignLink: (r: Row) => r.campaign_id, width: 200,
    value: r => (r.campaign_id ? `${campaignLabel(r)} - ${r.campaign_id}` : ''),
    render: r => r.campaign_id && (
      <div className="campaign-cell"><CampaignName c={r.campaign ?? { internal_name: r.campaign_name }} /><span className="id-tag">{r.campaign_id}</span></div>
    ) },
  { key: 'amount', label: 'Amount', render: r => r.amount != null && money(r.amount), align: 'right' },
  { key: 'summary', label: 'Details', width: 280, long: true },
  { key: 'submitted_at', label: 'Date', render: r => dateTime(r.submitted_at) },
  { key: 'age', label: 'Age', value: r => age(r.submitted_at) },
];

const historyColumns: Column[] = [
  { key: 'created_at', label: 'When', render: r => dateTime(r.created_at) },
  { key: 'task_type', label: 'Type', value: r => TYPES[r.task_type]?.label, render: r => <TypePill type={r.task_type} /> },
  { key: 'summary', label: 'Details', width: 280, long: true },
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
    async () => withCampaigns(await fetchAll((a, b) => supabase.from('admin_task_sheet').select('*').order('submitted_at').range(a, b) as never)),
    [version],
  );
  // New tasks show without a refresh: reload when anything changes tasks (a payout saved, a check voided...) and when
  // you come back to this tab (Moshe Henig, 2026-11-11).
  // Quietly: the rows stay on screen while the fresh list loads, so nothing flashes and the scroll position, open
  // task and ticked rows stay put (Moshe Henig, 2026-11-12).
  const reloadQuiet = useRef<() => void>(() => {});
  useEffect(() => {
    const again = () => reloadQuiet.current();
    const back = () => { if (document.visibilityState === 'visible') again(); };
    window.addEventListener('task-sheet-changed', again);
    document.addEventListener('visibilitychange', back);
    return () => { window.removeEventListener('task-sheet-changed', again); document.removeEventListener('visibilitychange', back); };
  }, []);
  const history = useQuery(
    () => (view === 'history'
      ? fetchAll((a, b) => supabase.from('task_sheet_actions').select('*').order('created_at', { ascending: false }).range(a, b) as never)
      : Promise.resolve([])),
    [view, version],
  );
  reloadQuiet.current = () => { void q.reload({ quiet: true }); if (view === 'history') void history.reload({ quiet: true }); };
  // Rows carry their task key as id, which is what the table's checkboxes go by (bulk edit).
  const all: Row[] = ((q.data as Row[]) ?? []).map(r => ({ ...r, id: r.task_key }));
  const rows = all.filter(r => (!type || r.task_type === type) && (!fundraiser || r.fundraiser === fundraiser));
  const fundraisers = [...new Set(all.map(r => r.fundraiser).filter(Boolean))].sort();
  const changed = () => window.dispatchEvent(new Event('task-sheet-changed'));   // the listener above reloads
  const done = () => { setOpen(null); changed(); };
  // Bulk edit (Moshe Henig, 2026-11-12): the tasks ticked, kept to those still waiting and shown by the filters.
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [bulkResult, setBulkResult] = useState<BulkResult | null>(null);
  const selectedTasks = rows.filter(r => picked.has(r.task_key));
  const onSelect = (list: Row[], on: boolean) => setPicked(prev => {
    const next = new Set(prev);
    for (const r of list) { if (on) next.add(r.task_key); else next.delete(r.task_key); }
    return next;
  });

  return (
    <section className="view">
      <div className="tabs">
        <button className={view === 'pending' ? 'active' : ''} onClick={() => setView('pending')}>Waiting ({all.filter(r => !r.held).length})</button>
        <button className={view === 'history' ? 'active' : ''} onClick={() => setView('history')}>History</button>
      </div>
      {view === 'pending' && bulkResult && (
        <div className={bulkResult.failed.length ? 'error' : 'notice'}>
          {bulkResult.label}: {bulkResult.ok} done{bulkResult.failed.length ? `, ${bulkResult.failed.length} not done:` : '.'}
          {bulkResult.failed.length > 0 && <ul>{bulkResult.failed.map(f => <li key={f}>{f}</li>)}</ul>}
          {' '}<button type="button" className="link" onClick={() => setBulkResult(null)}>Dismiss</button>
        </div>
      )}
      {view === 'pending' && selectedTasks.length > 0 && (
        <TaskBulk tasks={selectedTasks} onClear={() => setPicked(new Set())}
          onDone={r => { setPicked(new Set()); setBulkResult(r); changed(); }} />
      )}
      {view === 'pending' ? (
        <DataTable
          title="Task Sheet"
          rows={rows}
          loading={q.loading}
          error={q.error}
          columns={columns}
          exportName="task-sheet"
          onOpen={setOpen}
          selected={picked}
          onSelect={onSelect}
          actions={
            <>
              <div className="type-pick">
                <SearchSelect value={type || null} placeholder="All types"
                  options={Object.entries(TYPES).map(([k, v]) => ({ value: k, label: v.label }))} onChange={v => setType(v ?? '')} />
              </div>
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

  const campaignLink = item.campaign_id && <Link to={`/campaigns/${encodeURIComponent(item.campaign_id)}`}>{campaignLabel(item)} - {item.campaign_id}</Link>;
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
      {item.task_type === 'inactive_campaign' && <CampaignBalanceFacts campaignId={item.record_id} />}

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
      {item.task_type === 'ach_returned' && (
        <>
          <p className="muted">The bank sent this ACH debit back, so the gift is marked returned and its money is off the campaign. Reach the donor for another way to give.</p>
          <div className="donation-actions">{dismiss('Done', 'Take this off the sheet? Say how it was handled, for example "donor paid by card":')}</div>
        </>
      )}
      {item.task_type === 'post_dated_due' && <div className="donation-actions">{dismiss('Deposited')}</div>}
      {item.task_type === 'check_to_print' && <PayoutPrintTask payoutId={item.record_id} onDone={onDone} />}
      {item.task_type === 'check_unprinted' && <UnprintedCheckTask checkId={item.record_id} onDone={onDone} />}
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
      {item.task_type === 'machine_booking' && <MachineRequest item={item} onAct={act} />}
      {item.task_type === 'payout_request' && <ApprovePayout requestId={item.record_id} onAct={act} />}
      {item.task_type === 'receipt_text_missing' && <p><Link to="/receipt-text">Set up the receipt text</Link>. This leaves the sheet once it is saved.</p>}
      {item.task_type === 'import_conflict' && <ImportConflict conflictId={item.record_id} onAct={act} />}
      {item.task_type === 'receipt_reissue' && <ReissueReceipt receiptId={item.record_id} onAct={act} />}
      {item.task_type === 'scheduled_payout' && <ProcessScheduled payoutId={item.record_id} onAct={act} />}
      {item.task_type === 'recurring_failed' && <RecurringFailed id={item.record_id} onDone={onDone} />}
      {item.task_type === 'receipt_requested' && <ReceiptRequest item={item} onDone={() => { void log('receipt_sent').then(onDone); }}
        onHandled={() => { void log('done', 'Handled another way').then(onDone); }} />}
      {item.task_type === 'delivery_failed' && (
        <>
          <DeliveryFailed messageId={item.record_id} onDone={() => { void log('resent').then(onDone); }} />
          <div className="donation-actions">{dismiss('Handled another way', 'Take this off the sheet? Say how it was handled, for example "called the donor":')}</div>
        </>
      )}
      {item.task_type === 'bank_move_needed' && (
        <>
          <p className="muted">This campaign transfer moved money between campaigns on different bank accounts, so the money has to move between the banks too. Record it under <Link to="/reconciliation">Bank Reconciliation → Between accounts</Link>; this leaves the sheet once it's recorded.</p>
          <div className="donation-actions">{dismiss('Not needed', 'Take this off the sheet without recording a bank transfer? Say why:')}</div>
        </>
      )}
      {item.task_type === 'bank_reassign' && (
        <p className="muted">Open the campaign and choose another bank account, or clear it to use the default. This leaves the sheet once that's done.</p>
      )}
      {TRANSACTION_TASKS.has(item.task_type) && (
        <EditTransaction donationId={item.record_id}
          onSaved={deleted => { void log(deleted ? 'deleted' : 'edited').then(onDone); }} />
      )}
    </Overlay>
  );
}

/** A donor asked for a receipt on the thank-you page: issue it (or use the one already issued) and send it where they asked. */
function ReceiptRequest({ item, onDone, onHandled }: { item: Row; onDone: () => void; onHandled: () => void }) {
  const q = useQuery(async () => {
    const [t, r, d] = await Promise.all([
      supabase.from('task_items').select('detail').eq('task_key', item.task_key).maybeSingle(),
      supabase.from('receipts').select('id, receipt_number, donor_id, campaign_id').contains('donation_ids', [item.record_id]).eq('status', 'issued').maybeSingle(),
      supabase.from('donations').select('donor_id, campaign_id').eq('id', item.record_id).maybeSingle(),
    ]);
    return { to: (t.data?.detail ?? {}) as Row, receipt: r.data as Row | null, donation: d.data as Row | null };
  }, [item.task_key]);
  const [sending, setSending] = useState<Row | null>(null);
  const [error, setError] = useState<string | null>(null);
  const info = q.data as { to: Row; receipt: Row | null; donation: Row | null } | null;
  if (!info) return null;
  async function start() {
    setError(null);
    let receipt = info!.receipt;
    if (!receipt) {
      const { data, error: e } = await supabase.rpc('issue_receipt', { p_donation: item.record_id });
      if (e) return setError(e.message);
      receipt = (await supabase.from('receipts').select('id, receipt_number, donor_id, campaign_id').eq('id', data).maybeSingle()).data as Row;
    }
    setSending(receipt);
  }
  return (
    <div className="panel-box">
      <p className="muted small">They asked for it by {[info.to.email && `email to ${info.to.email}`, info.to.phone && `text to ${info.to.phone}`].filter(Boolean).join(' and ')}.
        {info.receipt ? ` Receipt ${info.receipt.receipt_number} is already issued.` : ' A receipt is issued first.'}</p>
      {error && <div className="error">{error}</div>}
      <div className="form-actions">
        <button type="button" className="btn" title="For a receipt printed or handed over in person"
          onClick={async () => {
            if (!confirm('Take this request off the Task Sheet without sending a receipt from here?')) return;
            const { error: e } = await supabase.rpc('resolve_task_item', { p_key: item.task_key });
            if (e) return setError(e.message);
            onHandled();
          }}>Handled another way</button>
        <div className="spacer" /><button type="button" className="btn primary" onClick={start}>{info.receipt ? 'Send the receipt' : 'Issue and send the receipt'}</button></div>
      {sending && (
        <SendDocumentDialog kind="receipt" recordId={sending.id} donorId={sending.donor_id ?? info.donation?.donor_id ?? null} campaignId={sending.campaign_id}
          title={sending.receipt_number} build={() => receiptDocument(sending.id)} to={{ email: info.to.email, phone: info.to.phone }}
          onClose={() => { setSending(null); onDone(); }} />
      )}
    </div>
  );
}

function MachineRequest({ item, onAct }: { item: Row; onAct: (call: PromiseLike<{ error: { message: string } | null }>, action: string, note?: string | null) => void }) {
  const q = useQuery(async () => (await supabase.from('machine_booking_list').select('*').eq('id', item.record_id).maybeSingle()).data as Row | null, [item.record_id]);
  const b = q.data as Row | null;
  if (!b) return null;
  return (
    <>
      <p className="muted small">Number {b.queue_position} in line that day{b.notes ? ` · ${b.notes}` : ''}. <Link to="/calendar">See the calendar</Link></p>
      <BookingActions booking={b} onAct={onAct} />
    </>
  );
}

function ReissueReceipt({ receiptId, onAct }: { receiptId: string; onAct: (call: PromiseLike<{ error: { message: string } | null }>, action: string, note?: string | null) => void }) {
  const q = useQuery(async () => (await supabase.from('receipts').select('donation_id, receipt_number').eq('id', receiptId).maybeSingle()).data as Row | null, [receiptId]);
  if (!q.data) return null;
  return (
    <div className="panel-box">
      <p className="muted small">Issue a new receipt for the donation as it is now. It prints straight away.</p>
      <div className="form-actions"><div className="spacer" />
        <button type="button" className="btn primary" onClick={() => onAct(supabase.rpc('issue_receipt', { p_donation: q.data!.donation_id }).then(async r => { if (!r.error) await printReceipts([r.data as string]); return r; }), 'reissued')}>Issue corrected receipt</button>
      </div>
    </div>
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

/**
 * Edit or delete the transaction behind a task (Moshe Henig, 2026-11-12), with the same form as the Transactions list:
 * Delete asks for a reason and keeps the transaction on file, exactly as it does there. After a save the sheet reloads,
 * so the task stays, changes or goes according to the transaction as it is now; the History tab records it.
 */
function EditTransaction({ donationId, onSaved }: { donationId: string; onSaved: (deleted: boolean) => void }) {
  const [record, setRecord] = useState<Row | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function start() {
    setError(null);
    const { data, error: e } = await supabase.from('donations').select(DONATION_SELECT).eq('id', donationId).maybeSingle();
    if (e) return setError(e.message);
    if (!data) return setError('This transaction is no longer on file.');
    setRecord(data as Row);
  }
  return (
    <>
      {error && <div className="error">{error}</div>}
      <div className="form-actions"><div className="spacer" />
        <button type="button" className="btn" onClick={start}>Edit or delete transaction</button>
      </div>
      {record && (
        <RecordForm table="donations" title="Edit Donation" fields={editDonationFields} record={record} allowDelete
          onClose={() => setRecord(null)}
          onSaved={row => { setRecord(null); onSaved(!!row._deleted); }} />
      )}
    </>
  );
}

/** An inactive campaign's balance, the same figures as the top of its campaign page (Moshe Henig, 2026-11-12). */
function CampaignBalanceFacts({ campaignId }: { campaignId: string }) {
  const q = useQuery(async () => {
    const { data, error } = await supabase.from('campaign_summary')
      .select('balance, balance_mode, combined_raised, combined_fees, combined_expenses, pending_balance, post_dated_amount, awaiting_approval, pledged_open, last_donation_at')
      .eq('id', campaignId).maybeSingle();
    if (error) throw new Error(error.message);
    return data as Row | null;
  }, [campaignId]);
  const c = q.data as Row | null | undefined;
  if (q.error) return <div className="error">{String(q.error)}</div>;
  if (!c) return q.loading ? <p className="muted small">Loading the balance…</p> : null;
  return (
    <div className="panel-box">
      <h3>Campaign balance</h3>
      <dl className="record-facts">
        <dt>Balance</dt><dd>{c.balance_mode === 'shared' ? <span className="muted">Shared: counted in the parent's balance</span> : <Balance value={c.balance} />}</dd>
        <dt>Raised</dt><dd>{money(c.combined_raised)}</dd>
        <dt>Fees</dt><dd>{money(c.combined_fees)}</dd>
        <dt>Expenses</dt><dd>{money(c.combined_expenses)}</dd>
        {Number(c.pending_balance) > 0 && <><dt>Pending</dt><dd>{money(c.pending_balance)} <span className="muted small">not in the balance yet</span></dd></>}
        {Number(c.post_dated_amount) > 0 && <><dt>Post-dated checks</dt><dd>{money(c.post_dated_amount)} <span className="muted small">not in the balance yet</span></dd></>}
        {Number(c.awaiting_approval) > 0 && <><dt>Awaiting approval</dt><dd>{money(c.awaiting_approval)} <span className="muted small">not in the balance yet</span></dd></>}
        {Number(c.pledged_open) > 0 && <><dt>Pledged (open)</dt><dd>{money(c.pledged_open)} <span className="muted small">not in the balance</span></dd></>}
        <dt>Last gift</dt><dd>{c.last_donation_at ? dateTime(c.last_donation_at) : 'None yet'}</dd>
      </dl>
    </div>
  );
}
