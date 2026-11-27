import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, as, rows, seededDb } from './harness';

// Moshe #20 (2026-11-15): after "Yes, it printed", a payout's amount and payee are locked; void the check to change
// them. Unprinted payouts stay editable.
const sql = (db: PGlite, q: string, params: unknown[] = []) => as(db, ADMIN, tx => tx.query(q, params));
const one = async <T = Record<string, any>>(db: PGlite, q: string, params: unknown[] = []) => (await rows<T>(db, ADMIN, q, params))[0];

describe('a printed payout is locked', () => {
  let base: PGlite;
  let db: PGlite;
  let payout: string;
  let check: string;
  beforeAll(async () => { base = await seededDb(); });
  beforeEach(async () => {
    db = await base.clone();
    payout = (await one<{ id: string }>(db, `insert into public.expenses (campaign_id, amount, payee, method) values ('1001', 250, 'Acme Roofing', 'Check') returning id`)).id;
    await sql(db, `select public.save_check_settings('a1', 'Cong Oizer', '1 Main St', 'JP Morgan Chase', '021000021', '123456789', 1001)`);
    check = (await one<{ check_id: string }>(db, `select * from public.issue_check($1, 'a1', null)`, [payout])).check_id;
  });

  it('stays editable until the check is confirmed printed', async () => {
    await sql(db, `update public.expenses set amount = 260 where id = $1`, [payout]);
    expect(Number((await one(db, `select amount from public.expenses where id = $1`, [payout])).amount)).toBe(260);
  });

  it('refuses a new amount or payee once printed, but allows the memo and notes', async () => {
    await sql(db, `select public.mark_check_printed($1)`, [check]);
    await expect(sql(db, `update public.expenses set amount = 300 where id = $1`, [payout])).rejects.toThrow(/Check #1001 .* has printed.*Void the check/);
    await expect(sql(db, `update public.expenses set payee = 'Someone Else', payee_id = null where id = $1`, [payout])).rejects.toThrow(/locked/);
    await sql(db, `update public.expenses set notes = 'Mailed Tuesday' where id = $1`, [payout]);
    expect((await one(db, `select notes from public.expenses where id = $1`, [payout])).notes).toBe('Mailed Tuesday');
  });

  it('unlocks once the check is voided', async () => {
    await sql(db, `select public.mark_check_printed($1)`, [check]);
    await sql(db, `select public.set_check_status($1, 'voided', 'Wrong amount')`, [check]);
    await sql(db, `update public.expenses set amount = 300 where id = $1`, [payout]);
    expect(Number((await one(db, `select amount from public.expenses where id = $1`, [payout])).amount)).toBe(300);
  });

  it('still lets two payees be merged', async () => {
    await sql(db, `select public.mark_check_printed($1)`, [check]);
    const keep = (await one<{ id: string }>(db, `insert into public.payees (name) values ('Acme Roofing LLC') returning id`)).id;
    const absorb = (await one<{ payee_id: string }>(db, `select payee_id from public.expenses where id = $1`, [payout])).payee_id;
    await sql(db, `select public.merge_payees($1, $2)`, [keep, absorb]);
    expect((await one(db, `select payee_id from public.expenses where id = $1`, [payout])).payee_id).toBe(keep);
  });
});
