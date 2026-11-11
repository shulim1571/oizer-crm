import type { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, MANAGER_1, as, rows, seededDb } from './harness';

// Moshe Henig, 2026-11-11: a check not yet confirmed printed is a task; confirming (or voiding) clears it.
const sql = (db: PGlite, q: string, p: unknown[] = [], user = ADMIN) => as(db, user, tx => tx.query(q, p));
const one = async <T = any>(db: PGlite, q: string, p: unknown[] = [], user = ADMIN) => (await rows<T>(db, user, q, p))[0];
const task = (db: PGlite, check: string) =>
  one(db, `select task_type, summary from public.admin_task_sheet where task_key = $1`, ['check_unprinted:' + check]);

describe('unprinted checks', () => {
  let db: PGlite;
  let check: { check_id: string; check_number: number };
  beforeEach(async () => {
    db = await seededDb();
    await sql(db, `select public.save_check_settings('a1', 'Cong Oizer', '1 Main St', 'Chase', '021000021', '123456789', 1001)`);
    const p = await one<{ id: string }>(db, `insert into public.expenses (campaign_id, amount, payee, method) values ('1001', 250, 'Acme Roofing', 'Check') returning id`);
    check = await one(db, `select * from public.issue_check($1, 'a1', null)`, [p.id]);
  });

  it('show on the Task Sheet until confirmed printed', async () => {
    expect(await task(db, check.check_id)).toEqual({ task_type: 'check_unprinted', summary: 'Check #1001 to Acme Roofing: not confirmed printed' });
    expect((await one(db, `select printed_at from public.checks where id = $1`, [check.check_id])).printed_at).toBeNull();
    await sql(db, `select public.mark_check_printed($1)`, [check.check_id]);
    expect(await task(db, check.check_id)).toBeUndefined();
    expect((await one(db, `select printed_at is not null p from public.checks where id = $1`, [check.check_id])).p).toBe(true);
  });

  it('leave the Task Sheet when voided', async () => {
    await sql(db, `select public.set_check_status($1, 'voided', 'Printer jam')`, [check.check_id]);
    expect(await task(db, check.check_id)).toBeUndefined();
  });

  it('are confirmed only by admins', async () => {
    await expect(sql(db, `select public.mark_check_printed($1)`, [check.check_id], MANAGER_1)).rejects.toThrow();
  });
});

describe('check printing follow-ups (Moshe Henig, 2026-11-11)', () => {
  let db: PGlite;
  let check: { check_id: string; check_number: number };
  let payoutId: string;
  beforeEach(async () => {
    db = await seededDb();
    await sql(db, `select public.save_check_settings('a1', 'Cong Oizer', '1 Main St', 'Chase', '021000021', '123456789', 5010)`);
    payoutId = (await one<{ id: string }>(db, `insert into public.expenses (campaign_id, amount, payee, method) values ('1001', 100, 'Cong Oizer', 'Check') returning id`)).id;
    check = await one(db, `select * from public.issue_check($1, 'a1', null)`, [payoutId]);
  });

  it('keep the issued check number on the payout when a stale payout form is saved', async () => {
    await sql(db, `update public.expenses set check_number = null, notes = 'saved from an old form' where id = $1`, [payoutId]);
    expect((await one(db, `select check_number from public.expenses where id = $1`, [payoutId])).check_number).toBe('5010');
  });

  it('can go back on the Task Sheet after a too-early yes, and the register shows whether each printed', async () => {
    await sql(db, `select public.mark_check_printed($1)`, [check.check_id]);
    expect(await task(db, check.check_id)).toBeUndefined();
    expect((await one(db, `select printed_at is not null p, printed_by from public.check_register where id = $1`, [check.check_id]))).toMatchObject({ p: true });
    await sql(db, `select public.mark_check_unprinted($1)`, [check.check_id]);
    expect(await task(db, check.check_id)).toEqual({ task_type: 'check_unprinted', summary: 'Check #5010 to Cong Oizer: not confirmed printed' });
    expect((await one(db, `select printed_at from public.check_register where id = $1`, [check.check_id])).printed_at).toBeNull();
    await expect(sql(db, `select public.mark_check_unprinted($1)`, [check.check_id], MANAGER_1)).rejects.toThrow();
  });
});
