import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { describeChanges, fieldLabel, showValue } from './RecordHistory';

// Readiness #46 (2026-11-15): history in words, not raw key/value pairs.
describe('readable history', () => {
  it('writes an edit as field: old → new, with money, dates and yes/no as people read them', () => {
    expect(describeChanges('update', { amount: { old: 100, new: 120 }, delivered: { old: false, new: true }, notes: { old: null, new: 'Fixed' } }))
      .toEqual(['Amount: $100.00 → $120.00', 'Delivered: No → Yes', 'Notes: (empty) → Fixed']);
    expect(fieldLabel('payment_method')).toBe('Payment method');
    expect(fieldLabel('some_new_field')).toBe('Some new field');
    expect(showValue('fee', '2.73')).toBe('$2.73');
  });
  it('lists what a new record had, skipping empty values and internal ids', () => {
    expect(describeChanges('insert', { id: 'x', org_id: 'o', amount: 50, notes: null, anonymous: false, payment_method: 'Cash' }))
      .toEqual(['Amount: $50.00', 'Payment method: Cash']);
  });
  it('is on donations (read-only view, edit form, fundraiser view), payouts and transfers, and on the Activity Log', () => {
    expect(readFileSync('src/components/DonationView.tsx', 'utf8')).toContain('<RecordHistory table="donations" id={String(row.id)} />');
    expect(readFileSync('src/components/RecordForm.tsx', 'utf8')).toContain("(p.table === 'donations' || p.table === 'expenses' || p.table === 'transfers') && !isNew");
    expect(readFileSync('src/pages/Donations.tsx', 'utf8')).toContain('<RecordHistory table="donations" id={String(row.id)} />');
    expect(readFileSync('src/pages/Activity.tsx', 'utf8')).toContain("describeChanges(r.action, r.changes as Row | null).join('; ')");
  });
});
