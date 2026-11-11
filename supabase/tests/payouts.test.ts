import type { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, MANAGER_1, MANAGER_2, as, rows, seededDb } from './harness';

const sql = (db: PGlite, q: string, params: unknown[] = [], user = ADMIN) => as(db, user, tx => tx.query(q, params));
const one = async <T = Record<string, any>>(db: PGlite, q: string, params: unknown[] = [], user = ADMIN) => (await rows<T>(db, user, q, params))[0];
const pay = async (db: PGlite, campaign: string, amount: number, payee: string | null, extra = '') =>
  (await one<{ id: string }>(db, `insert into public.expenses (campaign_id, amount, payee, method${extra ? ', scheduled_for' : ''}) values ($1, $2, $3, 'Check'${extra ? `, ${extra}` : ''}) returning id`, [campaign, amount, payee])).id;
const balance = async (db: PGlite, campaign: string, user = ADMIN) =>
  Number((await one(db, `select balance from public.campaign_summary where id = $1`, [campaign], user)).balance);
const ach = (db: PGlite, user = MANAGER_1, campaign = '1001', amount: number | null = 200, full = false) =>
  one<{ id: string }>(db, `select public.request_payout($1, $2, $3, 'Yeshiva Building Fund', 'ACH', null, 'Chase', 'checking', '021000021', '123456789', null, 'For the roof') as id`,
    [campaign, amount, full], user).then(r => r.id);

describe('payees', () => {
  let db: PGlite;
  beforeEach(async () => { db = await seededDb(); });

  it('makes a profile the first time a name is paid, and reuses it', async () => {
    const a = await pay(db, '1001', 10, 'Acme Supplies');
    const b = await pay(db, '1001', 20, '  acme supplies ');
    const ids = await rows<{ payee_id: string; payee: string }>(db, ADMIN, `select payee_id, payee from public.expenses where id in ($1, $2)`, [a, b]);
    expect(ids[0].payee_id).toBeTruthy();
    expect(ids[0].payee_id).toBe(ids[1].payee_id);
    const s = await one(db, `select name, payout_count, total_paid from public.payee_summary where id = $1`, [ids[0].payee_id]);
    expect(s).toMatchObject({ name: 'Acme Supplies', total_paid: '30.00' });
    expect(Number(s.payout_count)).toBe(2);
  });

  it('takes the name from a chosen profile', async () => {
    const p = (await one<{ id: string }>(db, `insert into public.payees (name, phone) values ('Rabbi Weiss', '845-555-0101') returning id`)).id;
    const e = (await one<{ id: string }>(db, `insert into public.expenses (campaign_id, amount, payee_id, method) values ('1001', 5, $1, 'Zelle') returning id`, [p])).id;
    expect((await one(db, `select payee from public.expenses where id = $1`, [e])).payee).toBe('Rabbi Weiss');
  });

  it('lets fundraisers search every payee by name, but not read flags or notes', async () => {
    const id = await pay(db, '1002', 10, 'Goldberg Printing');
    const payee = (await one(db, `select payee_id from public.expenses where id = $1`, [id])).payee_id;
    await sql(db, `insert into public.payee_flags (payee_id, reason) values ($1, 'Cashed twice')`, [payee]);
    expect(await rows(db, MANAGER_1, `select * from public.lookup_payees('goldb')`)).toEqual([{ id: payee, name: 'Goldberg Printing' }]);
    expect(await rows(db, MANAGER_1, `select id from public.payees where id = $1`, [payee])).toEqual([]);
    expect(await rows(db, MANAGER_2, `select * from public.payee_flags`)).toEqual([]);
    expect((await one(db, `select do_not_pay from public.payee_summary where id = $1`, [payee], MANAGER_2)).do_not_pay).toBe(false);
    expect((await one(db, `select do_not_pay from public.payee_summary where id = $1`, [payee])).do_not_pay).toBe(true);
    await expect(sql(db, `insert into public.payees (name) values ('X')`, [], MANAGER_1)).rejects.toThrow();
  });

  it('scopes a payee\'s totals to the fundraiser\'s own campaigns', async () => {
    await pay(db, '1001', 100, 'Shared Vendor');
    await pay(db, '1002', 40, 'Shared Vendor');
    const mine = await one(db, `select total_paid, campaigns from public.payee_summary where name = 'Shared Vendor'`, [], MANAGER_2);
    expect(mine).toMatchObject({ total_paid: '40.00', campaigns: ['1002'] });
    expect((await one(db, `select total_paid from public.payee_summary where name = 'Shared Vendor'`)).total_paid).toBe('140.00');
  });

  it('merges two profiles for good, carrying over a Do Not Pay flag', async () => {
    const a = await pay(db, '1001', 10, 'M. Cohen');
    const b = await pay(db, '1002', 15, 'Moshe Cohen');
    const [pa, pb] = await Promise.all([a, b].map(async id => (await one(db, `select payee_id from public.expenses where id = $1`, [id])).payee_id));
    await sql(db, `insert into public.payee_flags (payee_id, reason) values ($1, 'Bounced check')`, [pa]);
    await sql(db, `update public.payees set phone = '718-555-0000' where id = $1`, [pa]);
    await expect(sql(db, `select public.merge_payees($1, $2)`, [pb, pa], MANAGER_1)).rejects.toThrow();
    await sql(db, `select public.merge_payees($1, $2)`, [pb, pa]);
    const kept = await one(db, `select name, phone, payout_count, total_paid, do_not_pay from public.payee_summary where id = $1`, [pb]);
    expect(kept).toMatchObject({ name: 'Moshe Cohen', phone: '718-555-0000', total_paid: '25.00', do_not_pay: true });
    expect((await one(db, `select reason from public.payee_flags where payee_id = $1`, [pb])).reason).toMatch(/Carried over from M\. Cohen.*Bounced check/);
    expect(await rows(db, ADMIN, `select id from public.payee_summary where id = $1`, [pa])).toEqual([]);
    expect((await one(db, `select absorbed_name from public.payee_merges`)).absorbed_name).toBe('M. Cohen');
    await expect(sql(db, `select public.merge_payees($1, $2)`, [pb, pa])).rejects.toThrow(/not found/);
  });
});

describe('payout methods', () => {
  let db: PGlite;
  beforeEach(async () => { db = await seededDb(); });

  it('come with the standard ones and refuse anything else', async () => {
    expect((await rows<{ name: string }>(db, MANAGER_1, `select name from public.payout_methods order by name`)).map(r => r.name))
      .toEqual(['ACH', 'Account Transfer', 'Cash', 'Check', 'Credit Card', 'Wire', 'Zelle']);
    await expect(sql(db, `insert into public.expenses (campaign_id, amount, method) values ('1001', 5, 'Crypto')`)).rejects.toThrow(/payout methods/);
  });

  it('let the Super Admin add, edit and retire a custom one, keeping its history', async () => {
    await expect(sql(db, `select public.save_payout_method(null, 'Crypto')`, [], MANAGER_1)).rejects.toThrow(/Super Admin/);
    const id = (await one<{ id: string }>(db, `select public.save_payout_method(null, 'Crypto', 'Coinbase') as id`)).id;
    const e = (await one<{ id: string }>(db, `insert into public.expenses (campaign_id, amount, method) values ('1001', 5, 'crypto') returning id`)).id;
    await sql(db, `select public.save_payout_method($1, 'Crypto', null, null, false)`, [id]);
    await expect(sql(db, `insert into public.expenses (campaign_id, amount, method) values ('1001', 5, 'Crypto')`)).rejects.toThrow(/payout methods/);
    await sql(db, `update public.expenses set amount = 6 where id = $1`, [e]);
    expect((await one(db, `select is_custom from public.payout_methods where id = $1`, [id])).is_custom).toBe(true);
    const check = (await one<{ id: string }>(db, `select id from public.payout_methods where name = 'Check'`)).id;
    await expect(sql(db, `select public.save_payout_method($1, 'Cheque')`, [check])).rejects.toThrow(/standard/);
    await expect(sql(db, `select public.save_payout_method(null, 'zelle')`)).rejects.toThrow(/already/);
  });

  it('are set up for a new organization too', async () => {
    const org = (await db.query<{ id: string }>(`insert into public.organizations (slug, name) values ('new', 'New Org') returning id`)).rows[0].id;
    expect(Number((await db.query<{ n: string }>(`select count(*) as n from public.payout_methods where org_id = $1`, [org])).rows[0].n)).toBe(7);
  });
});

describe('payout visibility', () => {
  let db: PGlite;
  beforeEach(async () => { db = await seededDb(); });

  it('shows a secondary fundraiser the amount and date only, and their balance still counts it', async () => {
    await pay(db, '1003', 50, 'Hidden Vendor');
    expect(await rows(db, MANAGER_1, `select id from public.expenses where campaign_id = '1003'`)).toEqual([]);
    const brief = await rows<Record<string, any>>(db, MANAGER_1, `select * from public.campaign_payouts('1003')`);
    expect(brief).toHaveLength(1);
    expect(brief[0]).toMatchObject({ amount: '50.00', payee: null, method: null, detail: false });
    expect(await balance(db, '1003', MANAGER_1)).toBe(await balance(db, '1003'));
    const primary = await rows<Record<string, any>>(db, MANAGER_2, `select * from public.campaign_payouts('1003')`);
    expect(primary[0]).toMatchObject({ payee: 'Hidden Vendor', detail: true });
    await expect(rows(db, MANAGER_1, `select * from public.campaign_payouts('1002')`)).rejects.toThrow(/isn't yours/);
  });

  it('opens the details to a secondary given payout visibility', async () => {
    await pay(db, '1003', 50, 'Hidden Vendor');
    await sql(db, `select public.grant_override('m1', 'payout_visibility', array['1003'])`);
    expect((await one(db, `select payee from public.expenses where campaign_id = '1003'`, [], MANAGER_1)).payee).toBe('Hidden Vendor');
  });
});

describe('payout requests', () => {
  let db: PGlite;
  beforeEach(async () => { db = await seededDb(); });

  it('come from the primary fundraiser, with bank details encrypted', async () => {
    const id = await ach(db);
    const r = await one(db, `select status, method, routing_last4, account_last4, bank_name, amount from public.payout_requests where id = $1`, [id], MANAGER_1);
    expect(r).toMatchObject({ status: 'pending', method: 'ACH', routing_last4: '0021', account_last4: '6789', bank_name: 'Chase', amount: '200.00' });
    // Read as the database owner: nobody signed in can read this table at all.
    const raw = (await db.query<{ r: string; a: string }>(`select encode(routing, 'escape') as r, encode(account, 'escape') as a from public.payout_request_secrets where request_id = $1`, [id])).rows[0];
    await expect(rows(db, ADMIN, `select * from public.payout_request_secrets`)).rejects.toThrow();
    expect(raw.r).not.toContain('021000021');
    expect(raw.a).not.toContain('123456789');
    await expect(rows(db, MANAGER_1, `select * from public.payout_request_secrets`)).rejects.toThrow();
    await expect(rows(db, MANAGER_1, `select * from public.payout_request_details($1)`, [id])).rejects.toThrow();
    expect(await one(db, `select routing, account, zelle from public.payout_request_details($1)`, [id])).toEqual({ routing: '021000021', account: '123456789', zelle: null });
    expect((await rows(db, ADMIN, `select 1 from public.activity_log where action = 'view_payout_details'`)).length).toBe(1);
  });

  it('show an admin the full payee and bank details on opening, log each reveal, and keep everyone else on the masked view', async () => {
    const id = await ach(db);
    expect(await one(db, `select * from public.payout_request_details($1)`, [id])).toEqual({
      method: 'ACH', recipient_name: 'Yeshiva Building Fund', payee_name: null, bank_name: 'Chase', account_type: 'checking',
      routing: '021000021', account: '123456789', zelle: null,
    });
    // Each reveal is its own audit entry, with which fields were shown and never the numbers.
    await one(db, `select * from public.payout_request_details($1)`, [id]);
    const log = await rows(db, ADMIN, `select record_id, changes, user_email from public.activity_log where action = 'view_payout_details' order by created_at`);
    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({ record_id: id, changes: { method: 'ACH', fields: ['routing', 'account'] } });
    expect(log[0].user_email).toBeTruthy();
    expect(JSON.stringify(log)).not.toMatch(/021000021|123456789/);
    // The fundraiser who asked sees the masked request, never the full numbers.
    await expect(rows(db, MANAGER_1, `select * from public.payout_request_details($1)`, [id])).rejects.toThrow();
    expect(await one(db, `select bank_name, routing_last4, account_last4 from public.payout_requests where id = $1`, [id], MANAGER_1))
      .toEqual({ bank_name: 'Chase', routing_last4: '0021', account_last4: '6789' });
    // A request that isn't the organization's is refused.
    await expect(one(db, `select * from public.payout_request_details('nope')`)).rejects.toThrow(/not found/);
  });

  it('check the details for the method chosen', async () => {
    const q = (args: string) => sql(db, `select public.request_payout('1001', 50, false, 'Someone', ${args})`, [], MANAGER_1);
    await expect(q(`'ACH', null, 'Chase', 'checking', '1234', '99999'`)).rejects.toThrow(/9 digits/);
    await expect(q(`'ACH', null, null, 'checking', '021000021', '99999'`)).rejects.toThrow(/bank name/);
    await expect(q(`'Zelle'`)).rejects.toThrow(/Zelle needs/);
    await expect(q(`'Crypto'`)).rejects.toThrow(/payout method/);
    const z = (await one<{ id: string }>(db, `select public.request_payout('1001', 50, false, 'Someone', 'Zelle', null, null, null, null, null, 'someone@example.com') as id`, [], MANAGER_1)).id;
    expect((await one(db, `select zelle from public.payout_request_details($1)`, [z])).zelle).toBe('someone@example.com');
    expect((await one(db, `select zelle_hint from public.payout_requests where id = $1`, [z])).zelle_hint).toBe('so…');
  });

  it('are refused to a secondary, another campaign\'s fundraiser and a shared sub-campaign', async () => {
    await expect(ach(db, MANAGER_1, '1003')).rejects.toThrow(/primary fundraiser/);
    await expect(ach(db, MANAGER_2, '1001')).rejects.toThrow(/primary fundraiser/);
    await sql(db, `select public.grant_override('m1', 'request_payouts', array['1003'])`);
    expect(await ach(db, MANAGER_1, '1003')).toBeTruthy();
    await sql(db, `insert into public.campaigns (id, internal_name, external_name, parent_campaign_id, balance_mode, manager_id, status) values ('1001A', 'Sub', 'Sub', '1001', 'shared', 'm1', 'active')`);
    await expect(ach(db, MANAGER_1, '1001A')).rejects.toThrow(/primary fundraiser/);
  });

  it('are hidden from fundraisers who can\'t see payout details', async () => {
    await ach(db, MANAGER_2, '1003');
    expect(await rows(db, MANAGER_1, `select id from public.payout_requests`)).toEqual([]);
    expect((await rows(db, MANAGER_2, `select id from public.payout_requests`)).length).toBe(1);
  });

  it('reach the Task Sheet, and approving makes the payout and a payee', async () => {
    const id = await ach(db);
    const before = await balance(db, '1001');
    const item = await one(db, `select task_type, amount, summary from public.admin_task_sheet where record_id = $1`, [id]);
    expect(item).toMatchObject({ task_type: 'payout_request', amount: '200.00', summary: 'To Yeshiva Building Fund by ACH' });
    const payout = (await one<{ id: string }>(db, `select public.approve_payout_request($1, null, null, null, 'a1', null, 'ACH-778', 'Roof') as id`, [id])).id;
    const e = await one(db, `select amount, method, payee, request_id, reference, processed_at from public.expenses where id = $1`, [payout]);
    expect(e).toMatchObject({ amount: '200.00', method: 'ACH', payee: 'Yeshiva Building Fund', request_id: id, reference: 'ACH-778' });
    expect(e.processed_at).toBeTruthy();
    expect(await balance(db, '1001')).toBeCloseTo(before - 200, 2);
    expect(await rows(db, ADMIN, `select 1 from public.admin_task_sheet where record_id = $1`, [id])).toEqual([]);
    const r = await one(db, `select status, payout_id, decided_by from public.payout_requests where id = $1`, [id], MANAGER_1);
    expect(r).toMatchObject({ status: 'approved', payout_id: payout, decided_by: 'office@example.org' });
  });

  it('let only the first admin act', async () => {
    const id = await ach(db);
    await sql(db, `select public.approve_payout_request($1, null, null)`, [id]);
    await expect(sql(db, `select public.approve_payout_request($1, null, null)`, [id])).rejects.toThrow(/already handled by office@example.org/);
    await expect(sql(db, `select public.reject_payout_request($1, 'no')`, [id])).rejects.toThrow(/already handled/);
  });

  it('pay the full balance when asked, even below zero by admin choice', async () => {
    const id = await ach(db, MANAGER_1, '1001', null, true);
    const before = await balance(db, '1001');
    const payout = (await one<{ id: string }>(db, `select public.approve_payout_request($1, null, null) as id`, [id])).id;
    expect(Number((await one(db, `select amount from public.expenses where id = $1`, [payout])).amount)).toBeCloseTo(before, 2);
    expect(await balance(db, '1001')).toBeCloseTo(0, 2);
    const more = await ach(db, MANAGER_1, '1001', 25);
    await sql(db, `select public.approve_payout_request($1, null, null)`, [more]);
    expect(await balance(db, '1001')).toBeCloseTo(-25, 2);
  });

  it('can be rejected with a note that stays on the payee', async () => {
    const p = (await one<{ id: string }>(db, `insert into public.payees (name) values ('Known Payee') returning id`)).id;
    const id = (await one<{ id: string }>(db, `select public.request_payout('1001', 50, false, 'Known Payee', 'Cash', $1) as id`, [p], MANAGER_1)).id;
    await expect(sql(db, `select public.reject_payout_request($1, 'x')`, [id], MANAGER_1)).rejects.toThrow();
    await sql(db, `select public.reject_payout_request($1, 'Payee asked us to hold')`, [id]);
    expect(await one(db, `select status, decision_note from public.payout_requests where id = $1`, [id], MANAGER_1))
      .toEqual({ status: 'rejected', decision_note: 'Payee asked us to hold' });
    expect((await one(db, `select note from public.payee_notes where payee_id = $1`, [p])).note).toBe('Payee asked us to hold');
    expect(await rows(db, MANAGER_1, `select * from public.payee_notes`)).toEqual([]);
  });

  it('can be withdrawn while still waiting', async () => {
    const id = await ach(db);
    await expect(sql(db, `select public.withdraw_payout_request($1)`, [id], MANAGER_2)).rejects.toThrow(/not found/);
    await sql(db, `select public.withdraw_payout_request($1)`, [id], MANAGER_1);
    await expect(sql(db, `select public.approve_payout_request($1, null, null)`, [id])).rejects.toThrow(/withdrew/);
  });
});

describe('scheduled payouts', () => {
  let db: PGlite;
  beforeEach(async () => { db = await seededDb(); });

  it('leave the balance at once, wait, then reach the Task Sheet when due', async () => {
    const before = await balance(db, '1001');
    const id = await pay(db, '1001', 100, 'Later Vendor', `public.org_today() + 7`);
    expect((await one(db, `select processed_at from public.expenses where id = $1`, [id])).processed_at).toBeNull();
    expect(await balance(db, '1001')).toBeCloseTo(before - 100, 2);
    expect(await rows(db, ADMIN, `select 1 from public.admin_task_sheet where record_id = $1`, [id])).toEqual([]);
    expect(Number((await one(db, `select payout_count from public.payee_summary where name = 'Later Vendor'`)).payout_count)).toBe(0);
    await sql(db, `update public.expenses set scheduled_for = public.org_today() where id = $1`, [id]);
    expect((await one(db, `select task_type from public.admin_task_sheet where record_id = $1`, [id])).task_type).toBe('scheduled_payout');
    await sql(db, `select public.process_scheduled_payout($1, 'ZL-1')`, [id]);
    expect((await one(db, `select reference, processed_at from public.expenses where id = $1`, [id])).reference).toBe('ZL-1');
    expect(await rows(db, ADMIN, `select 1 from public.admin_task_sheet where record_id = $1`, [id])).toEqual([]);
    await expect(sql(db, `select public.process_scheduled_payout($1)`, [id])).rejects.toThrow(/already processed/);
  });

  it('give the balance back when cancelled', async () => {
    const before = await balance(db, '1001');
    const id = await pay(db, '1001', 100, 'Later Vendor', `public.org_today() + 7`);
    await sql(db, `delete from public.expenses where id = $1`, [id]);
    expect(await balance(db, '1001')).toBeCloseTo(before, 2);
  });

  it('can be set from a payout request', async () => {
    const id = await ach(db);
    const payout = (await one<{ id: string }>(db, `select public.approve_payout_request($1, null, 'Zelle', 150, null, public.org_today() + 3) as id`, [id])).id;
    expect(await one(db, `select amount, method, processed_at from public.expenses where id = $1`, [payout]))
      .toEqual({ amount: '150.00', method: 'Zelle', processed_at: null });
  });
});
