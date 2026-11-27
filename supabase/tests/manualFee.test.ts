import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, as, rows, seededDb } from './harness';

const sql = (db: PGlite, q: string, params: unknown[] = []) => as(db, ADMIN, tx => tx.query(q, params));
const fees = async (db: PGlite, id: string) =>
  (await rows<{ fee: string | null; net: string }>(db, ADMIN, `select fee::text, net_donation::text net from public.donations where id = $1`, [id]))[0];
const add = (db: PGlite, id: string, manual: number | null, method = 'Fee Test', status = 'completed') =>
  sql(db, `insert into public.donations (id, campaign_id, type, status, amount, manual_fee, payment_method) values ($1, '1001', 'Payment', $4, 100, $2, $3)`, [id, manual, method, status]);

describe('manual fee on a payment', () => {
  let base: PGlite;
  let db: PGlite;
  beforeAll(async () => {
    base = await seededDb();
    // A method with a preset fee of 3% + $0.30.
    await as(base, ADMIN, tx => tx.query(`insert into public.payment_methods (org_id, name, fee_type, fee_percent, fee_flat)
      values (public.current_org_id(), 'Fee Test', 'percent_flat', 3, 0.30)`));
  });
  beforeEach(async () => { db = await base.clone(); });

  it('uses the preset fee when the manual fee is blank', async () => {
    await add(db, 'mf-p1', null);
    expect(await fees(db, 'mf-p1')).toEqual({ fee: '3.30', net: '96.70' });
  });

  it('deducts the manual fee instead of the preset when one is entered', async () => {
    await add(db, 'mf-p2', 5);
    expect(await fees(db, 'mf-p2')).toEqual({ fee: '5.00', net: '95.00' });
    await add(db, 'mf-p3', 0);
    expect(await fees(db, 'mf-p3')).toEqual({ fee: '0.00', net: '100.00' });
  });

  it('works for a method with no preset fee', async () => {
    await add(db, 'mf-p4', 2, 'Cash');
    expect(await fees(db, 'mf-p4')).toEqual({ fee: '2.00', net: '98.00' });
  });

  it('recalculates when the manual fee is changed or cleared later', async () => {
    await add(db, 'mf-p5', null);
    await sql(db, `update public.donations set manual_fee = 7 where id = 'mf-p5'`);
    expect(await fees(db, 'mf-p5')).toEqual({ fee: '7.00', net: '93.00' });
    await sql(db, `update public.donations set manual_fee = null where id = 'mf-p5'`);
    expect(await fees(db, 'mf-p5')).toEqual({ fee: '3.30', net: '96.70' });
  });

  it('still leaves failed payments with no fee', async () => {
    await add(db, 'mf-p6', 5, 'Fee Test', 'failed');
    expect(await fees(db, 'mf-p6')).toEqual({ fee: '0.00', net: '0.00' });
  });
});
