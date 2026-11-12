import { describe, expect, it } from 'vitest';
import { ADMIN, OIZER, as, rows, seededDb } from './harness';

// Shulim, 2026-11-12: a test import of real data must be deletable in one step, leaving sample data alone.
describe('test import registry', () => {
  it('deletes exactly the registered rows, children first, even on closed campaigns', async () => {
    const db = await seededDb();
    const before = (await db.query<{ n: number }>(`select count(*)::int n from public.donations`)).rows[0].n;
    await db.exec(`
      insert into public.test_import_batches (batch_id, org_id) values ('t1', '${OIZER}');
      insert into public.managers (id, org_id, first_name, status) values ('AS-m1', '${OIZER}', 'Test', 'active');
      insert into public.campaigns (id, org_id, internal_name, external_name, manager_id, status) values ('AS-1', '${OIZER}', 'Imported', 'Imported', 'AS-m1', 'closed');
      alter table public.donations disable trigger user;
      insert into public.donations (id, org_id, campaign_id, amount, net_donation, type, status) values ('AS-d1', '${OIZER}', 'AS-1', 10, 10, 'Payment', 'completed');
      alter table public.donations enable trigger user;
      insert into public.test_import_rows (batch_id, table_name, record_id) values ('t1','managers','AS-m1'), ('t1','campaigns','AS-1'), ('t1','donations','AS-d1');
    `);
    const [r] = await rows<{ r: any }>(db, 'postgres' as never, `select public.delete_test_import('t1') r`).catch(async () => (await db.query<{ r: any }>(`select public.delete_test_import('t1') r`)).rows);
    expect(r.r).toMatchObject({ donations: 1, campaigns: 1, managers: 1 });
    expect((await db.query(`select 1 from public.campaigns where id = 'AS-1'`)).rows).toEqual([]);
    expect((await db.query<{ n: number }>(`select count(*)::int n from public.donations`)).rows[0].n).toBe(before);   // sample untouched
    expect((await db.query(`select deleted_at is not null d from public.test_import_batches where batch_id = 't1'`)).rows).toEqual([{ d: true }]);
  });

  it('is not callable by signed-in users', async () => {
    const db = await seededDb();
    await db.exec(`insert into public.test_import_batches (batch_id, org_id) values ('t2', '${OIZER}')`);
    await expect(as(db, ADMIN, tx => tx.query(`select public.delete_test_import('t2')`))).rejects.toThrow();
    await expect(rows(db, ADMIN, `select * from public.test_import_rows`)).rejects.toThrow();
  });

  it('does not make a Check To Print task for a payout with a hand-written check number', async () => {
    const db = await seededDb();
    const [p] = await rows<{ id: string }>(db, ADMIN, `insert into public.expenses (campaign_id, amount, payee, method, check_number) values ('1001', 50, 'X', 'Check', '1234') returning id`);
    expect(await rows(db, ADMIN, `select 1 from public.admin_task_sheet where task_key = $1`, ['check_to_print:' + p.id])).toEqual([]);
  });
});
