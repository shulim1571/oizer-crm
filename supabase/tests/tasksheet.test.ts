import type { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, MANAGER_1, MANAGER_2, as, rows, seededDb } from './harness';

const sql = (db: PGlite, q: string, params: unknown[] = [], user = ADMIN) => as(db, user, tx => tx.query(q, params));
const one = async <T = Record<string, any>>(db: PGlite, q: string, params: unknown[] = [], user = ADMIN) => (await rows<T>(db, user, q, params))[0];
const sheet = (db: PGlite, type?: string) =>
  rows<Record<string, any>>(db, ADMIN, `select * from public.admin_task_sheet ${type ? 'where task_type = $1' : ''} order by submitted_at`, type ? [type] : []);
const request = async (db: PGlite, name = 'Annual Dinner', user = MANAGER_1, parent: string | null = null) =>
  (await one<{ id: string }>(db, `select public.submit_campaign_request($1, 'About it', 5000, 'Please hurry', $2) as id`, [name, parent], user)).id;
const req = (db: PGlite, id: string) => one(db, `select * from public.campaign_requests where id = $1`, [id]);
const give = async (db: PGlite, values: Record<string, unknown>) => {
  const v = { amount: 100, type: 'Payment', status: 'completed', ...values };
  const keys = Object.keys(v);
  return (await one<{ id: string }>(db, `insert into public.donations (${keys.join(',')}) values (${keys.map((_, i) => `$${i + 1}`).join(',')}) returning id`, Object.values(v))).id;
};

describe('campaign requests', () => {
  let db: PGlite;
  beforeEach(async () => { db = await seededDb(); });

  it('are made by fundraisers and start pending, creating no campaign', async () => {
    const before = (await one<{ n: string }>(db, `select count(*) n from public.campaigns`)).n;
    const id = await request(db);
    expect(await req(db, id)).toMatchObject({ status: 'pending', name: 'Annual Dinner', manager_id: 'm1', campaign_id: null });
    expect((await one<{ n: string }>(db, `select count(*) n from public.campaigns`)).n).toBe(before);
    await expect(request(db, 'Mine', ADMIN)).rejects.toThrow(/Only a fundraiser/);
  });

  it("can't be written to directly", async () => {
    const id = await request(db);
    await expect(sql(db, `insert into public.campaign_requests (name) values ('x')`, [], MANAGER_1)).rejects.toThrow();
    await expect(sql(db, `update public.campaign_requests set status = 'approved' where id = $1`, [id], MANAGER_1)).rejects.toThrow();
    await expect(sql(db, `update public.campaign_requests set status = 'approved' where id = $1`, [id])).rejects.toThrow();
  });

  it('are private to the fundraiser who asked, and admins', async () => {
    const id = await request(db);
    expect((await rows(db, MANAGER_1, `select id from public.campaign_requests where id = $1`, [id])).length).toBe(1);
    expect(await rows(db, MANAGER_2, `select id from public.campaign_requests where id = $1`, [id])).toEqual([]);
  });

  it('create the campaign on approval, assigned to who asked, with edits and a team', async () => {
    const id = await request(db);
    const [{ c }] = await rows<{ c: string }>(db, ADMIN, `select public.approve_campaign_request($1, 'Annual Dinner 2027', 7500, null, array['m2'], 'Enjoy') as c`, [id]);
    const camp = await one(db, `select * from public.campaign_summary where id = $1`, [c]);
    expect(camp).toMatchObject({ internal_name: 'Annual Dinner 2027', goal: '7500.00', manager_id: 'm1', sub_manager_ids: ['m2'], status: 'active' });
    expect(await req(db, id)).toMatchObject({ status: 'approved', campaign_id: c, admin_note: 'Enjoy', decided_by: 'office@example.org' });
    expect((await rows(db, MANAGER_1, `select id from public.campaign_summary where id = $1`, [c])).length).toBe(1);
  });

  it('let the admin assign a different primary', async () => {
    const id = await request(db);
    const [{ c }] = await rows<{ c: string }>(db, ADMIN, `select public.approve_campaign_request($1, null, null, 'm2') as c`, [id]);
    expect((await one(db, `select manager_id from public.campaigns where id = $1`, [c])).manager_id).toBe('m2');
  });

  it('can ask for a sub-campaign under their own campaign only', async () => {
    await expect(request(db, 'Table', MANAGER_1, '1002')).rejects.toThrow(/your own campaigns/);
    const id = await request(db, 'Table', MANAGER_1, '1001');
    const [{ c }] = await rows<{ c: string }>(db, ADMIN, `select public.approve_campaign_request($1, null, null, null, '{}', null, 'independent') as c`, [id]);
    expect(await one(db, `select parent_campaign_id, balance_mode, manager_id from public.campaigns where id = $1`, [c]))
      .toEqual({ parent_campaign_id: '1001', balance_mode: 'independent', manager_id: 'm1' });
  });

  it('are handled once: the second admin to act is told', async () => {
    const id = await request(db);
    await sql(db, `select public.approve_campaign_request($1)`, [id]);
    await expect(sql(db, `select public.approve_campaign_request($1)`, [id])).rejects.toThrow(/already handled/);
    await expect(sql(db, `select public.decide_campaign_request($1, 'rejected')`, [id])).rejects.toThrow(/already handled/);
  });

  it('go rejected with history kept, creating nothing', async () => {
    const id = await request(db);
    await sql(db, `select public.decide_campaign_request($1, 'rejected', 'Not this year')`, [id]);
    expect(await req(db, id)).toMatchObject({ status: 'rejected', admin_note: 'Not this year', campaign_id: null });
    await expect(sql(db, `select public.resubmit_campaign_request($1, 'Again')`, [id], MANAGER_1)).rejects.toThrow(/sent back/);
  });

  it('come back for changes, are edited and resubmitted', async () => {
    const id = await request(db);
    await expect(sql(db, `select public.decide_campaign_request($1, 'changes_requested', ' ')`, [id])).rejects.toThrow(/what needs changing/);
    await expect(sql(db, `select public.resubmit_campaign_request($1, 'Early')`, [id], MANAGER_1)).rejects.toThrow(/sent back/);
    await sql(db, `select public.decide_campaign_request($1, 'changes_requested', 'Add a goal')`, [id]);
    expect((await sheet(db, 'campaign_request')).length).toBe(0);
    await expect(sql(db, `select public.resubmit_campaign_request($1, 'Mine now')`, [id], MANAGER_2)).rejects.toThrow(/sent back/);
    await sql(db, `select public.resubmit_campaign_request($1, 'Dinner v2', 'New', 9000)`, [id], MANAGER_1);
    expect(await req(db, id)).toMatchObject({ status: 'pending', name: 'Dinner v2', goal: '9000.00' });
    const [item] = await sheet(db, 'changes_resubmitted');
    expect(item).toMatchObject({ record_id: id, summary: 'Dinner v2' });
  });

  it('can be withdrawn by the one who asked, while still open', async () => {
    const id = await request(db);
    await expect(sql(db, `select public.withdraw_campaign_request($1)`, [id], MANAGER_2)).rejects.toThrow(/no longer/);
    await sql(db, `select public.withdraw_campaign_request($1)`, [id], MANAGER_1);
    expect((await req(db, id)).status).toBe('withdrawn');
    await expect(sql(db, `select public.withdraw_campaign_request($1)`, [id], MANAGER_1)).rejects.toThrow(/no longer/);
  });
});

describe('team requests', () => {
  let db: PGlite;
  beforeEach(async () => { db = await seededDb(); });
  const ask = async (role: string, name: string | null, email: string | null, phone: string | null = null, user = MANAGER_2, campaign = '1002') =>
    (await one<{ id: string }>(db, `select public.request_team_member($1, $2, $3, $4, $5) as id`, [campaign, role, name, email, phone], user)).id;

  it('come only from the primary, with a way to reach them', async () => {
    await expect(ask('secondary', 'Moshe', 'm@x.org', null, MANAGER_1, '1003')).rejects.toThrow(/primary fundraiser/);
    await expect(ask('secondary', 'Moshe', null)).rejects.toThrow(/email or a phone/);
    await expect(ask('guest', 'Moshe', null, '555')).rejects.toThrow(/signs in by email/);
  });

  it('add an existing fundraiser as secondary, once, on approval', async () => {
    const id = await ask('secondary', null, 'ONE@example.org');
    expect((await one(db, `select sub_manager_ids from public.campaigns where id = '1002'`)).sub_manager_ids).toEqual([]);
    await sql(db, `select public.decide_team_request($1, true)`, [id]);
    expect((await one(db, `select sub_manager_ids from public.campaigns where id = '1002'`)).sub_manager_ids).toEqual(['m1']);
    await expect(sql(db, `select public.decide_team_request($1, true)`, [id])).rejects.toThrow(/already handled/);
    const again = await ask('secondary', null, 'one@example.org');
    await sql(db, `select public.decide_team_request($1, true)`, [again]);
    expect((await one(db, `select sub_manager_ids from public.campaigns where id = '1002'`)).sub_manager_ids).toEqual(['m1']);
  });

  it('create someone new when they are not in the system', async () => {
    const id = await ask('secondary', 'New Person', 'new@example.org', '555-1212');
    await sql(db, `select public.decide_team_request($1, true)`, [id]);
    const m = await one(db, `select id, first_name, last_name, phone from public.managers where email = 'new@example.org'`);
    expect(m).toMatchObject({ first_name: 'New', last_name: 'Person', phone: '555-1212' });
    expect((await one(db, `select sub_manager_ids from public.campaigns where id = '1002'`)).sub_manager_ids).toEqual([m.id]);
  });

  it('can be changed to a guest by the admin before approving', async () => {
    const id = await ask('secondary', 'Board Member', 'board@example.org');
    await sql(db, `select public.decide_team_request($1, true, 'guest')`, [id]);
    expect((await rows(db, ADMIN, `select email from public.campaign_guests where campaign_id = '1002' and email = 'board@example.org'`)).length).toBe(1);
    expect((await one(db, `select sub_manager_ids from public.campaigns where id = '1002'`)).sub_manager_ids).toEqual([]);
    expect((await one(db, `select role, status from public.campaign_team_requests where id = $1`, [id]))).toEqual({ role: 'guest', status: 'approved' });
  });

  it('do nothing when rejected, and keep the note', async () => {
    const id = await ask('guest', 'X', 'x@example.org');
    await sql(db, `select public.decide_team_request($1, false, null, 'Not needed')`, [id]);
    expect(await rows(db, ADMIN, `select email from public.campaign_guests where email = 'x@example.org'`)).toEqual([]);
    expect(await one(db, `select status, admin_note from public.campaign_team_requests where id = $1`, [id])).toEqual({ status: 'rejected', admin_note: 'Not needed' });
  });

  it('are decided by admins only', async () => {
    const id = await ask('guest', 'X', 'x@example.org');
    await expect(sql(db, `select public.decide_team_request($1, true)`, [id], MANAGER_2)).rejects.toThrow(/Only admins/);
  });
});

describe('the Task Sheet', () => {
  let db: PGlite;
  beforeEach(async () => { db = await seededDb(); });

  it('is for admins only', async () => {
    await request(db);
    expect((await sheet(db)).length).toBeGreaterThan(0);
    expect(await rows(db, MANAGER_1, `select * from public.admin_task_sheet`)).toEqual([]);
    await expect(sql(db, `select public.log_task_action('a', 'b', 'c', 'dismissed')`, [], MANAGER_1)).rejects.toThrow(/Only admins/);
  });

  it('shows a request, and drops it once decided', async () => {
    const id = await request(db);
    const [item] = await sheet(db, 'campaign_request');
    expect(item).toMatchObject({ record_id: id, fundraiser: 'Manager One', amount: '5000.00', summary: 'Annual Dinner', held: false });
    await sql(db, `select public.approve_campaign_request($1)`, [id]);
    expect(await sheet(db, 'campaign_request')).toEqual([]);
  });

  it('lists oldest first, across types', async () => {
    await request(db);
    await give(db, { amount: 5 });
    const list = await sheet(db);
    const times = list.map(i => new Date(i.submitted_at).getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('shows a fundraiser payment until it is decided', async () => {
    await sql(db, `select public.grant_override('m1', 'enter_manual_payments', array['1001'])`);
    const [{ id }] = await rows<{ id: string }>(db, MANAGER_1,
      `insert into public.donations (campaign_id, amount, payment_method, name, type, status) values ('1001', 40, 'Cash', 'Moshe', 'Payment', 'completed') returning id`);
    const [item] = await sheet(db, 'pending_payment');
    expect(item).toMatchObject({ record_id: id, campaign_id: '1001', fundraiser: 'Manager One', amount: '40.00', summary: 'Cash from Moshe' });
    await sql(db, `select public.review_donation($1, true)`, [id]);
    expect(await sheet(db, 'pending_payment')).toEqual([]);
  });

  it('shows an unattributed payment until assigned, with a fee if given', async () => {
    const id = await give(db, { name: 'OJC grant', payment_method: 'OJC', amount: 500 });
    expect((await sheet(db, 'unattributed'))[0]).toMatchObject({ record_id: id, amount: '500.00', campaign_id: null });
    const before = Number((await one(db, `select balance from public.campaign_summary where id = '1003'`)).balance);
    await sql(db, `select public.assign_unattributed($1, '1003', 15)`, [id]);
    expect(await sheet(db, 'unattributed')).toEqual([]);
    expect(Number((await one(db, `select balance from public.campaign_summary where id = '1003'`)).balance)).toBe(before + 485);
    await expect(sql(db, `select public.assign_unattributed($1, '1001')`, [id])).rejects.toThrow(/already assigned/);
  });

  it('matches a pledge when an unattributed payment is assigned', async () => {
    const [{ id: pledge }] = await rows<{ id: string }>(db, ADMIN, `insert into public.pledges (campaign_id, donor_id, amount) values ('1003', 'd1', 500) returning id`);
    const id = await give(db, { donor_id: 'd1', amount: 500 });
    expect((await one(db, `select status from public.pledge_list where id = $1`, [pledge])).status).toBe('open');
    await sql(db, `select public.assign_unattributed($1, '1003')`, [id]);
    expect((await one(db, `select status from public.pledge_list where id = $1`, [pledge])).status).toBe('fulfilled');
  });

  it('can split an unattributed payment off the sheet', async () => {
    const id = await give(db, { amount: 100 });
    await sql(db, `select public.split_donation($1, $2::jsonb)`, [id, JSON.stringify([{ campaign_id: '1001', amount: 60 }, { campaign_id: '1003', amount: 40 }])]);
    expect(await sheet(db, 'unattributed')).toEqual([]);
  });

  it("won't assign to a closed campaign", async () => {
    await sql(db, `update public.campaigns set status = 'closed' where id = '1003'`);
    const id = await give(db, {});
    await expect(sql(db, `select public.assign_unattributed($1, '1003')`, [id])).rejects.toThrow(/closed/);
  });

  it('flags overdue vouchers and pledges, until dealt with', async () => {
    const [{ id: v }] = await rows<{ id: string }>(db, ADMIN,
      `insert into public.vouchers (campaign_id, issuer, face_value, fee_type, expected_date) values ('1003', 'Voucher — OJC Fund', 100, 'none', '2020-01-01') returning id`);
    expect((await sheet(db, 'voucher_overdue'))[0]).toMatchObject({ record_id: v, amount: '100.00' });
    await sql(db, `update public.vouchers set expected_date = '2099-01-01' where id = $1`, [v]);
    expect(await sheet(db, 'voucher_overdue')).toEqual([]);

    const [{ id: p }] = await rows<{ id: string }>(db, ADMIN,
      `insert into public.pledges (campaign_id, donor_id, amount, expected_date) values ('1003', 'd2', 70, '2020-01-01') returning id`);
    expect((await sheet(db, 'pledge_overdue'))[0]).toMatchObject({ record_id: p, amount: '70.00' });
    await give(db, { campaign_id: '1003', donor_id: 'd2', amount: 70 });
    expect(await sheet(db, 'pledge_overdue')).toEqual([]);
  });

  it('shows returned and post-dated checks, stale checks and quiet campaigns', async () => {
    const r = await give(db, { campaign_id: '1003', payment_method: 'Check', check_number: '55' });
    await sql(db, `select public.return_check($1, null, 'NSF')`, [r]);
    expect((await sheet(db, 'returned_check'))[0].summary).toBe('Check #55 · NSF');

    const pd = await give(db, { campaign_id: '1003', payment_method: 'Check', post_dated: true, check_date: '2020-01-01' });
    expect((await sheet(db, 'post_dated_due'))[0].record_id).toBe(pd);

    const [{ id: e }] = await rows<{ id: string }>(db, ADMIN,
      `insert into public.expenses (campaign_id, amount, method, payee, created_at) values ('1001', 20, 'Check', 'Acme', now() - interval '200 days') returning id`);
    expect((await sheet(db, 'stale_check'))[0]).toMatchObject({ record_id: e, summary: 'Check to Acme' });
    await sql(db, `update public.expenses set cleared = true where id = $1`, [e]);
    expect(await sheet(db, 'stale_check')).toEqual([]);

    await db.exec(`update public.donations set created_at = now() - interval '200 days' where campaign_id = '1002';
                   update public.expenses set created_at = now() - interval '200 days' where campaign_id = '1002';
                   update public.campaigns set created_at = now() - interval '200 days' where id = '1002'`);
    const quiet = await sheet(db, 'inactive_campaign');
    expect(quiet.map(i => i.record_id)).toContain('1002');
    await give(db, { campaign_id: '1002', amount: 1 });
    expect((await sheet(db, 'inactive_campaign')).map(i => i.record_id)).not.toContain('1002');
  });

  it('follows the settings for stale and inactive', async () => {
    await rows(db, ADMIN, `insert into public.expenses (campaign_id, amount, method, created_at) values ('1001', 20, 'Check', now() - interval '20 days') returning id`);
    expect(await sheet(db, 'stale_check')).toEqual([]);
    await sql(db, `update public.settings set value = '10' where key = 'stale_check_days'`);
    expect((await sheet(db, 'stale_check')).length).toBe(1);
  });

  it('asks for a new bank account when a campaign loses its own', async () => {
    await sql(db, `insert into public.accounts (id, name) values ('b2', 'Second')`);
    await sql(db, `update public.campaigns set account_id = 'b2' where id = '1003'`);
    await sql(db, `delete from public.accounts where id = 'b2'`);
    expect((await sheet(db, 'bank_reassign'))[0]).toMatchObject({ record_id: '1003', summary: 'Its bank account "Second" was removed' });
    await sql(db, `update public.campaigns set account_id = null where id = '1003'`);
    expect(await sheet(db, 'bank_reassign')).toEqual([]);
  });

  it('dismisses an item, keeps the history, and brings it back only if it recurs', async () => {
    const [{ id: v }] = await rows<{ id: string }>(db, ADMIN,
      `insert into public.vouchers (campaign_id, issuer, face_value, fee_type, expected_date) values ('1003', 'Voucher — OJC Fund', 100, 'none', '2020-01-01') returning id`);
    const [item] = await sheet(db, 'voucher_overdue');
    await sql(db, `select public.log_task_action($1, $2, $3, 'dismissed', 'Spoke to OJC')`, [item.task_key, item.task_type, item.summary]);
    expect(await sheet(db, 'voucher_overdue')).toEqual([]);
    expect(await one(db, `select action, note, acted_by from public.task_sheet_actions`)).toEqual({ action: 'dismissed', note: 'Spoke to OJC', acted_by: 'office@example.org' });
    await sql(db, `update public.vouchers set expected_date = '2021-01-01' where id = $1`, [v]);
    expect((await sheet(db, 'voucher_overdue')).length).toBe(1);
  });

  it('keeps a held item on the sheet, set aside', async () => {
    const id = await give(db, {});
    const [item] = await sheet(db, 'unattributed');
    await sql(db, `select public.log_task_action($1, $2, $3, 'held', 'Waiting on OJC')`, [item.task_key, item.task_type, item.summary]);
    expect((await sheet(db, 'unattributed'))[0]).toMatchObject({ record_id: id, held: true, held_note: 'Waiting on OJC' });
  });

  it('has a history nobody can rewrite', async () => {
    await sql(db, `select public.log_task_action('k', 't', 's', 'dismissed')`);
    await expect(sql(db, `update public.task_sheet_actions set note = 'x'`)).rejects.toThrow();
    await expect(sql(db, `delete from public.task_sheet_actions`)).rejects.toThrow();
    expect(await rows(db, MANAGER_1, `select * from public.task_sheet_actions`)).toEqual([]);
  });
});
