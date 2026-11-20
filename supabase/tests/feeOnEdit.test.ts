import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, as, rows, seededDb } from './harness';

// Moshe, 2026-11-18 (was readiness #1): only a changed payment method recalculates the fee; editing the amount,
// campaign or anything else keeps the fee the gift came in with. Manual fees are untouched.
const sql = (db: PGlite, q: string, params: unknown[] = []) => as(db, ADMIN, tx => tx.query(q, params));
const fees = async (db: PGlite, id: string) =>
  (await rows<{ fee: string | null; net: string }>(db, ADMIN, `select fee::text, net_donation::text net from public.donations where id = $1`, [id]))[0];

describe('fee when a donation is edited', () => {
  let base: PGlite;
  let db: PGlite;
  beforeAll(async () => {
    base = await seededDb();
    await as(base, ADMIN, tx => tx.query(`insert into public.payment_methods (org_id, name, fee_type, fee_percent, fee_flat) values
      (public.current_org_id(), 'Card Test', 'percent_flat', 2.9, 0.30), (public.current_org_id(), 'Cash Test', 'none', 0, 0)`));
  });
  beforeEach(async () => { db = await base.clone(); });
  const add = (id: string, amount: number, method: string, manual: number | null = null) =>
    sql(db, `insert into public.donations (id, campaign_id, type, status, amount, payment_method, manual_fee) values ($1, '1001', 'Payment', 'completed', $2, $3, $4)`, [id, amount, method, manual]);

  it('keeps the saved fee when the amount changes (net follows the amount)', async () => {
    await add('fe-1', 18, 'Card Test');
    expect(await fees(db, 'fe-1')).toEqual({ fee: '0.83', net: '17.17' });
    await sql(db, `update public.donations set amount = 1000 where id = 'fe-1'`);
    expect(await fees(db, 'fe-1')).toEqual({ fee: '0.83', net: '999.17' });
  });

  it('keeps the saved fee when the campaign, notes or other fields change, even if the method\'s rate changed since', async () => {
    await add('fe-1b', 100, 'Card Test');
    expect((await fees(db, 'fe-1b')).fee).toBe('3.20');
    await sql(db, `update public.payment_methods set fee_percent = 5 where name = 'Card Test'`);
    await sql(db, `update public.donations set campaign_id = '1002', notes = 'moved' where id = 'fe-1b'`);
    expect(await fees(db, 'fe-1b')).toEqual({ fee: '3.20', net: '96.80' });
  });

  it('recalculates when the method changes: Cash to Card', async () => {
    await add('fe-2', 100, 'Cash Test');
    expect((await fees(db, 'fe-2')).fee).toBe('0.00');
    await sql(db, `update public.donations set payment_method = 'Card Test' where id = 'fe-2'`);
    expect(await fees(db, 'fe-2')).toEqual({ fee: '3.20', net: '96.80' });
  });

  it("never overwrites a manual fee, a fee set by the same edit, or a feed's fee", async () => {
    await add('fe-3', 100, 'Card Test', 1);
    await sql(db, `update public.donations set amount = 500 where id = 'fe-3'`);
    expect(await fees(db, 'fe-3')).toEqual({ fee: '1.00', net: '499.00' });
    await add('fe-4', 100, 'Card Test');
    await sql(db, `update public.donations set amount = 200, fee = 7 where id = 'fe-4'`);
    expect((await fees(db, 'fe-4')).fee).toBe('7.00');
    await sql(db, `insert into public.donations (id, campaign_id, type, status, amount, payment_method, fee, donary_id) values ('fe-5', '1001', 'Payment', 'completed', 100, 'Card Test', 2.5, 'D-1')`);
    await sql(db, `update public.donations set campaign_id = '1002' where id = 'fe-5'`);
    expect((await fees(db, 'fe-5')).fee).toBe('2.50');
  });

  it('gives a failed charge its fee when it is later completed (#59)', async () => {
    await sql(db, `insert into public.donations (id, campaign_id, type, status, amount, payment_method) values ('fe-6', '1001', 'Payment', 'failed', 100, 'Card Test')`);
    expect((await fees(db, 'fe-6')).fee).toBe('0.00');
    // Only the system's retry completes a failed charge (as the database owner); admins can't via the edit form.
    await db.query(`update public.donations set status = 'completed' where id = 'fe-6'`);
    expect(await fees(db, 'fe-6')).toEqual({ fee: '3.20', net: '96.80' });
  });
});

// Readiness #16 (2026-11-15): a manual fee runs from $0 to the amount; blank uses the preset.
describe('manual fee bounds', () => {
  let base: PGlite;
  let db: PGlite;
  beforeAll(async () => {
    base = await seededDb();
    await as(base, ADMIN, tx => tx.query(`insert into public.payment_methods (org_id, name, fee_type, fee_percent, fee_flat) values (public.current_org_id(), 'Card Test', 'percent_flat', 2.9, 0.30)`));
  });
  beforeEach(async () => { db = await base.clone(); });
  const add = (id: string, manual: number | null, amount = 100) =>
    sql(db, `insert into public.donations (id, campaign_id, type, status, amount, payment_method, manual_fee) values ($1, '1001', 'Payment', 'completed', $2, 'Card Test', $3)`, [id, amount, manual]);

  it('refuses a negative fee and a fee above the amount, and takes 0 up to the amount', async () => {
    await expect(add('mb-neg', -1)).rejects.toThrow(/donations_manual_fee_range/);
    await expect(add('mb-over', 100.01)).rejects.toThrow(/donations_manual_fee_range/);
    await add('mb-zero', 0);
    await add('mb-all', 100);
    await expect(sql(db, `update public.donations set manual_fee = 150 where id = 'mb-zero'`)).rejects.toThrow(/donations_manual_fee_range/);
  });

  it('uses the preset when the manual fee is left blank', async () => {
    await add('mb-blank', null, 1000);
    const [d] = await rows<{ fee: string; manual_fee: string | null }>(db, ADMIN, `select fee, manual_fee from public.donations where id = 'mb-blank'`);
    expect(d.manual_fee).toBeNull();
    expect(d.fee).toBe('29.30');   // the Card Test preset, as in the tests above
  });
});
