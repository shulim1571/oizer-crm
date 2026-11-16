// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { donationKind, isUndeliveredCheck, NOT_DELIVERED } from '../pages/donationColumns';

// Readiness #36 (2026-11-15): a check recorded but not delivered yet showed as a green Completed payment.
describe('checks not delivered yet', () => {
  it('show as Not delivered, not as a payment, until delivered', () => {
    const chk = { status: 'completed', type: 'Payment', payment_method: 'Check', delivered: false };
    expect(isUndeliveredCheck(chk)).toBe(true);
    expect(donationKind(chk)).toBe(NOT_DELIVERED);
    expect(donationKind({ ...chk, delivered: true })).toBe('Payment');
    expect(donationKind({ ...chk, payment_method: 'Cash' })).toBe('Payment');
    expect(donationKind({ ...chk, status: 'refunded' })).toBe('Refunded');
  });
  it('can be picked in the type filter on Transactions, everywhere the list is used', () => {
    const d = readFileSync('src/pages/Donations.tsx', 'utf8');
    expect(d).toContain("if (kindFilter === NOT_DELIVERED) s = s.eq('undelivered_check', true);");
    expect(d).toContain('<option>{NOT_DELIVERED}</option>');
    expect(readFileSync('src/pages/donationColumns.tsx', 'utf8')).toContain('filterOptions: async () => [...Object.keys(DONATION_KINDS), NOT_DELIVERED]');
    expect(readFileSync('src/components/Pill.tsx', 'utf8')).toContain("'Not delivered': 'amber'");
  });
});
