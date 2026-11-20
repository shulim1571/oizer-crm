import { describe, expect, it } from 'vitest';
import { ADMIN, OIZER, as, rows, seededDb } from './harness';

// Readiness #59 (2026-11-15): fee % = fees / gifts raised, leaving transfers in out; checks flagged by method.
describe('campaign fee percent', () => {
  it('divides fees by gifts raised, not counting transfers in', async () => {
    const db = await seededDb();
    const pct = async () => Number((await rows<{ p: string }>(db, ADMIN, `select fee_percent p from public.campaign_summary where id = '1002'`, [], OIZER))[0].p);
    const before = await pct();
    await as(db, ADMIN, tx => tx.query(`insert into public.transfers (amount, from_campaign_id, to_campaign_id) values (5000, '1001', '1002')`), OIZER);
    expect(await pct()).toBeCloseTo(before, 6);   // a transfer in doesn't dilute the fee rate
    const [r] = await rows<{ fees: string; raised: string }>(db, ADMIN, `select fees, raised from public.campaign_summary where id = '1002'`, [], OIZER);
    expect(Number(r.raised)).toBeGreaterThan(5000);
  });
  it('marks check methods as checks', async () => {
    const db = await seededDb();
    const m = await rows<{ name: string; is_check: boolean }>(db, ADMIN, `select name, is_check from public.payment_methods where name in ('Check', 'Cash')`, [], OIZER);
    expect(Object.fromEntries(m.map(x => [x.name, x.is_check]))).toEqual({ Check: true, Cash: false });
  });
});
