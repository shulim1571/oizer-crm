/**
 * What an admin may change when editing a donation. The database enforces the same rules
 * (supabase/migrations/20261209000000_donation_edit_rules.sql); a test keeps the two lists in step.
 */

/** The statuses a donation can be moved to from the edit form, by its current status. */
export const DONATION_TRANSITIONS: Record<string, string[]> = {
  pending: ['completed', 'rejected'],
  post_dated: ['completed', 'voided', 'returned'],
  collect: ['completed', 'voided', 'failed', 'refunded', 'returned'],
  completed: ['voided', 'refunded', 'returned', 'collect'],
  failed: [],
  rejected: [],
  voided: [],
  refunded: [],
  returned: [],
};

/** Fields the card processor decides on a donation it handled. */
export const PROCESSOR_FIELDS = ['status', 'amount', 'payment_method', 'fee', 'manual_fee', 'created_at'];

export function allowedStatuses(current: string | null | undefined): string[] {
  if (!current) return Object.keys(DONATION_TRANSITIONS);
  return [current, ...(DONATION_TRANSITIONS[current] ?? [])];
}
