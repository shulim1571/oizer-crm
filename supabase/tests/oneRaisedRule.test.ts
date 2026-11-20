import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, OIZER, rows, seededDb } from './harness';

// Readiness #9 (2026-11-15): the Dashboard, Transactions and campaign balances each summed something different.
// One rule now: completed gifts, a Batch deposit at what's funded, checks not yet delivered left out (and shown
// with open pledges on the dashboard, Moshe's answer on #8).
const q = <T = Record<string, any>>(db: PGlite, sql: string, params: unknown[] = []) => rows<T>(db, ADMIN, sql, params, OIZER);
const num = (v: unknown) => Number(v ?? 0);

async function snapshot(db: PGlite) {
  const [tl] = await q(db, `select coalesce(sum(raised) filter (where counted), 0) raised, count(*) filter (where counted) n,
                                    coalesce(sum(amount) filter (where undelivered_check), 0) held from public.transaction_list`);
  const [{ s }] = await q(db, `select public.dashboard_stats(current_date - 3650, current_date + 1) s`);
  const [camp] = await q(db, `select raised from public.campaign_summary where id = '1001'`);
  return { tl: num(tl.raised), tlCount: num(tl.n), held: num(tl.held), dashAll: num(s.periods.all.raised), dashRange: num(s.range.raised),
           dashCount: num(s.range.count), undelivered: num(s.undelivered.amount), campaign: num(camp.raised) };
}

describe('one raised rule across the dashboard, transactions and campaign balances', () => {
  let base: PGlite;
  let db: PGlite;
  beforeAll(async () => { base = await seededDb(); });
  beforeEach(async () => { db = await base.clone(); });

  it('counts the same gifts the same way everywhere', async () => {
    const before = await snapshot(db);
    const add = (id: string, cols: string) => db.query(`insert into public.donations (org_id, id, campaign_id, ${cols.split('|')[0]}) values ('${OIZER}', '${id}', '1001', ${cols.split('|')[1]})`);
    await add('r-pay', `type, status, amount, payment_method|'Payment', 'completed', 100, 'Cash'`);
    await add('r-chk', `type, status, amount, payment_method, delivered|'Payment', 'completed', 250, 'Check', true`);
    await add('r-und', `type, status, amount, payment_method, delivered|'Payment', 'completed', 400, 'Check', false`);
    await add('r-col', `type, status, amount, payment_method|'Payment', 'collect', 75, 'Cash'`);
    await add('r-void', `type, status, amount, payment_method|'Payment', 'voided', 60, 'Cash'`);
    await add('r-bat', `type, status, amount, funded, payment_method|'Batch', 'completed', 500, 300, 'Cash'`);
    const [bat] = await q(db, `select funded from public.donations where id = 'r-bat'`);
    const after = await snapshot(db);
    const expected = 100 + 250 + num(bat.funded);   // the payment, the delivered check, the batch's funded part
    expect(after.tl - before.tl).toBeCloseTo(expected, 2);
    expect(after.dashAll - before.dashAll).toBeCloseTo(expected, 2);
    expect(after.dashRange - before.dashRange).toBeCloseTo(expected, 2);
    expect(after.campaign - before.campaign).toBeCloseTo(expected, 2);
    expect(after.tlCount - before.tlCount).toBe(3);
    expect(after.dashCount - before.dashCount).toBe(3);
    // The undelivered check: not raised anywhere, shown on its own (with open pledges on the dashboard).
    expect(after.held - before.held).toBe(400);
    expect(after.undelivered - before.undelivered).toBe(400);
    // Delivered: it moves into raised everywhere at once.
    await db.query(`update public.donations set delivered = true where id = 'r-und'`);
    const delivered = await snapshot(db);
    expect(delivered.tl - after.tl).toBe(400);
    expect(delivered.dashAll - after.dashAll).toBe(400);
    expect(delivered.campaign - after.campaign).toBe(400);
    expect(delivered.undelivered - after.undelivered).toBe(-400);
  });

  it('agrees on the seeded data as it stands', async () => {
    const s = await snapshot(db);
    expect(s.tl).toBeCloseTo(s.dashAll, 2);
    expect(s.tlCount).toBe(s.dashCount);
  });

  it('counts successful donations on the Platform page, as the Transactions list does', async () => {
    await db.query(`insert into public.platform_owners (user_id) values ('${ADMIN}')`);
    await db.query(`insert into public.donations (org_id, id, campaign_id, type, status, amount) values ('${OIZER}', 'p-void', '1001', 'Payment', 'voided', 5)`);
    const [org] = await q(db, `select donation_count from public.platform_list_orgs() where id = '${OIZER}'`);
    const [{ n }] = await q(db, `select count(*) n from public.transaction_list where status = 'completed'`);
    expect(num(org.donation_count)).toBe(num(n));
  });
});
