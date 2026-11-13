import { useEffect, useState } from 'react';
import SearchSelect from '../components/SearchSelect';
import { campaignOptions, clearLookups, type Option } from '../lib/lookups';
import { supabase, type Row } from '../lib/supabase';

/*
 * Bulk edit on the Task Sheet (Moshe Henig, 2026-11-12): pick several tasks and apply one action to all of them.
 * Each action is the same call the task's own panel makes, run once per task, and each success is logged in History
 * the same way. Only actions that fit every selected task are offered, so a mixed selection can't do the wrong thing
 * to some of them. Decisions that need a person to look at each one (requests, receipts, checks to print) stay one
 * at a time.
 */

type Call = PromiseLike<{ error: { message: string } | null }>;
export type BulkAction = {
  key: string;
  label: string;
  /** Task types it applies to; every selected task must be one of them. */
  types: string[];
  /** Logged in History for each task. */
  logAs: string;
  primary?: boolean;
  /** Asks for a note, logged with each task (null: no note). */
  note?: string;
  needsCampaign?: boolean;
  run?: (task: Row, campaign: string | null) => Call;
};

/** Task types whose panel has a "take it off the sheet" button. */
const DISMISSABLE = ['returned_check', 'ach_returned', 'post_dated_due', 'stale_check', 'inactive_campaign', 'delivery_failed', 'bank_move_needed'];

export const BULK_ACTIONS: BulkAction[] = [
  { key: 'archive', label: 'Archive campaigns', types: ['inactive_campaign'], logAs: 'archived', primary: true,
    run: t => supabase.from('campaigns').update({ status: 'archived' }).eq('id', t.record_id) },
  { key: 'assign', label: 'Assign to campaign', types: ['unattributed'], logAs: 'assigned', primary: true, needsCampaign: true,
    // Fee left as it is on each payment (null keeps it), as when assigning one with the fee box empty.
    run: (t, campaign) => supabase.rpc('assign_unattributed', { p_id: t.record_id, p_campaign: campaign, p_fee: null }) },
  { key: 'approve', label: 'Approve', types: ['pending_payment'], logAs: 'approved', primary: true,
    run: t => supabase.rpc('review_donation', { p_id: t.record_id, p_approve: true }) },
  { key: 'cleared', label: 'Mark cleared', types: ['stale_check'], logAs: 'cleared', primary: true,
    run: t => supabase.from('expenses').update({ cleared: true }).eq('id', t.record_id) },
  { key: 'hold', label: 'Hold for later', types: ['unattributed'], logAs: 'held', note: 'Hold these for later? They stay on the sheet, set aside. Add a note if useful:' },
  { key: 'dismiss', label: 'Take off the sheet', types: DISMISSABLE, logAs: 'dismissed', note: 'Take these off the sheet? Add a note if useful:' },
];

/** The actions that fit every selected task. */
export const actionsFor = (types: string[]) =>
  types.length === 0 ? [] : BULK_ACTIONS.filter(a => types.every(t => a.types.includes(t)));

export type BulkResult = { label: string; ok: number; failed: string[] };

export default function TaskBulk({ tasks, onClear, onDone }: { tasks: Row[]; onClear: () => void; onDone: (r: BulkResult) => void }) {
  const actions = actionsFor([...new Set(tasks.map(t => String(t.task_type)))]);
  const [campaign, setCampaign] = useState<string | null>(null);
  const [options, setOptions] = useState<Option[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const wantsCampaign = actions.some(a => a.needsCampaign);
  useEffect(() => { if (wantsCampaign) campaignOptions().then(setOptions); }, [wantsCampaign]);

  async function apply(a: BulkAction) {
    let note: string | null = null;
    if (a.note) {
      note = prompt(a.note);
      if (note === null) return;
    } else if (!confirm(`${a.label}: ${tasks.length} task${tasks.length === 1 ? '' : 's'}?`)) return;
    setBusy(a.key);
    let ok = 0;
    const failed: string[] = [];
    for (const t of tasks) {
      const { error } = a.run ? await a.run(t, campaign) : { error: null };
      if (error) { failed.push(`${t.summary ?? t.task_key}: ${error.message}`); continue; }
      const { error: logError } = await supabase.rpc('log_task_action', {
        p_key: t.task_key, p_type: t.task_type, p_summary: t.summary, p_action: a.logAs, p_note: a.needsCampaign ? campaign : note || null,
      });
      if (logError) { failed.push(`${t.summary ?? t.task_key}: ${logError.message}`); continue; }
      ok++;
    }
    clearLookups();
    setBusy(null);
    onDone({ label: a.label, ok, failed });
  }

  return (
    <div className="bulk-bar task-bulk">
      <b>{tasks.length} selected</b>
      <button type="button" className="link" onClick={onClear}>Clear</button>
      <div className="spacer" />
      {actions.some(a => a.needsCampaign) && (
        <div className="type-pick"><SearchSelect value={campaign} options={options} onChange={setCampaign} placeholder="Campaign, including drafts…" /></div>
      )}
      {actions.map(a => (
        <button key={a.key} type="button" className={`btn ${a.primary ? 'primary' : ''}`} disabled={!!busy || (a.needsCampaign && !campaign)}
          onClick={() => apply(a)}>{busy === a.key ? 'Working…' : a.label}</button>
      ))}
      {actions.length === 0 && (
        <p className="muted small">No action fits all of these together. Pick tasks of one kind, such as inactive campaigns or unattributed payments; requests, receipts and checks are handled one at a time.</p>
      )}
    </div>
  );
}
