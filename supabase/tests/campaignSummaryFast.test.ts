import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, OIZER, rows, seededDb } from './harness';

// Moshe Henig, 2026-11-16: the Campaigns list was slow (~0.5 s in the database, mostly campaign_summary adding up
// donations with every sum re-testing every row). Each row's flags are now worked out once. Same numbers.
const q = <T = Record<string, any>>(db: PGlite, sql: string) => rows<T>(db, ADMIN, sql, [], OIZER);

describe('campaign balances, worked out faster', () => {
  let base: PGlite;
  let db: PGlite;
  beforeAll(async () => { base = await seededDb(); });
  beforeEach(async () => { db = await base.clone(); });

  it('add up each kind of donation the same way as before', async () => {
    const add = (id: string, cols: string, vals: string) =>
      db.query(`insert into public.donations (org_id, id, campaign_id, ${cols}) values ('${OIZER}', '${id}', '1003', ${vals})`);
    const [before] = await q(db, `select raised, fees, pending_balance, donation_count, undelivered_checks_amount, undelivered_checks_count,
                                         post_dated_amount, awaiting_approval from public.campaign_summary where id = '1003'`);
    await add('f-pay', 'type, status, amount, fee, payment_method', `'Payment', 'completed', 100, 3, 'Cash'`);
    await add('f-und', 'type, status, amount, fee, payment_method, delivered', `'Payment', 'completed', 400, 0, 'Check', false`);
    await add('f-ref', 'type, status, amount, fee, payment_method', `'Payment', 'refunded', 50, 2, 'Card'`);
    await add('f-pd', 'type, status, amount, payment_method', `'Payment', 'post_dated', 70, 'Check'`);
    await add('f-pen', 'type, status, amount, payment_method', `'Payment', 'pending', 30, 'Cash'`);
    await add('f-fail', 'type, status, amount, payment_method', `'Payment', 'failed', 999, 'Card'`);
    const [after] = await q(db, `select raised, fees, pending_balance, donation_count, undelivered_checks_amount, undelivered_checks_count,
                                        post_dated_amount, awaiting_approval from public.campaign_summary where id = '1003'`);
    const n = (r: Record<string, any>, k: string) => Number(r[k] ?? 0);
    expect(n(after, 'raised') - n(before, 'raised')).toBe(100);                    // the completed payment only
    expect(n(after, 'fees') - n(before, 'fees')).toBeCloseTo(5, 2);                         // completed + refunded keep their fee
    expect(n(after, 'donation_count') - n(before, 'donation_count')).toBe(2);      // completed + refunded
    expect(n(after, 'undelivered_checks_amount') - n(before, 'undelivered_checks_amount')).toBe(400);
    expect(n(after, 'undelivered_checks_count') - n(before, 'undelivered_checks_count')).toBe(1);
    expect(n(after, 'post_dated_amount') - n(before, 'post_dated_amount')).toBe(70);
    expect(n(after, 'awaiting_approval') - n(before, 'awaiting_approval')).toBe(30);
  });

  it("works out each row's flags once", async () => {
    const [{ def }] = (await db.query<{ def: string }>(`select pg_get_viewdef('public.campaign_summary'::regclass) def`)).rows;
    expect(def).toMatch(/AS und/);
    expect(def).toMatch(/OFFSET 0/);
  });
});
