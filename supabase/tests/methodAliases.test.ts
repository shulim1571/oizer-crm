import { describe, expect, it } from 'vitest';
import { ADMIN, OIZER, rows, seededDb } from './harness';

// Readiness #57 (2026-11-15): imported method names grouped under the standard method on the dashboard chart.
describe('imported method names on the dashboard chart', () => {
  it('group under the standard method, put payouts aside, and leave fees alone', async () => {
    const db = await seededDb();
    const add = (id: string, method: string, amount: number) => db.query(
      `insert into public.donations (org_id, id, campaign_id, type, status, amount, manual_fee, payment_method) values ($1, $2, '1001', 'Payment', 'completed', $3, 0, $4)`, [OIZER, id, amount, method]);
    await add('al-1', 'Credit Card VISA', 100);
    await add('al-2', 'usaepay', 50);
    await add('al-3', 'Stripe Payout- AB Charity', 30);
    await rows(db, ADMIN, `insert into public.payment_method_aliases (alias, method_name) values ('Credit Card VISA', 'Credit Card'), ('usaepay', 'Credit Card')`, [], OIZER);
    await rows(db, ADMIN, `insert into public.payment_method_aliases (alias, not_a_method) values ('Stripe Payout- AB Charity', true)`, [], OIZER);
    const [{ s }] = await rows<{ s: any }>(db, ADMIN, `select public.dashboard_stats(public.org_today() - 1, public.org_today()) s`, [], OIZER);
    const m = Object.fromEntries((s.methods as any[]).map(x => [x.name, Number(x.total)]));
    expect(m['Credit Card']).toBeGreaterThanOrEqual(150);
    expect(m['Credit Card VISA']).toBeUndefined();
    expect(m['Not a way of giving']).toBe(30);
    const [{ f }] = (await db.query<{ f: string }>(`select fee::text f from public.donations where id = 'al-1'`)).rows;
    expect(f).toBe('0.00');
  });
});
