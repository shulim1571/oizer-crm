import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, as, rows, seededDb } from './harness';

// Readiness #1 (2026-11-15): editing amount, method or campaign recalculates the fee; manual fees are untouched.
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

  it('recalculates when the amount changes: 18 to 1,000 on 2.9% + 0.30', async () => {
    await add('fe-1', 18, 'Card Test');
    expect(await fees(db, 'fe-1')).toEqual({ fee: '0.83', net: '17.17' });
    await sql(db, `update public.donations set amount = 1000 where id = 'fe-1'`);
    expect(await fees(db, 'fe-1')).toEqual({ fee: '29.30', net: '970.70' });
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
