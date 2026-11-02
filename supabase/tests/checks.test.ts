import type { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, MANAGER_1, as, rows, seededDb } from './harness';

const sql = (db: PGlite, q: string, params: unknown[] = [], user = ADMIN) => as(db, user, tx => tx.query(q, params));
const one = async <T = Record<string, any>>(db: PGlite, q: string, params: unknown[] = [], user = ADMIN) => (await rows<T>(db, user, q, params))[0];
const payout = async (db: PGlite, amount = 250, payee: string | null = 'Acme Roofing') =>
  (await one<{ id: string }>(db, `insert into public.expenses (campaign_id, amount, payee, method) values ('1001', $1, $2, 'Check') returning id`, [amount, payee])).id;
const setUp = (db: PGlite, next = 1001) =>
  sql(db, `select public.save_check_settings('a1', 'Cong Oizer', '1 Main St', 'JP Morgan Chase', '021000021', '123456789', $1)`, [next]);
const issue = async (db: PGlite, id: string, memo: string | null = null) =>
  one<{ check_id: string; check_number: number }>(db, `select * from public.issue_check($1, 'a1', $2)`, [id, memo]);

describe('check settings', () => {
  let db: PGlite;
  beforeEach(async () => { db = await seededDb(); });

  it('must be filled in before a check prints', async () => {
    const id = await payout(db);
    await expect(issue(db, id)).rejects.toThrow(/routing number, account number and starting check number/);
    await sql(db, `select public.save_check_settings('a1', 'Cong Oizer', null, 'Chase', '021000021', null, 500)`);
    await expect(issue(db, id)).rejects.toThrow(/routing number/);
  });

  it('check the routing number and stay admin only', async () => {
    await expect(sql(db, `select public.save_check_settings('a1', 'X', null, 'Y', '1234', '99999', 1)`)).rejects.toThrow(/9 digits/);
    await setUp(db);
    await expect(rows(db, MANAGER_1, `select public.save_check_settings('a1', 'X', null, 'Y', '021000021', '99999', 1)`)).rejects.toThrow();
    expect(await rows(db, MANAGER_1, `select * from public.account_check_settings`)).toEqual([]);
    expect((await one(db, `select routing_number, account_number from public.account_check_settings`))).toEqual({ routing_number: '021000021', account_number: '123456789' });
  });

  it('won\'t go back to numbers already printed', async () => {
    await setUp(db);
    await issue(db, await payout(db));
    await expect(setUp(db, 1000)).rejects.toThrow(/already been used/);
    await setUp(db, 2000);
    expect((await issue(db, await payout(db))).check_number).toBe(2000);
  });
});

describe('issuing checks', () => {
  let db: PGlite;
  beforeEach(async () => { db = await seededDb(); await setUp(db); });

  it('numbers them in order per account and marks the payout', async () => {
    const a = await payout(db);
    const b = await payout(db, 75, 'Goldberg Printing');
    expect((await issue(db, a, 'Roof repair')).check_number).toBe(1001);
    expect((await issue(db, b)).check_number).toBe(1002);
    expect(await one(db, `select check_number, account_id, cleared, method from public.expenses where id = $1`, [a]))
      .toEqual({ check_number: '1001', account_id: 'a1', cleared: false, method: 'Check' });
    expect(await one(db, `select payee, amount, memo, status, days_outstanding from public.check_register where check_number = 1001`))
      .toEqual({ payee: 'Acme Roofing', amount: '250.00', memo: 'Roof repair', status: 'outstanding', days_outstanding: 0 });
    expect((await one(db, `select next_check_number from public.account_check_settings`)).next_check_number).toBe(1003);
  });

  it('prints only one live check per payout, and needs a payee', async () => {
    const a = await payout(db);
    await issue(db, a);
    await expect(issue(db, a)).rejects.toThrow(/already has a check/);
    await expect(issue(db, await payout(db, 10, null))).rejects.toThrow(/who the check is to/);
  });

  it('voids with a reason, never reuses the number, and lets the payout get a new check', async () => {
    const a = await payout(db);
    const first = await issue(db, a);
    await expect(sql(db, `select public.set_check_status($1, 'voided')`, [first.check_id])).rejects.toThrow(/reason/);
    await sql(db, `select public.set_check_status($1, 'voided', 'Printed misaligned')`, [first.check_id]);
    await expect(sql(db, `select public.set_check_status($1, 'cleared')`, [first.check_id])).rejects.toThrow(/stays that way/);
    const second = await issue(db, a);
    expect(second.check_number).toBe(1002);
    expect((await rows(db, ADMIN, `select check_number, status, status_reason from public.check_register order by check_number`)))
      .toEqual([{ check_number: 1001, status: 'voided', status_reason: 'Printed misaligned' }, { check_number: 1002, status: 'outstanding', status_reason: null }]);
  });

  it('clears from the register or from the payout, either way', async () => {
    const a = await payout(db);
    const b = await payout(db);
    const ka = await issue(db, a);
    await issue(db, b);
    await sql(db, `select public.set_check_status($1, 'cleared')`, [ka.check_id]);
    expect((await one(db, `select cleared from public.expenses where id = $1`, [a])).cleared).toBe(true);
    await sql(db, `update public.expenses set cleared = true where id = $1`, [b]);
    expect((await one(db, `select status from public.checks where expense_id = $1`, [b])).status).toBe('cleared');
  });

  it('drops a voided or lost check from the stale list', async () => {
    const a = await payout(db);
    const k = await issue(db, a);
    await sql(db, `update public.expenses set created_at = now() - interval '200 days' where id = $1`, [a]);
    expect((await rows(db, ADMIN, `select 1 from public.admin_task_sheet where record_id = $1 and task_type = 'stale_check'`, [a])).length).toBe(1);
    await sql(db, `select public.set_check_status($1, 'lost', 'Payee never got it')`, [k.check_id]);
    expect(await rows(db, ADMIN, `select 1 from public.admin_task_sheet where record_id = $1`, [a])).toEqual([]);
  });

  it('are admin only', async () => {
    const a = await payout(db);
    await expect(rows(db, MANAGER_1, `select * from public.issue_check($1, 'a1')`, [a])).rejects.toThrow();
    await issue(db, a);
    expect(await rows(db, MANAGER_1, `select * from public.check_register`)).toEqual([]);
    await expect(sql(db, `update public.checks set amount = 1`)).rejects.toThrow();
  });
});

describe('check files', () => {
  let db: PGlite;
  beforeEach(async () => { db = await seededDb(); });

  it('stores a signature per account and one MICR font, admin only', async () => {
    const png = Buffer.from('fake png bytes').toString('base64');
    await sql(db, `select public.save_check_asset('signature', 'a1', $1, 'image/png', 'sig.png')`, [png]);
    await sql(db, `select public.save_check_asset('micr_font', null, $1, 'font/ttf', 'micr.ttf', 'A', 'C')`, [png]);
    expect(await one(db, `select file_name, data, transit_char, onus_char from public.check_asset('micr_font')`))
      .toEqual({ file_name: 'micr.ttf', data: png, transit_char: 'A', onus_char: 'C' });
    expect((await one(db, `select data from public.check_asset('signature', 'a1')`)).data).toBe(png);
    await expect(sql(db, `select public.save_check_asset('signature', 'a1', $1, 'image/gif')`, [png])).rejects.toThrow(/PNG or JPG/);
    await expect(rows(db, MANAGER_1, `select * from public.check_asset('micr_font')`)).rejects.toThrow();
    await expect(rows(db, ADMIN, `select * from public.check_assets`)).rejects.toThrow();
  });
});

describe('task sheet dates', () => {
  it('show date-only items at midnight New York time, not the evening before', async () => {
    const db = await seededDb();
    const id = (await one<{ id: string }>(db, `insert into public.expenses (campaign_id, amount, payee, method, scheduled_for) values ('1001', 5, 'X', 'Zelle', public.org_today() + 1) returning id`)).id;
    await sql(db, `update public.expenses set scheduled_for = date '2026-11-02' where id = $1`, [id]);
    const at = (await one<{ t: string }>(db, `select to_char(submitted_at at time zone 'America/New_York', 'YYYY-MM-DD HH24:MI') as t from public.admin_task_sheet where record_id = $1`, [id])).t;
    expect(at).toBe('2026-11-02 00:00');
  });
});
