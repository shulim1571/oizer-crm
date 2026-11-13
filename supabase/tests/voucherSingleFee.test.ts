import type { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, as, rows, seededDb } from './harness';

// Moshe Henig, 2026-11-11: one fee field on the voucher form; an amount is a flat fee, empty uses the issuer's rate.
const sql = (db: PGlite, q: string, p: unknown[] = []) => as(db, ADMIN, tx => tx.query(q, p));
const fee = async (db: PGlite, id: string) => (await rows<Record<string, string>>(db, ADMIN, `select fee_type, fee_percent::text, fee_flat::text from public.vouchers where id = $1`, [id]))[0];
const add = async (db: PGlite, feeFlat: number | null) =>
  (await rows<{ id: string }>(db, ADMIN, `insert into public.vouchers (campaign_id, issuer, face_value, fee_flat) values ('1003', 'Voucher — OJC Fund', 100, $1) returning id`, [feeFlat]))[0].id;

describe('voucher fee', () => {
  let db: PGlite;
  beforeEach(async () => {
    db = await seededDb();
    await sql(db, `update public.payment_methods set fee_type = 'percent', fee_percent = 3, fee_flat = 0 where name = 'Voucher — OJC Fund'`);
  });

  it('is the amount typed, as a flat fee', async () => {
    expect(await fee(db, await add(db, 4))).toEqual({ fee_type: 'flat', fee_percent: '0.000', fee_flat: '4.00' });
  });

  it('uses the issuer’s rate when left empty', async () => {
    expect(await fee(db, await add(db, null))).toEqual({ fee_type: 'percent', fee_percent: '3.000', fee_flat: '0.00' });
  });

  it('becomes that flat fee when the amount is changed later, before funds arrive', async () => {
    const id = await add(db, null);
    await sql(db, `update public.vouchers set fee_flat = 2.5 where id = $1`, [id]);
    expect(await fee(db, id)).toEqual({ fee_type: 'flat', fee_percent: '0.000', fee_flat: '2.50' });
  });
});
