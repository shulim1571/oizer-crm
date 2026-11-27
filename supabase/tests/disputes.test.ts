import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, OIZER, as, rows, seededDb } from './harness';

// Readiness #17 (2026-11-15): partial refunds in the app, disputed gifts held out of the balance, chargebacks with
// their fee, and Task Sheet items for disputes and chargebacks.
const sql = (db: PGlite, q: string, params: unknown[] = []) => as(db, ADMIN, tx => tx.query(q, params), OIZER);
const one = async <T = Record<string, any>>(db: PGlite, q: string, params: unknown[] = []) => (await rows<T>(db, ADMIN, q, params, OIZER))[0];
const svc = async (db: PGlite, q: string, params: unknown[] = []) => (await rows(db, 'service_role', q, params))[0];
const camp = async (db: PGlite) => {
  const r = await one(db, `select raised::numeric raised, fees::numeric fees, balance::numeric balance from public.campaign_summary where id = '1003'`);
  return { raised: Number(r.raised), fees: Number(r.fees), balance: Number(r.balance) };
};
const gift = async (db: PGlite, id: string, amount = 100, fee = 3) => {
  await db.query(`insert into public.donations (org_id, id, campaign_id, type, status, amount, manual_fee, payment_method)
                  values ($1, $2, '1003', 'Payment', 'completed', $3, $4, 'Cash')`, [OIZER, id, amount, fee]);
};
const openTasks = async (db: PGlite) => (await db.query<{ task_key: string }>(
  `select task_key from public.task_items where org_id = $1 and task_type in ('disputed', 'chargeback') and resolved_at is null order by task_key`, [OIZER])).rows.map(r => r.task_key);

describe('refunds, disputes and chargebacks', () => {
  let base: PGlite;
  let db: PGlite;
  beforeAll(async () => {
    base = await seededDb();
    await base.query(`update public.org_members set role = 'super_admin' where user_id = $1`, [ADMIN]);
  });
  beforeEach(async () => { db = await base.clone(); });

  it('refunds part of a gift by hand: $30 of $100 leaves $70 counted; the rest folds the parts in', async () => {
    await gift(db, 'r1');
    const before = await camp(db);
    await sql(db, `select public.refund_donation('r1', null, null, 'Donor asked', 30)`);
    expect((await camp(db)).raised - before.raised).toBe(-30);
    expect(await one(db, `select status from public.donations where id = 'r1'`)).toEqual({ status: 'completed' });
    const [part] = (await db.query<any>(`select amount, refund_of, status from public.donations where refund_of = 'r1'`)).rows;
    expect(part).toEqual({ amount: '-30.00', refund_of: 'r1', status: 'completed' });
    await expect(sql(db, `select public.refund_donation('r1', null, null, null, 80)`)).rejects.toThrow(/more than the 70/);
    await sql(db, `select public.refund_donation('r1', null, null, 'The rest')`);
    expect(await one(db, `select status from public.donations where id = 'r1'`)).toEqual({ status: 'refunded' });
    expect((await camp(db)).raised - before.raised).toBe(-100);   // not -130: the part is folded into the full refund
  });

  it('holds a disputed gift out of the balance, keeps its fee spent, and lists it on the Task Sheet until settled', async () => {
    await gift(db, 'd1');
    const before = await camp(db);
    await sql(db, `select public.mark_disputed('d1', 'Donor says not authorized')`);
    const held = await camp(db);
    expect(held.raised - before.raised).toBe(-100);
    expect(held.fees).toBe(before.fees);
    expect(await openTasks(db)).toEqual(['disputed:d1']);
    const sheet = await rows(db, ADMIN, `select task_type from public.admin_task_sheet where task_key = 'disputed:d1'`, [], OIZER);
    expect(sheet).toEqual([{ task_type: 'disputed' }]);
    // Won: back in the balance, off the sheet.
    await sql(db, `select public.settle_dispute('d1', true, null, 'Bank sided with us')`);
    expect(await camp(db)).toEqual(before);
    expect(await openTasks(db)).toEqual([]);
  });

  it('records a chargeback and its fee, off the balance, on the Task Sheet', async () => {
    await gift(db, 'cb1');
    const before = await camp(db);
    await sql(db, `select public.mark_disputed('cb1')`);
    await sql(db, `select public.settle_dispute('cb1', false, 15, 'Lost')`);
    const after = await camp(db);
    expect(after.raised - before.raised).toBe(-100);
    expect(after.fees - before.fees).toBeCloseTo(15, 2);                 // the chargeback fee, besides the original fee
    expect(after.balance - before.balance).toBeCloseTo(-115, 2);
    expect(await one(db, `select status, chargeback_fee from public.donations where id = 'cb1'`)).toEqual({ status: 'chargeback', chargeback_fee: '15.00' });
    expect(await openTasks(db)).toEqual(['chargeback:cb1']);
    await expect(sql(db, `select public.record_chargeback('cb1', 5)`)).rejects.toThrow(/Only a completed or disputed/);
  });

  it('refunds part of a card payment at Sola, and the rest stays counted', async () => {
    await sql(db, `select public.save_payment_settings('ifields_public_key', 'sandbox_api_key', 'pin0123456789abc', true)`);
    const sale = (await one(db, `select public.begin_card_sale('1003', 'd1', 100, null, false, 'Moshe Klein', 'mk@example.org', null, '1.2.3.4') id`)).id;
    await svc(db, `select * from public.claim_gateway_request($1, $2)`, [OIZER, sale]);
    const done = (await svc(db, `select public.record_gateway_result($1, $2, $3) r`, [OIZER, sale, JSON.stringify({ xResult: 'A', xStatus: 'Approved', xRefNum: '2000001', xCardType: 'Visa' })])).r;
    const donation = done.donation_id;
    await expect(one(db, `select public.begin_card_reversal($1, 'refund', 150) id`, [donation])).rejects.toThrow(/up to the 100/);
    const r = (await one(db, `select public.begin_card_reversal($1, 'refund', 30) id`, [donation])).id;
    const claimed = await svc(db, `select kind, amount from public.claim_gateway_request($1, $2)`, [OIZER, r]);
    expect(claimed).toEqual({ kind: 'refund', amount: '30.00' });
    await svc(db, `select public.record_gateway_result($1, $2, $3) r`, [OIZER, r, JSON.stringify({ xResult: 'A', xRefNum: '2000002' })]);
    expect(await one(db, `select status from public.donations where id = $1`, [donation])).toEqual({ status: 'completed' });
    const [part] = (await db.query<any>(`select amount from public.donations where refund_of = $1`, [donation])).rows;
    expect(part.amount).toBe('-30.00');
    await expect(one(db, `select public.begin_card_reversal($1, 'void') id`, [donation])).rejects.toThrow(/Part of this payment was refunded/);
  });
});
