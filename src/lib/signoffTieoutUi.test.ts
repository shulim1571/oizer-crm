import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Readiness #29 (2026-11-15): the books next to the adjusted bank balance when signing off, and in the printout.
describe('sign-off tie-out on the page', () => {
  const r = readFileSync('src/pages/Reconciliation.tsx', 'utf8');
  it('shows the books, the adjusted bank balance and any difference before signing off', () => {
    expect(r).toContain("await rpc('recon_tieout', { p_account: account, p_period_end: end, p_statement_balance: Number(balance),");
    expect(r).toContain('Books: <b>{money(tie.data.book_balance)}</b> · Adjusted bank balance: <b>{money(tie.data.adjusted_balance)}</b>');
  });
  it('prints the book balance and difference with the period', () => {
    expect(r).toContain("[['Book balance', money(r.book_balance)] as [string, string], ['Difference', money(r.book_difference)] as [string, string]]");
  });
});
