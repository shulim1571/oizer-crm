import { useState } from 'react';
import { dateTime, money } from '../lib/format';
import { supabase, type Row } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';

/*
 * Readable history (readiness #46): who changed what and when, field by field, old to new, for a donation, payout or
 * transfer. Admins see everything; a fundraiser sees their own campaigns' records, without bank or payee details
 * (the database decides, record_history). The Activity Log page uses the same wording.
 */

const LABELS: Record<string, string> = {
  amount: 'Amount', fee: 'Fee', manual_fee: 'Manual fee', net_donation: 'Net', chargeback_fee: 'Chargeback fee', funded: 'Funded',
  payment_method: 'Payment method', method: 'Method', campaign_id: 'Campaign', from_campaign_id: 'From campaign', to_campaign_id: 'To campaign',
  donor_id: 'Donor', donor_label: 'Donor', name: 'Name', status: 'Status', type: 'Type', notes: 'Notes', description: 'Memo', memo: 'Memo',
  created_at: 'Date', check_number: 'Check #', check_date: 'Check date', post_dated: 'Post-dated', delivered: 'Delivered',
  source: 'Source', anonymous: 'Anonymous', possible_duplicate: 'Possible duplicate', payee: 'To', scheduled_for: 'Scheduled for',
  processed_at: 'Processed', cleared: 'Cleared', reversal_date: 'Reversal date', reversal_reason: 'Reason', reversal_notes: 'Reversal notes',
  split_group_id: 'Split', deleted_at: 'Deleted', voucher_id: 'Voucher', batch_id: 'Batch', email: 'Email', phone: 'Phone', cell_phone: 'Cell phone', home_phone: 'Home phone',
};
const MONEY = new Set(['amount', 'fee', 'manual_fee', 'net_donation', 'chargeback_fee', 'funded', 'batch_pending']);
const SKIP = new Set(['id', 'org_id', 'updated_at', 'search_text']);

export const fieldLabel = (k: string) => LABELS[k] ?? k.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());

/** One value, as people read it. */
export function showValue(k: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return '(empty)';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (MONEY.has(k) && !Number.isNaN(Number(v))) return money(Number(v));
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return dateTime(v);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

const ACTIONS: Record<string, string> = {
  insert: 'Created', update: 'Changed', delete: 'Deleted', soft_delete: 'Deleted', restore: 'Restored',
  fee_difference_applied: 'Real processor fee applied', pledge_payment_removed: 'Pledge payment removed',
};
export const actionLabel = (a: string) => ACTIONS[a] ?? a.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());

/** The changes in an entry as readable lines: "Amount: $100.00 → $120.00" for an edit, the values for a new record. */
export function describeChanges(action: string, changes: Row | null): string[] {
  if (!changes) return [];
  const entries = Object.entries(changes).filter(([k]) => !SKIP.has(k));
  if (action === 'update') {
    return entries.map(([k, v]) => `${fieldLabel(k)}: ${showValue(k, (v as Row)?.old)} → ${showValue(k, (v as Row)?.new)}`);
  }
  if (action === 'soft_delete' || action === 'restore') return [];
  return entries.filter(([, v]) => v !== null && v !== '' && v !== false).map(([k, v]) => `${fieldLabel(k)}: ${showValue(k, v)}`);
}

export default function RecordHistory({ table, id }: { table: 'donations' | 'expenses' | 'transfers'; id: string }) {
  const [open, setOpen] = useState(false);
  const q = useQuery(async () => (open ? (((await supabase.rpc('record_history', { p_table: table, p_id: id })).data ?? []) as Row[]) : null), [table, id, open]);
  return (
    <details className="record-history" onToggle={e => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>History</summary>
      {q.loading && open && <p className="muted small">Loading…</p>}
      {(q.data ?? []).length === 0 && !q.loading && open && <p className="muted small">No changes recorded.</p>}
      <ol>
        {(q.data ?? []).map((h, i) => (
          <li key={i}>
            <div className="small"><b>{actionLabel(h.action)}</b> · {h.who} · <span className="muted">{dateTime(h.created_at)}</span></div>
            {h.action === 'update'
              ? <ul>{describeChanges(h.action, h.changes).map((line, j) => <li key={j} className="small">{line}</li>)}</ul>
              : null}
          </li>
        ))}
      </ol>
    </details>
  );
}
