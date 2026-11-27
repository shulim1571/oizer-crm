import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Readiness #60 (2026-11-15): one click to record a bank fee or interest; a daily automatic Plaid sync.
describe('bank feed on the page and in the function', () => {
  it('records a bank line as a bank fee or interest in one click', () => {
    const r = readFileSync('src/pages/Reconciliation.tsx', 'utf8');
    expect(r).toContain("{l.amount < 0 ? 'Bank fee' : 'Interest'}</button>");
    expect(r).toContain("p_difference_type: fee ? 'bank_fee' : 'interest'");
  });
  it('syncs every linked account from the daily job, with the cron token', () => {
    const f = readFileSync('supabase/functions/plaid/index.ts', 'utf8');
    expect(f).toContain("if (cron && b.action === 'sync_all') {");
    expect(f).toContain("await rpc('check_cron_token', { p_token: cron }, null) !== true");
  });
});
