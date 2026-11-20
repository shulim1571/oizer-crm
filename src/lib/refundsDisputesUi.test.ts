import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Readiness #17 (2026-11-15): partial refunds in the app, disputes and chargebacks.
describe('refunds, disputes and chargebacks in the app', () => {
  const actions = readFileSync('src/pages/DonationActions.tsx', 'utf8');
  it('refunds all or part of a gift by hand', () => {
    expect(actions).toContain("supabase.rpc('refund_donation', { p_id: record.id, p_date: today(), p_method: null, p_notes: notes || null, p_amount: amount })");
  });
  it('marks a card payment disputed, settles it, or records a chargeback with its fee', () => {
    expect(actions).toContain("supabase.rpc('mark_disputed'");
    expect(actions).toContain("supabase.rpc('settle_dispute'");
    expect(actions).toContain("supabase.rpc('record_chargeback'");
  });
  it('refunds part of a card payment at Sola with its amount, checked by the database first', () => {
    const fn = readFileSync('supabase/functions/payments/index.ts', 'utf8');
    expect(fn).toContain("p_amount: b.action === 'refund' && b.amount ? b.amount : null");
    expect(fn).toContain("xCommand: c.method === 'ach' ? 'check:refund' : 'cc:refund', xAmount: Number(c.amount).toFixed(2)");
    expect(readFileSync('src/pages/Payments.tsx', 'utf8')).toContain("callPayments({ action, donation_id: record.id, ...(amount ? { amount } : {}) })");
  });
  it('names the new statuses', () => {
    expect(readFileSync('src/pages/donationColumns.tsx', 'utf8')).toContain("disputed: 'Disputed', chargeback: 'Chargeback',");
  });
});
