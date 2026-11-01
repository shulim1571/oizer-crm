import type { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, MANAGER_1, MANAGER_2, OIZER, as, ids, rows, seededDb } from './harness';

const summary = async (db: PGlite, id: string) =>
  (await rows<{ raised: string; fees: string; balance: string; post_dated_amount: string; awaiting_approval: string }>(
    db, ADMIN, `select raised, fees, balance, post_dated_amount, awaiting_approval from public.campaign_summary where id = $1`, [id]))[0];
const donation = async (db: PGlite, id: string) => (await db.query<Record<string, any>>(`select * from public.donations where id = $1`, [id])).rows[0];
const setFee = (db: PGlite, name: string, type: string, pct: number, flat: number) =>
  as(db, ADMIN, tx => tx.query(`update public.payment_methods set fee_type = $1, fee_percent = $2, fee_flat = $3 where name = $4`, [type, pct, flat, name]));
const add = async (db: PGlite, user: string, values: Record<string, unknown>) => {
  const keys = Object.keys(values);
  const [r] = await rows<{ id: string }>(db, user,
    `insert into public.donations (${keys.join(',')}) values (${keys.map((_, i) => `$${i + 1}`).join(',')}) returning id`, Object.values(values));
  return r.id;
};

describe('fees', () => {
  let db: PGlite;
  beforeEach(async () => { db = await seededDb(); });

  it('start at nothing, seeded for each organization', async () => {
    const r = await rows<{ name: string; fee_type: string }>(db, ADMIN, `select name, fee_type from public.payment_methods where name in ('Check','Credit Card') order by name`);
    expect(r).toEqual([{ name: 'Check', fee_type: 'none' }, { name: 'Credit Card', fee_type: 'none' }]);
  });

  it("match the spec's example: 2.9% + $0.30 on $500 is $14.80", async () => {
    await setFee(db, 'Credit Card', 'percent_flat', 2.9, 0.3);
    const id = await add(db, ADMIN, { campaign_id: '1003', amount: 500, payment_method: 'Credit Card' });
    expect(await donation(db, id)).toMatchObject({ fee: '14.80', net_donation: '485.20' });
  });

  it('handle flat and percent, and ignore case in the method name', async () => {
    await setFee(db, 'Wire', 'flat', 0, 25);
    await setFee(db, 'ACH', 'percent', 1, 0);
    expect((await donation(db, await add(db, ADMIN, { campaign_id: '1003', amount: 1000, payment_method: 'wire' }))).fee).toBe('25.00');
    expect((await donation(db, await add(db, ADMIN, { campaign_id: '1003', amount: 1000, payment_method: 'ACH' }))).fee).toBe('10.00');
  });

  it('let an entered fee win, including zero', async () => {
    await setFee(db, 'Credit Card', 'percent', 3, 0);
    const id = await add(db, ADMIN, { campaign_id: '1003', amount: 100, payment_method: 'Credit Card', fee: 0 });
    expect(await donation(db, id)).toMatchObject({ fee: '0.00', net_donation: '100.00' });
  });

  it('leave a method with no setup alone', async () => {
    const id = await add(db, ADMIN, { campaign_id: '1003', amount: 100, payment_method: 'Credit Card VISA' });
    expect(await donation(db, id)).toMatchObject({ fee: null, net_donation: '100.00' });
  });

  it('can be set differently for one campaign', async () => {
    await setFee(db, 'Credit Card', 'percent', 3, 0);
    const [m] = await rows<{ id: string }>(db, ADMIN, `select id from public.payment_methods where name = 'Credit Card'`);
    await as(db, ADMIN, tx => tx.query(`insert into public.campaign_fee_overrides (campaign_id, method_id, fee_type, fee_percent) values ('1003', $1, 'percent', 1)`, [m.id]));
    expect((await donation(db, await add(db, ADMIN, { campaign_id: '1003', amount: 100, payment_method: 'Credit Card' }))).fee).toBe('1.00');
    expect((await donation(db, await add(db, ADMIN, { campaign_id: '1002', amount: 100, payment_method: 'Credit Card' }))).fee).toBe('3.00');
  });

  it('are changed only with the fee permission, and logged', async () => {
    await db.exec(`insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000000b', 'second@example.org');
                   insert into public.org_members (org_id, user_id, role) values ('${OIZER}', '00000000-0000-0000-0000-00000000000b', 'admin')`);
    const second = '00000000-0000-0000-0000-00000000000b';
    const change = (u: string) => rows(db, u, `update public.payment_methods set fee_type = 'flat', fee_flat = 9 where name = 'Check' returning id`);
    expect(await change(second)).toEqual([]);
    expect(await change(MANAGER_1)).toEqual([]);
    await as(db, ADMIN, tx => tx.query(`select public.set_delegation('${second}', 'configure_fees', true)`));
    expect(await change(second)).toHaveLength(1);
    const log = (await db.query<{ changes: { fee_flat: { new: number } } }>(`select changes from public.activity_log where table_name = 'payment_methods' and action = 'update'`)).rows;
    expect(log[0].changes.fee_flat.new).toBe(9);
  });
});

describe('fundraiser entry and approval', () => {
  let db: PGlite;
  beforeEach(async () => { db = await seededDb(); });
  const grant = (scope = 'null') => as(db, ADMIN, tx => tx.query(`select public.grant_override('m1', 'enter_manual_payments', ${scope})`));
  const enter = () => add(db, MANAGER_1, { campaign_id: '1001', amount: 50, payment_method: 'Cash', status: 'completed' });

  it('needs the override', async () => {
    await expect(enter()).rejects.toThrow(/row-level security/);
  });

  it('is held as pending whatever status they send, and stays out of the balance', async () => {
    await grant();
    const before = await summary(db, '1001');
    const id = await enter();
    expect((await donation(db, id)).status).toBe('pending');
    const after = await summary(db, '1001');
    expect(after.raised).toBe(before.raised);
    expect(after.awaiting_approval).toBe('50.00');
  });

  it('is limited to the campaigns the override names, and to their own', async () => {
    await grant(`array['1003']`);
    await expect(enter()).rejects.toThrow(/row-level security/);
    await expect(add(db, MANAGER_1, { campaign_id: '1002', amount: 5 })).rejects.toThrow(/row-level security/);
    expect((await donation(db, await add(db, MANAGER_1, { campaign_id: '1003', amount: 5 }))).status).toBe('pending');
  });

  it('posts when approved, reactivating an archived campaign', async () => {
    await grant();
    const id = await enter();
    const raised = Number((await summary(db, '1001')).raised);
    await as(db, ADMIN, tx => tx.query(`update public.campaigns set status = 'archived' where id = '1001'`));
    await as(db, ADMIN, tx => tx.query(`select public.review_donation($1, true)`, [id]));
    expect(await donation(db, id)).toMatchObject({ status: 'completed', reviewed_by: 'office@example.org' });
    expect(Number((await summary(db, '1001')).raised)).toBe(raised + 50);
    expect((await db.query(`select status from public.campaigns where id = '1001'`)).rows).toEqual([{ status: 'active' }]);
  });

  it('needs a reason to reject, and rejected money never counts', async () => {
    await grant();
    const id = await enter();
    const raised = (await summary(db, '1001')).raised;
    await expect(as(db, ADMIN, tx => tx.query(`select public.review_donation($1, false, ' ')`, [id]))).rejects.toThrow(/reason is required/);
    await as(db, ADMIN, tx => tx.query(`select public.review_donation($1, false, 'No such check')`, [id]));
    expect(await donation(db, id)).toMatchObject({ status: 'rejected', review_note: 'No such check' });
    expect((await summary(db, '1001')).raised).toBe(raised);
  });

  it('can only be handled once, and says who got there first', async () => {
    await grant();
    const id = await enter();
    await as(db, ADMIN, tx => tx.query(`select public.review_donation($1, true)`, [id]));
    await expect(as(db, ADMIN, tx => tx.query(`select public.review_donation($1, false, 'x')`, [id]))).rejects.toThrow(/already handled by office@example.org/);
  });

  it('is approved by admins only', async () => {
    await grant();
    const id = await enter();
    await expect(as(db, MANAGER_1, tx => tx.query(`select public.review_donation($1, true)`, [id]))).rejects.toThrow(/Only admins/);
  });
});

describe('refunds and returned checks', () => {
  let db: PGlite;
  beforeEach(async () => { db = await seededDb(); });

  it('a refund takes the net off and keeps the fee spent', async () => {
    const before = await summary(db, '1003');
    await as(db, ADMIN, tx => tx.query(`select public.refund_donation('p3', '2026-11-01', 'Check', 'Donor asked')`));
    const after = await summary(db, '1003');
    expect(after.raised).toBe('0');
    expect(after.fees).toBe(before.fees);
    expect(after.balance).toBe('-3.20');
    expect(await donation(db, 'p3')).toMatchObject({ status: 'refunded', reversal_method: 'Check', reversal_notes: 'Donor asked' });
  });

  it('only applies to a completed gift', async () => {
    await expect(as(db, ADMIN, tx => tx.query(`select public.refund_donation('v1')`))).rejects.toThrow(/completed/);
    await expect(as(db, MANAGER_1, tx => tx.query(`select public.refund_donation('p1')`))).rejects.toThrow(/Only admins/);
  });

  it('a returned check reverses and creates a follow-up task', async () => {
    const id = await add(db, ADMIN, { campaign_id: '1003', donor_id: 'd1', amount: 200, payment_method: 'Check', name: 'Moshe' });
    const raised = Number((await summary(db, '1003')).raised);
    await as(db, ADMIN, tx => tx.query(`select public.return_check($1, '2026-11-01', 'NSF')`, [id]));
    expect((await donation(db, id)).status).toBe('returned');
    expect(Number((await summary(db, '1003')).raised)).toBe(raised - 200);
    const task = (await db.query(`select title, description, donor_id, status from public.tasks where campaign_id = '1003'`)).rows[0];
    expect(task).toEqual({ title: 'Collect replacement for returned check: Moshe $200.00', description: 'Bank reason: NSF', donor_id: 'd1', status: 'Pending' });
  });

  it('returning a split check returns every part', async () => {
    const id = await add(db, ADMIN, { campaign_id: '1003', amount: 100, payment_method: 'Check', name: 'Split' });
    await as(db, ADMIN, tx => tx.query(`select public.split_donation($1, $2::jsonb)`, [id, JSON.stringify([{ campaign_id: '1003', amount: 60 }, { campaign_id: '1001', amount: 40 }])]));
    await as(db, ADMIN, tx => tx.query(`select public.return_check($1, null, 'NSF')`, [id]));
    const parts = (await db.query<{ status: string }>(`select status from public.donations where split_group_id = (select split_group_id from public.donations where id = $1)`, [id])).rows;
    expect(parts.map(p => p.status)).toEqual(['returned', 'returned']);
    const tasks = (await db.query<{ title: string }>(`select title from public.tasks where title like '%Split%' order by title`)).rows;
    expect(tasks.map(x => x.title)).toEqual(['Collect replacement for returned check: Split $40.00', 'Collect replacement for returned check: Split $60.00']);
  });

  it('only checks can be returned', async () => {
    await expect(as(db, ADMIN, tx => tx.query(`select public.return_check('p1', null, 'NSF')`))).rejects.toThrow(/completed check/);
  });

  it('deleting needs a reason, keeps it on file, and moves the balance', async () => {
    await expect(as(db, ADMIN, tx => tx.query(`select public.delete_donation('p3', '  ')`))).rejects.toThrow(/reason is required/);
    await as(db, ADMIN, tx => tx.query(`select public.delete_donation('p3', 'Entered twice')`));
    expect(await donation(db, 'p3')).toMatchObject({ delete_reason: 'Entered twice', deleted_by: 'office@example.org' });
    expect((await summary(db, '1003')).raised).toBe('0');
  });
});

describe('post-dated checks', () => {
  let db: PGlite;
  beforeEach(async () => { db = await seededDb(); });
  const add30 = (campaign = '1003') => add(db, ADMIN, { campaign_id: campaign, amount: 300, payment_method: 'Check', post_dated: true, check_date: '2099-01-01' });

  it('wait outside the balance until their date', async () => {
    const before = await summary(db, '1003');
    const id = await add30();
    expect((await donation(db, id)).status).toBe('post_dated');
    const after = await summary(db, '1003');
    expect(after.raised).toBe(before.raised);
    expect(after.post_dated_amount).toBe('300.00');
  });

  it('a check dated today or earlier posts straight away', async () => {
    const id = await add(db, ADMIN, { campaign_id: '1003', amount: 5, post_dated: true, check_date: '2020-01-01' });
    expect((await donation(db, id)).status).toBe('completed');
  });

  it('clear on the date through the job, not before', async () => {
    const id = await add30();
    await db.query(`select public.run_job('post_dated')`);
    expect((await donation(db, id)).status).toBe('post_dated');
    await db.exec(`update public.donations set check_date = current_date where id = '${id}'`);
    await db.query(`select public.run_job('post_dated')`);
    expect((await donation(db, id)).status).toBe('completed');
    expect((await summary(db, '1003')).post_dated_amount).toBe('0');
    expect((await db.query(`select ok from public.job_runs where job = 'post_dated' order by id desc limit 1`)).rows).toEqual([{ ok: true }]);
  });

  it('reactivates an archived campaign, and leaves money from a closed one unattributed', async () => {
    const a = await add30('1002');
    const b = await add30('1003');
    await as(db, ADMIN, tx => tx.query(`update public.campaigns set status = 'archived' where id = '1002'`));
    await as(db, ADMIN, tx => tx.query(`update public.campaigns set status = 'closed' where id = '1003'`));
    await db.exec(`update public.donations set check_date = current_date where id in ('${a}', '${b}')`);
    await db.query(`select public.run_job('post_dated')`);
    expect((await db.query(`select status from public.campaigns where id = '1002'`)).rows).toEqual([{ status: 'active' }]);
    expect(await donation(db, b)).toMatchObject({ status: 'completed', campaign_id: null });
    expect((await db.query(`select 1 from public.job_runs where job = 'post_dated' and ok`)).rows).toHaveLength(1);
  });

  it('is scheduled daily', async () => {
    expect((await db.query(`select schedule from cron.job where jobname = 'post_dated'`)).rows).toEqual([{ schedule: '0 10 * * *' }]);
  });
});

describe('duplicates', () => {
  let db: PGlite;
  beforeEach(async () => { db = await seededDb(); });
  const gift = (at: string, amount = 100, donor = 'd1', campaign = '1003') => add(db, ADMIN, { campaign_id: campaign, donor_id: donor, amount, created_at: at });

  it('flags both gifts inside the window, and never blocks', async () => {
    const a = await gift('2026-11-01T10:00:00Z');
    const b = await gift('2026-11-01T10:05:00Z');
    expect((await donation(db, a)).possible_duplicate).toBe(true);
    expect((await donation(db, b)).possible_duplicate).toBe(true);
  });

  it('ignores gifts outside the window, or with a different amount, donor or campaign', async () => {
    const a = await gift('2026-11-01T10:00:00Z');
    await gift('2026-11-01T11:00:00Z');
    await gift('2026-11-01T10:01:00Z', 101);
    await gift('2026-11-01T10:01:00Z', 100, 'd2');
    await gift('2026-11-01T10:01:00Z', 100, 'd1', '1002');
    expect((await donation(db, a)).possible_duplicate).toBe(false);
  });

  it('follows the window setting', async () => {
    await as(db, ADMIN, tx => tx.query(`update public.settings set value = '60' where key = 'duplicate_window_minutes'`));
    await gift('2026-11-01T10:00:00Z');
    expect((await donation(db, await gift('2026-11-01T10:30:00Z'))).possible_duplicate).toBe(true);
  });

  it('can be marked reviewed', async () => {
    const a = await gift('2026-11-01T10:00:00Z');
    await gift('2026-11-01T10:05:00Z');
    await as(db, ADMIN, tx => tx.query(`select public.mark_duplicate_reviewed($1)`, [a]));
    expect(await donation(db, a)).toMatchObject({ possible_duplicate: false, duplicate_reviewed_by: 'office@example.org' });
  });
});

describe('splitting a donation', () => {
  let db: PGlite;
  beforeEach(async () => { db = await seededDb(); });
  const split = (id: string, legs: object[], user = ADMIN) => as(db, user, tx => tx.query(`select public.split_donation($1, $2)`, [id, JSON.stringify(legs)]));

  it("shares the fee as in the spec: $1000 split 600/400 with a $29.30 fee", async () => {
    await db.exec(`update public.donations set fee = 29.30 where id = 'p1'`);
    await split('p1', [{ campaign_id: '1002', amount: 600 }, { campaign_id: '1003', amount: 400 }]);
    const legs = (await db.query(`select campaign_id, amount, fee, net_donation from public.donations where split_group_id is not null order by amount desc`)).rows;
    expect(legs).toEqual([
      { campaign_id: '1002', amount: '600.00', fee: '17.58', net_donation: '582.42' },
      { campaign_id: '1003', amount: '400.00', fee: '11.72', net_donation: '388.28' },
    ]);
  });

  it('moves the money and leaves total raised and fees unchanged', async () => {
    const all = async () => {
      const s = await rows<{ raised: string; fees: string }>(db, ADMIN, `select raised, fees from public.campaign_summary`);
      return [s.reduce((t, r) => t + Number(r.raised), 0).toFixed(2), s.reduce((t, r) => t + Number(r.fees), 0).toFixed(2)];
    };
    const before = await all();
    await split('p1', [{ campaign_id: '1001', amount: 333.33 }, { campaign_id: '1002', amount: 333.33 }, { campaign_id: '1003', amount: 333.34 }]);
    expect(await all()).toEqual(before);
  });

  it('gives the pennies to the largest part so fees add up exactly', async () => {
    await db.exec(`update public.donations set fee = 10 where id = 'p1'`);
    await split('p1', [{ campaign_id: '1001', amount: 333.33 }, { campaign_id: '1002', amount: 333.33 }, { campaign_id: '1003', amount: 333.34 }]);
    const legs = (await db.query<{ fee: string; amount: string }>(`select fee, amount from public.donations where split_group_id is not null order by amount`)).rows;
    expect(legs.reduce((t, l) => t + Number(l.fee), 0).toFixed(2)).toBe('10.00');
    expect(legs[2]).toEqual({ fee: '3.34', amount: '333.34' });
  });

  it('keeps donor details on every part and credits the donor the same total', async () => {
    const total = async () => (await rows<{ total_given: string }>(db, ADMIN, `select total_given from public.donor_summary where id = 'd1'`))[0].total_given;
    const before = await total();
    await split('p1', [{ campaign_id: '1002', amount: 700 }, { campaign_id: '1003', amount: 300 }]);
    expect((await db.query(`select distinct donor_id from public.donations where split_group_id is not null`)).rows).toEqual([{ donor_id: 'd1' }]);
    expect(await total()).toBe(before);
  });

  it('must add up, needs two parts, and only once', async () => {
    await expect(split('p1', [{ campaign_id: '1002', amount: 600 }, { campaign_id: '1003', amount: 300 }])).rejects.toThrow(/add up to 900/);
    await expect(split('p1', [{ campaign_id: '1002', amount: 1000 }])).rejects.toThrow(/at least two/);
    await split('p1', [{ campaign_id: '1002', amount: 600 }, { campaign_id: '1003', amount: 400 }]);
    await expect(split('p1', [{ campaign_id: '1002', amount: 300 }, { campaign_id: '1003', amount: 300 }])).rejects.toThrow(/already split/);
  });

  it('refuses closed campaigns entirely, voided gifts, and non-admins', async () => {
    await as(db, ADMIN, tx => tx.query(`update public.campaigns set status = 'closed' where id = '1003'`));
    await expect(split('p1', [{ campaign_id: '1002', amount: 600 }, { campaign_id: '1003', amount: 400 }])).rejects.toThrow(/closed/);
    expect((await donation(db, 'p1')).split_group_id).toBeNull();
    await expect(split('v1', [{ campaign_id: '1002', amount: 500 }, { campaign_id: '1003', amount: 499 }])).rejects.toThrow(/completed/);
    await expect(split('p1', [{ campaign_id: '1002', amount: 600 }, { campaign_id: '1001', amount: 400 }], MANAGER_1)).rejects.toThrow(/Only admins/);
  });

  it('lets one part be refunded alone', async () => {
    await db.exec(`update public.donations set fee = 10 where id = 'p1'`);
    await split('p1', [{ campaign_id: '1002', amount: 600 }, { campaign_id: '1003', amount: 400 }]);
    const [other] = (await db.query<{ id: string }>(`select id from public.donations where split_group_id is not null and campaign_id = '1003'`)).rows;
    await as(db, ADMIN, tx => tx.query(`select public.refund_donation($1)`, [other.id]));
    expect((await db.query(`select campaign_id, status from public.donations where split_group_id is not null order by campaign_id`)).rows)
      .toEqual([{ campaign_id: '1002', status: 'completed' }, { campaign_id: '1003', status: 'refunded' }]);
  });
});

describe('batch entry', () => {
  let db: PGlite;
  beforeEach(async () => { db = await seededDb(); });
  const ROWS = [
    { amount: 100, payment_method: 'Cash' },
    { amount: 50, payment_method: 'Check', check_number: '123', name: 'Name Only', notes: 'n' },
    { amount: 25, payment_method: 'Cash', donor_id: 'd1' },
    { amount: 10, payment_method: 'Zelle', name: 'Brand New Person', phone: '555', create_donor: true },
  ];
  const submit = (user: string, key = 'k1', list: object[] = ROWS, campaign = '1003') =>
    rows<{ b: string }>(db, user, `select public.submit_batch($1, $2, $3) as b`, [campaign, key, JSON.stringify(list)]);

  it('posts every row at once with one numbered batch', async () => {
    const before = Number((await summary(db, '1003')).raised);
    const [{ b }] = await submit(ADMIN);
    expect(b).toMatch(/^BCH-\d{4}-00001$/);
    expect(Number((await summary(db, '1003')).raised)).toBe(before + 185);
    const r = (await db.query<Record<string, any>>(`select amount, name, donor_id, check_number, status from public.donations where batch_entry_id = $1 order by amount desc`, [b])).rows;
    expect(r.map(x => x.status)).toEqual(['completed', 'completed', 'completed', 'completed']);
    expect(r[0]).toMatchObject({ donor_id: null, name: null });
    expect(r[1]).toMatchObject({ donor_id: null, name: 'Name Only', check_number: '123' });
    expect(r[2].donor_id).toBe('d1');
    const newDonor = (await db.query(`select first_name, last_name, phone from public.donors where id = $1`, [r[3].donor_id])).rows[0];
    expect(newDonor).toEqual({ first_name: 'Brand', last_name: 'New Person', phone: '555' });
    expect((await db.query(`select row_count, total, submitted_by, source_label from public.batch_entries`)).rows).toEqual(
      [{ row_count: 4, total: '185.00', submitted_by: 'office@example.org', source_label: 'Batch Entry — Admin' }]);
  });

  it('a double submit changes nothing', async () => {
    const [{ b }] = await submit(ADMIN);
    const [{ b: again }] = await submit(ADMIN);
    expect(again).toBe(b);
    expect((await db.query(`select 1 from public.donations where batch_entry_id = $1`, [b])).rows).toHaveLength(4);
  });

  it('is all or nothing, numbers go up', async () => {
    await expect(submit(ADMIN, 'bad', [{ amount: 5, payment_method: 'Cash' }, { amount: -1, payment_method: 'Cash' }])).rejects.toThrow(/above zero/);
    await expect(submit(ADMIN, 'bad2', [{ amount: 5 }])).rejects.toThrow(/payment method/);
    expect((await db.query(`select 1 from public.batch_entries`)).rows).toEqual([]);
    const [{ b }] = await submit(ADMIN, 'k2');
    expect(b).toMatch(/-00001$/);
    const [{ b: second }] = await submit(ADMIN, 'k3');
    expect(second).toMatch(/-00002$/);
  });

  it('a fundraiser needs the override, and their batch waits for approval', async () => {
    await expect(submit(MANAGER_1)).rejects.toThrow(/permission/);
    await as(db, ADMIN, tx => tx.query(`select public.grant_override('m1', 'enter_manual_payments')`));
    const before = (await summary(db, '1003')).raised;
    const [{ b }] = await submit(MANAGER_1);
    expect((await db.query(`select distinct status from public.donations where batch_entry_id = $1`, [b])).rows).toEqual([{ status: 'pending' }]);
    expect((await summary(db, '1003')).raised).toBe(before);
    expect((await summary(db, '1003')).awaiting_approval).toBe('185.00');
    expect((await db.query<{ source_label: string }>(`select source_label from public.batch_entries`)).rows[0].source_label).toBe('Batch Entry — Fundraiser (Pending)');
    expect(ids(await rows(db, MANAGER_1, `select id from public.batch_entries`))).toEqual([b]);
    expect(await rows(db, MANAGER_2, `select id from public.batch_entries`)).toEqual([]);
  });

  it("can't reach a campaign a fundraiser isn't on", async () => {
    await as(db, ADMIN, tx => tx.query(`select public.grant_override('m1', 'enter_manual_payments')`));
    await expect(submit(MANAGER_1, 'k', ROWS, '1002')).rejects.toThrow(/permission/);
  });

  it('respects closed campaigns', async () => {
    await as(db, ADMIN, tx => tx.query(`update public.campaigns set status = 'closed' where id = '1003'`));
    await expect(submit(ADMIN)).rejects.toThrow(/closed/);
    expect((await db.query(`select 1 from public.batch_entries`)).rows).toEqual([]);
  });

  it('is closed to outsiders', async () => {
    await expect(submit('anon')).rejects.toThrow(/permission denied/);
    await expect(rows(db, ADMIN, `insert into public.batch_entries (id, client_key, source_label) values ('x', 'y', 'z')`)).rejects.toThrow(/permission denied/);
    await expect(rows(db, ADMIN, `select public.next_reference('${OIZER}', 'BCH')`)).rejects.toThrow(/permission denied/);
  });
});

describe('moving existing data', () => {
  it('flags nothing and changes no existing fee', async () => {
    const db = await seededDb();
    expect((await db.query(`select 1 from public.donations where possible_duplicate`)).rows).toEqual([]);
    expect((await donation(db, 'p1')).fee).toBe('29.30');
    expect((await donation(db, 'c1')).fee).toBeNull();
  });
});
