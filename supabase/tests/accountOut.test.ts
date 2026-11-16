import { describe, expect, it } from 'vitest';
import { ADMIN, OIZER, rows, seededDb } from './harness';

// Readiness #61 (2026-11-15): payouts out shown positive; money that came back is its own figure.
describe('bank account totals', () => {
  it('show payouts out as a positive figure and what came back separately', async () => {
    const db = await seededDb();
    await db.query(`insert into public.expenses (org_id, id, campaign_id, amount, account_id) values ($1, 'ao-1', '1001', -500, 'a1')`, [OIZER]);
    const [a] = await rows<Record<string, string>>(db, ADMIN, `select payouts_out, returned_in, expenses_total from public.account_summary where id = 'a1'`, [], OIZER);
    expect(Number(a.payouts_out)).toBeGreaterThan(0);
    expect(Number(a.returned_in)).toBe(500);
    expect(Number(a.payouts_out) - Number(a.returned_in)).toBeCloseTo(Number(a.expenses_total), 2);
  });
});
